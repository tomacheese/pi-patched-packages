import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DynamicLoopState, LoopEntry, Trigger } from "../types.js";
interface LoopStoreLike {
    list(): LoopEntry[];
    get(id: string): LoopEntry | undefined;
    create(trigger: Trigger, prompt: string, options: {
        recurring: boolean;
        readOnly?: boolean;
        maxFires?: number;
        dynamic?: Partial<DynamicLoopState>;
    }): LoopEntry;
    pause(id: string): LoopEntry | undefined;
    resume(id: string): LoopEntry | undefined;
    delete(id: string): boolean;
}
interface TriggerSystemLike {
    add(entry: LoopEntry): void;
    remove(id: string): void;
}
export interface LoopCommandOptions {
    pi: ExtensionAPI;
    getStore: () => LoopStoreLike;
    getTriggerSystem: () => TriggerSystemLike;
    updateWidget: () => void;
    onDynamicLoopActivated?: (entry: LoopEntry) => void;
    onLoopStopped?: (loopId: string) => void;
}
export declare function registerLoopCommand(options: LoopCommandOptions): void;
export {};
