/**
 * Handoff generation and storage.
 *
 * The LLM call and the message serialiser (`serializeConversation`) are injected
 * by the caller so this module stays pure and unit testable, and so the
 * extension never ends up resolving a second copy of the pi package.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { isRecord, logDebug } from "./util.ts";
import { RESUME_COMMAND } from "./types.ts";
import type { PendingWait, PendingWaitFileV1, PluginConfig, Strategy } from "./types.ts";

export const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given the conversation history, generate a focused, self-contained handoff summary for a fresh session:

1. High-level goal and the user's most recent concrete request.
2. Key architectural decisions and approaches chosen.
3. Modified files (with exact paths) and the current status of each.
4. The exact interrupted point and clear, ordered next steps.

Rules:
- Output clean Markdown only, no conversational filler.
- Preserve exact file paths, command lines and identifiers.
- If something is uncertain, say so explicitly instead of guessing.
- Keep it under 800 words.`;

const GOAL_LIMIT = 2_000;
const STATE_LIMIT = 4_000;

export interface BranchFiles {
	read: string[];
	modified: string[];
}

function isTextBlock(block: unknown): block is { type: string; text: string } {
	return isRecord(block) && block["type"] === "text" && typeof block["text"] === "string";
}

/** Flatten message content (string or block array) into plain text. */
export function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextBlock)
		.map((block) => block.text)
		.join("\n");
}

export function truncateMiddle(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = Math.floor(limit * 0.4);
	const tail = limit - head;
	return `${text.slice(0, head)}\n\n[... ${text.length - limit} characters omitted ...]\n\n${text.slice(text.length - tail)}`;
}

interface ToolCallBlock {
	name: string;
	path: string;
}

function extractToolCalls(branch: SessionEntry[]): ToolCallBlock[] {
	const calls: ToolCallBlock[] = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message as unknown;
		if (!isRecord(message) || message["role"] !== "assistant") continue;
		const content = message["content"];
		if (!Array.isArray(content)) continue;

		for (const block of content) {
			if (!isRecord(block) || block["type"] !== "toolCall") continue;
			const name = block["name"];
			const args = block["arguments"];
			if (typeof name !== "string" || !isRecord(args)) continue;
			const path = args["path"];
			if (typeof path !== "string") continue;
			calls.push({ name, path });
		}
	}
	return calls;
}

/** Files touched by the branch, split into "written" and "only read". */
export function extractFilesFromBranch(branch: SessionEntry[]): BranchFiles {
	const read = new Set<string>();
	const modified = new Set<string>();

	for (const call of extractToolCalls(branch)) {
		if (call.name === "edit" || call.name === "write") modified.add(call.path);
		else if (call.name === "read") read.add(call.path);
	}

	return {
		read: [...read].filter((file) => !modified.has(file)).sort(),
		modified: [...modified].sort(),
	};
}

export interface BranchSummary {
	/** Text of the most recent user request (not the very first one). */
	goal: string;
	/** Text of the most recent assistant message. */
	lastThought: string;
	/** Number of user turns in the branch. */
	userTurns: number;
}

/**
 * Extract the current goal and last known state.
 *
 * Taking the *last* user message matters: in a long session the first user
 * message is hours old and describes a different sub-task than the one that was
 * interrupted.
 */
export function extractBranchSummary(branch: SessionEntry[]): BranchSummary {
	let goal = "";
	let lastThought = "";
	let userTurns = 0;

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message as unknown;
		if (!isRecord(message)) continue;
		const role = message["role"];

		if (role === "user") {
			const text = contentToText(message["content"]).trim();
			if (text.length === 0) continue;
			userTurns += 1;
			goal = text;
		} else if (role === "assistant") {
			const text = contentToText(message["content"]).trim();
			if (text.length > 0) lastThought = text;
		}
	}

	return { goal, lastThought, userTurns };
}

export interface FallbackHandoffOptions {
	previousHandoff?: string | null;
}

export function buildLocalFallbackHandoff(branch: SessionEntry[], options: FallbackHandoffOptions = {}): string {
	const { goal, lastThought, userTurns } = extractBranchSummary(branch);
	const { read, modified } = extractFilesFromBranch(branch);

	const sections: string[] = [
		"# Handoff Context (generated locally, no model call)",
		"",
		"> The quota was exhausted, so this handoff was assembled from session data",
		"> instead of by a model. Treat file lists below as authoritative and re-read",
		"> anything you are unsure about before editing.",
		"",
		"## Current Task (most recent user request)",
		goal ? truncateMiddle(goal, GOAL_LIMIT) : "Continue the previous development task.",
		"",
	];

	if (modified.length > 0) {
		sections.push("## Files Modified So Far", ...modified.map((file) => `- \`${file}\``), "");
	}
	if (read.length > 0) {
		sections.push("## Files Read (context)", ...read.map((file) => `- \`${file}\``), "");
	}
	if (modified.length === 0 && read.length === 0) {
		sections.push("## Files Touched", "_No file operations were recorded in this session._", "");
	}
	if (lastThought) {
		sections.push(
			"## Last Assistant State Before Interruption",
			truncateMiddle(lastThought, STATE_LIMIT),
			"",
		);
	}
	if (options.previousHandoff) {
		sections.push(
			"## Earlier Handoff Snapshot (may be stale)",
			truncateMiddle(options.previousHandoff, STATE_LIMIT),
			"",
		);
	}

	sections.push(
		"## Instructions For The New Session",
		`The previous session (${userTurns} user turn${userTurns === 1 ? "" : "s"}) was suspended because the model usage limit was reached.`,
		"This fresh session exists so that the provider KV cache does not have to be re-ingested.",
		"",
		"1. Re-read the files listed above to confirm their current state.",
		"2. Continue the current task from the interrupted point.",
		"Do not re-summarise the old conversation, and do not ask for context that is already listed above.",
	);

	return sections.join("\n");
}

