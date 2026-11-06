import { atMaxFires } from "./loop-reducer.js";
export class TriggerSystem {
    pi;
    scheduler;
    store;
    onFire;
    isDedicatedEventLoop;
    eventSubscriptions = new Map();
    hybridTimers = new Map();
    lastFireTime = new Map();
    constructor(pi, scheduler, store, onFire, isDedicatedEventLoop = () => false) {
        this.pi = pi;
        this.scheduler = scheduler;
        this.store = store;
        this.onFire = onFire;
        this.isDedicatedEventLoop = isDedicatedEventLoop;
    }
    start() {
        this.scheduler.start();
        for (const entry of this.store.list()) {
            if (entry.status !== "active")
                continue;
            if (entry.trigger.type !== "event" && entry.trigger.type !== "hybrid")
                continue;
            if (this.isDedicatedEventLoop(entry.id))
                continue;
            const event = entry.trigger.type === "hybrid" ? entry.trigger.event : entry.trigger;
            this.subscribeEvent(entry, event.source, event.filter);
        }
    }
    stop() {
        this.scheduler.stop();
        for (const [_source, subs] of this.eventSubscriptions) {
            for (const unsub of subs.values())
                unsub();
        }
        this.eventSubscriptions.clear();
        for (const timer of this.hybridTimers.values())
            clearTimeout(timer);
        this.hybridTimers.clear();
    }
    add(entry) {
        this.scheduler.add(entry);
        if ((entry.trigger.type === "event" || entry.trigger.type === "hybrid") && !this.isDedicatedEventLoop(entry.id)) {
            const ev = entry.trigger.type === "hybrid" ? entry.trigger.event : entry.trigger;
            this.subscribeEvent(entry, ev.source, ev.filter);
        }
    }
    remove(id) {
        this.scheduler.remove(id);
        for (const [source, subs] of this.eventSubscriptions) {
            const unsub = subs.get(id);
            if (unsub) {
                unsub();
                subs.delete(id);
            }
            if (subs.size === 0)
                this.eventSubscriptions.delete(source);
        }
        const timer = this.hybridTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.hybridTimers.delete(id);
        }
        this.lastFireTime.delete(id);
    }
    subscribeEvent(entry, source, filter) {
        if (!this.eventSubscriptions.has(source)) {
            this.eventSubscriptions.set(source, new Map());
        }
        const subs = this.eventSubscriptions.get(source);
        if (subs.has(entry.id))
            return;
        const unsub = this.pi.events.on(source, (data) => {
            if (entry.trigger.type === "hybrid") {
                this.handleHybridFire(entry, data);
            }
            else {
                if (this.matchesFilter(data, filter)) {
                    this.fireLoop(entry);
                }
            }
        });
        subs.set(entry.id, unsub);
    }
    handleHybridFire(entry, _data) {
        const now = Date.now();
        const last = this.lastFireTime.get(entry.id) ?? 0;
        const debounceMs = entry.trigger.type === "hybrid" ? entry.trigger.debounceMs : 0;
        if (now - last < debounceMs) {
            const existing = this.hybridTimers.get(entry.id);
            if (existing)
                clearTimeout(existing);
        }
        const remaining = debounceMs - (now - last);
        if (remaining <= 0) {
            this.fireLoop(entry);
            return;
        }
        const timer = setTimeout(() => {
            this.hybridTimers.delete(entry.id);
            this.fireLoop(entry);
        }, remaining);
        this.hybridTimers.set(entry.id, timer);
    }
    retire(entry) {
        this.remove(entry.id);
        this.store.delete(entry.id);
    }
    fireLoop(entry) {
        const current = this.store.get(entry.id);
        if (current?.status !== "active") {
            this.remove(entry.id);
            return;
        }
        const now = Date.now();
        if (now >= current.expiresAt) {
            if (this.scheduler.expire(current, now))
                this.remove(current.id);
            return;
        }
        this.lastFireTime.set(current.id, now);
        this.onFire(current, "event");
        const fresh = this.store.get(entry.id);
        if (!fresh) {
            this.remove(entry.id);
            return;
        }
        if (fresh.recurring && atMaxFires(fresh)) {
            if (fresh.readOnly)
                this.remove(fresh.id);
            else
                this.retire(fresh);
            return;
        }
        if (!fresh.recurring) {
            if (fresh.readOnly)
                this.remove(fresh.id);
            else
                this.retire(fresh);
        }
    }
    matchesFilter(data, filter) {
        if (!filter)
            return true;
        if (filter.startsWith("regex:")) {
            try {
                const regex = new RegExp(filter.slice(6));
                return regex.test(JSON.stringify(data));
            }
            catch {
                return false;
            }
        }
        try {
            const parsed = JSON.parse(filter);
            for (const [key, value] of Object.entries(parsed)) {
                const dataValue = data?.[key];
                if (dataValue === undefined)
                    return false;
                if (typeof value === "object" && typeof dataValue === "object") {
                    if (JSON.stringify(value) !== JSON.stringify(dataValue))
                        return false;
                }
                else if (String(dataValue) !== String(value)) {
                    return false;
                }
            }
            return true;
        }
        catch {
            return true;
        }
    }
}
