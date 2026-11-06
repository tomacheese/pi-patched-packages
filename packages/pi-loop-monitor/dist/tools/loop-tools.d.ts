import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopEntry, Trigger } from "../types.js";
interface LoopStoreLike {
    list(): LoopEntry[];
    get(id: string): LoopEntry | undefined;
    create(trigger: Trigger, prompt: string, opts: {
        recurring: boolean;
        readOnly?: boolean;
        maxFires?: number;
        dynamic?: Partial<NonNullable<LoopEntry["dynamic"]>>;
    }): LoopEntry;
    pause(id: string): LoopEntry | undefined;
    continueDynamic(id: string, fields: {
        prompt?: string;
        dynamic: Partial<NonNullable<LoopEntry["dynamic"]>>;
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
}
interface TriggerSystemLike {
    add(entry: LoopEntry): void;
    remove(id: string): void;
}
interface SchedulerLike {
    nextFire(id: string): number | undefined;
}
interface MonitorLike {
    id: string;
    status: string;
}
interface MonitorManagerLike {
    get(id: string): MonitorLike | undefined;
}
export interface LoopToolsOptions {
    pi: ExtensionAPI;
    getStore: () => LoopStoreLike;
    getTriggerSystem: () => TriggerSystemLike;
    getScheduler: () => SchedulerLike;
    getMonitorManager: () => MonitorManagerLike;
    updateWidget: () => void;
    isReadOnlyGuardAvailable: () => boolean;
    onDynamicLoopActivated?: (entry: LoopEntry) => void;
    onLoopStopped?: (loopId: string) => void;
}
export declare function registerLoopTools(options: LoopToolsOptions): void;
export {};
