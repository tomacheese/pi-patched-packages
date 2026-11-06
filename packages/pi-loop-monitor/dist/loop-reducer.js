export const MAX_LOOP_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
export function atMaxFires(loop) {
    return !!loop.maxFires && (loop.fireCount ?? 0) >= loop.maxFires;
}
function cloneState(state) { return { nextId: state.nextId, loopsById: { ...state.loopsById } }; }
export function reduceLoopState(state, event) {
    if (event.type === "LOOP_CREATED") {
        const next = cloneState(state);
        const id = String(next.nextId++);
        const loop = {
            id, prompt: event.payload.prompt, trigger: event.payload.trigger, status: "active",
            recurring: event.payload.recurring, createdAt: event.at, updatedAt: event.at,
            expiresAt: event.at + MAX_LOOP_EXPIRY_MS, readOnly: event.payload.readOnly,
            maxFires: event.payload.maxFires, fireCount: 0,
            dynamic: event.payload.trigger.type === "dynamic" || event.payload.dynamic ? {
                goal: event.payload.dynamic?.goal ?? event.payload.prompt,
                state: event.payload.dynamic?.state, metrics: event.payload.dynamic?.metrics,
                doneCriteria: event.payload.dynamic?.doneCriteria, iteration: event.payload.dynamic?.iteration ?? 0,
                nextWakeAt: event.payload.dynamic?.nextWakeAt,
                awaitingUpdate: event.payload.dynamic?.awaitingUpdate ?? false,
                lastUpdatedAt: event.payload.dynamic?.lastUpdatedAt ?? event.at,
            } : undefined,
        };
        next.loopsById[id] = loop;
        return { state: next, effects: [{ type: "PERSIST_LOOP", entityType: "loop", entityId: id, payload: { loop } }] };
    }
    const id = event.payload.id;
    const current = state.loopsById[id];
    if (!current)
        return { state, effects: [] };
    if (["LOOP_DELETED", "LOOP_MAX_FIRES_REACHED", "LOOP_EXPIRED"].includes(event.type)) {
        const next = cloneState(state);
        delete next.loopsById[id];
        return { state: next, effects: [{ type: "DELETE_LOOP", entityType: "loop", entityId: id, payload: { id } }] };
    }
    const next = cloneState(state);
    const loop = { ...current };
    if (event.type === "LOOP_PAUSED") {
        loop.status = "paused";
        loop.pause = { kind: event.payload.kind, at: event.at, ...(event.payload.reason ? { reason: event.payload.reason } : {}) };
        loop.updatedAt = event.at;
    }
    if (event.type === "LOOP_RESUMED") {
        loop.status = "active";
        loop.pause = undefined;
        loop.updatedAt = event.at;
    }
    if (event.type === "LOOP_FIRED") {
        loop.fireCount = (loop.fireCount ?? 0) + 1;
        loop.updatedAt = event.at;
    }
    if (event.type === "LOOP_DYNAMIC_UPDATED") {
        loop.prompt = event.payload.prompt ?? loop.prompt;
        loop.dynamic = {
            goal: event.payload.dynamic.goal ?? loop.dynamic?.goal ?? loop.prompt,
            state: event.payload.dynamic.state ?? loop.dynamic?.state,
            metrics: event.payload.dynamic.metrics ?? loop.dynamic?.metrics,
            doneCriteria: event.payload.dynamic.doneCriteria ?? loop.dynamic?.doneCriteria,
            iteration: event.payload.dynamic.iteration ?? loop.dynamic?.iteration ?? 0,
            nextWakeAt: "nextWakeAt" in event.payload.dynamic ? event.payload.dynamic.nextWakeAt : loop.dynamic?.nextWakeAt,
            awaitingUpdate: event.payload.dynamic.awaitingUpdate ?? loop.dynamic?.awaitingUpdate ?? false,
            lastUpdatedAt: event.payload.dynamic.lastUpdatedAt ?? event.at,
        };
        loop.updatedAt = event.at;
    }
    next.loopsById[id] = loop;
    return { state: next, effects: [{ type: "PERSIST_LOOP", entityType: "loop", entityId: id, payload: { loop } }] };
}
