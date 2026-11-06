import type { LoopStore } from "./store.js";
import type { LoopEntry, LoopExpiryDisposition, LoopFireOrigin } from "./types.js";
export declare class CronScheduler {
    private store;
    private onFire;
    private onExpired?;
    private canExpire;
    private fireTimes;
    private expiryTimes;
    constructor(store: LoopStore, onFire: (entry: LoopEntry, origin: LoopFireOrigin) => void, onExpired?: ((entry: LoopEntry, disposition: LoopExpiryDisposition) => void) | undefined, canExpire?: () => boolean);
    start(): void;
    stop(): void;
    add(entry: LoopEntry): void;
    expire(entry: LoopEntry, now?: number): boolean;
    remove(id: string): void;
    nextFire(id: string): number | undefined;
    private retire;
    private retireExpired;
    private armTimer;
    pump(now: number, filter?: (entry: LoopEntry) => boolean): void;
}
