import type { CommandReportedOutcome, MonitorEntry, MonitorProgress } from "./types.js";
type ReducerSource = "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
export interface MonitorReducerEntry extends MonitorEntry {
    onDoneRegistered?: boolean;
}
export interface MonitorReducerState {
    nextId: number;
    monitorsById: Record<string, MonitorReducerEntry>;
}
export type MonitorReducerEvent = {
    type: "MONITOR_CREATED";
    at: number;
    source: ReducerSource;
    entityType?: "monitor";
    entityId?: string;
    payload: {
        command: string;
        description?: string;
        timeout: number;
    };
} | {
    type: "MONITOR_OUTPUT";
    at: number;
    source: ReducerSource;
    entityType?: "monitor";
    entityId?: string;
    payload: {
        id: string;
        lines: string[];
        ratePerMinute: number;
    };
} | {
    type: "MONITOR_COMPLETED" | "MONITOR_ERRORED";
    at: number;
    source: ReducerSource;
    entityType?: "monitor";
    entityId?: string;
    payload: {
        id: string;
        exitCode?: number;
        error?: string;
    };
} | {
    type: "MONITOR_OUTCOME_REPORTED";
    at: number;
    source: ReducerSource;
    entityType?: "monitor";
    entityId?: string;
    payload: {
        id: string;
        outcome: CommandReportedOutcome;
    };
} | {
    type: "MONITOR_PROGRESS_UPDATED";
    at: number;
    source: ReducerSource;
    entityType?: "monitor";
    entityId?: string;
    payload: {
        id: string;
        progress: Omit<MonitorProgress, "updatedAt">;
    };
} | {
    type: "MONITOR_STOPPED";
    at: number;
    source: ReducerSource;
    entityType?: "monitor";
    entityId?: string;
    payload: {
        id: string;
        reason: "manual" | "timeout";
    };
} | {
    type: "MONITOR_PRUNED" | "MONITOR_ONDONE_REGISTERED";
    at: number;
    source: ReducerSource;
    entityType?: "monitor";
    entityId?: string;
    payload: {
        id: string;
    };
};
export type MonitorReducerEffect = {
    type: "PERSIST_MONITOR";
    entityType: "monitor";
    entityId: string;
    payload: {
        monitor: MonitorReducerEntry;
    };
} | {
    type: "DELETE_MONITOR";
    entityType: "monitor";
    entityId: string;
    payload: {
        id: string;
    };
};
export interface MonitorReduceResult {
    state: MonitorReducerState;
    effects: MonitorReducerEffect[];
}
export declare function reduceMonitorState(state: MonitorReducerState, event: MonitorReducerEvent): MonitorReduceResult;
export {};
