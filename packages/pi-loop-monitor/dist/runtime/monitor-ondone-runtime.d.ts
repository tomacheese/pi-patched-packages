import type { MonitorManager } from "../monitor-manager.js";
import type { LoopEntry, MonitorEntry } from "../types.js";
export interface MonitorOnDoneRuntimeOptions {
    monitorManager: MonitorManager;
    getLoop: (id: string) => LoopEntry | undefined;
    deleteLoop: (id: string) => void;
    onLoopFire: (entry: LoopEntry, monitor?: MonitorEntry) => void;
    isContextCurrent: () => boolean;
    debug?: (...args: unknown[]) => void;
}
export interface MonitorOnDoneRuntime {
    register(doneLoop: LoopEntry, monitorId: string): void;
}
export declare function createMonitorOnDoneRuntime(options: MonitorOnDoneRuntimeOptions): MonitorOnDoneRuntime;
