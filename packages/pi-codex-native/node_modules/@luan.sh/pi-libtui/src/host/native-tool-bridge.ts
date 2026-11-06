import { InteractiveMode, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	type CodeModePresentation,
	type NativeToolRenderers,
	nativeOrchestrationRenderers,
	type PresentationHost,
} from "./codemode-presentation.ts";
import { historicalNestedPresentation, type NestedToolResults } from "./nested-tool-results.ts";

const PROTOCOL = "pi-libtui/native-tool-bridge/v2" as const;
const KEY = Symbol.for(PROTOCOL);
const OWNER = Symbol.for(`${PROTOCOL}/owner`);
interface PresentationOwner {
	readonly protocol: typeof PROTOCOL;
	refresh(): void;
}
interface Bridge {
	readonly protocol: typeof PROTOCOL;
	retain(): () => void;
	acquire(tui: TUI, nested: NestedToolResults, history: () => readonly SessionEntry[]): () => void;
}
// type-boundary: Pi 1.0's private interactive renderer lookup and cross-realm leases; isBridge/isRenderers narrow them here.
type NativeValue = unknown;
function isBridge(value: NativeValue): value is Bridge {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<Bridge>;
	return (
		candidate.protocol === PROTOCOL && typeof candidate.acquire === "function" && typeof candidate.retain === "function"
	);
}
function isOwner(value: NativeValue): value is PresentationOwner {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PresentationOwner>;
	return candidate.protocol === PROTOCOL && typeof candidate.refresh === "function";
}
function isRenderers(value: NativeValue): value is NativeToolRenderers {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<NativeToolRenderers>;
	return (
		(candidate.renderCall === undefined || typeof candidate.renderCall === "function") &&
		(candidate.renderResult === undefined || typeof candidate.renderResult === "function") &&
		(candidate.renderShell === undefined || candidate.renderShell === "self" || candidate.renderShell === "default")
	);
}

/** Replace this Pi 1.0 compatibility lease when Pi exposes an independent tool-renderer hook. */
export function installNativeToolBridge(
	tui: TUI,
	nested: NestedToolResults,
	history: () => readonly SessionEntry[],
): () => void {
	return ensureBridge()?.acquire(tui, nested, history) ?? (() => {});
}

/** Prepare before Pi restores history; session_start attaches the TUI afterwards. */
export function retainNativeToolBridge(): () => void {
	return ensureBridge()?.retain() ?? (() => {});
}

function ensureBridge(): Bridge | undefined {
	const prototype = InteractiveMode.prototype;
	const existing: NativeValue = Reflect.get(prototype, KEY);
	if (isBridge(existing)) return existing;
	const get: NativeValue = Reflect.get(prototype, "getRegisteredToolDefinition");
	if (typeof get !== "function") return undefined;
	const hosts = new WeakMap<
		object,
		{
			tui: TUI;
			nested: NestedToolResults;
			history: () => readonly SessionEntry[];
			views: Set<CodeModePresentation>;
			leases: number;
		}
	>();
	let leases = 0;
	const wrappedGet = function (this: InteractiveMode, name: string): NativeToolRenderers | undefined {
		const definition: NativeValue = Reflect.apply(get, this, [name]);
		const ui: NativeValue = Reflect.get(this, "ui");
		const host = ui && typeof ui === "object" ? hosts.get(ui) : undefined;
		const refresh: NativeValue = Reflect.get(this, "rebuildChatFromMessages");
		if (ui && typeof ui === "object" && typeof refresh === "function" && !isOwner(Reflect.get(ui, OWNER))) {
			// Keep the owner for the TUI lifetime: Pi rebuilds history before session_start on reload.
			const owner: PresentationOwner = { protocol: PROTOCOL, refresh: () => Reflect.apply(refresh, this, []) };
			Reflect.set(ui, OWNER, owner);
		}
		if (!host || (name !== "codemode" && name !== "tool_search") || !isRenderers(definition))
			return isRenderers(definition) ? definition : undefined;
		const presentation: PresentationHost = {
			tui: host.tui,
			nested: host.nested,
			history: (parent) => historicalNestedPresentation(host.history(), parent),
			definition: (toolName) => {
				const tool: NativeValue = Reflect.apply(get, this, [toolName]);
				return isRenderers(tool) ? tool : undefined;
			},
			track: (view) => host.views.add(view),
		};
		return { ...definition, ...nativeOrchestrationRenderers(name, presentation) };
	};
	const bridge: Bridge = {
		protocol: PROTOCOL,
		retain() {
			leases++;
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				if (--leases > 0) return;
				if (Reflect.get(prototype, "getRegisteredToolDefinition") === wrappedGet)
					Reflect.set(prototype, "getRegisteredToolDefinition", get);
				if (Reflect.get(prototype, KEY) === bridge) Reflect.deleteProperty(prototype, KEY);
			};
		},
		acquire(tui, nested, history) {
			let host = hosts.get(tui);
			if (!host) {
				host = { tui, nested, history, views: new Set(), leases: 0 };
				hosts.set(tui, host);
			}
			host.leases++;
			const release = bridge.retain();
			const owner: NativeValue = Reflect.get(tui, OWNER);
			if (isOwner(owner)) owner.refresh();
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				if (--host.leases === 0) {
					for (const view of host.views) view.dispose();
					hosts.delete(tui);
				}
				release();
			};
		},
	};
	Reflect.set(prototype, "getRegisteredToolDefinition", wrappedGet);
	Object.defineProperty(prototype, KEY, { configurable: true, value: bridge });
	return bridge;
}
