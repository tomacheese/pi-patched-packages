import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	symlinkSync,
	lstatSync,
	mkdirSync,
	renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { configuredPiValues } from "../src/config/pi-settings.ts";
import { PiSettingsSync } from "../src/config/pi-settings-sync.ts";
import { XSettingsStore } from "../src/config/store.ts";
import { watchSettings } from "../src/runtime/settings-watch.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(toml = "", json = "{}") {
	const directory = mkdtempSync(join(tmpdir(), "pi-xsettings-sync-"));
	directories.push(directory);
	const tomlPath = join(directory, "xsettings.toml");
	const jsonPath = join(directory, "settings.json");
	const baselinePath = join(directory, "state", "baseline.json");
	writeFileSync(tomlPath, toml);
	writeFileSync(jsonPath, json);
	return {
		directory,
		tomlPath,
		jsonPath,
		baselinePath,
		store: new XSettingsStore(tomlPath),
		sync: new PiSettingsSync(tomlPath, baselinePath),
	};
}

describe("Pi settings reconciliation", () => {
	test("exports native codemode settings without dropping bootstrap configuration", async () => {
		const f = fixture(
			'[tools]\npi.codemode.mode = "only"\npi.codemode.inlineBudget = 1000\n',
			'{"packages":["pi-xsettings"],"codemode":{"other":true}}',
		);
		await f.sync.reconcile();
		expect(JSON.parse(readFileSync(f.jsonPath, "utf8"))).toEqual({
			packages: ["pi-xsettings"],
			codemode: { mode: "only", inlineBudget: 1000, other: true },
		});
	});
	test("reads owner-prefixed Pi values from category tables", () => {
		expect(configuredPiValues({ appearance: { pi: { theme: "dark", terminal: { showImages: false } } } })).toEqual({
			theme: "dark",
			"terminal.showImages": false,
		});
	});

	test("imports native values on first load and preserves bootstrap and extension settings", async () => {
		const f = fixture(
			'[tools]\nother.value = "kept"\n',
			'{"packages":["pi-xsettings"],"theme":"dark","terminal":{"showImages":false,"other":1}}',
		);
		const before = readFileSync(f.jsonPath, "utf8");
		const result = await f.sync.reconcile();
		expect(result.conflicts).toEqual([]);
		expect(configuredPiValues(result.document)).toEqual({ theme: "dark", "terminal.showImages": false });
		expect(result.document.tools).toEqual({ other: { value: "kept" } });
		expect(readFileSync(f.jsonPath, "utf8")).toBe(before);
	});

	test("exports TOML-only values and does not rewrite settled files", async () => {
		const f = fixture('[appearance]\npi.theme = "dark"\n');
		await f.sync.reconcile();
		expect(readFileSync(f.jsonPath, "utf8")).toContain('"theme": "dark"');
		const before = [f.tomlPath, f.jsonPath, f.baselinePath].map((path) => readFileSync(path, "utf8"));
		await f.sync.reconcile();
		expect([f.tomlPath, f.jsonPath, f.baselinePath].map((path) => readFileSync(path, "utf8"))).toEqual(before);
	});

	test("preserves initial disagreement until the user explicitly resolves it", async () => {
		const f = fixture('[behavior]\npi.enabledModels = ["openai/astra"]\n', '{"enabledModels":["openai-codex/astra"]}');
		const before = [f.tomlPath, f.jsonPath].map((path) => readFileSync(path, "utf8"));
		for (let attempt = 0; attempt < 2; attempt++) {
			expect((await f.sync.reconcile()).conflicts).toEqual(["enabledModels"]);
			expect([f.tomlPath, f.jsonPath].map((path) => readFileSync(path, "utf8"))).toEqual(before);
		}
		const result = await f.sync.reconcile({ path: ["behavior", "pi", "enabledModels"], value: ["openai-codex/astra"] });
		expect(result.conflicts).toEqual([]);
		expect(configuredPiValues(result.document).enabledModels).toEqual(["openai-codex/astra"]);
	});

	test.each([
		["base", "native", "native", false],
		["toml", "base", "toml", false],
		["same", "same", "same", false],
		["toml", "native", undefined, true],
		[undefined, "base", undefined, false],
		["base", undefined, undefined, false],
		[undefined, "native", undefined, true],
		["toml", undefined, undefined, true],
	] as const)("reconciles TOML %s and JSON %s from a common baseline", async (toml, json, expected, conflict) => {
		const f = fixture('[appearance]\npi.theme = "base"\n', '{"theme":"base"}');
		await f.sync.reconcile();
		if (toml === undefined) await f.store.unset(["appearance", "pi", "theme"]);
		else await f.store.set(["appearance", "pi", "theme"], toml);
		writeFileSync(f.jsonPath, JSON.stringify({ theme: json }));
		const before = [f.tomlPath, f.jsonPath].map((path) => readFileSync(path, "utf8"));
		// A new process must use the persisted baseline, not its own starting snapshot.
		const result = await new PiSettingsSync(f.tomlPath, f.baselinePath).reconcile();
		expect(result.conflicts).toEqual(conflict ? ["theme"] : []);
		if (conflict) expect([f.tomlPath, f.jsonPath].map((path) => readFileSync(path, "utf8"))).toEqual(before);
		else {
			if (expected === undefined) expect(configuredPiValues(result.document).theme).toBeUndefined();
			else expect(configuredPiValues(result.document).theme).toBe(expected);
			expect(JSON.parse(readFileSync(f.jsonPath, "utf8")).theme).toBe(expected);
		}
	});

	test("native SettingsManager edits survive an unrelated xsettings save and restart", async () => {
		const f = fixture('[appearance]\npi.theme = "dark"\n[behavior]\npi.enabledModels = ["a", "b"]\n');
		await f.sync.reconcile();
		const native = SettingsManager.create(f.directory, f.directory, { projectTrusted: false });
		native.setEnabledModels(["b", "a", "c"]);
		native.setTheme("light");
		await native.flush();
		const result = await f.sync.reconcile({ path: ["tools", "extension", "enabled"], value: true });
		expect(configuredPiValues(result.document)).toEqual({ theme: "light", enabledModels: ["b", "a", "c"] });
		expect(result.document.tools).toEqual({ extension: { enabled: true } });
		expect((await new PiSettingsSync(f.tomlPath, f.baselinePath).reconcile()).conflicts).toEqual([]);
		native.setEnabledModels(undefined);
		await native.flush();
		expect(configuredPiValues((await f.sync.reconcile()).document).enabledModels).toBeUndefined();
	});

	test("merges independent nested changes and keeps a conflicting setting untouched", async () => {
		const f = fixture(
			'[appearance]\npi.theme = "dark"\n[behavior]\npi.compaction.enabled = true\npi.compaction.reserveTokens = 10\n',
		);
		await f.sync.reconcile();
		await f.store.set(["appearance", "pi", "theme"], "toml");
		await f.store.set(["behavior", "pi", "compaction", "enabled"], false);
		writeFileSync(f.jsonPath, '{"theme":"native","compaction":{"enabled":true,"reserveTokens":20,"other":"kept"}}');
		const result = await f.sync.reconcile();
		expect(result.conflicts).toEqual(["theme"]);
		expect(configuredPiValues(result.document)).toMatchObject({
			theme: "toml",
			"compaction.enabled": false,
			"compaction.reserveTokens": 20,
		});
		expect(JSON.parse(readFileSync(f.jsonPath, "utf8"))).toEqual({
			theme: "native",
			compaction: { enabled: false, reserveTokens: 20, other: "kept" },
		});
	});

	test("a stale native session cannot restore a removed model through an unrelated save", async () => {
		const f = fixture('[behavior]\npi.enabledModels = ["openai/astra", "openai-codex/astra"]\n');
		await f.sync.reconcile();
		const native = SettingsManager.create(f.directory, f.directory, { projectTrusted: false });
		await f.store.set(["behavior", "pi", "enabledModels"], ["openai-codex/astra"]);
		await f.sync.reconcile();
		native.setTheme("dark");
		await native.flush();
		const restarted = new PiSettingsSync(f.tomlPath, f.baselinePath);
		expect((await restarted.reconcile()).conflicts).toEqual([]);
		expect(configuredPiValues((await restarted.reconcile()).document).enabledModels).toEqual(["openai-codex/astra"]);
		expect(JSON.parse(readFileSync(f.jsonPath, "utf8")).enabledModels).toEqual(["openai-codex/astra"]);
	});

	test.each(["toml", "json", "baseline"] as const)(
		"does not overwrite files after invalid %s and recovers after repair",
		async (broken) => {
			const f = fixture('[appearance]\npi.theme = "dark"\n');
			await f.sync.reconcile();
			const path = broken === "toml" ? f.tomlPath : broken === "json" ? f.jsonPath : f.baselinePath;
			const original = readFileSync(path, "utf8");
			writeFileSync(path, "[broken");
			const before = [f.tomlPath, f.jsonPath, f.baselinePath].map((file) => readFileSync(file, "utf8"));
			await expect(f.sync.reconcile()).rejects.toThrow();
			expect([f.tomlPath, f.jsonPath, f.baselinePath].map((file) => readFileSync(file, "utf8"))).toEqual(before);
			writeFileSync(path, original);
			expect((await f.sync.reconcile()).conflicts).toEqual([]);
		},
	);

	test("concurrent hosts reread state under the shared lock", async () => {
		const f = fixture();
		const other = new PiSettingsSync(f.tomlPath, f.baselinePath);
		await Promise.all([
			f.sync.reconcile({ path: ["appearance", "pi", "theme"], value: "dark" }),
			other.reconcile({ path: ["behavior", "pi", "enabledModels"], value: ["a"] }),
		]);
		expect(configuredPiValues((await f.sync.reconcile()).document)).toEqual({ theme: "dark", enabledModels: ["a"] });
	});

	test("watches atomic replacement behind managed symlinks and leaves both links intact", async () => {
		const f = fixture('[appearance]\npi.theme = "dark"\n');
		const repository = join(f.directory, "repo");
		mkdirSync(repository);
		for (const path of [f.tomlPath, f.jsonPath]) {
			const target = join(repository, path === f.tomlPath ? "xsettings.toml" : "settings.json");
			renameSync(path, target);
			symlinkSync(target, path);
		}
		await f.sync.reconcile();
		let stop = () => {};
		try {
			await new Promise<void>((resolve, reject) => {
				stop = watchSettings(
					[f.tomlPath, f.jsonPath],
					async () => {
						const result = await f.sync.reconcile();
						if (configuredPiValues(result.document).theme === "light") resolve();
					},
					reject,
				);
				const temporary = join(repository, "replacement.json");
				writeFileSync(temporary, '{"theme":"light"}');
				renameSync(temporary, join(repository, "settings.json"));
			});
		} finally {
			stop();
		}
		expect(lstatSync(f.tomlPath).isSymbolicLink()).toBe(true);
		expect(lstatSync(f.jsonPath).isSymbolicLink()).toBe(true);
		expect(configuredPiValues(await f.store.load()).theme).toBe("light");
	});
});