/**
 * Cache key for a generated handoff. Includes the leaf id and branch length so
 * that new work invalidates a pre-generated handoff instead of resuming from a
 * stale snapshot.
 */
export function computeHandoffCacheKey(sessionId: string, leafId: string | null | undefined, branchLength: number): string {
	return `${sessionId}|${leafId ?? "-"}|${branchLength}`;
}

/** Keep only the trailing `maxTurns` user turns plus everything after them. */
export function trimToRecentTurns(branch: SessionEntry[], maxTurns: number): SessionEntry[] {
	if (maxTurns <= 0) return branch;
	let seen = 0;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (!entry || entry.type !== "message") continue;
		const message = entry.message as unknown;
		if (!isRecord(message) || message["role"] !== "user") continue;
		if (contentToText(message["content"]).trim().length === 0) continue;
		seen += 1;
		if (seen >= maxTurns) return branch.slice(index);
	}
	return branch;
}

/** Keep the tail of a serialized conversation, which is where the work is. */
export function truncateSerializedConversation(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	const tail = text.slice(text.length - maxChars);
	const firstBreak = tail.indexOf("\n\n");
	const cleaned = firstBreak > 0 && firstBreak < 2_000 ? tail.slice(firstBreak + 2) : tail;
	return {
		text: `[... ${text.length - maxChars} characters of earlier conversation omitted ...]\n\n${cleaned}`,
		truncated: true,
	};
}

export function handoffFileName(now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const suffix = Math.random().toString(36).slice(2, 6);
	return `handoff-${stamp}-${suffix}.md`;
}

/**
 * Resolve a handoff file name (never a path) inside the handoff directory.
 * Rejects traversal so `/auto-continue-resume ../../etc/passwd` is not a thing.
 */
export function resolveHandoffPath(name: string, dir: string): string | null {
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > 200) return null;
	if (!/^[A-Za-z0-9._-]+\.md$/.test(trimmed)) return null;
	if (trimmed.includes("..")) return null;
	return join(dir, trimmed);
}

