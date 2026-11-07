/** Private pi-loop-monitor extension for persistent loop wakes and background process monitoring. */
import { randomUUID } from "node:crypto";
import { registerLoopCommand } from "./commands/loop-command.js";
import { registerMonitorsCommand } from "./commands/monitors-command.js";
import { atMaxFires } from "./loop-reducer.js";
import { MonitorManager } from "./monitor-manager.js";
import { buildLoopExpiredPayload } from "./runtime/loop-events.js";
import { createMonitorOnDoneRuntime } from "./runtime/monitor-ondone-runtime.js";
import { createNotificationRuntime } from "./runtime/notification-runtime.js";
import { isReadOnlyWakeGuardAvailable } from "./runtime/read-only-guard-runtime.js";
import { resolveLoopStorePath } from "./runtime/scope.js";
import { registerSessionRuntimeHooks } from "./runtime/session-runtime.js";
import { isStaleExtensionContextError } from "./runtime/stale-context.js";
import { CronScheduler } from "./scheduler.js";
import { LoopStore } from "./store.js";
import { registerLoopTools } from "./tools/loop-tools.js";
import { registerMonitorTools } from "./tools/monitor-tools.js";
import { TriggerSystem } from "./trigger-system.js";
import { LoopWidget } from "./ui/widget.js";
const DEBUG = !!process.env.PI_LOOP_DEBUG;
const READ_ONLY_RETIREMENT_PENDING_REASON = "Post-delivery retirement is pending";
const READ_ONLY_DELIVERY_PENDING_REASON = "Terminal read-only wake is pending delivery";
function debug(...args) { if (DEBUG)
    console.error("[pi-loop-monitor]", ...args); }
