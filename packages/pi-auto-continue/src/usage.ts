/**
 * Interpretation of the configured usage command's process result.
 *
 * Extracted from the extension wiring so the exit-code/timeout handling is unit
 * testable. This matters because pi's `exec` reports a timeout-killed process as
 * `code === 0, killed === true`: a signal-terminated child has `code === null`,
 * and the exec wrapper coalesces that to `0`. Checking `code` first therefore
 * turned every CodexBar timeout into "invalid output" and hid the real cause.
 */
import type { UsageFetchStatus } from "./types.ts";

/** The subset of pi's `ExecResult` this module needs. */
export interface UsageCommandProcessResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export interface UsageCommandFailure {
	status: UsageFetchStatus;
	detail: string;
}

export interface UsageCommandOutcome {
	payload: unknown[] | null;
	failure?: UsageCommandFailure;
}

/**
 * Extract the first JSON array from a command's stdout. CodexBar (and similar
 * tools) may print a warning line before the payload, which used to make the
 * whole lookup silently fail.
 */
export function parseUsagePayload(stdout: string): unknown[] | null {
	const trimmed = stdout.trim();
	if (!trimmed) return null;
	try {
		const direct = JSON.parse(trimmed);
		return Array.isArray(direct) ? direct : null;
	} catch {
		// Fall through to a best-effort slice.
	}
	const start = trimmed.indexOf("[");
	const end = trimmed.lastIndexOf("]");
	if (start < 0 || end <= start) return null;
	try {
		const sliced = JSON.parse(trimmed.slice(start, end + 1));
		return Array.isArray(sliced) ? sliced : null;
	} catch {
		return null;
	}
}

/**
 * Turn a finished usage-command run into a payload or a classified failure.
 *
 * Order matters:
 * 1. `killed` is checked first because a killed process can still report
 *    `code === 0`, and its truncated stdout must not be parsed as a successful
 *    response.
 * 2. A parseable JSON array wins even when the exit code is non-zero. CodexBar
 *    exits `1` whenever one provider fails to refresh while still printing a
 *    usable payload for the others (observed roughly one run in five), so
 *    rejecting it made reset detection silently blind at exactly the moment a
 *    provider was in trouble.
 * 3. A spawn failure is reported as `command-missing`. pi's `exec` resolves
 *    (never rejects) with `code: 1, stdout: "", stderr: ""` for ENOENT, so the
 *    "no output at all" case is the missing-command signal and is what drives
 *    the "Install CodexBar" hint.
 */
export function classifyUsageResult(result: UsageCommandProcessResult, argv: string[]): UsageCommandOutcome {
	if (result.killed) {
		return {
			payload: null,
			failure: {
				status: "timeout",
				detail: `${argv.join(" ")} was killed after the configured timeout; increase the 'timeout' setting with /ac config timeout <ms>`,
			},
		};
	}

	const payload = parseUsagePayload(result.stdout);
	if (payload) return { payload };

	if (result.code !== 0) {
		const commandLine = argv.join(" ");
		const producedOutput = result.stdout.trim().length > 0 || result.stderr.trim().length > 0;
		if (!producedOutput) {
			return {
				payload: null,
				failure: {
					status: "command-missing",
					detail: `${commandLine}: command not found or produced no output`,
				},
			};
		}
		const detail = (result.stderr || result.stdout || `exit code ${result.code}`).trim().slice(0, 300);
		return { payload: null, failure: { status: "command-failed", detail } };
	}

	return {
		payload: null,
		failure: { status: "invalid-output", detail: "could not parse a JSON array from the usage command output" },
	};
}
