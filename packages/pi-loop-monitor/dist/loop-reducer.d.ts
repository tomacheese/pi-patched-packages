import type { DynamicLoopState, LoopEntry, LoopFireOrigin, LoopPauseKind, Trigger } from "./types.js";
export declare const MAX_LOOP_EXPIRY_MS: number;
export declare function atMaxFires(loop: Pick<LoopEntry, "maxFires" | "fireCount">): boolean;
type ReducerSource = "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
export interface LoopReducerState {
    nextId: number;
    loopsById: Record<string, LoopEntry>;
}
export type LoopReducerEvent = {
    type: "LOOP_CREATED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
        prompt: string;
        trigger: Trigger;
        recurring: boolean;
        readOnly?: boolean;
        maxFires?: number;
        dynamic?: Partial<DynamicLoopState>;
    };
} | {
    type: "LOOP_PAUSED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
        id: string;
        kind: LoopPauseKind;
        reason?: string;
    };
} | {
    type: "LOOP_RESUMED" | "LOOP_FIRED" | "LOOP_DELETED" | "LOOP_MAX_FIRES_REACHED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
        id: string;
        origin?: LoopFireOrigin;
    };
} | {
    type: "LOOP_EXPIRED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
        id: string;
        reason: "expires_at" | "resume_event_stale" | "already_completed_monitor";
    };
} | {
    type: "LOOP_DYNAMIC_UPDATED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
        id: string;
        prompt?: string;
        dynamic: Partial<DynamicLoopState>;
    };
};
export type LoopReducerEffect = {
    type: "PERSIST_LOOP";
    entityType: "loop";
    entityId: string;
    payload: {
        loop: LoopEntry;
    };
} | {
    type: "DELETE_LOOP";
    entityType: "loop";
    entityId: string;
    payload: {
        id: string;
    };
};
export interface LoopReduceResult {
    state: LoopReducerState;
    effects: LoopReducerEffect[];
}
export declare function reduceLoopState(state: LoopReducerState, event: LoopReducerEvent): LoopReduceResult;
export {};
