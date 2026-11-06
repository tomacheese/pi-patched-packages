/**
 * pi-auto-continue — extension entry point.
 *
 * Detects provider rate/usage limits, waits for the quota reset, then resumes
 * the task. Handoff mode resumes in a *fresh* session that contains only a
 * compact handoff document, which avoids re-ingesting a huge transcript after
 * the provider KV cache has expired.
 *
 * Wiring only: parsing, selection and formatting live in sibling modules and are
 * unit tested.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

import { CONFIG_KEYS, DEFAULT_CONFIG, applyConfigSetting, configFileLooksBroken, describeConfig, hasConfigFile, loadConfig, saveConfig } from "./config.ts";
import { formatClock, formatRemainingTime, parseDurationAndPrompt, parseDurationInput } from "./duration.ts";
import {
	buildResumeCommand,
	createHandoffCache,
	fromPendingWaitFile,
	generateHandoffDocument,
	handoffFileName,
	pruneHandoffs,
	readHandoffFile,
	toPendingWaitFile,
	writeHandoffFile,
} from "./handoff.ts";
import { EXHAUSTED_PERCENT, hasResetCredits, preferredCodexBarProvider, selectResetWindow } from "./providers.ts";
import { isRateLimitError, isTransientProviderError, parseErrorBodyReset, parseHeaderReset } from "./reset-parse.ts";
import { classifyUsageResult } from "./usage.ts";
import {
	createSafeUi,
	getConfigPath,
	getHandoffDir,
	isRecord,
	logDebug,
	messageOf,
	safeHasUi,
	withSpinner,
} from "./util.ts";
import { SessionWaitStore } from "./pending-store.ts";
import { WaitScheduler } from "./wait.ts";
import { RESUME_COMMAND, STATUS_KEY } from "./types.ts";
import type { PluginConfig, PendingWait, QuotaResetInfo, Strategy, UsageSnapshot } from "./types.ts";

const HANDOFF_TIMEOUT_MS = 60_000;
const USAGE_CACHE_MS = 60_000;
const THRESHOLD_CHECK_INTERVAL_MS = 5 * 60_000;
/** Minimum retry interval; short throttles must not trigger rapid model retries. */
const AUTO_MIN_WAIT_MS = 5 * 60_000;
/** Cap the backoff when quota reset data is missing or inaccurate. */
const AUTO_MAX_RETRY_DELAY_MS = 60 * 60_000;
/** Slack added after a known reset time so the retry does not land just before it. */
const AUTO_RESET_MARGIN_MS = 5_000;
/** Delay before resuming after a transient provider failure that is not a rate limit. */
const TRANSIENT_RESUME_DELAY_MS = 3 * 60_000;
/** Consecutive transient failures resumed automatically before giving up. */
const MAX_TRANSIENT_RESUMES = 3;

interface RateLimitEvidence {
	rateLimited: boolean;
	runErrored: boolean;
	transient?: boolean;
	headers?: Record<string, string>;
	errorMessage?: string;
}

/** Message type carried by a `message` session entry (not exported from the pi root). */
type BranchMessage = Extract<SessionEntry, { type: "message" }>["message"];

function blockText(block: unknown): string {
	if (!isRecord(block)) return "";
	return block["type"] === "text" && typeof block["text"] === "string" ? block["text"] : "";
}

/** True when the user kept the stock usage command (so narrowing flags are safe). */
function isDefaultUsageCommand(argv: string[]): boolean {
	return argv.length === DEFAULT_CONFIG.usageCommand.length && argv.every((part, index) => part === DEFAULT_CONFIG.usageCommand[index]);
}

