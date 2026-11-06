export function reduceMonitorCompletionEvent(event) {
    if (event.type !== "MONITOR_ONDONE_TRIGGERED")
        return [];
    return [{
            type: "DELIVER_MONITOR_ONDONE_WAKE",
            entityType: "monitor",
            entityId: event.payload.monitorId,
            payload: {
                loopId: event.payload.loopId,
                monitorId: event.payload.monitorId,
                monitor: event.payload.monitor,
            },
        }];
}
