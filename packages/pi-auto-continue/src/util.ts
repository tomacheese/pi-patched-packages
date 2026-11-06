/**
 * Side-effecting helpers: agent-dir discovery, safe atomic JSON/state IO,
 * a never-throwing file logger, and a stale-context-safe UI wrapper.
 *
 * The UI wrapper is the load-bearing piece for safety: `ctx` handed to event
 * handlers throws as soon as the session is replaced or extensions are
 * reloaded (`runner.assertActive()`), and an uncaught throw inside a
 * `setInterval`/`setTimeout` callback terminates the whole pi process.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { EXTENSION_NAME, STATUS_KEY } from "./types.ts";

const LOG_MAX_BYTES = 512 * 1024;

/** Config/state root. Honours `PI_CODING_AGENT_DIR` the same way pi does. */
export function getAgentDir(): string {
	const override = process.env["PI_CODING_AGENT_DIR"]?.trim();
	if (override && override.length > 0) return override;
	return join(homedir(), ".pi", "agent");
}

export function getStateDir(): string {
	return join(getAgentDir(), EXTENSION_NAME);
}

export function getHandoffDir(): string {
	return join(getStateDir(), "handoffs");
}

export function getConfigPath(): string {
	const override = process.env["PI_AUTO_CONTINUE_CONFIG"]?.trim();
	if (override && override.length > 0) return override;
	return join(getStateDir(), "config.json");
}

/** Session-scoped wait files. Without a session file, return the legacy path
 * for migration only; never write new waits to the shared legacy file. */
export function getPendingWaitPath(sessionFile?: string): string {
	if (!sessionFile) return join(getStateDir(), "pending-wait.json");
	const key = createHash("sha256").update(sessionFile).digest("hex");
	return join(getStateDir(), "pending-waits", `${key}.json`);
}

export function getLogPath(): string {
	return join(getStateDir(), "debug.log");
}

export function ensureDir(dir: string): boolean {
	try {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		return true;
	} catch {
		return false;
	}
}

export function readJsonFile<T>(path: string): T | undefined {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch (error) {
		logDebug(`readJsonFile failed for ${path}: ${messageOf(error)}`);
		return undefined;
	}
}

