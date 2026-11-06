import { computeJitter, cronToNextFire } from "./loop-parse.js";
function computeNextFire(entry) {
    if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid") {
        return cronToNextFire(entry.trigger.type === "hybrid" ? entry.trigger.cron : entry.trigger.schedule);
    }
    if (entry.trigger.type === "dynamic") {
        return new Date(entry.dynamic?.nextWakeAt ?? Date.now());
    }
    return new Date(Date.now() + 60000);
}
export class CronScheduler {
    store;
    onFire;
    onExpired;
    canExpire;
    fireTimes = new Map();
    expiryTimes = new Map();
    constructor(store, onFire, onExpired, canExpire = () => true) {
        this.store = store;
        this.onFire = onFire;
        this.onExpired = onExpired;
        this.canExpire = canExpire;
    }
    start() {
        for (const storedEntry of this.store.list()) {
            let entry = storedEntry;
            if (entry.status !== "active")
                continue;
            if (entry.trigger.type === "event") {
                this.expiryTimes.set(entry.id, entry.expiresAt);
                continue;
            }
            if (entry.trigger.type === "dynamic" && entry.dynamic?.awaitingUpdate && !this.fireTimes.has(entry.id)) {
                entry = this.store.updateDynamic(entry.id, {
                    dynamic: {
                        awaitingUpdate: false,
                        nextWakeAt: undefined,
                        lastUpdatedAt: Date.now(),
                    },
                }) ?? entry;
            }
            this.armTimer(entry);
        }
    }
    stop() {
        this.fireTimes.clear();
        this.expiryTimes.clear();
    }
    add(entry) {
        if (entry.trigger.type === "event") {
            this.expiryTimes.set(entry.id, entry.expiresAt);
            return;
        }
        this.armTimer(entry);
    }
    expire(entry, now = Date.now()) {
        const current = this.store.get(entry.id);
        if (current?.status !== "active")
            return true;
        if (now < current.expiresAt)
            return false;
        return this.retireExpired(current, now);
    }
    remove(id) {
        this.fireTimes.delete(id);
        this.expiryTimes.delete(id);
    }
    nextFire(id) {
        return this.fireTimes.get(id);
    }
    retire(entry) {
        this.store.delete(entry.id);
        this.remove(entry.id);
    }
    retireExpired(entry, now = Date.now()) {
        if (!this.canExpire())
            return false;
        const record = this.store.expireEntry(entry.id, now);
        if (!record) {
            const current = this.store.get(entry.id);
            if (current?.status === "active") {
                this.expiryTimes.set(entry.id, current.expiresAt);
                return false;
            }
            this.remove(entry.id);
            return true;
        }
        this.remove(entry.id);
        this.onExpired?.(record.entry, record.disposition);
        return true;
    }
    armTimer(entry) {
        const nextFire = computeNextFire(entry);
        let jitter = 0;
        if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid") {
            const scheduleExpr = entry.trigger.type === "hybrid" ? entry.trigger.cron : entry.trigger.schedule;
            const minuteField = scheduleExpr.trim().split(/\s+/)[0] ?? "";
            const minuteStep = minuteField.startsWith("*/") ? parseInt(minuteField.slice(2), 10) || 30 : 30;
            jitter = computeJitter(entry.id, entry.recurring, minuteStep);
        }
        const fireTime = nextFire.getTime() + jitter;
        if (fireTime >= entry.expiresAt) {
            this.fireTimes.delete(entry.id);
            this.expiryTimes.set(entry.id, entry.expiresAt);
            return;
        }
        this.expiryTimes.delete(entry.id);
        this.fireTimes.set(entry.id, fireTime);
    }
    pump(now, filter) {
        for (const [id, expiryTime] of this.expiryTimes) {
            if (now < expiryTime)
                continue;
            const entry = this.store.get(id);
            if (entry?.status !== "active") {
                this.remove(id);
                continue;
            }
            if (now < entry.expiresAt) {
                this.expiryTimes.set(id, entry.expiresAt);
                continue;
            }
            this.expire(entry, now);
        }
        for (const [id, fireTime] of this.fireTimes) {
            if (now < fireTime)
                continue;
            const entry = this.store.get(id);
            if (entry?.status !== "active") {
                this.fireTimes.delete(id);
                continue;
            }
            // Expiry takes precedence over awaiting/filter skips so an expired
            // controller still retires and emits its expiry receipt.
            if (now >= entry.expiresAt) {
                this.retireExpired(entry, now);
                continue;
            }
            if (entry.trigger.type === "dynamic" && entry.dynamic?.awaitingUpdate)
                continue;
            if (filter && !filter(entry))
                continue;
            this.onFire(entry, "scheduler");
            const fresh = this.store.get(id);
            if (!fresh) {
                this.fireTimes.delete(id);
                continue;
            }
            if (!fresh.recurring) {
                if (fresh.readOnly)
                    this.fireTimes.delete(id);
                else
                    this.retire(fresh);
                continue;
            }
            if (fresh.maxFires && (fresh.fireCount ?? 0) >= fresh.maxFires) {
                if (fresh.readOnly)
                    this.fireTimes.delete(id);
                else
                    this.retire(fresh);
                continue;
            }
            this.armTimer(fresh);
        }
    }
}