test("per-model budgets round-trip through native settings with inherited values", async () => {
	const f = fixture(
		"",
		JSON.stringify({
			cacheWarming: "idle",
			compaction: {
				modelOverrides: {
					"openai-codex/gpt-6-sol": { reserveTokens: 32768 },
				},
			},
		}),
	);
	const imported = await f.sync.reconcile();
	expect(configuredPiValues(imported.document)).toMatchObject({
		cacheWarming: "idle",
		"compaction.modelOverrides": [
			{ model: "openai-codex/gpt-6-sol", reserveTokens: 32768, keepRecentTokens: "inherit" },
		],
	});
	await f.sync.reconcile({
		path: ["behavior", "pi", "compaction", "modelOverrides"],
		value: [{ model: "openai-codex/gpt-6-luna", reserveTokens: "inherit", keepRecentTokens: 0 }],
	});
	const native = JSON.parse(readFileSync(f.jsonPath, "utf8"));
	expect(native.compaction.modelOverrides).toEqual({ "openai-codex/gpt-6-luna": { keepRecentTokens: 0 } });
	const before = readFileSync(f.tomlPath, "utf8");
	await f.sync.reconcile();
	expect(readFileSync(f.tomlPath, "utf8")).toBe(before);
	await f.sync.reconcile({ path: ["behavior", "pi", "compaction", "modelOverrides"], value: undefined });
	expect(JSON.parse(readFileSync(f.jsonPath, "utf8")).compaction?.modelOverrides).toBeUndefined();
});

test.each([null, { reserveTokens: -1 }, { reserveTokens: "bad" }, { unexpected: 1 }, { model: "other/model" }])(
	"invalid native model budget fails without overwriting settings (%j)",
	async (value) => {
		const f = fixture("", JSON.stringify({ compaction: { modelOverrides: { "openai-codex/gpt-6-sol": value } } }));
		const before = readFileSync(f.jsonPath, "utf8");
		await expect(f.sync.reconcile()).rejects.toThrow("Invalid compaction");
		expect(readFileSync(f.jsonPath, "utf8")).toBe(before);
	},
);
