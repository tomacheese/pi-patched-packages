import { type LoopReducerEffect, type LoopReducerEvent, type LoopReducerState } from "./loop-reducer.js";
import { ReducerBackedStore } from "./reducer-backed-store.js";
import type { DynamicLoopState, LoopEntry, LoopExpiryDisposition, LoopExpiryReason, LoopFireOrigin, LoopPauseKind, LoopStoreData, Trigger } from "./types.js";
export interface ExpiredLoopRecord {
    entry: LoopEntry;
    disposition: LoopExpiryDisposition;
    reason: LoopExpiryReason;
}
export declare class LoopStore extends ReducerBackedStore<LoopEntry, LoopReducerState, LoopReducerEvent, LoopStoreData, LoopReducerEffect> {
    constructor(listIdOrPath?: string);
    create(trigger: Trigger, prompt: string, opts: {
        recurring: boolean;
        readOnly?: boolean;
        maxFires?: number;
        dynamic?: Partial<DynamicLoopState>;
    }): LoopEntry;
    pause(id: string, kind?: LoopPauseKind, reason?: string): LoopEntry | undefined;
    resume(id: string): LoopEntry | undefined;
    fire(id: string, origin?: LoopFireOrigin): LoopEntry | undefined;
    updateDynamic(id: string, fields: {
        prompt?: string;
        dynamic: Partial<DynamicLoopState>;
    }): LoopEntry | undefined;
    continueDynamic(id: string, fields: {
        prompt?: string;
        dynamic: Partial<DynamicLoopState>;
    }, expected?: {
        status: LoopEntry["status"];
        iteration: number;
        updatedAt: number;
    }): LoopEntry | undefined;
    stopDynamic(id: string, status: "completed" | "paused", expected: {
        status: LoopEntry["status"];
        iteration: number;
        updatedAt: number;
    }): boolean;
    delete(id: string): boolean;
    expireEntry(id: string, now?: number): ExpiredLoopRecord | undefined;
    expireEntries(now?: number): ExpiredLoopRecord[];
    clearExpired(): number;
    expireEventLoopEntries(sessionStartedAt: number): ExpiredLoopRecord[];
    expireEventLoops(sessionStartedAt: number): number;
    clearAll(): number;
}
