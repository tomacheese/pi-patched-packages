const HEARTBEAT_MS = 30_000;
export function registerSessionRuntimeHooks(options) {
    const { pi, getSessionGeneration, advanceSessionGeneration, recreateSessionStore, getStore, getScheduler, getTriggerSystem, setLatestCtx, setSessionId, widget, notificationRuntime, flushPendingNotifications, retryReadOnlyRetirements, finalizeReadOnlyRetirements, recoverReadOnlyRetirements, shutdownMonitors, isContextCurrent, emitLoopExpired } = options;
    let storeUpgraded = false;
    let persistedShown = false;
    let heartbeatTimer;
    const current = (generation) => generation === getSessionGeneration();
    function ensureHeartbeat() {
        if (heartbeatTimer)
            return;
        heartbeatTimer = setInterval(() => {
            const generation = getSessionGeneration();
            if (!current(generation))
                return;
            try {
                getScheduler().pump(Date.now());
                widget.update();
            }
            catch {
                // A heartbeat is best-effort; turn boundaries will pump again.
            }
        }, HEARTBEAT_MS);
        heartbeatTimer.unref?.();
    }
    function stopHeartbeat() { if (heartbeatTimer)
        clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
    function upgrade(ctx) { if (!storeUpgraded)
        recreateSessionStore(ctx.sessionManager.getSessionId()); storeUpgraded = true; }
    async function showPersisted(generation = getSessionGeneration()) {
        if (!current(generation) || persistedShown || !isContextCurrent())
            return;
        persistedShown = true;
        const startedAt = Date.now();
        const store = getStore();
        for (const record of store.expireEntries(startedAt)) {
            if (!current(generation))
                return;
            emitLoopExpired(record.entry, record.disposition, record.reason, generation);
        }
        for (const record of store.expireEventLoopEntries(startedAt)) {
            if (!current(generation))
                return;
            emitLoopExpired(record.entry, record.disposition, record.reason, generation);
        }
        if (store.list().length > 0)
            getTriggerSystem().start();
        ensureHeartbeat();
    }
    async function prepare(ctx) { const generation = getSessionGeneration(); setLatestCtx(ctx); setSessionId(ctx.sessionManager.getSessionId()); widget.setUICtx(ctx.ui); upgrade(ctx); recoverReadOnlyRetirements(); ensureHeartbeat(); await showPersisted(generation); if (current(generation))
        widget.update(); }
    pi.on("session_start", async (_event, ctx) => prepare(ctx));
    pi.on("turn_start", async (_event, ctx) => { await prepare(ctx); getScheduler().pump(Date.now()); });
    pi.on("before_agent_start", async (_event, ctx) => prepare(ctx));
    pi.on("agent_start", async (_event, ctx) => { notificationRuntime.syncRuntimeState({ agentRunning: true, hasPendingMessages: ctx.hasPendingMessages() }); setLatestCtx(ctx); widget.setUICtx(ctx.ui); });
    pi.on("agent_end", async (_event, ctx) => { setLatestCtx(ctx); widget.setUICtx(ctx.ui); });
    pi.on("agent_settled", async (_event, ctx) => {
        const generation = getSessionGeneration();
        setLatestCtx(ctx);
        widget.setUICtx(ctx.ui);
        notificationRuntime.syncRuntimeState({ agentRunning: false, hasPendingMessages: ctx.hasPendingMessages() });
        await flushPendingNotifications({ ignorePendingMessages: true });
        if (current(generation))
            await flushPendingNotifications({ ignorePendingMessages: true });
        if (current(generation))
            retryReadOnlyRetirements();
        if (current(generation))
            getScheduler().pump(Date.now());
    });
    pi.on("session_shutdown", async () => { advanceSessionGeneration(); getTriggerSystem().stop(); stopHeartbeat(); notificationRuntime.clear("session_shutdown"); finalizeReadOnlyRetirements(); setSessionId(undefined); storeUpgraded = false; persistedShown = false; await shutdownMonitors(); });
    pi.on("session_switch", async (_event, ctx) => {
        const generation = advanceSessionGeneration();
        getTriggerSystem().stop();
        stopHeartbeat();
        notificationRuntime.clear("session_switch");
        finalizeReadOnlyRetirements();
        setSessionId(undefined);
        storeUpgraded = false;
        persistedShown = false;
        await shutdownMonitors();
        if (!current(generation))
            return;
        setLatestCtx(ctx);
        widget.setUICtx(ctx.ui);
        setSessionId(ctx.sessionManager.getSessionId());
        upgrade(ctx);
        recoverReadOnlyRetirements();
        await showPersisted(generation);
        if (current(generation))
            widget.update();
    });
}
