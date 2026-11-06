import type { DynamicLoopState, MonitorOutcome } from "./types.js";
type ReducerSource = "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
export type NotificationDeliveryGroup = "monitor-state" | "monitor-terminal" | "monitor-started" | "loop-expiry";
export interface ReducerNotification {
    key: string;
    loopId: string;
    message: string;
    timestamp: number;
    trigger: unknown;
    recurring?: boolean;
    persistent?: boolean;
    readOnly?: boolean;
    dynamic?: DynamicLoopState;
    monitorOutcome?: MonitorOutcome;
    fireLimitReached?: boolean;
    sessionGeneration?: number;
    deliveryGroup?: NotificationDeliveryGroup;
    monitorId?: string;
    revision?: number;
    sourceEpoch?: number;
    changedAt?: number;
}
export interface NotificationReducerState {
    notificationsByKey: Record<string, ReducerNotification>;
    agentRunning: boolean;
    hasPendingMessages: boolean;
}
export type NotificationReducerEvent = {
    type: "NOTIFICATION_QUEUED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: {
        notification: ReducerNotification;
    };
} | {
    type: "NOTIFICATION_DROPPED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: {
        key: string;
        reason: "session_switch" | "session_shutdown" | "superseded";
    };
} | {
    type: "NOTIFICATION_CLEARED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: {
        reason: "session_switch" | "session_shutdown";
    };
} | {
    type: "NOTIFICATION_FLUSH_REQUESTED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: {
        ignorePendingMessages?: boolean;
    };
} | {
    type: "NOTIFICATION_RUNTIME_UPDATED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: {
        agentRunning: boolean;
        hasPendingMessages: boolean;
    };
};
export type NotificationReducerEffect = {
    type: "REQUEST_NOTIFICATION_FLUSH";
    payload: Record<string, never>;
} | {
    type: "DELIVER_NOTIFICATION";
    entityType: "notification";
    entityId: string;
    payload: {
        notification: ReducerNotification;
    };
} | {
    type: "DELIVER_NOTIFICATION_DIGEST";
    entityType: "notification";
    entityId: string;
    payload: {
        notifications: ReducerNotification[];
    };
};
export interface NotificationReduceResult {
    state: NotificationReducerState;
    effects: NotificationReducerEffect[];
}
export declare function reduceNotificationState(state: NotificationReducerState, event: NotificationReducerEvent): NotificationReduceResult;
export {};
