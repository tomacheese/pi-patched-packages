/**
 * Config loading, validation and persistence.
 *
 * The config lives on disk (not in the extension closure) because pi rebuilds
 * the resource loader and re-runs the extension factory on every session
 * replacement — including the handoff-to-a-fresh-session path this extension
 * itself triggers. In-memory-only settings would silently reset there.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { getConfigPath, clampBool, clampInt, ensureDir, isRecord, logDebug, readJsonFile, splitCommandLine, writeJsonFile } from "./util.ts";
import type { PluginConfig } from "./types.ts";

export const DEFAULT_CONFIG: PluginConfig = {
	strategy: "handoff",
	handoffThreshold: 90,
	autoMode: "prompt",
	autoResumeMaxWaitMinutes: 240,
	usageCommand: ["codexbar", "usage", "--json"],
	usageCommandTimeoutMs: 30000,
	handoffRetention: 20,
	handoffMaxTurns: 12,
	handoffMaxChars: 120_000,
	resumeImmediatelyOnResetCredits: true,
};

const STRATEGIES = new Set(["handoff", "inplace"]);
const AUTO_MODES = new Set(["auto", "prompt"]);

/** Normalise arbitrary parsed JSON into a valid config, filling in defaults. */
export function normalizeConfig(raw: unknown): PluginConfig {
	if (!isRecord(raw)) return { ...DEFAULT_CONFIG };

	const strategy = typeof raw["strategy"] === "string" && STRATEGIES.has(raw["strategy"])
		? (raw["strategy"] as PluginConfig["strategy"])
		: DEFAULT_CONFIG.strategy;
	const autoMode = typeof raw["autoMode"] === "string" && AUTO_MODES.has(raw["autoMode"])
		? (raw["autoMode"] as PluginConfig["autoMode"])
		: DEFAULT_CONFIG.autoMode;

	const usageCommand = Array.isArray(raw["usageCommand"])
		? raw["usageCommand"].filter((part): part is string => typeof part === "string" && part.length > 0)
		: [];

	return {
		strategy,
		autoMode,
		handoffThreshold: clampInt(raw["handoffThreshold"], 10, 99, DEFAULT_CONFIG.handoffThreshold),
		autoResumeMaxWaitMinutes: clampInt(raw["autoResumeMaxWaitMinutes"], 1, 7 * 24 * 60, DEFAULT_CONFIG.autoResumeMaxWaitMinutes),
		usageCommand: usageCommand.length > 0 ? usageCommand : [...DEFAULT_CONFIG.usageCommand],
		usageCommandTimeoutMs: clampInt(raw["usageCommandTimeoutMs"], 500, 60_000, DEFAULT_CONFIG.usageCommandTimeoutMs),
		handoffRetention: clampInt(raw["handoffRetention"], 1, 500, DEFAULT_CONFIG.handoffRetention),
		handoffMaxTurns: clampInt(raw["handoffMaxTurns"], 1, 500, DEFAULT_CONFIG.handoffMaxTurns),
		handoffMaxChars: clampInt(raw["handoffMaxChars"], 2_000, 2_000_000, DEFAULT_CONFIG.handoffMaxChars),
		resumeImmediatelyOnResetCredits: clampBool(raw["resumeImmediatelyOnResetCredits"], DEFAULT_CONFIG.resumeImmediatelyOnResetCredits),
	};
}

export function loadConfig(path: string = getConfigPath()): PluginConfig {
	return normalizeConfig(readJsonFile<unknown>(path));
}

export function saveConfig(config: PluginConfig, path: string = getConfigPath()): boolean {
	ensureDir(dirname(path));
	const ok = writeJsonFile(path, config);
	if (!ok) logDebug(`failed to persist config to ${path}`);
	return ok;
}

export interface ConfigMutationResult {
	ok: boolean;
	message: string;
}

/** Settings exposed by `/ac config`; each has a one-line description. */
export const CONFIG_KEYS: Record<string, { describe: string; read: (config: PluginConfig) => string }> = {
	strategy: {
		describe: "handoff | inplace — what to do when the reset time is reached",
		read: (config) => config.strategy,
	},
	threshold: {
		describe: "10-99 — pre-generate the handoff at this used percent",
		read: (config) => `${config.handoffThreshold}%`,
	},
	mode: {
		describe: "auto | prompt — auto waits silently only within automaxwait",
		read: (config) => config.autoMode,
	},
	automaxwait: {
		describe: "1-10080 minutes — longest reset that `auto` mode waits silently",
		read: (config) => `${config.autoResumeMaxWaitMinutes}m`,
	},
	usagecommand: {
		describe: "command line used to read provider usage (default: codexbar usage --json; the default gets --provider <id> appended)",
		read: (config) => config.usageCommand.join(" "),
	},
	timeout: {
		describe: "500-60000 ms — how long the usage command may run before it is killed",
		read: (config) => `${config.usageCommandTimeoutMs}ms`,
	},
	retention: {
		describe: "1-500 — how many handoff files to keep",
		read: (config) => String(config.handoffRetention),
	},
	maxturns: {
		describe: "1-500 — trailing messages included in the handoff prompt",
		read: (config) => String(config.handoffMaxTurns),
	},
	maxchars: {
		describe: "2000-2000000 — character budget for the serialized conversation",
		read: (config) => String(config.handoffMaxChars),
	},
	resetcredits: {
		describe: "true | false — offer an immediate resume when reset credits exist",
		read: (config) => String(config.resumeImmediatelyOnResetCredits),
	},
};

