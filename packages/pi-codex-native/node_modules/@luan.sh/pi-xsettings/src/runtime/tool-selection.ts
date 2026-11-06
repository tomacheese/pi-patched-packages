import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Configuration owns the session's baseline; transcript navigation cannot remove it. */
export function applyConfiguredTools(pi: ExtensionAPI): void {
	const configured = SettingsManager.inMemory(pi.getSettings()).getDefaultTools() ?? [];
	const available = new Set(pi.getAllTools().map((tool) => tool.name));
	const active = new Set(pi.getActiveTools());
	const missing = configured.filter((name) => available.has(name) && !active.has(name));
	if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
}
