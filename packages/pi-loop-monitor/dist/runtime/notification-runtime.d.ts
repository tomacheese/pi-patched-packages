import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type NotificationDeliveryGroup } from "../notification-reducer.js";
import type { DynamicLoopState, LoopEntry, MonitorEntry, MonitorOutcome, Trigger } from "../types.js";
import type { LoopExpiredPayload } from "./loop-events.js";
export interface LoopFireEvent {
    loopId: string;
    prompt: string;
    trigger: Trigger | string;
    timestamp: number;
    readOnly?: boolean;
    recurring?: boolean;
    persistent?: boolean;
    dynamic?: DynamicLoopState;
    fireLimitReached?: boolean;
    monitorOutcome?: MonitorOutcome;
    sessionGeneration?: number;
}
export interface PendingNotification extends LoopFireEvent {
    key: string;
    message: string;
    deliveryGroup?: NotificationDeliveryGroup;
    monitorId?: string;
    revision?: number;
    sourceEpoch?: number;
    changedAt?: number;
}
export interface MonitorStartedEvent {
    monitorId: string;
    command: string;
    description?: string;
    timestamp: number;
    sessionGeneration?: number;
}
export interface NotificationRuntimeOptions {
    pi: ExtensionAPI;
    getHasPendingMessages: () => boolean;
    getIsIdle: () => boolean;
    getMonitor: (monitorId: string) => MonitorEntry | undefined;
    getLoop: (loopId: string) => LoopEntry | undefined;
    onReadOnlyGuardUnavailable?: (notification: PendingNotification, reason: string) => void;
    onReadOnlyNotificationDelivered?: (notification: PendingNotification) => void;
    onReadOnlyTerminalNotificationDiscarded?: (notification: PendingNotification) => void;
    debug?: (...args: unknown[]) => void;
}
export interface NotificationRuntime {
    syncRuntimeState(options?: {
        agentRunning?: boolean;
        hasPendingMessages?: boolean;
    }): void;
    queueOrDeliverNotification(data: LoopFireEvent): Promise<void>;
    queueOrDeliverLoopExpired(data: LoopExpiredPayload & {
        sessionGeneration?: number;
    }): Promise<void>;
    queueOrDeliverMonitorStarted(data: MonitorStartedEvent): Promise<void>;
    discardMonitorStarted(monitorId: string): void;
    discardLoop(loopId: string): void;
    discardMonitorSignals(monitorId: string): void;
    dismissMonitor(monitorId: string): boolean;
    flushPendingNotifications(options?: {
        ignorePendingMessages?: boolean;
    }): Promise<void>;
    clear(reason: "session_shutdown" | "session_switch"): void;
}
export declare function createNotificationRuntime({ pi, getHasPendingMessages, getIsIdle, getMonitor, getLoop, onReadOnlyGuardUnavailable, onReadOnlyNotificationDelivered, onReadOnlyTerminalNotificationDiscarded, debug }: NotificationRuntimeOptions): NotificationRuntime;