export default function (pi) {
    const runtimeId = randomUUID();
    const runtimeProbeEvent = `pi-loop-monitor:runtime-probe:${runtimeId}`;
    let sessionGeneration = 0;
    let latestCtx;
    let store = new LoopStore(resolveLoopStorePath());
    const monitorManager = new MonitorManager(pi);
    const widget = new LoopWidget(store, monitorManager);
    monitorManager.setOnChange(() => widget.update());
    const dedicatedMonitorSignalLoops = new Set();
    const isDedicatedEventLoop = (loopId) => dedicatedMonitorSignalLoops.has(loopId);
    function isCurrentExtensionContext() {
        try {
            pi.events.emit(runtimeProbeEvent, { runtimeId, sessionGeneration });
            return true;
        }
        catch (error) {
            if (!isStaleExtensionContextError(error))
                throw error;
            debug("dropping stale runtime callback");
            return false;
        }
    }
    function emitExpired(entry, disposition, source, reason, generation = sessionGeneration) {
        if (generation !== sessionGeneration || !isCurrentExtensionContext())
            return;
        triggerSystem.remove(entry.id);
        notificationRuntime.discardLoop(entry.id);
        const payload = buildLoopExpiredPayload(entry, disposition, source, reason, Date.now());
        try {
            pi.events.emit("loops:expired", payload);
        }
        catch (error) {
            debug("loops:expired listener failed", error);
        }
        void notificationRuntime.queueOrDeliverLoopExpired({ ...payload, sessionGeneration: generation }).catch((error) => debug("expiry notification failed", error));
    }
    function createScheduler(loopStore) { return new CronScheduler(loopStore, (entry, origin) => onLoopFire(entry, undefined, origin), (entry, disposition) => emitExpired(entry, disposition, "scheduler", "expires_at"), isCurrentExtensionContext); }
    let scheduler = createScheduler(store);
    let triggerSystem = new TriggerSystem(pi, scheduler, store, (entry, origin) => onLoopFire(entry, undefined, origin), isDedicatedEventLoop);
    const pendingReadOnlyRetirements = new Set();
    function retireReadOnlyLoop(loopId) {
        triggerSystem.remove(loopId);
        try {
            store.delete(loopId);
            pendingReadOnlyRetirements.delete(loopId);
            widget.update();
        }
        catch (error) {
            pendingReadOnlyRetirements.add(loopId);
            try {
                store.pause(loopId, "administrative", READ_ONLY_RETIREMENT_PENDING_REASON);
            }
            catch { /* retry after settlement */ }
            debug("read-only loop retirement failed", loopId, error);
        }
    }
    function retryReadOnlyRetirements() {
        for (const loopId of [...pendingReadOnlyRetirements])
            retireReadOnlyLoop(loopId);
    }
    function finalizeReadOnlyRetirements() {
        retryReadOnlyRetirements();
        pendingReadOnlyRetirements.clear();
    }
    function recoverReadOnlyRetirements() {
        for (const entry of store.list()) {
            if (entry.status === "paused" && (entry.pause?.reason === READ_ONLY_RETIREMENT_PENDING_REASON
                || entry.pause?.reason === READ_ONLY_DELIVERY_PENDING_REASON))
                retireReadOnlyLoop(entry.id);
        }
    }
    function pauseForReadOnlyGuard(entry, reason) {
        if (store.get(entry.id)?.status === "active") {
            store.pause(entry.id, "administrative", `Read-only guard unavailable: ${reason}`);
            triggerSystem.remove(entry.id);
            widget.update();
        }
        latestCtx?.ui.notify(`Read-only loop #${entry.id} was paused because pi-ask could not enforce its tool restrictions.`, "error");
    }
    // Provider limit stand-down state (see the agent_end handler below).
    let providerLimitedUntil = 0;
    let providerLimitStreak = 0;
    let providerLimitFlushTimer;
    const notificationRuntime = createNotificationRuntime({
        pi,
        getHasPendingMessages: () => latestCtx?.hasPendingMessages() ?? false,
        // While limited, report "not idle" so every delivery path is requeued instead of producing a failing turn
        // each; the flush timer below resumes delivery after the limit.
        getIsIdle: () => (latestCtx?.isIdle() ?? true) && Date.now() >= providerLimitedUntil,
        getMonitor: (monitorId) => monitorManager.get(monitorId),
        getLoop: (loopId) => store.get(loopId),
        onReadOnlyGuardUnavailable: (notification, reason) => {
            const entry = store.get(notification.loopId);
            if (!entry)
                return;
            if (!notification.recurring || notification.fireLimitReached)
                retireReadOnlyLoop(notification.loopId);
            else
                pauseForReadOnlyGuard(entry, reason);
        },
        onReadOnlyNotificationDelivered: (notification) => {
            if (notification.recurring && !notification.fireLimitReached)
                return;
            retireReadOnlyLoop(notification.loopId);
        },
        onReadOnlyTerminalNotificationDiscarded: (notification) => retireReadOnlyLoop(notification.loopId),
        debug,
    });
    const monitorOnDoneRuntime = createMonitorOnDoneRuntime({ monitorManager, getLoop: (id) => store.get(id), deleteLoop: (id) => { store.delete(id); }, onLoopFire, isContextCurrent: isCurrentExtensionContext, debug });
    const dismissLoopNotifications = (loopId) => notificationRuntime.discardLoop(loopId);
    registerMonitorsCommand({
        pi, getStore: () => store, getMonitorManager: () => monitorManager, getTriggerSystem: () => triggerSystem, updateWidget: () => widget.update(),
        onDynamicLoopActivated: onLoopFire,
        onLoopStopped: dismissLoopNotifications,
        onMonitorStopping: (monitorId) => notificationRuntime.discardMonitorSignals(monitorId),
    });
    function emitLoopFire(entry, monitor) {
        const event = { loopId: entry.id, prompt: entry.prompt, trigger: entry.trigger, timestamp: Date.now(), readOnly: entry.readOnly, recurring: entry.recurring, persistent: entry.recurring, dynamic: entry.dynamic, fireLimitReached: atMaxFires(entry), sessionGeneration, monitorOutcome: monitor ? { monitorId: monitor.id, status: monitor.status, exitCode: monitor.exitCode, stopReason: monitor.stopReason, reportedOutcome: monitor.reportedOutcome, outputLines: monitor.outputLines } : undefined };
        void notificationRuntime.queueOrDeliverNotification(event)
            .catch((error) => debug("loop notification delivery failed", entry.id, error));
        pi.events.emit("loop:fire", structuredClone(event));
    }
    // Provider limit stand-down: while the model provider reports a usage limit, recurring wakes cannot
    // succeed. They are skipped (not counted as fires) until the reset time or an exponential backoff
    // (5 min doubling to 1 h) has passed, instead of failing every 2 minutes for hours.
    pi.on("agent_end", (event) => {
        const messages = Array.isArray(event?.messages) ? event.messages : [];
        let last;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            if (messages[index]?.role === "assistant") {
                last = messages[index];
                break;
            }
        }
        const text = last?.stopReason === "error" && typeof last.errorMessage === "string" ? last.errorMessage : "";
        if (!/usage[ _-]?limit|rate[ _-]?limit|quota|too many requests|\b429\b|overloaded/i.test(text)) {
            if (last?.stopReason !== "error") {
                providerLimitStreak = 0;
                providerLimitedUntil = 0;
            }
            return;
        }
        providerLimitStreak += 1;
        const hint = /resets?\s+in\s+(?:~\s*)?(\d+(?:\.\d+)?)\s*(h|m)(?![a-z])/i.exec(text);
        const hinted = hint ? Number.parseFloat(hint[1]) * (hint[2].toLowerCase() === "h" ? 3_600_000 : 60_000) : 0;
        const backoff = Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.min(providerLimitStreak - 1, 10));
        providerLimitedUntil = Date.now() + Math.min(Math.max(hinted, backoff), 12 * 3_600_000);
        clearTimeout(providerLimitFlushTimer);
        providerLimitFlushTimer = setTimeout(() => { void notificationRuntime.flushPendingNotifications().catch((error) => debug("provider-limit flush failed", error)); }, providerLimitedUntil - Date.now() + 1000);
        providerLimitFlushTimer.unref?.();
    });
    function onLoopFire(entry, monitor, origin = monitor ? "monitor" : "dynamic") {
        if (!isCurrentExtensionContext())
            return;
        if (Date.now() < providerLimitedUntil && entry.recurring !== false)
            return;
        const current = store.get(entry.id);
        if (current?.status !== "active") {
            triggerSystem.remove(entry.id);
            return;
        }
        if (current.readOnly && !isReadOnlyWakeGuardAvailable(pi)) {
            pauseForReadOnlyGuard(current, "pi-ask guard unavailable");
            return;
        }
        if (atMaxFires(current)) {
            triggerSystem.remove(current.id);
            store.delete(current.id);
            widget.update();
            return;
        }
        const fired = store.fire(current.id, origin);
        if (!fired)
            return;
        const firedAt = Date.now();
        const updated = fired.trigger.type === "dynamic" ? store.updateDynamic(fired.id, { dynamic: { awaitingUpdate: true, nextWakeAt: undefined, lastUpdatedAt: firedAt } }) ?? fired : fired;
        const delivered = { ...updated, prompt: entry.prompt };
        if (atMaxFires(delivered) && !delivered.readOnly) {
            triggerSystem.remove(delivered.id);
            store.delete(delivered.id);
            widget.update();
        }
        else if (delivered.readOnly && (!delivered.recurring || atMaxFires(delivered))) {
            triggerSystem.remove(delivered.id);
            try {
                store.pause(delivered.id, "administrative", READ_ONLY_DELIVERY_PENDING_REASON);
            }
            catch (error) {
                debug("terminal read-only delivery marker failed", delivered.id, error);
                retireReadOnlyLoop(delivered.id);
                latestCtx?.ui.notify(`Read-only loop #${delivered.id} could not be safely delivered and was retired.`, "error");
                return;
            }
        }
        emitLoopFire(delivered, monitor);
    }
    registerSessionRuntimeHooks({
        pi, getSessionGeneration: () => sessionGeneration, advanceSessionGeneration: () => ++sessionGeneration,
        recreateSessionStore: (sessionId) => { dedicatedMonitorSignalLoops.clear(); store = new LoopStore(resolveLoopStorePath(sessionId)); widget.setStore(store); scheduler = createScheduler(store); triggerSystem = new TriggerSystem(pi, scheduler, store, (entry, origin) => onLoopFire(entry, undefined, origin), isDedicatedEventLoop); },
        getStore: () => store, getScheduler: () => scheduler, getTriggerSystem: () => triggerSystem,
        setLatestCtx: (ctx) => { latestCtx = ctx; }, setSessionId: () => { }, widget, notificationRuntime,
        flushPendingNotifications: notificationRuntime.flushPendingNotifications, retryReadOnlyRetirements, finalizeReadOnlyRetirements, recoverReadOnlyRetirements, shutdownMonitors: () => monitorManager.shutdown(), isContextCurrent: isCurrentExtensionContext,
        emitLoopExpired: (entry, disposition, reason, generation) => emitExpired(entry, disposition, "session_recovery", reason, generation),
    });
    // The MonitorCreate result already reports the start; a wake for it only made the model call MonitorList.
    pi.events.on("monitor:finished", (event) => { const id = event.monitorId; if (!id)
        return; notificationRuntime.discardMonitorStarted(id); notificationRuntime.discardMonitorSignals(id); });
    registerLoopTools({ pi, getStore: () => store, getTriggerSystem: () => triggerSystem, getScheduler: () => scheduler, getMonitorManager: () => monitorManager, updateWidget: () => widget.update(), isReadOnlyGuardAvailable: () => isReadOnlyWakeGuardAvailable(pi), onDynamicLoopActivated: onLoopFire, onLoopStopped: dismissLoopNotifications });
    registerMonitorTools({
        pi, getStore: () => store, getMonitorManager: () => monitorManager, updateWidget: () => widget.update(),
        handleMonitorDoneLoop: (doneLoop, monitorId) => monitorOnDoneRuntime.register(doneLoop, monitorId),
        handleMonitorSignalLoop: (signalLoop, monitorId) => {
            dedicatedMonitorSignalLoops.add(signalLoop.id);
            const generation = sessionGeneration;
            const unsubscribe = pi.events.on("monitor:signal", (event) => {
                const data = event;
                if (data.monitorId !== monitorId || generation !== sessionGeneration || !isCurrentExtensionContext())
                    return;
                const current = store.get(signalLoop.id);
                const monitor = monitorManager.get(monitorId);
                if (current?.status !== "active" || monitor?.status !== "running")
                    return;
                if (Date.now() >= current.expiresAt) {
                    const expired = store.expireEntry(current.id, Date.now());
                    dedicatedMonitorSignalLoops.delete(current.id);
                    if (expired)
                        emitExpired(expired.entry, expired.disposition, "scheduler", "expires_at");
                    unsubscribe();
                    return;
                }
                onLoopFire({ ...current, prompt: `${current.prompt}\nMonitor #${monitorId} signal (untrusted command output): ${JSON.stringify(data.outcome)}. The monitor remains subscribed; do not recreate it for this signal.` }, monitor);
            });
            monitorManager.onTerminal(monitorId, () => {
                unsubscribe();
                dedicatedMonitorSignalLoops.delete(signalLoop.id);
                if (generation === sessionGeneration && isCurrentExtensionContext()) {
                    store.delete(signalLoop.id);
                    notificationRuntime.discardLoop(signalLoop.id);
                    widget.update();
                }
            });
        },
        onMonitorStopping: (monitorId) => notificationRuntime.discardMonitorSignals(monitorId),
        onMonitorDismiss: (monitorId) => notificationRuntime.dismissMonitor(monitorId),
    });
    registerLoopCommand({ pi, getStore: () => store, getTriggerSystem: () => triggerSystem, updateWidget: () => widget.update(), onDynamicLoopActivated: onLoopFire, onLoopStopped: dismissLoopNotifications });
}
