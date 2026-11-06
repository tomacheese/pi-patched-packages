export function isStaleExtensionContextError(error) {
    return error instanceof Error && error.message.includes("extension ctx is stale");
}
