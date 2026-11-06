import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

export type PresentationJson =
	| null
	| boolean
	| number
	| string
	| readonly PresentationJson[]
	| { [key: string]: PresentationJson };
export interface NestedPresentation {
	id: string;
	name: string;
	args: { [key: string]: PresentationJson };
	status: "running" | "succeeded" | "failed" | "warning";
	result?: PresentationResult;
}
export interface PresentationResult {
	content: { type: "text"; text: string }[];
	details?: PresentationJson;
	isError: boolean;
}
export interface NestedPresentationSnapshot {
	version: 1;
	calls: NestedPresentation[];
	omitted: number;
}

const MAX_CALLS = 256;
// Bounded presentation metadata, including normalized output; raise only for larger tool-owned previews.
const MAX_RESULT_CHARACTERS = 256 * 1024;
const MAX_SNAPSHOT_CHARACTERS = 2 * 1024 * 1024;
// type-boundary: Pi's untyped execution events and persisted details; JSON validation narrows them immediately below.
type NativeValue = unknown;

function isJson(value: NativeValue): value is PresentationJson {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	return typeof value === "object" && Object.values(value).every(isJson);
}
export function jsonObject(value: NativeValue): value is { [key: string]: PresentationJson } {
	return value !== null && typeof value === "object" && !Array.isArray(value) && isJson(value);
}
function copyJson(value: NativeValue, maximum: number): PresentationJson | undefined {
	try {
		const encoded = JSON.stringify(value);
		if (!encoded || encoded.length > maximum) return undefined;
		const decoded: NativeValue = JSON.parse(encoded);
		return isJson(decoded) ? decoded : undefined;
	} catch {
		return undefined;
	}
}
function result(value: NativeValue, isError: boolean): PresentationResult | undefined {
	const copied = copyJson(value, MAX_RESULT_CHARACTERS);
	if (!jsonObject(copied) || !Array.isArray(copied.content)) return undefined;
	const content: PresentationResult["content"] = [];
	for (const block of copied.content) {
		if (jsonObject(block) && block.type === "text" && typeof block.text === "string")
			content.push({ type: "text", text: block.text });
	}
	return { content, ...(copied.details !== undefined ? { details: copied.details } : {}), isError };
}

export function readNestedPresentation(value: NativeValue): NestedPresentationSnapshot | undefined {
	if (
		!jsonObject(value) ||
		value.version !== 1 ||
		!Array.isArray(value.calls) ||
		typeof value.omitted !== "number" ||
		!Number.isSafeInteger(value.omitted) ||
		value.omitted < 0
	)
		return undefined;
	const calls: NestedPresentation[] = [];
	for (const call of value.calls) {
		if (
			!jsonObject(call) ||
			typeof call.id !== "string" ||
			typeof call.name !== "string" ||
			!jsonObject(call.args) ||
			(call.status !== "running" &&
				call.status !== "succeeded" &&
				call.status !== "failed" &&
				call.status !== "warning")
		)
			return undefined;
		const saved = call.result === undefined ? undefined : result(call.result, call.status === "failed");
		if (call.result !== undefined && !saved) return undefined;
		calls.push({
			id: call.id,
			name: call.name,
			args: call.args,
			status: call.status,
			...(saved ? { result: saved } : {}),
		});
	}
	return { version: 1, calls, omitted: value.omitted };
}

export function historicalNestedPresentation(
	entries: readonly SessionEntry[],
	parent: string,
): NestedPresentationSnapshot | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolCallId !== parent)
			continue;
		const saved = entry.message.nestedCalls;
		if (!saved) return undefined;
		return {
			version: 1,
			omitted: 0,
			calls: saved.calls.map((call) => ({
				id: call.id,
				name: call.name,
				args: call.arguments ?? {},
				status: call.status === "ok" ? "succeeded" : call.status === "error" ? "failed" : "warning",
			})),
		};
	}
	return undefined;
}

/** Presentation only: Pi remains responsible for nested execution, validation and policy. */
export class NestedToolResults {
	private readonly parents = new Map<string, { calls: Map<string, NestedPresentation>; omitted: number }>();
	private readonly listeners = new Map<string, Set<() => void>>();
	clear(): void {
		this.parents.clear();
	}
	watch(parent: string, listener: () => void): () => void {
		let listeners = this.listeners.get(parent);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(parent, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.listeners.delete(parent);
		};
	}
	private changed(parent: string): void {
		for (const listener of [...(this.listeners.get(parent) ?? [])]) listener();
	}

	get(parent: string): NestedPresentationSnapshot | undefined {
		const captured = this.parents.get(parent);
		if (!captured) return undefined;
		const snapshot: NestedPresentationSnapshot = { version: 1, calls: [], omitted: captured.omitted };
		let characters = 0;
		for (const call of captured.calls.values()) {
			const size = JSON.stringify(call).length;
			if (characters + size > MAX_SNAPSHOT_CHARACTERS) {
				snapshot.omitted++;
				continue;
			}
			snapshot.calls.push(call);
			characters += size;
		}
		return snapshot;
	}

	register(pi: ExtensionAPI): void {
		pi.on("tool_execution_start", (event) => {
			if (!event.parentToolCallId) return;
			let captured = this.parents.get(event.parentToolCallId);
			if (!captured) {
				captured = { calls: new Map(), omitted: 0 };
				this.parents.set(event.parentToolCallId, captured);
			}
			if (captured.calls.size >= MAX_CALLS) {
				captured.omitted++;
				return;
			}
			const args = copyJson(event.args, 8 * 1024);
			captured.calls.set(event.toolCallId, {
				id: event.toolCallId,
				name: event.toolName,
				args: jsonObject(args) ? args : {},
				status: "running",
			});
			this.changed(event.parentToolCallId);
		});
		pi.on("tool_execution_update", (event) => {
			const call = event.parentToolCallId && this.parents.get(event.parentToolCallId)?.calls.get(event.toolCallId);
			if (call) {
				call.result = result(event.partialResult, false);
				this.changed(event.parentToolCallId!);
			}
		});
		pi.on("tool_execution_end", (event) => {
			const call = event.parentToolCallId && this.parents.get(event.parentToolCallId)?.calls.get(event.toolCallId);
			if (!call) return;
			call.status = event.isError ? "failed" : "succeeded";
			call.result = result(event.result, event.isError);
			this.changed(event.parentToolCallId!);
		});
		pi.on("tool_result", (event) => {
			if (event.parentToolCallId) return;
			const snapshot = this.get(event.toolCallId);
			this.parents.delete(event.toolCallId);
			if (event.toolName !== "codemode" || !snapshot || !jsonObject(event.details)) return;
			return { details: { ...event.details, libtuiNestedCalls: snapshot } };
		});
		pi.on("agent_settled", () => this.clear());
	}
}