/** Write JSON via temp file + rename so a crash can never leave a truncated file. */
export function writeJsonFile(path: string, value: unknown): boolean {
	try {
		ensureDir(dirname(path));
		const tmp = `${path}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
		renameSync(tmp, path);
		return true;
	} catch (error) {
		logDebug(`writeJsonFile failed for ${path}: ${messageOf(error)}`);
		return false;
	}
}

export function removeFileIfExists(path: string): void {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch (error) {
		logDebug(`removeFileIfExists failed for ${path}: ${messageOf(error)}`);
	}
}

/**
 * Append a line to the extension debug log. Logging must never break pi, so
 * every failure is swallowed. The log is truncated in place when it grows past
 * a small cap.
 */
export function logDebug(message: string): void {
	try {
		const path = getLogPath();
		ensureDir(getStateDir());
		if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) {
			writeFileSync(path, "", "utf-8");
		}
		appendFileSync(path, `${new Date().toISOString()} ${message}\n`, "utf-8");
	} catch {
		// Intentionally ignored: logging must never throw.
	}
}

export function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export function clampBool(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Split a user supplied command line into argv, honouring simple quoting. */
export function splitCommandLine(input: string): string[] {
	const out: string[] = [];
	const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(input)) !== null) {
		out.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return out.filter((part) => part.length > 0);
}

export interface SafeUi {
	/** False once the captured context has been invalidated. */
	readonly alive: boolean;
	/** `ctx.hasUI`, but false instead of throwing on a stale context. */
	readonly hasUI: boolean;
	setStatus(text: string | undefined): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
}

/**
 * Wrap an extension context so that *every* UI call is guarded:
 * - reading `ctx.ui` throws on a stale context, so liveness is probed per call
 * - the returned promise-returning methods resolve to a fallback instead of rejecting
 */
/**
 * Read `ctx.hasUI` safely. `hasUI`, `ui`, `model`, `sessionManager` and friends
 * are guarded getters that throw once the extension context has been
 * invalidated by a session replacement or reload, and an uncaught throw from an
 * event handler is reported as an extension error (and from a timer callback it
 * would take the whole process down).
 */
export function safeHasUi(ctx: ExtensionContext): boolean {
	try {
		return ctx.hasUI === true;
	} catch {
		return false;
	}
}

export function createSafeUi(ctx: ExtensionContext): SafeUi {
	const ui = (): ExtensionContext["ui"] | undefined => {
		try {
			return ctx.ui;
		} catch {
			return undefined;
		}
	};

	return {
		get alive(): boolean {
			return ui() !== undefined;
		},
		get hasUI(): boolean {
			try {
				return ctx.hasUI === true;
			} catch {
				return false;
			}
		},
		setStatus(text: string | undefined): void {
			try {
				ui()?.setStatus(STATUS_KEY, text);
			} catch (error) {
				logDebug(`setStatus failed: ${messageOf(error)}`);
			}
		},
		notify(message: string, type: "info" | "warning" | "error" = "info"): void {
			try {
				ui()?.notify(message, type);
			} catch (error) {
				logDebug(`notify failed: ${messageOf(error)}`);
			}
		},
		async select(title: string, options: string[]): Promise<string | undefined> {
			try {
				const current = ui();
				if (!current) return undefined;
				return await current.select(title, options);
			} catch (error) {
				logDebug(`select failed: ${messageOf(error)}`);
				return undefined;
			}
		},
		async input(title: string, placeholder?: string): Promise<string | undefined> {
			try {
				const current = ui();
				if (!current) return undefined;
				return await current.input(title, placeholder);
			} catch (error) {
				logDebug(`input failed: ${messageOf(error)}`);
				return undefined;
			}
		},
		async confirm(title: string, message: string): Promise<boolean> {
			try {
				const current = ui();
				if (!current) return false;
				return await current.confirm(title, message);
			} catch (error) {
				logDebug(`confirm failed: ${messageOf(error)}`);
				return false;
			}
		},
	};
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_INTERVAL_MS = 80;

/**
 * Run an async task while updating `setStatus` with an animated Braille spinner (80ms).
 *
 * Spinners may overlap (an unawaited threshold check and a dialog). They are kept
 * in a stack with a single shared timer so that only the innermost spinner paints
 * and a finishing spinner restores the text of the one below it instead of
 * clearing the status for everyone.
 */
interface ActiveSpinner {
	message: string;
	frameIndex: number;
}

const activeSpinners: ActiveSpinner[] = [];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerReport: ((text: string | undefined) => void) | null = null;

function renderSpinner(): void {
	const top = activeSpinners[activeSpinners.length - 1];
	if (!top || !spinnerReport) return;
	spinnerReport(`${SPINNER_FRAMES[top.frameIndex]} ${top.message}`);
}

function stopSpinnerTimer(): void {
	if (!spinnerTimer) return;
	clearInterval(spinnerTimer);
	spinnerTimer = null;
}

export async function withSpinner<T>(
	setStatus: (text: string | undefined) => void,
	message: string,
	task: () => Promise<T>,
): Promise<T> {
	const entry: ActiveSpinner = { message, frameIndex: 0 };
	activeSpinners.push(entry);
	spinnerReport = setStatus;
	if (!spinnerTimer) {
		spinnerTimer = setInterval(() => {
			for (const spinner of activeSpinners) {
				spinner.frameIndex = (spinner.frameIndex + 1) % SPINNER_FRAMES.length;
			}
			renderSpinner();
		}, SPINNER_INTERVAL_MS);
		spinnerTimer.unref?.();
	}
	renderSpinner();

	try {
		return await task();
	} finally {
		const index = activeSpinners.indexOf(entry);
		if (index >= 0) activeSpinners.splice(index, 1);
		if (activeSpinners.length === 0) {
			stopSpinnerTimer();
			spinnerReport?.(undefined);
			spinnerReport = null;
		} else {
			renderSpinner();
		}
	}
}
