/**
 * Session-isolated pending wait persistence. Only the owning session may
 * restore/clear a wait. Legacy shared waits are adopted only by their owner.
 */
import { existsSync } from "node:fs";
import { fromPendingWaitFile, toPendingWaitFile } from "./handoff.ts";
import { getPendingWaitPath, readJsonFile, removeFileIfExists, writeJsonFile } from "./util.ts";
import type { PendingWait } from "./types.ts";

export type LoadedWait = { kind: "restored"; wait: PendingWait } | { kind: "invalid" };

export class SessionWaitStore {
	private activePath: string | undefined;

	load(sessionFile: string): LoadedWait | null {
		const path = getPendingWaitPath(sessionFile);
		if (existsSync(path)) {
			const wait = fromPendingWaitFile(readJsonFile<unknown>(path));
			if (!wait || wait.sessionFile !== sessionFile) {
				removeFileIfExists(path);
				return { kind: "invalid" };
			}
			this.activePath = path;
			return { kind: "restored", wait };
		}

		// Previous releases used one shared file for all Pi sessions. Never
		// delete or adopt a wait belonging to another session.
		const legacyPath = getPendingWaitPath();
		if (!existsSync(legacyPath)) return null;
		const legacyWait = fromPendingWaitFile(readJsonFile<unknown>(legacyPath));
		if (!legacyWait || legacyWait.sessionFile !== sessionFile) return null;
		this.activePath = legacyPath;
		return { kind: "restored", wait: legacyWait };
	}

	/** Writes the new path before removing an owned legacy file. */
	save(wait: PendingWait): boolean {
		if (!wait.sessionFile) return false;
		const path = getPendingWaitPath(wait.sessionFile);
		if (!writeJsonFile(path, toPendingWaitFile(wait))) return false;
		if (this.activePath && this.activePath !== path) removeFileIfExists(this.activePath);
		this.activePath = path;
		return true;
	}

	clear(): void {
		if (this.activePath) removeFileIfExists(this.activePath);
		this.activePath = undefined;
	}

	/** Drop local ownership without deleting a previous session's saved wait. */
	forget(): void {
		this.activePath = undefined;
	}
}
