/**
 * Reset-time extraction from HTTP headers and provider error bodies.
 *
 * All entry points are pure (`now` is injectable) and every candidate time is
 * sanity checked: a reset must be in the future and within a plausible horizon,
 * otherwise the parse is rejected instead of producing a nonsense wait (for
 * example year-2286 timestamps from misread millisecond deltas).
 */
import type { QuotaResetInfo } from "./types.ts";

/** Longest wait we are willing to believe: 60 days. */
const MAX_FUTURE_MS = 60 * 24 * 60 * 60 * 1000;
/** `retry-after` style deltas longer than 7 days are almost certainly a misread epoch. */
const MAX_DELTA_MS = 7 * 24 * 60 * 60 * 1000;

export function isPlausibleReset(time: number, now: number, maxFutureMs: number = MAX_FUTURE_MS): boolean {
	return Number.isFinite(time) && time > now && time - now <= maxFutureMs;
}

/**
 * Parse an ISO/RFC3339-ish timestamp found in a provider error body.
 *
 * Provider payloads are server generated and use UTC, so a timestamp without an
 * explicit offset is treated as UTC rather than as the machine's local zone.
 * (JS `new Date("2026-09-20 04:01:02")` is implementation defined and V8 reads
 * it as local time, which silently shifts the wait by the UTC offset.)
 */
export function parseIsoTimestamp(raw: string): Date | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	// Already has an explicit zone/offset.
	if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
		const direct = new Date(trimmed);
		return Number.isNaN(direct.getTime()) ? null : direct;
	}

	// Normalise "YYYY-MM-DD HH:MM:SS[.sss]" to "YYYY-MM-DDTHH:MM:SS[.sss]Z".
	const normalized = `${trimmed.replace(" ", "T")}Z`;
	const utc = new Date(normalized);
	return Number.isNaN(utc.getTime()) ? null : utc;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}

/**
 * Resolve a numeric rate-limit-reset header.
 *
 * Providers are inconsistent: the value may be an epoch in seconds, an epoch in
 * milliseconds, a delta in seconds, or a delta in milliseconds. We disambiguate
 * by magnitude and then validate the resulting instant.
 */
export function resolveNumericReset(raw: number, now: number): number | null {
	if (!Number.isFinite(raw) || raw <= 0) return null;

	if (raw >= 1e12) {
		// Milliseconds since epoch (>= 2001-09-09).
		return isPlausibleReset(raw, now) ? raw : null;
	}
	if (raw >= 1e9) {
		// Seconds since epoch (>= 2001-09-09).
		const ms = raw * 1000;
		return isPlausibleReset(ms, now) ? ms : null;
	}
	if (raw >= 1e6) {
		// Delta in milliseconds (>= 16.7 minutes). A delta in seconds this large
		// would mean a rate limit longer than 11 days, which providers do not send.
		const ms = now + raw;
		return isPlausibleReset(ms, now, MAX_FUTURE_MS) ? ms : null;
	}
	// Delta in seconds.
	const ms = now + raw * 1000;
	return isPlausibleReset(ms, now, MAX_FUTURE_MS) ? ms : null;
}

export function parseHeaderReset(
	headers: Record<string, string> | undefined,
	provider: string,
	now: number = Date.now(),
): QuotaResetInfo | null {
	if (!headers || Object.keys(headers).length === 0) return null;

	const retryAfter = getHeader(headers, "retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		if (Number.isFinite(seconds) && seconds > 0) {
			const ms = seconds * 1000;
			if (ms <= MAX_DELTA_MS) {
				return {
					resetsAt: new Date(now + ms),
					provider,
					source: "http-header",
					windowTitle: "Retry-After",
					windowFamily: "unknown",
				};
			}
		} else {
			const httpDate = new Date(retryAfter);
			if (isPlausibleReset(httpDate.getTime(), now)) {
				return {
					resetsAt: httpDate,
					provider,
					source: "http-header",
					windowTitle: "Retry-After (date)",
					windowFamily: "unknown",
				};
			}
		}
	}

	const numericHeaders = [
		["x-ratelimit-reset", "X-RateLimit-Reset"],
		["x-ratelimit-reset-requests", "X-RateLimit-Reset-Requests"],
		["anthropic-ratelimit-unified-reset", "Anthropic Unified Reset"],
		["anthropic-ratelimit-requests-reset", "Anthropic Requests Reset"],
		["x-codex-reset-at", "Codex Reset At"],
		["ratelimit-reset", "RateLimit-Reset"],
	] as const;

	for (const [header, label] of numericHeaders) {
		const value = getHeader(headers, header);
		if (!value) continue;

		const numeric = Number.parseFloat(value);
		const resolved = resolveNumericReset(numeric, now);
		if (resolved !== null) {
			return {
				resetsAt: new Date(resolved),
				provider,
				source: "http-header",
				windowTitle: label,
				windowFamily: "unknown",
			};
		}

		const parsedDate = parseIsoTimestamp(value);
		if (parsedDate && isPlausibleReset(parsedDate.getTime(), now)) {
			return {
				resetsAt: parsedDate,
				provider,
				source: "http-header",
				windowTitle: label,
				windowFamily: "unknown",
			};
		}
	}

	return null;
}

