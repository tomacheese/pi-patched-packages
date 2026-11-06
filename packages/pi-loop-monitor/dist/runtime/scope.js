import { homedir } from "node:os";
import { join } from "node:path";
function resolveLoopsDir() {
    return join(homedir(), ".pi", "loops");
}
export function resolveLoopStorePath(sessionId) {
    if (!sessionId)
        return undefined;
    return join(resolveLoopsDir(), `loops-${sessionId}.json`);
}
