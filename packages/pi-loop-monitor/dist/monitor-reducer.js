function cloneState(state) {
    return {
        nextId: state.nextId,
        monitorsById: { ...state.monitorsById },
    };
}
export function reduceMonitorState(state, event) {
    if (event.type === "MONITOR_CREATED") {
        const next = cloneState(state);
        const id = String(next.nextId++);
        const monitor = {
            id,
            command: event.payload.command,
            description: event.payload.description,
            timeout: event.payload.timeout,
            status: "running",
            startedAt: event.at,
            outputLines: 0,
            outputBuffer: [],
        };
        next.monitorsById[id] = monitor;
        return {
            state: next,
            effects: [{ type: "PERSIST_MONITOR", entityType: "monitor", entityId: id, payload: { monitor } }],
        };
    }
    const id = event.payload.id;
    const current = state.monitorsById[id];
    if (!current)
        return { state, effects: [] };
    if (event.type === "MONITOR_PRUNED") {
        const next = cloneState(state);
        delete next.monitorsById[id];
        return {
            state: next,
            effects: [{ type: "DELETE_MONITOR", entityType: "monitor", entityId: id, payload: { id } }],
        };
    }
    const next = cloneState(state);
    const monitor = { ...current };
    if (event.type === "MONITOR_OUTPUT") {
        monitor.outputLines += event.payload.lines.length;
        monitor.outputBuffer = [...monitor.outputBuffer, ...event.payload.lines].slice(-200);
        monitor.lastOutputAt = event.at;
        monitor.outputRatePerMinute = event.payload.ratePerMinute;
    }
    if (event.type === "MONITOR_OUTCOME_REPORTED") {
        monitor.reportedOutcome = event.payload.outcome;
    }
    if (event.type === "MONITOR_PROGRESS_UPDATED") {
        monitor.progress = {
            ...monitor.progress,
            ...withoutUndefined(event.payload.progress),
            source: event.payload.progress.source,
            updatedAt: event.at,
        };
    }
    function withoutUndefined(value) {
        return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
    }
    if (event.type === "MONITOR_COMPLETED") {
        monitor.status = "completed";
        monitor.exitCode = event.payload.exitCode;
        monitor.completedAt = event.at;
    }
    if (event.type === "MONITOR_ERRORED") {
        monitor.status = "error";
        if (event.payload.exitCode !== undefined)
            monitor.exitCode = event.payload.exitCode;
        monitor.completedAt = event.at;
    }
    if (event.type === "MONITOR_STOPPED") {
        monitor.status = "stopped";
        monitor.stopReason = event.payload.reason;
        monitor.completedAt = event.at;
    }
    if (event.type === "MONITOR_ONDONE_REGISTERED") {
        monitor.onDoneRegistered = true;
    }
    next.monitorsById[id] = monitor;
    return {
        state: next,
        effects: [{ type: "PERSIST_MONITOR", entityType: "monitor", entityId: id, payload: { monitor } }],
    };
}
