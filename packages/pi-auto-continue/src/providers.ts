/**
 * CodexBar payload interpretation: provider matching, window selection and
 * reset-credit detection. Pure functions so the (surprisingly subtle) window
 * selection can be unit tested against real payload shapes.
 */
import { isRecord } from "./util.ts";
import type { QuotaResetInfo, WindowFamily } from "./types.ts";

interface RawWindow {
	title?: string;
	resetsAt?: string;
	usedPercent?: number;
	windowMinutes?: number;
	resetDescription?: string;
}

/** Used percent at which a window is treated as the one that hit the limit. */
export const EXHAUSTED_PERCENT = 99;

export interface WindowSelection {
	resetInfo: QuotaResetInfo | null;
	/** Max used percent across windows that apply to the active model. */
	maxUsedPercent: number;
	/** Max used percent across every window in the payload. */
	overallMaxUsedPercent: number;
	/** True when at least one CodexBar item matched this pi provider. */
	matchedProvider: boolean;
}

/**
 * Map a pi provider/model pair to candidate CodexBar provider ids.
 * Cheap substring matching in both directions is used because CodexBar ids
 * ("codex", "claude", "antigravity", "cursor", ...) do not line up 1:1 with pi
 * provider names ("openai-codex", "antigravity", "cursor").
 */
export function mapPiProviderToCodexBar(piProvider: string, modelId: string): string[] {
	const provider = (piProvider || "").toLowerCase();
	const model = (modelId || "").toLowerCase();

	if (provider.includes("anthropic") || model.includes("claude")) return ["claude", "antigravity"];
	if (
		provider.includes("openai") ||
		model.includes("gpt") ||
		model.includes("o1") ||
		model.includes("o3") ||
		model.includes("o4") ||
		model.includes("codex")
	) {
		return ["codex", "openai", "antigravity"];
	}
	if (provider.includes("google") || model.includes("gemini")) return ["gemini", "antigravity"];
	if (provider.includes("cursor")) return ["cursor"];
	if (provider.includes("deepseek")) return ["deepseek"];
	if (provider.includes("groq") || model.includes("grok")) return ["groqcloud", "grok"];
	if (provider.includes("antigravity")) return ["antigravity"];
	return provider ? [provider] : [];
}

/**
 * The single CodexBar provider id that best represents the active pi provider.
 * Used to narrow the usage query: an unfiltered CodexBar run queries every
 * enabled provider and takes roughly three times longer.
 */
export function preferredCodexBarProvider(piProvider: string, modelId: string): string | null {
	const provider = (piProvider || "").toLowerCase();

	if (provider.includes("antigravity")) return "antigravity";
	if (provider.includes("openai") || provider.includes("codex")) return "codex";
	if (provider.includes("anthropic")) return "claude";
	if (provider.includes("google") || provider.includes("gemini")) return "gemini";
	if (provider.includes("cursor")) return "cursor";
	if (provider.includes("deepseek")) return "deepseek";

	switch (modelFamily(modelId)) {
		case "claude":
			return "claude";
		case "gemini":
			return "gemini";
		case "gpt":
			return "codex";
		case "grok":
			return "grok";
		case "deepseek":
			return "deepseek";
		default:
			return null;
	}
}

export function modelFamily(modelId: string): WindowFamily {
	const model = (modelId || "").toLowerCase();
	if (model.includes("gemini")) return "gemini";
	if (model.includes("claude")) return "claude";
	if (model.includes("gpt") || model.includes("codex") || /(^|[^a-z])o[1-9]([^a-z]|$)/.test(model)) return "gpt";
	if (model.includes("grok")) return "grok";
	if (model.includes("deepseek")) return "deepseek";
	return "unknown";
}

/**
 * Classify a labelled window. Windows without a label are `unknown`, which is
 * treated as "applies to any model"; labelled windows from an unrelated family
 * are filtered out so a Claude/GPT weekly limit cannot make a Gemini session
 * wait for the wrong reset.
 */
export function windowFamilyFromTitle(title: string | undefined): WindowFamily {
	if (!title) return "unknown";
	const lower = title.toLowerCase();
	if (lower.includes("gemini")) return "gemini";
	if (lower.includes("claude")) return "claude";
	if (lower.includes("gpt") || lower.includes("codex")) return "gpt";
	if (lower.includes("grok")) return "grok";
	if (lower.includes("deepseek")) return "deepseek";
	return "other";
}

function isFamilyCompatible(window: WindowFamily, model: WindowFamily): boolean {
	if (model === "unknown") return true;
	return window === model || window === "unknown";
}

function collectRawWindows(usage: Record<string, unknown>): RawWindow[] {
	const windows: RawWindow[] = [];

	for (const key of ["primary", "secondary", "tertiary"] as const) {
		const entry = usage[key];
		if (!isRecord(entry)) continue;
		windows.push({
			resetsAt: typeof entry["resetsAt"] === "string" ? entry["resetsAt"] : undefined,
			usedPercent: typeof entry["usedPercent"] === "number" ? entry["usedPercent"] : undefined,
			windowMinutes: typeof entry["windowMinutes"] === "number" ? entry["windowMinutes"] : undefined,
			resetDescription: typeof entry["resetDescription"] === "string" ? entry["resetDescription"] : undefined,
		});
	}

	const extras = usage["extraRateWindows"];
	if (Array.isArray(extras)) {
		for (const extra of extras) {
			if (!isRecord(extra)) continue;
			const window = extra["window"];
			if (!isRecord(window)) continue;
			windows.push({
				title: typeof extra["title"] === "string" ? extra["title"] : undefined,
				resetsAt: typeof window["resetsAt"] === "string" ? window["resetsAt"] : undefined,
				usedPercent: typeof window["usedPercent"] === "number" ? window["usedPercent"] : undefined,
				windowMinutes: typeof window["windowMinutes"] === "number" ? window["windowMinutes"] : undefined,
				resetDescription: typeof window["resetDescription"] === "string" ? window["resetDescription"] : undefined,
			});
		}
	}

	return dropUntitledDuplicates(windows);
}

