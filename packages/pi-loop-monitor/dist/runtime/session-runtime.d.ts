import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LoopStore } from "../store.js";
import type { LoopEntry, LoopExpiryDisposition, LoopExpiryReason } from "../types.js";
import type { NotificationRuntime } from "./notification-runtime.js";
export interface SessionRuntimeOptions {
    pi: ExtensionAPI;
    getSessionGeneration: () => number;
    advanceSessionGeneration: () => number;
    recreateSessionStore: (sessionId: string) => void;
    getStore: () => LoopStore;
    getScheduler: () => {
        pump(now: number): void;
    };
    getTriggerSystem: () => {
        start(): void;
        stop(): void;
    };
    setLatestCtx: (ctx: ExtensionContext) => void;
    setSessionId: (sessionId: string | undefined) => void;
    widget: {
        setUICtx(ui: ExtensionContext["ui"]): void;
        update(): void;
    };
    notificationRuntime: NotificationRuntime;
    flushPendingNotifications: (options?: {
        ignorePendingMessages?: boolean;
    }) => Promise<void>;
    retryReadOnlyRetirements: () => void;
    finalizeReadOnlyRetirements: () => void;
    recoverReadOnlyRetirements: () => void;
    shutdownMonitors: () => Promise<void>;
    isContextCurrent: () => boolean;
    emitLoopExpired: (entry: LoopEntry, disposition: LoopExpiryDisposition, reason: LoopExpiryReason, generation: number) => void;
}
export declare function registerSessionRuntimeHooks(options: SessionRuntimeOptions): void;
