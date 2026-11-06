import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopFireEvent } from "./notification-runtime.js";
export interface ReadOnlyGuardAcquisition {
    ownerId?: string;
    acquisitionToken?: string;
    reason?: string;
}
export declare function getReadOnlyWakeGuardStatus(pi: ExtensionAPI): {
    available: boolean;
    active: boolean;
};
export declare function isReadOnlyWakeGuardAvailable(pi: ExtensionAPI): boolean;
export declare function acquireReadOnlyWakeGuard(pi: ExtensionAPI, notification: LoopFireEvent & {
    key: string;
}): ReadOnlyGuardAcquisition;
export declare function releaseReadOnlyWakeGuard(pi: ExtensionAPI, ownerId: string, acquisitionToken: string): boolean;
