import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopEntry, MonitorEntry, MonitorProgress, Trigger } from "../types.js";
interface MonitorManagerLike {
    list(): MonitorEntry[];
    get(id: string): MonitorEntry | undefined;
    create(command: string, description?: string, timeout?: number): MonitorEntry;
    stop(id: string): Promise<boolean>;
    updateProgress(id: string, progress: Omit<MonitorProgress, "source" | "updatedAt">): MonitorEntry | undefined;
}
interface LoopStoreLike {
    get(id: string): LoopEntry | undefined;
    create(trigger: Trigger, prompt: string, opts: {
        recurring: boolean;
        readOnly?: boolean;
        maxFires?: number;
    }): LoopEntry;
    delete(id: string): boolean;
}
export interface MonitorToolsOptions {
    pi: ExtensionAPI;
    getStore: () => LoopStoreLike;
    getMonitorManager: () => MonitorManagerLike;
    updateWidget: () => void;
    handleMonitorDoneLoop: (doneLoop: LoopEntry, monitorId: string) => void;
    handleMonitorSignalLoop: (signalLoop: LoopEntry, monitorId: string) => void;
    onMonitorStopping?: (monitorId: string) => void;
    onMonitorDismiss?: (monitorId: string) => boolean;
}
export declare function registerMonitorTools(options: MonitorToolsOptions): void;
export {};