const ISO_PATTERN = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/;
// `(?:~\s*)?` covers `Resets in ~125h` without letting two `\s` quantifiers compete
// for the same whitespace (quadratic backtracking); (?![a-z]) rather than \b so `1h30m` parses.
const RELATIVE_PATTERN = /(?:in|after|wait|try again in)\s+(?:~\s*)?((?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])\s*)+)/i;
const CLOCK_PATTERN = /(?:at|until|resets? at)\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?/i;

/** Parse a relative duration phrase such as `1 hour 30 minutes`. */
export function parseRelativeDuration(text: string): number | null {
	let totalMs = 0;
	let matched = false;
	const token = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?|h|m|s)(?![a-z])/g;
	for (const match of text.matchAll(token)) {
		const rawValue = match[1];
		const unit = match[2];
		if (!rawValue || !unit) continue;
		const value = Number.parseFloat(rawValue);
		if (!Number.isFinite(value)) continue;
		const factor = unit.startsWith("h") ? 3600_000 : unit.startsWith("m") ? 60_000 : 1000;
		totalMs += value * factor;
		matched = true;
	}
	return matched && totalMs > 0 ? totalMs : null;
}

export function parseErrorBodyReset(
	text: string | undefined,
	provider: string,
	now: number = Date.now(),
): QuotaResetInfo | null {
	if (!text) return null;

	const isoMatch = ISO_PATTERN.exec(text);
	if (isoMatch?.[1]) {
		const parsed = parseIsoTimestamp(isoMatch[1]);
		if (parsed && isPlausibleReset(parsed.getTime(), now)) {
			return {
				resetsAt: parsed,
				provider,
				source: "error-body",
				windowTitle: "Error Timestamp",
				windowFamily: "unknown",
			};
		}
	}

	const relativeMatch = RELATIVE_PATTERN.exec(text);
	if (relativeMatch?.[1]) {
		const delta = parseRelativeDuration(relativeMatch[1]);
		if (delta !== null && delta <= MAX_DELTA_MS) {
			return {
				resetsAt: new Date(now + delta),
				provider,
				source: "error-body",
				windowTitle: "Error Duration",
				windowFamily: "unknown",
			};
		}
	}

	const clockMatch = CLOCK_PATTERN.exec(text);
	if (clockMatch?.[1] && clockMatch[2]) {
		let hours = Number.parseInt(clockMatch[1], 10);
		const minutes = Number.parseInt(clockMatch[2], 10);
		const seconds = clockMatch[3] ? Number.parseInt(clockMatch[3], 10) : 0;
		const ampm = clockMatch[4]?.toLowerCase();
		if (ampm === "pm" && hours < 12) hours += 12;
		if (ampm === "am" && hours === 12) hours = 0;
		if (Number.isFinite(hours) && hours <= 23 && minutes <= 59 && seconds <= 59) {
			const target = new Date(now);
			target.setHours(hours, minutes, seconds, 0);
			if (target.getTime() <= now) target.setDate(target.getDate() + 1);
			if (isPlausibleReset(target.getTime(), now)) {
				return {
					resetsAt: target,
					provider,
					source: "error-body",
					windowTitle: "Error Clock Time",
					windowFamily: "unknown",
				};
			}
		}
	}

	return null;
}

/**
 * Patterns that indicate the failure is a quota/rate limit rather than a real bug.
 *
 * These are deliberately anchored on word boundaries: the previous substring
 * list matched any message containing "429" (for example "completed in 1429ms")
 * or the bare word "capacity", which could open the rate-limit dialog for an
 * unrelated error.
 */
const RATE_LIMIT_PATTERNS: RegExp[] = [
	/\brate[ _-]?limit(?:s|ed|ing)?(?![a-z])/i,
	/\busage[ _-]?limit(?:s|ed|ing)?/i,
	/\bquota[ _-]?(exceeded|exhausted|exceed|reached)/i,
	/\binsufficient (quota|capacity|credits?|balance)/i,
	/\bresource[ _-]?(has been )?exhausted(?![a-z])/i,
	/\btoo many requests/i,
	/\boverloaded(?![a-z])/i,
	/\bcredit balance is too low/i,
	/(?:^|[^0-9])429(?![0-9])/,
];

/**
 * Transient provider failures that clear on their own within minutes but are not
 * rate limits (for example the Codex transport exhausting its stream retries).
 */
const TRANSIENT_ERROR_PATTERNS: RegExp[] = [/\bstream retry budget was exhausted/i];

export function isTransientProviderError(message: string | undefined): boolean {
	if (!message) return false;
	return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function isRateLimitError(message: string | undefined): boolean {
	if (!message) return false;
	return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}
