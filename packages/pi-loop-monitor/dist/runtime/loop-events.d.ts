import type { LoopEntry, LoopExpiryDisposition, LoopExpiryReason, LoopExpirySource } from "../types.js";
export interface LoopExpiredPayload {
    loopId: string;
    prompt: string;
    trigger: LoopEntry["trigger"];
    recurring: boolean;
    createdAt: number;
    expiresAt: number;
    expiredAt: number;
    disposition: LoopExpiryDisposition;
    source: LoopExpirySource;
    reason: LoopExpiryReason;
}
export declare function buildLoopExpiredPayload(entry: LoopEntry, disposition: LoopExpiryDisposition, source: LoopExpirySource, reason: LoopExpiryReason, expiredAt: number): LoopExpiredPayload;
