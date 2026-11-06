/**
 * Duration / clock parsing and formatting. Pure functions, fully unit tested.
 */

const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Render a remaining duration compactly.
 * `1h 05m` / `5m 03s` / `42s` — sub-units that add nothing are dropped.
 */
export function formatRemainingTime(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const totalSecs = Math.ceil(ms / 1000);
	const hours = Math.floor(totalSecs / 3600);
	const minutes = Math.floor((totalSecs % 3600) / 60);
	const seconds = totalSecs % 60;
	const pad = (value: number): string => String(value).padStart(2, "0");

	if (hours > 0) return `${hours}h ${pad(minutes)}m`;
	if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
	return `${seconds}s`;
}

/** Format an absolute time as `HH:MM` in local time. */
export function formatClock(date: Date): string {
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Parse `HH:MM[:SS]` into an absolute timestamp later than `now`.
 * Times already passed today roll over to tomorrow, which matches how provider
 * error bodies phrase resets ("resets at 4:30am").
 */
export function parseClockTime(input: string, now: number = Date.now()): number | null {
	const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(input.trim());
	if (!match) return null;
	const hours = Number.parseInt(match[1] ?? "", 10);
	const minutes = Number.parseInt(match[2] ?? "", 10);
	const seconds = match[3] ? Number.parseInt(match[3], 10) : 0;
	if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
	if (hours > 23 || minutes > 59 || seconds > 59) return null;

	const target = new Date(now);
	target.setHours(hours, minutes, seconds, 0);
	if (target.getTime() <= now) target.setDate(target.getDate() + 1);
	return target.getTime();
}

/**
 * Parse a user supplied wait duration.
 *
 * Accepted forms:
 * - `16:45` / `16:45:30`  -> absolute clock time (today or tomorrow)
 * - `1h30m`, `90m`, `45s`, `2 hours 30 minutes`
 * - `5`                  -> 5 minutes (bare numbers are minutes)
 *
 * Returns milliseconds from `now`, or `null` when the input cannot be parsed.
 */
export function parseDurationInput(input: string, now: number = Date.now()): number | null {
	const text = input.trim().toLowerCase();
	if (!text) return null;

	const clock = parseClockTime(text, now);
	if (clock !== null) {
		const delta = clock - now;
		return delta > 0 && delta <= MAX_DURATION_MS ? delta : null;
	}

	// Reject negative input instead of silently reading "-30m" as 30 minutes.
	if (/^-/.test(text) || /-\s*\d/.test(text)) return null;

	let totalMs = 0;
	let matched = false;

	// Single pass so a token such as "30m" can never be counted twice, and unit
	// names are tried longest-first (`minutes` before `m`).
	const token = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?|h|m|s)(?![a-z])/g;
	for (const match of text.matchAll(token)) {
		const rawValue = match[1];
		const unit = match[2];
		if (!rawValue || !unit) continue;
		const value = Number.parseFloat(rawValue);
		if (!Number.isFinite(value) || value < 0) continue;
		const factor = unit.startsWith("h")
			? 3600 * 1000
			: unit.startsWith("m")
				? 60 * 1000
				: 1000;
		totalMs += value * factor;
		matched = true;
	}

	if (matched) {
		return totalMs > 0 && totalMs <= MAX_DURATION_MS ? totalMs : null;
	}

	const bare = Number.parseFloat(text);
	if (Number.isFinite(bare) && bare > 0) {
		const ms = bare * 60 * 1000;
		return ms <= MAX_DURATION_MS ? ms : null;
	}

	return null;
}

export interface DurationAndPromptResult {
	durationMs: number | null;
	prompt?: string;
}

/**
 * Separate a duration specifier from an optional trailing prompt.
 *
 * Examples:
 * - `45m` -> duration: 45m, prompt: undefined
 * - `45m run the tests` -> duration: 45m, prompt: "run the tests"
 * - `2 hours` -> duration: 2h, prompt: undefined
 * - `2 hours run the tests` -> duration: 2h, prompt: "run the tests"
 * - `1h30m continue` -> duration: 1h30m, prompt: "continue"
 * - `16:30` -> duration: till 16:30, prompt: undefined
 * - `16:30 do something` -> duration: till 16:30, prompt: "do something"
 * - `5` -> duration: 5m, prompt: undefined
 * - `5 do something` -> duration: 5m, prompt: "do something"
 */
export function parseDurationAndPrompt(raw: string, now: number = Date.now()): DurationAndPromptResult {
	const trimmed = raw.trim();
	if (!trimmed) return { durationMs: null };

	// 1. Clock time at the beginning: `HH:MM[:SS] [prompt]`
	const clockMatch = /^(\d{1,2}:\d{2}(?::\d{2})?)(?:\s+(.*))?$/.exec(trimmed);
	if (clockMatch) {
		const clockMs = parseClockTime(clockMatch[1] ?? "", now);
		if (clockMs !== null) {
			const delta = clockMs - now;
			const durationMs = delta > 0 && delta <= MAX_DURATION_MS ? delta : null;
			return { durationMs, prompt: clockMatch[2]?.trim() || undefined };
		}
	}

	// 2. Unit duration at the beginning: `((?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?|h|m|s)\s*)+)(.*)`
	const unitMatch = /^((?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?|h|m|s)(?![a-z])\s*)+)(.*)$/i.exec(trimmed);
	if (unitMatch) {
		const durationMs = parseDurationInput(unitMatch[1] ?? "", now);
		if (durationMs !== null) {
			return { durationMs, prompt: unitMatch[2]?.trim() || undefined };
		}
	}

	// 3. Bare number of minutes at the beginning: `\d+(?:\.\d+)? [prompt]`
	const bareMatch = /^(\d+(?:\.\d+)?)(?:\s+(.*))?$/.exec(trimmed);
	if (bareMatch) {
		const durationMs = parseDurationInput(bareMatch[1] ?? "", now);
		if (durationMs !== null) {
			return { durationMs, prompt: bareMatch[2]?.trim() || undefined };
		}
	}

	return { durationMs: null };
}

export { MAX_DURATION_MS };
