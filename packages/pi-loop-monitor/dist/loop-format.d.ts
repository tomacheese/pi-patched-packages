import type { Trigger } from "./types.js";
export type TriggerFormatStyle = "command" | "create" | "list" | "notification";
export declare function formatTrigger(trigger: Trigger | string, style?: TriggerFormatStyle): string;
