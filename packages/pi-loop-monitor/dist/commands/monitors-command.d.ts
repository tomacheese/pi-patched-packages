import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MonitorManager } from "../monitor-manager.js";
import type { LoopStore } from "../store.js";
import type { LoopEntry } from "../types.js";
interface TriggerSystemLike {
    add(entry: LoopEntry): void;
    remove(id: string): void;
}
export interface MonitorsCommandOptions {
    pi: ExtensionAPI;
    getStore: () => LoopStore;
    getMonitorManager: () => MonitorManager;
    getTriggerSystem: () => TriggerSystemLike;
    updateWidget: () => void;
    onDynamicLoopActivated?: (entry: LoopEntry) => void;
    onLoopStopped?: (loopId: string) => void;
    onMonitorStopping?: (monitorId: string) => void;
}
export declare function registerMonitorsCommand(options: MonitorsCommandOptions): void;
export {};
