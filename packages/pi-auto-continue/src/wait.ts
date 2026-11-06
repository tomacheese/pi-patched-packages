/**
 * Wait/countdown scheduler.
 *
 * Safety properties this class guarantees:
 * - no timer callback can throw out of the event loop (an uncaught throw inside
 *   `setInterval` terminates pi), because every callback body is wrapped
 * - timers are `unref()`ed so a pending multi-hour wait cannot keep the process
 *   alive, and `dispose()` clears them on `session_shutdown`
 * - state changes are reported through a callback so the caller can persist a
 *   pending wait and restore it after a restart
 */
import { formatClock, formatRemainingTime } from "./duration.ts";
import { logDebug, messageOf } from "./util.ts";

export interface WaitDeps {
	/** Called to render status text. Must never throw. */
	setStatus: (text: string | undefined) => void;
	/** Called exactly once when the wait elapses. May be async; errors are caught. */
	onFire: (wait: PendingWaitLike) => Promise<void> | void;
	/** Called whenever the pending wait is created or cleared. */
	onChange: (wait: PendingWaitLike | null) => void;
	tickMs?: number;
	/** Extra buffer added after the provider reset time. Defaults to 5s. */
	bufferMs?: number;
	/** Floor for the fire delay. Defaults to 1s (keeps the buffer meaningful). */
	minDelayMs?: number;
	log?: (message: string) => void;
}

export interface PendingWaitLike {
	targetTime: Date;
	provider: string;
	strategy: "handoff" | "inplace";
	customPrompt?: string;
	handoffFile?: string;
	sessionFile?: string;
}

export class WaitScheduler {
	private readonly deps: WaitDeps;
	private wait: PendingWaitLike | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private interval: ReturnType<typeof setInterval> | null = null;
	private firing = false;

	constructor(deps: WaitDeps) {
		this.deps = deps;
	}

	get current(): PendingWaitLike | null {
		return this.wait;
	}

	private log(message: string): void {
		(this.deps.log ?? logDebug)(message);
	}

	private render(): void {
		const wait = this.wait;
		if (!wait) return;
		const remaining = wait.targetTime.getTime() - Date.now();
		const label = wait.strategy === "handoff" ? "Handoff (new session)" : "In-place";
		if (remaining <= 0) {
			this.deps.setStatus(`⏳ [Auto-Continue] Quota ready, launching ${label}...`);
			return;
		}
		this.deps.setStatus(
			`⏳ [${label}] Resumes at ${formatClock(wait.targetTime)} (in ${formatRemainingTime(remaining)}) · /ac cancel to stop`,
		);
	}

	start(wait: PendingWaitLike): void {
		this.stop({ silent: true });
		this.wait = wait;
		try {
			this.deps.onChange(wait);
		} catch (error) {
			this.log(`onChange(start) failed: ${messageOf(error)}`);
		}

		const guard = (fn: () => void, what: string): void => {
			try {
				fn();
			} catch (error) {
				this.log(`${what} failed: ${messageOf(error)}`);
			}
		};

		guard(() => this.render(), "render");

		this.interval = setInterval(() => guard(() => this.render(), "render"), this.deps.tickMs ?? 1000);
		this.interval.unref?.();

		const delay = Math.max(wait.targetTime.getTime() - Date.now() + (this.deps.bufferMs ?? 5000), this.deps.minDelayMs ?? 1000);
		this.timer = setTimeout(() => {
			void this.fire();
		}, delay);
		this.timer.unref?.();
	}

	private clearTimers(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	private async fire(): Promise<void> {
		if (this.firing) return;
		this.firing = true;

		const wait = this.wait;
		this.clearTimers();
		this.wait = null;

		try {
			this.deps.onChange(null);
		} catch (error) {
			this.log(`onChange(fire) failed: ${messageOf(error)}`);
		}

		try {
			this.deps.setStatus(undefined);
			this.deps.setStatus("⏰ [Auto-Continue] Quota reset reached, resuming...");
		} catch (error) {
			this.log(`status update failed: ${messageOf(error)}`);
		}

		try {
			if (wait) await this.deps.onFire(wait);
		} catch (error) {
			this.log(`onFire failed: ${messageOf(error)}`);
		} finally {
			this.firing = false;
			try {
				this.deps.setStatus(undefined);
			} catch (error) {
				this.log(`status clear failed: ${messageOf(error)}`);
			}
		}
	}

	/** Stop the countdown. Returns the wait that was cancelled, if any. */
	stop(options: { silent?: boolean } = {}): PendingWaitLike | null {
		const wait = this.wait;
		this.clearTimers();
		this.wait = null;
		if (wait) {
			try {
				this.deps.onChange(null);
			} catch (error) {
				this.log(`onChange(stop) failed: ${messageOf(error)}`);
			}
			if (!options.silent) {
				try {
					this.deps.setStatus(undefined);
				} catch (error) {
					this.log(`status clear failed: ${messageOf(error)}`);
				}
			}
		}
		return wait;
	}

	/**
	 * Called from `session_shutdown`: drop timers and in-memory state *without*
	 * clearing the persisted pending wait, so the next session can restore it.
	 */
	dispose(): void {
		this.clearTimers();
		this.wait = null;
	}

	/** Status text for `/cancel-wait` style messages. */
	static describe(wait: PendingWaitLike): string {
		return `${wait.strategy} wait until ${formatClock(wait.targetTime)} (${wait.provider})`;
	}
}
