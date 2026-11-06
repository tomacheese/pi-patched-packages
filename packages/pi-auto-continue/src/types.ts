/**
 * Shared types and constants for pi-auto-continue.
 *
 * This module must stay dependency-free (type-only imports) so that it can be
 * unit tested with plain `node --test`.
 */

export const STATUS_KEY = "pi-auto-continue";
export const EXTENSION_NAME = "pi-auto-continue";

/**
 * Internal command the wait scheduler dispatches to resume a wait with a real
 * command context (`newSession` only exists on command contexts).
 */
export const RESUME_COMMAND = "_ac-resume";

/** Strategy used once the quota reset time is reached. */
export type Strategy = "handoff" | "inplace";

/** `auto` starts the countdown without asking; `prompt` always asks first. */
export type AutoMode = "auto" | "prompt";

/** Where a reset time came from, best-first: codexbar > http header > error body > manual. */
export type ResetSource = "codexbar" | "http-header" | "error-body" | "manual";

/**
 * Which model/product family a quota window belongs to.
 * `unknown` means "the provider did not label this window", which is treated as
 * "applies to whatever model is active".
 */
export type WindowFamily =
	| "gemini"
	| "claude"
	| "gpt"
	| "grok"
	| "deepseek"
	| "other"
	| "unknown";

export interface QuotaResetInfo {
	resetsAt: Date;
	resetDescription?: string;
	provider: string;
	source: ResetSource;
	usedPercent?: number;
	windowTitle?: string;
	windowMinutes?: number;
	windowFamily: WindowFamily;
}

export interface PluginConfig {
	/** What to do when the reset time is reached. */
	strategy: Strategy;
	/** Used percent at which a handoff is pre-generated to save KV cache. */
	handoffThreshold: number;
	/** `auto` resumes without prompting, but only inside `autoResumeMaxWaitMinutes`. */
	autoMode: AutoMode;
	/** Upper bound for silently waiting in `auto` mode. Longer resets always prompt. */
	autoResumeMaxWaitMinutes: number;
	/** Command used to read provider usage. Defaults to CodexBar. */
	usageCommand: string[];
	usageCommandTimeoutMs: number;
	/** How many handoff files to keep on disk. */
	handoffRetention: number;
	/** How many trailing messages to include when generating a handoff. */
	handoffMaxTurns: number;
	/** Character budget for the serialized conversation sent to the handoff model. */
	handoffMaxChars: number;
	/** Offer an immediate resume when the provider reports unused reset credits. */
	resumeImmediatelyOnResetCredits: boolean;
}

/** A wait that is either pending in memory or persisted across restarts. */
export interface PendingWait {
	targetTime: Date;
	provider: string;
	strategy: Strategy;
	customPrompt?: string;
	/** Handoff file name (not a path) inside the handoff directory. */
	handoffFile?: string;
	/** Session file the wait was created in, used to decide whether in-place resume still applies. */
	sessionFile?: string;
}

/** On-disk shape of `pending-wait.json`. */
export interface PendingWaitFileV1 {
	version: 1;
	targetTimeIso: string;
	provider: string;
	strategy: Strategy;
	customPrompt?: string;
	handoffFile?: string;
	sessionFile?: string;
	createdAtIso: string;
}

export type UsageFetchStatus = "ok" | "command-missing" | "command-failed" | "invalid-output" | "timeout";

export interface UsageSnapshot {
	status: UsageFetchStatus;
	/** Human readable detail for `/quota` and the log. */
	detail?: string;
	resetInfo: QuotaResetInfo | null;
	/** Max used percent across windows that apply to the active model. */
	maxUsedPercent: number;
	/** Max used percent across every window in the payload (diagnostics). */
	overallMaxUsedPercent: number;
	/** Provider reports unused reset credits that can restore quota immediately. */
	resetCreditsAvailable: boolean;
}
