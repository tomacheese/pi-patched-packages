import type { ReducerEffect, ReducerEvent } from "./coordinator.js";
import type { MonitorEntry } from "./types.js";
export type MonitorCompletionEvent = ReducerEvent<"MONITOR_ONDONE_TRIGGERED", {
    loopId: string;
    monitorId: string;
    monitor?: MonitorEntry;
}>;
export type MonitorCompletionEffect = ReducerEffect<"DELIVER_MONITOR_ONDONE_WAKE", {
    loopId: string;
    monitorId: string;
    monitor?: MonitorEntry;
}>;
export declare function reduceMonitorCompletionEvent(event: MonitorCompletionEvent): MonitorCompletionEffect[];