/**
 * `primary`/`secondary` repeat one of the labelled `extraRateWindows` in
 * provider payloads such as antigravity. Those repeats carry no label, so drop
 * them whenever an identical labelled window exists — otherwise the family
 * filter cannot exclude them and the wrong reset wins.
 */
function dropUntitledDuplicates(windows: RawWindow[]): RawWindow[] {
	const titled = windows.filter((window) => window.title !== undefined && window.resetsAt !== undefined);
	return windows.filter((window) => {
		if (window.title !== undefined) return true;
		if (window.resetsAt === undefined) return true;
		return !titled.some(
			(candidate) =>
				candidate.resetsAt === window.resetsAt &&
				numbersClose(candidate.usedPercent, window.usedPercent) &&
				numbersClose(candidate.windowMinutes, window.windowMinutes),
		);
	});
}

function numbersClose(a: number | undefined, b: number | undefined): boolean {
	if (a === undefined && b === undefined) return true;
	if (a === undefined || b === undefined) return false;
	return Math.abs(a - b) < 0.01;
}

export function hasResetCredits(payload: unknown): boolean {
	if (!Array.isArray(payload)) return false;
	for (const item of payload) {
		if (!isRecord(item)) continue;
		const usage = item["usage"];
		if (!isRecord(usage)) continue;
		const credits = usage["codexResetCredits"];
		if (!isRecord(credits)) continue;
		const available = credits["availableCount"];
		if (typeof available === "number" && available > 0) return true;
		const list = credits["credits"];
		if (Array.isArray(list) && list.length > 0) return true;
	}
	return false;
}

export function selectResetWindow(
	payload: unknown,
	options: { provider: string; modelId: string; exhaustedPercent?: number; now?: number },
): WindowSelection {
	const now = options.now ?? Date.now();
	const exhaustedPercent = options.exhaustedPercent ?? EXHAUSTED_PERCENT;
	const empty: WindowSelection = {
		resetInfo: null,
		maxUsedPercent: 0,
		overallMaxUsedPercent: 0,
		matchedProvider: false,
	};
	if (!Array.isArray(payload)) return empty;

	const candidates = mapPiProviderToCodexBar(options.provider, options.modelId);
	if (candidates.length === 0) return empty;

	const family = modelFamily(options.modelId);
	let matchedProvider = false;
	let overallMax = 0;
	const applicable: Array<{ window: RawWindow; family: WindowFamily }> = [];

	for (const item of payload) {
		if (!isRecord(item)) continue;

		const usage = item["usage"];
		const windows = isRecord(usage) ? collectRawWindows(usage) : [];

		// Diagnostics count every window in the payload, not just the ones that
		// apply to the active model, so `/quota` can show pressure from other
		// model families/providers.
		for (const window of windows) {
			if (typeof window.usedPercent === "number") {
				overallMax = Math.max(overallMax, window.usedPercent);
			}
		}

		const itemProvider = String(item["provider"] ?? "").toLowerCase();
		// An entry without a provider id must never match: `candidate.includes("")`
		// is always true, so it used to match every provider.
		if (itemProvider.length === 0) continue;
		const matches = candidates.some(
			(candidate) => itemProvider.includes(candidate) || candidate.includes(itemProvider),
		);
		if (!matches) continue;
		matchedProvider = true;

		for (const window of windows) {
			const windowFam = windowFamilyFromTitle(window.title);
			if (isFamilyCompatible(windowFam, family)) {
				applicable.push({ window, family: windowFam });
			}
		}
	}

	if (!matchedProvider) return { ...empty, matchedProvider: false, overallMaxUsedPercent: overallMax };

	let maxUsedPercent = 0;
	let exhausted: QuotaResetInfo | null = null;
	let earliest: QuotaResetInfo | null = null;

	for (const { window } of applicable) {
		if (typeof window.usedPercent === "number") {
			maxUsedPercent = Math.max(maxUsedPercent, window.usedPercent);
		}
		if (!window.resetsAt) continue;
		const parsed = new Date(window.resetsAt);
		const time = parsed.getTime();
		if (Number.isNaN(time) || time <= now) continue;

		const info: QuotaResetInfo = {
			resetsAt: parsed,
			provider: options.provider,
			source: "codexbar",
			windowFamily: windowFamilyFromTitle(window.title),
			...(window.title !== undefined ? { windowTitle: window.title } : {}),
			...(window.usedPercent !== undefined ? { usedPercent: window.usedPercent } : {}),
			...(window.windowMinutes !== undefined ? { windowMinutes: window.windowMinutes } : {}),
			...(window.resetDescription !== undefined ? { resetDescription: window.resetDescription } : {}),
		};

		const isExhausted = typeof window.usedPercent === "number" && window.usedPercent >= exhaustedPercent;
		if (isExhausted && (!exhausted || time < exhausted.resetsAt.getTime())) exhausted = info;
		if (!earliest || time < earliest.resetsAt.getTime()) earliest = info;
	}

	return {
		resetInfo: exhausted ?? earliest,
		maxUsedPercent,
		overallMaxUsedPercent: overallMax,
		matchedProvider,
	};
}