export function writeHandoffFile(content: string, dir: string, name: string = handoffFileName()): string | null {
	try {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const path = resolveHandoffPath(name, dir);
		if (!path) return null;
		writeFileSync(path, content, "utf-8");
		return name;
	} catch (error) {
		logDebug(`writeHandoffFile failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

export function readHandoffFile(name: string, dir: string): string | null {
	try {
		const path = resolveHandoffPath(name, dir);
		if (!path || !existsSync(path)) return null;
		return readFileSync(path, "utf-8");
	} catch (error) {
		logDebug(`readHandoffFile failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

/** Delete old handoff files, keeping the newest `keep` entries. */
export function pruneHandoffs(dir: string, keep: number): number {
	try {
		if (!existsSync(dir) || keep <= 0) return 0;
		const files = readdirSync(dir)
			.filter((name) => /^handoff-.*\.md$/.test(name))
			.map((name) => {
				const path = join(dir, name);
				let mtime = 0;
				try {
					mtime = statSync(path).mtimeMs;
				} catch {
					mtime = 0;
				}
				return { name, path, mtime };
			})
			// Newest first; the name is timestamped, so it breaks ties when two files
			// share an mtime and keeps pruning deterministic.
			.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));

		let removed = 0;
		for (const file of files.slice(keep)) {
			try {
				unlinkSync(file.path);
				removed += 1;
			} catch {
				// Ignore: retention is best effort.
			}
		}
		return removed;
	} catch (error) {
		logDebug(`pruneHandoffs failed: ${error instanceof Error ? error.message : String(error)}`);
		return 0;
	}
}

/** The command the timer sends to resume a wait, resolved from a command context. */
export function buildResumeCommand(strategy: Strategy, handoffFile?: string, commandName: string = RESUME_COMMAND): string {
	if (strategy === "handoff" && handoffFile) return `/${commandName} ${handoffFile}`;
	return `/${commandName} --inplace`;
}

export function toPendingWaitFile(wait: PendingWait, now: Date = new Date()): PendingWaitFileV1 {
	return {
		version: 1,
		targetTimeIso: wait.targetTime.toISOString(),
		provider: wait.provider,
		strategy: wait.strategy,
		createdAtIso: now.toISOString(),
		...(wait.customPrompt !== undefined ? { customPrompt: wait.customPrompt } : {}),
		...(wait.handoffFile !== undefined ? { handoffFile: wait.handoffFile } : {}),
		...(wait.sessionFile !== undefined ? { sessionFile: wait.sessionFile } : {}),
	};
}

export function fromPendingWaitFile(raw: unknown): PendingWait | null {
	if (!isRecord(raw)) return null;
	if (raw["version"] !== 1) return null;
	const targetTimeIso = raw["targetTimeIso"];
	const provider = raw["provider"];
	const strategy = raw["strategy"];
	if (typeof targetTimeIso !== "string" || typeof provider !== "string") return null;
	if (strategy !== "handoff" && strategy !== "inplace") return null;

	const targetTime = new Date(targetTimeIso);
	if (Number.isNaN(targetTime.getTime())) return null;

	const readOptional = (key: string): string | undefined => {
		const value = raw[key];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	};

	const customPrompt = readOptional("customPrompt");
	const handoffFile = readOptional("handoffFile");
	const sessionFile = readOptional("sessionFile");

	return {
		targetTime,
		provider,
		strategy,
		...(customPrompt !== undefined ? { customPrompt } : {}),
		...(handoffFile !== undefined ? { handoffFile } : {}),
		...(sessionFile !== undefined ? { sessionFile } : {}),
	};
}

export interface HandoffCache {
	/** Cache key of `content`. */
	key: string | null;
	/** Last produced handoff (model or local). */
	content: string | null;
	/** Last model-produced handoff, used as a stale-but-useful fallback section. */
	modelContent: string | null;
	/** File name the cached content was written to, so a cache hit can still resume via handoff. */
	file: string | null;
	/** How the cached content was produced, so callers can warn about a local fallback. */
	generatedBy: "model" | "local" | null;
}

export function createHandoffCache(): HandoffCache {
	return { key: null, content: null, modelContent: null, file: null, generatedBy: null };
}

/**
 * Generate (or reuse) the handoff document.
 *
 * `callModel` receives the serialised conversation and returns the generated
 * text, or `null` when the call failed (quota exhausted, timeout, ...).
 */
export async function generateHandoffDocument(deps: {
	branch: SessionEntry[];
	sessionId: string;
	leafId: string | null | undefined;
	config: PluginConfig;
	cache: HandoffCache;
	goalOverride?: string;
	serialize: (branch: SessionEntry[]) => string;
	callModel: (systemPrompt: string, userText: string) => Promise<string | null>;
	writeFile: (content: string) => string | null;
}): Promise<{ content: string; file: string | null; fromCache: boolean; generatedBy: "model" | "local" }> {
	const key = computeHandoffCacheKey(deps.sessionId, deps.leafId, deps.branch.length);
	if (deps.cache.key === key && deps.cache.content) {
		// A cache hit must still hand back a file name. Returning `null` here made
		// `armWait` persist a handoff wait without a handoff file, which silently
		// degraded the resume to an in-place continuation of the old session.
		const file = deps.cache.file ?? deps.writeFile(deps.cache.content);
		deps.cache.file = file;
		return {
			content: deps.cache.content,
			file,
			fromCache: true,
			generatedBy: deps.cache.generatedBy ?? "model",
		};
	}

	const previous = deps.cache.modelContent;
	const { goal } = extractBranchSummary(deps.branch);
	const effectiveGoal = deps.goalOverride?.trim() || goal || "Continue the previous task";

	const recent = trimToRecentTurns(deps.branch, deps.config.handoffMaxTurns);
	const conversation = truncateSerializedConversation(deps.serialize(recent), deps.config.handoffMaxChars);
	const userText = [
		"## Conversation History (most recent turns)",
		"",
		conversation.text,
		"",
		"## Goal For The New Session",
		"",
		effectiveGoal,
	].join("\n");

	const modelText = await deps.callModel(HANDOFF_SYSTEM_PROMPT, userText);

	if (modelText && modelText.trim()) {
		const content = modelText.trim();
		const file = deps.writeFile(content);
		deps.cache.key = key;
		deps.cache.content = content;
		deps.cache.modelContent = content;
		deps.cache.file = file;
		deps.cache.generatedBy = "model";
		return { content, file, fromCache: false, generatedBy: "model" };
	}

	// Model generation failed; a locally assembled handoff with correct file
	// lists and the newest state beats reusing a stale snapshot.
	const local = buildLocalFallbackHandoff(deps.branch, { previousHandoff: previous });
	const file = deps.writeFile(local);
	deps.cache.key = key;
	deps.cache.content = local;
	deps.cache.file = file;
	deps.cache.generatedBy = "local";
	return { content: local, file, fromCache: false, generatedBy: "local" };
}
