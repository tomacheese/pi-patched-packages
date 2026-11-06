export function buildLoopExpiredPayload(entry, disposition, source, reason, expiredAt) {
    return { loopId: entry.id, prompt: entry.prompt, trigger: entry.trigger, recurring: entry.recurring, createdAt: entry.createdAt, expiresAt: entry.expiresAt, expiredAt, disposition, source, reason };
}
