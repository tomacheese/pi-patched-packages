import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const PI_ASK_GUARD_ACQUIRE_EVENT = "pi-ask:guard:acquire";
const PI_ASK_GUARD_RELEASE_EVENT = "pi-ask:guard:release";
const PI_ASK_GUARD_PROBE_EVENT = "pi-ask:guard:probe";
const READ_ONLY_TOOL_NAMES = [
    "read",
    "grep",
    "find",
    "ls",
    "web_search",
    "source_check",
    "fetch_content",
    "get_search_content",
];
const OWN_TOOL_NAMES = ["LoopList", "MonitorList"];
const OWN_EXTENSION_ENTRY_STEM = fileURLToPath(new URL("../index", import.meta.url));
function withoutTypeScriptOrJavaScriptExtension(path) {
    return path.replace(/\.(?:[cm]?[jt]s)$/, "");
}
export function getReadOnlyWakeGuardStatus(pi) {
    const request = {};
    pi.events.emit(PI_ASK_GUARD_PROBE_EVENT, request);
    return {
        available: request.available === true && request.protocolVersion === 1,
        active: request.active === true,
    };
}
export function isReadOnlyWakeGuardAvailable(pi) {
    return getReadOnlyWakeGuardStatus(pi).available;
}
export function acquireReadOnlyWakeGuard(pi, notification) {
    const ownerId = `pi-loop-monitor:${notification.key}`;
    const allowedTools = [...READ_ONLY_TOOL_NAMES];
    const configuredTools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
    const ownToolRule = (name, equals) => {
        const sourceInfo = configuredTools.get(name)?.sourceInfo;
        if (!sourceInfo || withoutTypeScriptOrJavaScriptExtension(resolve(sourceInfo.path)) !== OWN_EXTENSION_ENTRY_STEM) {
            return { name, ...(equals ? { equals } : {}), sourceInfo: { source: "pi-loop-monitor", path: OWN_EXTENSION_ENTRY_STEM } };
        }
        return { name, ...(equals ? { equals } : {}), sourceInfo: { source: sourceInfo.source, path: sourceInfo.path } };
    };
    allowedTools.push(...OWN_TOOL_NAMES.map((name) => ownToolRule(name)));
    if (notification.dynamic || (typeof notification.trigger !== "string" && notification.trigger.type === "dynamic")) {
        allowedTools.push(ownToolRule("LoopUpdate", { id: notification.loopId }));
    }
    const request = {
        ownerId,
        allowedTools,
        context: `[READ-ONLY LOOP #${notification.loopId}] Tool access is restricted for this wake. Do not attempt project changes or shell commands.`,
        startsRun: true,
    };
    pi.events.emit(PI_ASK_GUARD_ACQUIRE_EVENT, request);
    if (request.response?.status === "active"
        && request.response.ownerId === ownerId
        && request.response.acquisitionToken)
        return { ownerId, acquisitionToken: request.response.acquisitionToken };
    return { reason: request.response?.reason ?? "pi-ask guard unavailable" };
}
export function releaseReadOnlyWakeGuard(pi, ownerId, acquisitionToken) {
    const request = { ownerId, acquisitionToken };
    pi.events.emit(PI_ASK_GUARD_RELEASE_EVENT, request);
    return request.released === true;
}