export function describeConfig(config: PluginConfig): string {
	return Object.entries(CONFIG_KEYS)
		.map(([key, meta]) => `• ${key} = ${meta.read(config)}  (${meta.describe})`)
		.join("\n");
}

/** Apply a single `/ac config <key> <value>` mutation in place. */
export function applyConfigSetting(config: PluginConfig, key: string, value: string | undefined): ConfigMutationResult {
	const normalizedKey = key.trim().toLowerCase();

	if (normalizedKey === "usagecommand") {
		const argv = value ? splitCommandLine(value) : [];
		if (argv.length === 0) return { ok: false, message: "usagecommand needs a command line, e.g. `usagecommand codexbar usage --json`" };
		config.usageCommand = argv;
		return { ok: true, message: `usageCommand = ${argv.join(" ")}` };
	}

	if (value === undefined || value.trim() === "") {
		return { ok: false, message: `Usage: /ac config ${Object.keys(CONFIG_KEYS).join("|")} <value>` };
	}
	const raw = value.trim().toLowerCase();

	switch (normalizedKey) {
		case "strategy": {
			if (!STRATEGIES.has(raw)) return { ok: false, message: "strategy must be `handoff` or `inplace`" };
			config.strategy = raw as PluginConfig["strategy"];
			return { ok: true, message: `strategy = ${config.strategy}` };
		}
		case "mode": {
			if (!AUTO_MODES.has(raw)) return { ok: false, message: "mode must be `auto` or `prompt`" };
			config.autoMode = raw as PluginConfig["autoMode"];
			return { ok: true, message: `mode = ${config.autoMode}` };
		}
		case "threshold": {
			const parsed = Number.parseInt(raw, 10);
			if (!Number.isFinite(parsed)) return { ok: false, message: "threshold must be a number between 10 and 99" };
			config.handoffThreshold = clampInt(parsed, 10, 99, DEFAULT_CONFIG.handoffThreshold);
			return { ok: true, message: `threshold = ${config.handoffThreshold}%` };
		}
		case "automaxwait": {
			const parsed = Number.parseInt(raw, 10);
			if (!Number.isFinite(parsed)) return { ok: false, message: "automaxwait must be minutes between 1 and 10080" };
			config.autoResumeMaxWaitMinutes = clampInt(parsed, 1, 7 * 24 * 60, DEFAULT_CONFIG.autoResumeMaxWaitMinutes);
			return { ok: true, message: `automaxwait = ${config.autoResumeMaxWaitMinutes}m` };
		}
		case "timeout": {
			const parsed = Number.parseInt(raw, 10);
			if (!Number.isFinite(parsed)) return { ok: false, message: "timeout must be a number of milliseconds between 500 and 60000" };
			config.usageCommandTimeoutMs = clampInt(parsed, 500, 60_000, DEFAULT_CONFIG.usageCommandTimeoutMs);
			return { ok: true, message: `timeout = ${config.usageCommandTimeoutMs}ms` };
		}
		case "retention": {
			const parsed = Number.parseInt(raw, 10);
			if (!Number.isFinite(parsed)) return { ok: false, message: "retention must be a number between 1 and 500" };
			config.handoffRetention = clampInt(parsed, 1, 500, DEFAULT_CONFIG.handoffRetention);
			return { ok: true, message: `retention = ${config.handoffRetention}` };
		}
		case "maxturns": {
			const parsed = Number.parseInt(raw, 10);
			if (!Number.isFinite(parsed)) return { ok: false, message: "maxturns must be a number between 1 and 500" };
			config.handoffMaxTurns = clampInt(parsed, 1, 500, DEFAULT_CONFIG.handoffMaxTurns);
			return { ok: true, message: `maxturns = ${config.handoffMaxTurns}` };
		}
		case "maxchars": {
			const parsed = Number.parseInt(raw, 10);
			if (!Number.isFinite(parsed)) return { ok: false, message: "maxchars must be a number between 2000 and 2000000" };
			config.handoffMaxChars = clampInt(parsed, 2_000, 2_000_000, DEFAULT_CONFIG.handoffMaxChars);
			return { ok: true, message: `maxchars = ${config.handoffMaxChars}` };
		}
		case "resetcredits": {
			if (raw !== "true" && raw !== "false") return { ok: false, message: "resetcredits must be `true` or `false`" };
			config.resumeImmediatelyOnResetCredits = raw === "true";
			return { ok: true, message: `resetcredits = ${config.resumeImmediatelyOnResetCredits}` };
		}
		default:
			return { ok: false, message: `Unknown key \`${key}\`. Known keys: ${Object.keys(CONFIG_KEYS).join(", ")}` };
	}
}

/** True when the config file exists on disk. */
export function hasConfigFile(path: string = getConfigPath()): boolean {
	return existsSync(path);
}

/** True when the config file exists but could not be parsed (surfaced to the user). */
export function configFileLooksBroken(path: string = getConfigPath()): boolean {
	return existsSync(path) && readJsonFile<unknown>(path) === undefined;
}