export default function piAutoContinue(pi: ExtensionAPI): void {
	const config: PluginConfig = loadConfig();
	const handoffCache = createHandoffCache();
	const evidence: RateLimitEvidence = { rateLimited: false, runErrored: false };

	let usageCache: { at: number; snapshot: UsageSnapshot } | undefined;
	let lastThresholdCheck = 0;
	/** Auto-mode waits that ended and were followed by another rate limit; drives the retry backoff. */
	let autoResumeCount = 0;
	/** Epoch ms at which the last auto-mode wait ends, so limit errors arriving during it are not counted as failed retries. */
	let lastAutoWaitEndMs = 0;
	/** Consecutive transient provider failures resumed automatically. */
	let transientResumeCount = 0;
	let scheduler: WaitScheduler;
	const pendingStore = new SessionWaitStore();
	let boundSessionFile: string | undefined;
	let configProblemNotified = configFileLooksBroken();
	/**
	 * The scheduler needs a context for status rendering, but contexts go stale on
	 * session replacement. Track the freshest one instead of capturing the first.
	 */
	let lastStatusCtx: ExtensionContext | undefined;

	// ---------------------------------------------------------------------
	// Usage lookup
	// ---------------------------------------------------------------------

	function providerId(ctx: ExtensionContext): string {
		try {
			return ctx.model?.provider ?? "unknown";
		} catch {
			return "unknown";
		}
	}

	function modelId(ctx: ExtensionContext): string {
		try {
			return ctx.model?.id ?? "";
		} catch {
			return "";
		}
	}

	async function fetchUsage(ctx: ExtensionContext, maxAgeMs = 0): Promise<UsageSnapshot> {
		const now = Date.now();
		if (usageCache && now - usageCache.at < maxAgeMs) return usageCache.snapshot;

		const empty: UsageSnapshot = {
			status: "ok",
			resetInfo: null,
			maxUsedPercent: 0,
			overallMaxUsedPercent: 0,
			resetCreditsAvailable: false,
		};

		const finish = (snapshot: UsageSnapshot): UsageSnapshot => {
			usageCache = { at: Date.now(), snapshot };
			if (snapshot.status !== "ok") logDebug(`usage lookup ${snapshot.status}: ${snapshot.detail ?? ""}`);
			return snapshot;
		};

		if (config.usageCommand.length === 0) {
			return finish({ ...empty, status: "invalid-output", detail: "usageCommand is empty" });
		}

		/** Run a command and classify its process result (timeout, exit code, JSON). */
		const run = async (argv: string[]): Promise<{ payload: unknown[] | null; failure?: UsageSnapshot }> => {
			const [command, ...args] = argv;
			if (!command) return { payload: null, failure: { ...empty, status: "invalid-output", detail: "usageCommand is empty" } };

			try {
				const result = await pi.exec(command, args, { timeout: config.usageCommandTimeoutMs });
				const outcome = classifyUsageResult(result, argv);
				if (!outcome.payload) {
					return { payload: null, failure: { ...empty, ...(outcome.failure ?? { status: "command-failed", detail: "no data" }) } };
				}
				return { payload: outcome.payload };
			} catch (error) {
				const message = messageOf(error);
				const missing = /enoent|not found|no such file/i.test(message);
				return {
					payload: null,
					failure: { ...empty, status: missing ? "command-missing" : "command-failed", detail: `${argv.join(" ")}: ${message}` },
				};
			}
		};

		const select = (payload: unknown[]): { snapshot: UsageSnapshot; matchedProvider: boolean } => {
			const selection = selectResetWindow(payload, {
				provider: providerId(ctx),
				modelId: modelId(ctx),
				now: Date.now(),
			});
			return {
				matchedProvider: selection.matchedProvider,
				snapshot: {
					status: "ok",
					resetInfo: selection.resetInfo,
					maxUsedPercent: selection.maxUsedPercent,
					overallMaxUsedPercent: selection.overallMaxUsedPercent,
					resetCreditsAvailable: hasResetCredits(payload),
					...(selection.matchedProvider ? {} : { detail: "no usage entry matched the active provider" }),
				},
			};
		};

		// Fast path: ask only about the provider that is actually in use. The full
		// command is only retried when the narrowed query could not identify the
		// active provider at all: a matched provider reporting 0% is a valid answer,
		// and re-running the slower unfiltered query would not change it.
		const narrowed = narrowedUsageArgv(ctx);
		if (narrowed) {
			const first = await run(narrowed);
			if (first.payload) {
				const { snapshot, matchedProvider } = select(first.payload);
				if (matchedProvider) return finish(snapshot);
				logDebug(`narrowed usage query (${narrowed.join(" ")}) matched no provider; retrying with the full command`);
			} else if (first.failure?.status === "timeout" || first.failure?.status === "command-missing") {
				// Retrying a missing binary or an already-timed-out command just doubles
				// the wait for the same answer.
				logDebug(`narrowed usage query (${narrowed.join(" ")}) failed with ${first.failure.status}; not retrying the full command`);
				return finish(first.failure);
			} else {
				logDebug(`narrowed usage query (${narrowed.join(" ")}) failed; retrying with the full command`);
			}
		}

		const full = await run(config.usageCommand);
		if (!full.payload) return finish(full.failure ?? { ...empty, status: "command-failed", detail: "usage command returned no data" });
		return finish(select(full.payload).snapshot);
	}

	/**
	 * Append `--provider <id>` to the *default* CodexBar command only.
	 * A custom `usageCommand` is passed through untouched because its flags are
	 * the user's to choose.
	 */
	function narrowedUsageArgv(ctx: ExtensionContext): string[] | null {
		if (!isDefaultUsageCommand(config.usageCommand)) return null;
		const preferred = preferredCodexBarProvider(providerId(ctx), modelId(ctx));
		if (!preferred) return null;
		return [...config.usageCommand, "--provider", preferred];
	}

	// ---------------------------------------------------------------------
	// Handoff generation
	// ---------------------------------------------------------------------

	function branchOf(ctx: ExtensionContext): SessionEntry[] {
		try {
			return ctx.sessionManager.getBranch();
		} catch (error) {
			logDebug(`getBranch failed: ${messageOf(error)}`);
			return [];
		}
	}

	function serializeBranch(branch: SessionEntry[]): string {
		const messages: BranchMessage[] = [];
		for (const entry of branch) {
			if (entry.type === "message") messages.push(entry.message);
		}
		try {
			return serializeConversation(convertToLlm(messages));
		} catch (error) {
			logDebug(`serializeConversation failed: ${messageOf(error)}`);
			return "";
		}
	}

	async function callHandoffModel(ctx: ExtensionContext, systemPrompt: string, userText: string): Promise<string | null> {
		let model;
		try {
			model = ctx.model;
		} catch {
			return null;
		}
		if (!model) return null;

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: userText }],
							timestamp: Date.now(),
						},
					],
				},
				{ cacheRetention: "none", signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS) },
			);
			if (response.stopReason === "error") {
				logDebug(`handoff model call failed: ${response.errorMessage ?? "unknown error"}`);
				return null;
			}
			const text = response.content
				.map(blockText)
				.filter((part) => part.length > 0)
				.join("\n");
			return text.trim() ? text : null;
		} catch (error) {
			logDebug(`handoff model call threw: ${messageOf(error)}`);
			return null;
		}
	}

	async function generateHandoff(
		ctx: ExtensionContext,
		goalOverride?: string,
	): Promise<{ content: string; file: string | null; generatedBy: "model" | "local"; fromCache: boolean }> {
		const branch = branchOf(ctx);
		let sessionId = "unknown";
		let leafId: string | null = null;
		try {
			sessionId = ctx.sessionManager.getSessionId();
			leafId = ctx.sessionManager.getLeafId();
		} catch {
			// Keep defaults; the cache key just becomes less precise.
		}

		return generateHandoffDocument({
			branch,
			sessionId,
			leafId,
			config,
			cache: handoffCache,
			...(goalOverride !== undefined ? { goalOverride } : {}),
			serialize: serializeBranch,
			callModel: (systemPrompt, userText) => callHandoffModel(ctx, systemPrompt, userText),
			writeFile: (content) => {
				const name = writeHandoffFile(content, getHandoffDir(), handoffFileName());
				if (name) pruneHandoffs(getHandoffDir(), config.handoffRetention);
				return name;
			},
		});
	}

	// ---------------------------------------------------------------------
	// Resume execution
	// ---------------------------------------------------------------------

	/**
	 * Resume work in the current session (no fresh session, no handoff).
	 *
	 * `deliverAs: "followUp"` makes this safe while the agent is streaming: the
	 * message is queued instead of throwing "Agent is already processing" and
	 * losing the resume. When the agent is idle the option is ignored by pi.
	 */
	function resumeInPlace(ctx: ExtensionContext, prompt?: string): void {
		const text = prompt?.trim() || "Continue the previous task from where you left off.";
		try {
			pi.sendUserMessage(text, { deliverAs: "followUp" });
		} catch (error) {
			logDebug(`in-place resume failed: ${messageOf(error)}`);
		}
	}

	/**
	 * Resolve the registered name of the internal resume command.
	 *
	 * Only the exact name is accepted: when another extension registers the same
	 * name, pi suffixes *both* copies (`_ac-resume:1`, `_ac-resume:2`), and a
	 * `startsWith` guess could dispatch the resume into that other handler.
	 * Falling back to an in-place resume is lossy but safe.
	 */
	function resolveResumeCommandName(): string | null {
		let commands: string[];
		try {
			commands = pi.getCommands().map((command) => command.name);
		} catch (error) {
			logDebug(`getCommands failed: ${messageOf(error)}`);
			return null;
		}
		if (commands.includes(RESUME_COMMAND)) return RESUME_COMMAND;
		if (commands.some((name) => name.startsWith(`${RESUME_COMMAND}:`))) {
			logDebug(`resume command name '${RESUME_COMMAND}' was suffixed by a name collision; using the in-place fallback`);
		}
		return null;
	}

	/**
	 * Resume a wait.
	 *
	 * Handoff mode goes through the `/_ac-resume` *command* rather than calling
	 * `ctx.newSession()` directly: `newSession` only exists on command contexts,
	 * not on the context handed to event handlers or timers. That command handler
	 * also waits for the agent to become idle, so resuming while a turn is still
	 * streaming cannot interrupt it.
	 */
	function performResume(ctx: ExtensionContext, wait: PendingWait): void {
		const ui = createSafeUi(ctx);

		if (wait.strategy === "handoff" && wait.handoffFile) {
			const resumeCommandName = resolveResumeCommandName();
			const content = readHandoffFile(wait.handoffFile, getHandoffDir());

			if (!content) {
				ui.notify(`Handoff file ${wait.handoffFile} is missing; resuming in place instead.`, "warning");
			} else if (resumeCommandName) {
				try {
					pi.sendUserMessage(buildResumeCommand("handoff", wait.handoffFile, resumeCommandName), { expandPromptTemplates: true });
					return;
				} catch (error) {
					logDebug(`handoff resume dispatch failed: ${messageOf(error)}`);
				}
			} else {
				ui.notify("Resume command unavailable; resuming in place with the handoff text.", "warning");
			}

			resumeInPlace(ctx, content ? `## Task Handoff\n\n${content}\n\n---\nPlease proceed with the next steps.` : undefined);
			return;
		}

		resumeInPlace(ctx, wait.customPrompt);
	}

	// ---------------------------------------------------------------------
	// Wait scheduling
	// ---------------------------------------------------------------------

	function persistWait(wait: PendingWait | null): void {
		if (!wait) {
			pendingStore.clear();
			return;
		}
		if (!pendingStore.save(wait)) {
			logDebug("wait could not be persisted (missing session file or I/O failure)");
		}
	}

	scheduler = new WaitScheduler({
		setStatus: (text) => {
			// The scheduler callback has no context of its own; keep the last known
			// context so status updates survive. A stale context is ignored.
			if (lastStatusCtx) createSafeUi(lastStatusCtx).setStatus(text);
		},
		onChange: (wait) => persistWait(wait as PendingWait | null),
		onFire: async (wait) => {
			persistWait(null);
			const ctx = lastStatusCtx;
			if (!ctx) {
				logDebug("wait fired without a bound context; nothing to resume");
				return;
			}
			const ui = createSafeUi(ctx);
			ui.notify(`⏰ Quota reset reached — resuming (${wait.strategy}).`, "info");
			performResume(ctx, wait as PendingWait);
		},
	});

	/**
	 * The scheduler needs a context for status rendering, but contexts go stale on
	 * session replacement, so `lastStatusCtx` is refreshed by every event handler.
	 */
	function startWait(ctx: ExtensionContext, wait: PendingWait): void {
		lastStatusCtx = ctx;
		scheduler.start(wait);
	}

	// ---------------------------------------------------------------------
	// Usage-limit handling
	// ---------------------------------------------------------------------

	interface Choice {
		id: "now" | "handoff" | "inplace" | "custom-handoff" | "custom-inplace" | "cancel";
		label: string;
	}

	function pickResetInfo(usage: UsageSnapshot, provider: string, now: number): QuotaResetInfo | null {
		const headerInfo = parseHeaderReset(evidence.headers, provider, now);
		const bodyInfo = parseErrorBodyReset(evidence.errorMessage, provider, now);

		// A CodexBar window that is actually exhausted is the most trustworthy
		// source: the 429 itself often carries only a short retry hint.
		const codexExhausted =
			usage.resetInfo && (usage.resetInfo.usedPercent ?? 0) >= EXHAUSTED_PERCENT ? usage.resetInfo : null;

		// Non-exhausted usage windows are not evidence of this specific 429.
		// Prefer a bounded retry over waiting for an unrelated long window.
		return codexExhausted ?? headerInfo ?? bodyInfo;
	}

	async function askDuration(
		ctx: ExtensionContext,
		resetInfo: QuotaResetInfo | null,
		remainingMs: number,
	): Promise<number | null> {
		const ui = createSafeUi(ctx);
		const fallback = resetInfo ? formatRemainingTime(remainingMs) : "30m";
		const input = await ui.input("Wait duration (e.g. 30m, 1h30m, 16:45):", fallback);
		if (!input || !input.trim()) return null;
		const parsed = parseDurationInput(input);
		if (!parsed || parsed <= 0) {
			ui.notify("Invalid duration.", "error");
			return null;
		}
		return parsed;
	}

	async function armWait(
		ctx: ExtensionContext,
		options: {
			strategy: Strategy;
			targetTime: Date;
			provider: string;
			customPrompt?: string;
		},
	): Promise<void> {
		const ui = createSafeUi(ctx);
		let handoffFile: string | undefined;

		if (options.strategy === "handoff") {
			ui.setStatus("Generating handoff context...");
			const result = await generateHandoff(ctx);
			ui.setStatus(undefined);
			handoffFile = result.file ?? undefined;
			logDebug(`handoff generated by ${result.generatedBy}${handoffFile ? ` as ${handoffFile}` : ""}`);
			if (result.generatedBy === "local") {
				ui.notify("Live handoff generation failed (quota?), so a locally assembled handoff was used.", "warning");
			}
		}

		let sessionFile: string | undefined;
		try {
			sessionFile = ctx.sessionManager.getSessionFile();
		} catch {
			sessionFile = undefined;
		}

		startWait(ctx, {
			targetTime: options.targetTime,
			provider: options.provider,
			strategy: options.strategy,
			...(options.customPrompt !== undefined ? { customPrompt: options.customPrompt } : {}),
			...(handoffFile !== undefined ? { handoffFile } : {}),
			...(sessionFile !== undefined ? { sessionFile } : {}),
		});

		const mode = options.strategy === "handoff" ? "a fresh session (handoff)" : "this session (in-place)";
		ui.notify(`Waiting until ${formatClock(options.targetTime)} to resume in ${mode}. /ac cancel stops it.`, "info");
	}

	/** Non-interactive modes: log loudly instead of returning silently. */
	async function handleUsageLimitHeadless(ctx: ExtensionContext, resetInfo: QuotaResetInfo | null, usage: UsageSnapshot): Promise<void> {
		const detail = resetInfo
			? `reset at ${resetInfo.resetsAt.toISOString()} (source: ${resetInfo.source})`
			: "no reset time could be determined";
		const usageNote = usage.status === "ok" ? "" : ` [usage command: ${usage.status}${usage.detail ? ` — ${usage.detail}` : ""}]`;
		const message = `[${STATUS_KEY}] usage limit reached, ${detail}.${usageNote} Non-interactive mode: nothing was scheduled. Re-run with a UI, or use /ac <time> interactively.`;
		logDebug(message);
		// stderr keeps stdout clean for --print/--mode json consumers.
		process.stderr.write(`${message}\n`);
	}

	async function handleUsageLimit(ctx: ExtensionContext): Promise<void> {
		const ui = createSafeUi(ctx);
		const provider = providerId(ctx);
		const strategy = config.strategy;

		const usage = await withSpinner((text) => ui.setStatus(text), "Checking quota reset time...", () => fetchUsage(ctx));

		const now = Date.now();
		const resetInfo = pickResetInfo(usage, provider, now);
		evidence.headers = undefined;
		evidence.errorMessage = undefined;

		const remainingMs = resetInfo ? Math.max(resetInfo.resetsAt.getTime() - now, 0) : 0;

		if (!safeHasUi(ctx)) {
			await handleUsageLimitHeadless(ctx, resetInfo, usage);
			return;
		}

		// Tell the user when the usage lookup itself failed, otherwise the dialog
		// silently degrades to header/error-body estimates.
		if (usage.status !== "ok" && usage.status !== "command-missing") {
			ui.notify(`Usage lookup failed (${usage.status}): ${usage.detail ?? "unknown error"}`, "warning");
		} else if (usage.status === "command-missing") {
			ui.notify(
				`Usage command not found (${config.usageCommand.join(" ")}). Install CodexBar or set another command with /ac config usagecommand <command line>.`,
				"warning",
			);
		}

		// In auto mode a confirmed usage limit always schedules a wait, never a
		// blocking selection dialog. A known reset time is trusted for the first
		// retries; if the limit persists after waits have ended, the retry backoff
		// takes over so a stale or very short reset cannot loop indefinitely.
		if (config.autoMode === "auto") {
			const backoffMs = Math.min(AUTO_MAX_RETRY_DELAY_MS, AUTO_MIN_WAIT_MS * 2 ** Math.min(autoResumeCount, 4));
			const cappedResetWaitMs = Math.min(remainingMs, config.autoResumeMaxWaitMinutes * 60_000);
			// A known, still-future reset time is exact: wait for it instead of the
			// retry backoff, which only guards against missing or stale reset data.
			// After two retries that hit the limit again, the backoff is a floor too.
			const resetKnown = resetInfo !== null && remainingMs > 0;
			const waitMs = resetKnown
				? Math.max(cappedResetWaitMs + AUTO_RESET_MARGIN_MS, autoResumeCount >= 2 ? backoffMs : 0)
				: backoffMs;
			// Only an error that arrives after the previous wait ended is a failed retry;
			// other limit errors during a wait must not inflate the counter.
			if (Date.now() >= lastAutoWaitEndMs) autoResumeCount = Math.min(autoResumeCount + 1, 5);
			lastAutoWaitEndMs = Date.now() + waitMs;
			logDebug(`auto mode wait: ${formatRemainingTime(waitMs)}; consecutive rate limits=${autoResumeCount}; reset source=${resetInfo?.source ?? "unknown"}`);
			await armWait(ctx, { strategy, targetTime: new Date(Date.now() + waitMs), provider });
			return;
		}

		const choices: Choice[] = [];
		if (usage.resetCreditsAvailable && config.resumeImmediatelyOnResetCredits) {
			choices.push({ id: "now", label: "Resume now (unused reset credits available)" });
		}

		const isHandoffDefault = config.strategy === "handoff";
		const handoffChoice: Choice = {
			id: "handoff",
			label: resetInfo
				? `New session at reset (handoff) ${isHandoffDefault ? "[default]" : ""}`
				: `New session (handoff) ${isHandoffDefault ? "[default]" : ""}`,
		};
		const inplaceChoice: Choice = {
			id: "inplace",
			label: resetInfo
				? `Current session at reset (in-place) ${!isHandoffDefault ? "[default]" : ""}`
				: `Current session (in-place) ${!isHandoffDefault ? "[default]" : ""}`,
		};

		if (isHandoffDefault) {
			choices.push(handoffChoice, inplaceChoice);
		} else {
			choices.push(inplaceChoice, handoffChoice);
		}

		choices.push({ id: "custom-handoff", label: "Custom duration → New session (handoff)" });
		choices.push({ id: "custom-inplace", label: "Custom duration → Current session (in-place)" });
		choices.push({ id: "cancel", label: "Cancel" });

		const timeTag = resetInfo
			? ` · resets in ${formatRemainingTime(remainingMs)} (${formatClock(resetInfo.resetsAt)})`
			: " · no reset time detected";
		const title = `Rate limit reached (${provider})${timeTag}`;

		const selected = await ui.select(title, choices.map((choice) => choice.label));
		const choice = selected ? choices.find((candidate) => candidate.label === selected) : undefined;
		if (!choice || choice.id === "cancel") {
			ui.notify("Auto-continue cancelled.", "info");
			return;
		}

		if (choice.id === "now") {
			resumeInPlace(ctx);
			return;
		}

		const needsInput = choice.id.startsWith("custom") || !resetInfo;
		let targetTime = resetInfo?.resetsAt ?? new Date(now + 30 * 60_000);
		if (needsInput) {
			const parsed = await askDuration(ctx, resetInfo, remainingMs);
			if (parsed === null) {
				ui.notify("Auto-continue cancelled.", "info");
				return;
			}
			targetTime = new Date(Date.now() + parsed);
		}

		const chosenStrategy: Strategy = choice.id.includes("inplace") ? "inplace" : "handoff";
		await armWait(ctx, { strategy: chosenStrategy, targetTime, provider });
	}

	// ---------------------------------------------------------------------
	// Pending-wait restore
	// ---------------------------------------------------------------------

	function notifyConfigProblemOnce(ctx: ExtensionContext): void {
		if (!configProblemNotified) return;
		configProblemNotified = false;
		createSafeUi(ctx).notify(
			`pi-auto-continue: ${getConfigPath()} exists but could not be parsed, so defaults are in use. Fix or delete that file.`,
			"warning",
		);
	}

	let firstRunChecked = false;
	function maybeNotifyFirstRun(ctx: ExtensionContext): void {
		if (firstRunChecked) return;
		firstRunChecked = true;
		if (!hasConfigFile()) {
			saveConfig(config);
			createSafeUi(ctx).notify(
				`pi-auto-continue: active with '${config.strategy}' strategy (pre-generates context at ${config.handoffThreshold}% to save tokens). Use /ac config strategy inplace to keep full session history.`,
				"info",
			);
		}
	}

	function maybeRestorePendingWait(ctx: ExtensionContext): void {
		notifyConfigProblemOnce(ctx);
		maybeNotifyFirstRun(ctx);

		// Non-interactive runs never schedule a wait: there is no countdown to show
		// and no /ac cancel to stop an autonomous resume.
		if (!safeHasUi(ctx)) return;
		let sessionFile: string | undefined;
		try {
			sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
		} catch {
			sessionFile = undefined;
		}

		// A Pi process may switch sessions without exiting. Preserve the old
		// session's saved wait, but never let its timer run in the new session.
		if (sessionFile !== boundSessionFile) {
			scheduler.dispose();
			pendingStore.forget();
			boundSessionFile = sessionFile;
		}
		if (!sessionFile || scheduler.current) return;

		const loaded = pendingStore.load(sessionFile);
		if (!loaded) return;
		const ui = createSafeUi(ctx);
		if (loaded.kind === "invalid") {
			ui.notify("pi-auto-continue: this session's saved wait was invalid and was discarded.", "warning");
			return;
		}
		const wait = loaded.wait;

		// A wait is armed for the provider that hit the limit. If the user switched
		// providers, its reset time is meaningless, so discard instead of resuming
		// the wrong task under the wrong quota.
		const currentProvider = providerId(ctx);
		if (wait.provider && currentProvider !== "unknown" && wait.provider !== currentProvider) {
			ui.notify(
				`pi-auto-continue: a saved wait for '${wait.provider}' does not match the active provider '${currentProvider}' and was discarded.`,
				"warning",
			);
			pendingStore.clear();
			return;
		}

		const remaining = wait.targetTime.getTime() - Date.now();
		if (remaining <= 0) {
			ui.notify(
				`pi-auto-continue: a saved wait already elapsed at ${formatClock(wait.targetTime)} — resuming in 5s.`,
				"info",
			);
			// Let the scheduler own the timer so repeated settle events cannot
			// schedule duplicate resumptions.
			startWait(ctx, { ...wait, targetTime: new Date() });
			return;
		}

		ui.notify(
			`pi-auto-continue: restored a saved wait (${formatRemainingTime(remaining)} left, ${wait.strategy}). /ac cancel stops it.`,
			"info",
		);
		startWait(ctx, wait);
	}

	// ---------------------------------------------------------------------
	// Event wiring
	// ---------------------------------------------------------------------

	pi.on("agent_start", () => {
		evidence.rateLimited = false;
		evidence.runErrored = false;
		evidence.transient = false;
		evidence.headers = undefined;
		evidence.errorMessage = undefined;
	});

	pi.on("after_provider_response", (event) => {
		if (event.status === 429) {
			evidence.rateLimited = true;
			evidence.headers = event.headers;
		}
	});

	pi.on("turn_end", (event) => {
		const message = event.message as unknown;
		if (!isRecord(message) || message["role"] !== "assistant") return;
		if (message["stopReason"] !== "error") return;
		evidence.runErrored = true;
		const errorMessage = typeof message["errorMessage"] === "string" ? message["errorMessage"] : "";
		evidence.errorMessage = errorMessage;
		if (isRateLimitError(errorMessage)) evidence.rateLimited = true;
		else if (isTransientProviderError(errorMessage)) evidence.transient = true;
	});

	/**
	 * Pre-emptive threshold check.
	 *
	 * Deliberately not awaited: reading usage shells out to CodexBar, which takes
	 * several seconds, and `agent_settled` is awaited by the session runtime —
	 * blocking here would delay idle detection on every turn.
	 */
	async function checkThreshold(ctx: ExtensionContext): Promise<void> {
		if (config.strategy !== "handoff") return;
		// A wait is already armed, so nothing needs to be pre-generated.
		if (scheduler.current) return;

		const now = Date.now();
		if (now - lastThresholdCheck < THRESHOLD_CHECK_INTERVAL_MS) return;
		lastThresholdCheck = now;

		const usage = await fetchUsage(ctx, USAGE_CACHE_MS);
		if (usage.maxUsedPercent < config.handoffThreshold || usage.maxUsedPercent >= 100) return;

		const result = await generateHandoff(ctx);
		// A cache hit means the branch has not moved since the last pre-generation,
		// so stay quiet instead of re-notifying on every throttled check.
		if (result.fromCache) return;

		createSafeUi(ctx).notify(
			`[${STATUS_KEY}] Quota at ${Math.round(usage.maxUsedPercent)}% (threshold ${config.handoffThreshold}%). Pre-generated a handoff (${result.generatedBy}) so resume avoids KV-cache reload.`,
			"warning",
		);
	}

	pi.on("agent_settled", async (_event, ctx) => {
		lastStatusCtx = ctx;

		if (evidence.rateLimited && evidence.runErrored) {
			evidence.rateLimited = false;
			evidence.runErrored = false;
			await handleUsageLimit(ctx);
			return;
		}
		if (evidence.transient && evidence.runErrored) {
			evidence.transient = false;
			evidence.runErrored = false;
			transientResumeCount += 1;
			// Only in auto mode (the user opted into unattended resumes), and never replacing a wait that is already armed.
			if (transientResumeCount <= MAX_TRANSIENT_RESUMES && config.autoMode === "auto" && !scheduler.current && safeHasUi(ctx)) {
				logDebug(`transient provider failure: resuming in ${formatRemainingTime(TRANSIENT_RESUME_DELAY_MS)} (${transientResumeCount}/${MAX_TRANSIENT_RESUMES})`);
				await armWait(ctx, {
					strategy: "inplace",
					targetTime: new Date(Date.now() + TRANSIENT_RESUME_DELAY_MS),
					provider: providerId(ctx),
				});
				return;
			}
		} else if (!evidence.runErrored) {
			transientResumeCount = 0;
		}
		// A settling run that was not rate limited means the limit cleared, so the
		// auto-resume loop guard can start over.
		autoResumeCount = 0;
		// Clear latching evidence so a transient 429 that pi retried internally can
		// never produce a dialog after a successful run, and so a later manual `/ac`
		// cannot parse a reset time out of a stale error message.
		evidence.rateLimited = false;
		evidence.headers = undefined;
		evidence.errorMessage = undefined;

		maybeRestorePendingWait(ctx);

		if (safeHasUi(ctx)) void checkThreshold(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		lastStatusCtx = ctx;
		maybeRestorePendingWait(ctx);
	});

	pi.on("session_shutdown", () => {
		// Clear timers so a pending wait can never fire against a stale context.
		// Keep the session-scoped wait on disk for a future restart.
		scheduler.dispose();
		pendingStore.forget();
		boundSessionFile = undefined;
	});

	// ---------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------

	function cancelWait(ctx: ExtensionCommandContext): void {
		const ui = createSafeUi(ctx);
		const cancelled = scheduler.stop();
		if (!cancelled) {
			ui.notify("No active wait timer.", "info");
			return;
		}
		ui.setStatus(undefined);
		ui.notify(`Cancelled the wait until ${formatClock(cancelled.targetTime)}.`, "info");
	}

	async function handleQuota(ctx: ExtensionCommandContext): Promise<void> {
		const ui = createSafeUi(ctx);
		const usage = await withSpinner((text) => ui.setStatus(text), "Fetching quota...", () => fetchUsage(ctx));

		if (usage.status === "command-missing") {
			ui.notify(
				`Usage command not found (${config.usageCommand.join(" ")}).\nInstall CodexBar, or set another command with:\n/ac config usagecommand <command line>`,
				"error",
			);
			return;
		}
		if (usage.status !== "ok") {
			ui.notify(`Usage lookup failed (${usage.status}): ${usage.detail ?? "unknown error"}`, "error");
			return;
		}

		const credits = usage.resetCreditsAvailable ? "\nReset credits: available (can resume immediately)" : "";
		const overall =
			usage.overallMaxUsedPercent > usage.maxUsedPercent
				? `\nHighest window across all providers: ${Math.round(usage.overallMaxUsedPercent)}%`
				: "";

		if (!usage.resetInfo) {
			ui.notify(
				`Quota: ${Math.round(usage.maxUsedPercent)}% used${overall}\nNo upcoming reset detected.${usage.detail ? `\n${usage.detail}` : ""}${credits}`,
				"info",
			);
			return;
		}

		const remaining = Math.max(usage.resetInfo.resetsAt.getTime() - Date.now(), 0);
		const window = usage.resetInfo.windowTitle ? ` [${usage.resetInfo.windowTitle}]` : "";
		const percent = usage.resetInfo.usedPercent !== undefined ? ` (used ${Math.round(usage.resetInfo.usedPercent)}%)` : "";
		ui.notify(
			`${usage.resetInfo.provider}${window}${percent}\nResets at ${formatClock(usage.resetInfo.resetsAt)} — in ${formatRemainingTime(remaining)}${overall}${credits}`,
			"info",
		);
	}

	/**
	 * Wait for an in-flight turn to finish without letting a failure abort the
	 * resume. Used before a handoff snapshot and before dispatching a resume.
	 */
	async function waitForIdleSafely(ctx: ExtensionCommandContext): Promise<void> {
		try {
			await ctx.waitForIdle();
		} catch (error) {
			logDebug(`waitForIdle failed: ${messageOf(error)}`);
		}
	}

	async function handleHandoff(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const ui = createSafeUi(ctx);
		// The handoff is generated from the current branch, so let an in-flight turn
		// finish first instead of snapshotting a half-written conversation.
		await waitForIdleSafely(ctx);
		const result = await withSpinner((text) => ui.setStatus(text), "Generating handoff...", () => generateHandoff(ctx, args?.trim() || undefined));

		let parentSession: string | undefined;
		try {
			parentSession = ctx.sessionManager.getSessionFile();
		} catch {
			parentSession = undefined;
		}

		persistWait(null);
		await ctx.newSession({
			...(parentSession !== undefined ? { parentSession } : {}),
			withSession: async (replacementCtx) => {
				replacementCtx.ui.notify("🔄 Switched to a fresh session with handoff context.", "info");
				await replacementCtx.sendUserMessage(
					`## Task Handoff (Fresh Session)\n\n${result.content}\n\n---\nPlease proceed with the next steps.`,
				);
			},
		});
	}

	function handleConfig(args: string, ctx: ExtensionCommandContext): void {
		const ui = createSafeUi(ctx);
		const parts = (args ?? "").trim().split(/\s+/);
		const key = parts[0]?.trim();
		const value = parts.slice(1).join(" ");

		if (!key) {
			ui.notify(
				`Config file: ${getConfigPath()}\n${describeConfig(config)}\n\nUsage: /ac config <key> <value>`,
				"info",
			);
			return;
		}

		const known = Object.keys(CONFIG_KEYS);
		if (known.includes(key.toLowerCase()) && (!value || !value.trim())) {
			ui.notify(`${key} = ${CONFIG_KEYS[key.toLowerCase()]?.read(config)}\n(${CONFIG_KEYS[key.toLowerCase()]?.describe})`, "info");
			return;
		}

		const result = applyConfigSetting(config, key, value);
		if (!result.ok) {
			ui.notify(result.message, "error");
			return;
		}

		const saved = saveConfig(config);
		ui.notify(
			result.message + (saved ? "\nSaved to disk." : "\nWarning: could not write the config file; this change is in-memory only."),
			saved ? "info" : "warning",
		);
	}

	async function handleAutoContinue(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const raw = (args ?? "").trim();
		if (!raw) {
			await handleUsageLimit(ctx);
			return;
		}

		const parts = raw.split(/\s+/).filter(Boolean);
		const firstToken = parts[0]?.toLowerCase();
		const restArgs = parts.slice(1).join(" ");

		if (firstToken === "cancel" || firstToken === "stop") {
			cancelWait(ctx);
			return;
		}
		if (firstToken === "quota" || firstToken === "usage") {
			await handleQuota(ctx);
			return;
		}
		if (firstToken === "handoff") {
			await handleHandoff(restArgs, ctx);
			return;
		}
		if (firstToken === "config" || firstToken === "cfg") {
			handleConfig(restArgs, ctx);
			return;
		}

		const { durationMs, prompt } = parseDurationAndPrompt(raw);
		if (!durationMs || durationMs <= 0) {
			createSafeUi(ctx).notify(
				"Invalid argument or duration.\nUsage:\n  /ac [duration] [prompt]   (e.g. /ac 45m · /ac 1h30m · /ac 2 hours)\n  /ac cancel                (cancel active wait)\n  /ac quota                 (view quota & reset times)\n  /ac handoff [goal]        (switch to fresh session with handoff)\n  /ac config [key] [value]  (view/change settings)",
				"error",
			);
			return;
		}

		await armWait(ctx, {
			strategy: config.strategy,
			targetTime: new Date(Date.now() + durationMs),
			provider: providerId(ctx),
			...(prompt ? { customPrompt: prompt } : {}),
		});
	}

	// Primary commands (Plan A: Subcommands & Clean Names)
	pi.registerCommand("auto-continue", {
		description: "Auto-continue: /auto-continue [time] | cancel | quota | handoff | config",
		handler: handleAutoContinue,
	});

	pi.registerCommand("ac", {
		description: "Auto-continue: /ac [time] | cancel | quota | handoff | config (alias for /auto-continue)",
		handler: handleAutoContinue,
	});

	pi.registerCommand("handoff", {
		description: "Generate a handoff and switch to a fresh session immediately: /handoff [goal]",
		handler: (args, ctx) => handleHandoff(args, ctx),
	});

	pi.registerCommand("quota", {
		description: "Show current provider quota and reset times",
		handler: (_args, ctx) => handleQuota(ctx),
	});

	pi.registerCommand("usage", {
		description: "Show current provider quota and reset times (alias for /quota)",
		handler: (_args, ctx) => handleQuota(ctx),
	});

	// Internal resume command (dispatched by the wait scheduler)
	pi.registerCommand(RESUME_COMMAND, {
		description: "(internal) Resume a pending wait: /_ac-resume <handoff-file> | --inplace",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const ui = createSafeUi(ctx);
			const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const inPlace = tokens.includes("--inplace");
			const fileName = tokens.find((token) => !token.startsWith("--"));

			persistWait(null);

			// The timer can fire while a turn is still streaming. Waiting here keeps the
			// resume from being dropped (in-place) or cutting a turn short (handoff).
			ui.setStatus("⏳ Waiting for the current turn to finish before resuming...");
			await waitForIdleSafely(ctx);
			ui.setStatus(undefined);

			if (inPlace || !fileName) {
				resumeInPlace(ctx);
				return;
			}

			const content = readHandoffFile(fileName, getHandoffDir());
			if (!content) {
				ui.notify(`Handoff file ${fileName} not found; resuming in place instead.`, "warning");
				resumeInPlace(ctx);
				return;
			}

			let parentSession: string | undefined;
			try {
				parentSession = ctx.sessionManager.getSessionFile();
			} catch {
				parentSession = undefined;
			}

			await ctx.newSession({
				...(parentSession !== undefined ? { parentSession } : {}),
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify("🔄 Fresh session started from the handoff (KV cache preserved).", "info");
					await replacementCtx.sendUserMessage(
						`## Task Handoff (Fresh Session)\n\n${content}\n\n---\nPlease proceed with the next steps.`,
					);
				},
			});
		},
	});

	logDebug(`loaded: strategy=${config.strategy} threshold=${config.handoffThreshold}% mode=${config.autoMode}`);
}
