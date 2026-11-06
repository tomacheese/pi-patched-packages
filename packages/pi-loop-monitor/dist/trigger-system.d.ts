import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CronScheduler } from "./scheduler.js";
import type { LoopStore } from "./store.js";
import type { LoopEntry, LoopFireOrigin } from "./types.js";
export declare class TriggerSystem {
    private pi;
    private scheduler;
    private store;
    private onFire;
    private isDedicatedEventLoop;
    private eventSubscriptions;
    private hybridTimers;
    private lastFireTime;
    constructor(pi: ExtensionAPI, scheduler: CronScheduler, store: LoopStore, onFire: (entry: LoopEntry, origin: LoopFireOrigin) => void, isDedicatedEventLoop?: (loopId: string) => boolean);
    start(): void;
    stop(): void;
    add(entry: LoopEntry): void;
    remove(id: string): void;
    private subscribeEvent;
    private handleHybridFire;
    private retire;
    private fireLoop;
    private matchesFilter;
}
