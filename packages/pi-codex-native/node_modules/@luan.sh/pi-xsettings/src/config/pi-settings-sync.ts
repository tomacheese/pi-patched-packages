import { modelOverrideRecord, modelOverrideRows } from "./pi-compaction.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Lockfile from "proper-lockfile";
import { type SettingValue, settingPath } from "../protocol/settings.ts";
import { PI_SETTINGS } from "./pi-settings.ts";
import {
	deletePath,
	getPath,
	parseXSettings,
	setPath,
	type SettingsRecord,
	type StoredSettingValue,
	stringifyXSettings,
} from "./store.ts";

const { lock } = createRequire(realpathSync(fileURLToPath(import.meta.url)))("proper-lockfile") as typeof Lockfile;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type PiValue = SettingValue;
// null records a synchronized deletion; a missing key has no established baseline.
type Snapshot = Record<string, PiValue | null>;

export interface SettingsEdit {
	path: readonly string[];
	value: SettingValue | undefined;
}

export interface SettingsSyncResult {
	document: SettingsRecord;
	conflicts: string[];
}

function isObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObject(source: string): JsonObject {
	const value = JSON.parse(source) as JsonValue;
	if (!isObject(value)) throw new Error("Expected a settings JSON object");
	return value;
}

function readFile(path: string, fallback: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return fallback;
	}
}

function targetPath(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return join(targetPath(dirname(path)), basename(path));
	}
}

function writeFile(path: string, source: string): void {
	const target = targetPath(path);
	mkdirSync(dirname(target), { recursive: true });
	let mode = 0o600;
	try {
		mode = statSync(target).mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = `${target}.tmp-${process.pid}`;
	writeFileSync(temporary, source, { mode });
	renameSync(temporary, target);
}

function isSettingValue(value: JsonValue | StoredSettingValue): value is SettingValue {
	if (value === null || value instanceof Date) return false;
	if (Array.isArray(value)) return value.every(isSettingValue);
	if (typeof value === "object")
		return Object.values(value).every((item) => item !== undefined && isSettingValue(item));
	return (
		typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
	);
}

function piValue(value: JsonValue | StoredSettingValue | undefined, key: string): PiValue | null {
	if (value === undefined) return null;
	if (key === "compaction.modelOverrides") {
		if (!isSettingValue(value)) throw new Error("Invalid compaction model overrides");
		return modelOverrideRows(value);
	}
	if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
	if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) return value;
	throw new Error(`Invalid Pi setting: ${key}`);
}

function jsonPath(document: JsonObject, path: readonly string[]): JsonValue | undefined {
	let current: JsonValue | undefined = document;
	for (const segment of path) current = current !== undefined && isObject(current) ? current[segment] : undefined;
	return current;
}

function putJson(document: JsonObject, path: readonly string[], value: PiValue | null): void {
	const [key, ...rest] = path;
	if (!key) return;
	if (rest.length === 0) {
		if (value === null) delete document[key];
		else document[key] = value;
		return;
	}
	const existing = document[key];
	if (existing !== undefined && !isObject(existing)) throw new Error(`Invalid Pi settings object: ${key}`);
	const child = existing ?? {};
	putJson(child, rest, value);
	if (Object.keys(child).length === 0) delete document[key];
	else document[key] = child;
}

function readBaseline(source: string): Snapshot {
	const document = readObject(source);
	const values: Snapshot = {};
	for (const { key } of PI_SETTINGS) {
		if (Object.hasOwn(document, key)) values[key] = document[key] === null ? null : piValue(document[key], key);
	}
	return values;
}

function equal(left: PiValue | null | undefined, right: PiValue | null | undefined): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function mergeSettings(document: SettingsRecord, json: JsonObject, baseline: Snapshot, edit?: SettingsEdit): string[] {
	const conflicts: string[] = [];
	for (const definition of PI_SETTINGS) {
		const { key } = definition;
		const path = settingPath(definition);
		const stored = getPath(document, path);
		const toml = piValue(stored, key);
		const native = piValue(jsonPath(json, key.split(".")), key);
		let value: PiValue | null;
		if (edit && JSON.stringify(edit.path) === JSON.stringify(path)) value = piValue(edit.value, key);
		else if (equal(toml, native)) value = toml;
		else if (Object.hasOwn(baseline, key)) {
			if (equal(toml, baseline[key])) value = native;
			else if (equal(native, baseline[key])) value = toml;
			else {
				conflicts.push(key);
				continue;
			}
		} else if (toml === null || native === null) value = toml ?? native;
		else {
			conflicts.push(key);
			continue;
		}
		if (value === null) deletePath(document, path);
		else setPath(document, path, value);
		putJson(
			json,
			key.split("."),
			value !== null && key === "compaction.modelOverrides" ? modelOverrideRecord(value) : value,
		);
		baseline[key] = value;
	}
	if (edit) {
		if (edit.value === undefined) deletePath(document, edit.path);
		else setPath(document, edit.path, edit.value);
	}
	return conflicts;
}

/** Reconcile under the same lock used by Pi's native SettingsManager. */
export class PiSettingsSync {
	readonly jsonPath: string;
	readonly baselinePath: string;
	private pending = Promise.resolve();

	constructor(
		readonly tomlPath: string,
		baselinePath?: string,
	) {
		this.jsonPath = join(dirname(tomlPath), "settings.json");
		const identity = createHash("sha256")
			.update(`${targetPath(tomlPath)}\0${targetPath(this.jsonPath)}`)
			.digest("hex");
		this.baselinePath = baselinePath ?? join(homedir(), ".cache", "pi-xsettings", identity, "baseline.json");
	}

	reconcile(edit?: SettingsEdit): Promise<SettingsSyncResult> {
		const result = this.pending.then(async () => {
			mkdirSync(dirname(this.jsonPath), { recursive: true });
			const release = await lock(this.jsonPath, {
				realpath: false,
				retries: { retries: 10, minTimeout: 20, maxTimeout: 100 },
			});
			try {
				return this.reconcileLocked(edit);
			} finally {
				await release();
			}
		});
		this.pending = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private reconcileLocked(edit?: SettingsEdit): SettingsSyncResult {
		const tomlSource = readFile(this.tomlPath, "");
		const document = parseXSettings(tomlSource);
		const originalDocument = JSON.stringify(document);
		const jsonSource = readFile(this.jsonPath, "{}");
		const json = readObject(jsonSource);
		const originalJson = JSON.stringify(json);
		const baselineSource = readFile(this.baselinePath, "{}");
		const baseline = readBaseline(baselineSource);
		const conflicts = mergeSettings(document, json, baseline, edit);
		// No asynchronous gap between reads and writes while holding Pi's lock.
		if (JSON.stringify(document) !== originalDocument) writeFile(this.tomlPath, stringifyXSettings(document));
		if (JSON.stringify(json) !== originalJson) writeFile(this.jsonPath, JSON.stringify(json, null, 2));
		const nextBaseline = JSON.stringify(baseline, null, 2);
		if (nextBaseline !== baselineSource) writeFile(this.baselinePath, nextBaseline);
		return { document, conflicts };
	}
}
