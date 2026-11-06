import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createCodemodeExtension,
	createReadToolDefinition,
	createToolSearchExtension,
	DefaultResourceLoader,
	initTheme,
	SettingsManager,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import {
	type CodeModePresentation,
	nativeOrchestrationRenderers,
	type PresentationHost,
} from "../src/host/codemode-presentation.ts";
import { NestedToolResults, readNestedPresentation } from "../src/host/nested-tool-results.ts";
import { ToolActivity } from "../src/tool/activity.ts";

const tui = new TuiAltScreen(new ProcessTerminal());
let root: string;
let definitions: Map<string, ToolDefinition>;
const views: CodeModePresentation[] = [];
const renders: Array<{ details: object; partial: boolean; failed: boolean }> = [];
const host: PresentationHost = {
	tui,
	nested: new NestedToolResults(),
	definition: (name) => definitions.get(name),
	history: () => undefined,
	track: (view) => views.push(view),
};
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-native-presentation-"));
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager: SettingsManager.inMemory(),
		noSkills: true,
		noThemes: true,
		noContextFiles: true,
		noPromptTemplates: true,
		extensionFactories: [
			createCodemodeExtension(),
			createToolSearchExtension(),
			(pi) =>
				pi.registerTool({
					name: "fixture",
					label: "fixture",
					description: "A tool with its own presentation",
					parameters: createReadToolDefinition(root).parameters,
					renderShell: "self",
					execute: async () => ({
						content: [{ type: "text", text: "READABLE OUTPUT" }],
						details: { label: "Rendered by the tool", body: "READABLE OUTPUT" },
					}),
					renderResult(result, options, theme, context) {
						renders.push({ details: result.details, partial: options.isPartial, failed: context.isError });
						return ToolActivity.reuse(context.lastComponent, {
							theme,
							requestRender: context.invalidate,
							view: {
								action: {
									verb: result.details.label,
									status: context.isError ? "failed" : options.isPartial ? "running" : "succeeded",
								},
								payload: { kind: "text", text: result.details.body, revision: 0 },
							},
						});
					},
				}),
		],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	definitions = new Map(
		loader
			.getExtensions()
			.extensions.flatMap((extension) => [...extension.tools].map(([name, tool]) => [name, tool.definition])),
	);
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
	initTheme("dark", false);
	renders.length = 0;
});
afterEach(() => {
	for (const view of views.splice(0)) view.dispose();
});
function parent() {
	return new ToolExecutionComponent(
		"codemode",
		"script",
		{ code: 'text(await tools.fixture({path:"example.ts"}));' },
		{},
		nativeOrchestrationRenderers("codemode", host),
		tui,
		"/tmp",
	);
}
function result(status: "running" | "succeeded" | "failed") {
	return {
		content: [
			{
				type: "text",
				text: 'Script completed\nWall time 0.1 seconds\nOutput:\n{"chunk_id":"raw","output":"READABLE OUTPUT"}',
			},
		],
		details: {
			libtuiNestedCalls: {
				version: 1,
				omitted: 0,
				calls: [
					{
						id: "script/1",
						name: "fixture",
						args: { path: "example.ts" },
						status,
						result: {
							content: [{ type: "text", text: "READABLE OUTPUT" }],
							details: { label: "Rendered by the tool", body: "READABLE OUTPUT" },
							isError: status === "failed",
						},
					},
				],
			},
		},
		isError: status === "failed",
	};
}
test.each([40, 80, 160])("nested tool presentation replaces JavaScript and wrapper JSON at %i columns", (width) => {
	const component = parent();
	component.updateResult(result("succeeded"));
	const lines = component.render(width);
	const text = lines.map(stripTerminalSequences).join("\n");
	expect(text).toContain("Rendered by the tool");
	expect(text).toContain("READABLE OUTPUT");
	expect(text).not.toContain("tools.fixture");
	expect(text).not.toContain("chunk_id");
	expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	expect(renders.at(-1)).toEqual({
		details: { label: "Rendered by the tool", body: "READABLE OUTPUT" },
		partial: false,
		failed: false,
	});
	component.setExpanded(true);
	const expanded = component.render(width).map(stripTerminalSequences).join("\n");
	expect(expanded).toContain("tools.fixture");
	expect(expanded).toContain("chunk_id");
});
test("partial and failed nested results reach the same tool renderer", () => {
	const component = parent();
	component.updateResult(result("running"), true);
	component.render(80);
	expect(renders.at(-1)?.partial).toBe(true);
	component.updateResult(result("failed"));
	component.render(80);
	expect(renders.at(-1)?.failed).toBe(true);
});
test("historical calls without saved results never invent a failed result", () => {
	const component = parent();
	component.updateResult({
		content: [],
		details: { calls: [{ id: "old/1", name: "fixture", args: '{"path":"example.ts"}', status: "ok" }] },
		isError: false,
	});
	expect(component.render(80).map(stripTerminalSequences).join("\n")).toContain("fixture");
	expect(renders).toEqual([]);
});
test("invalid persisted presentation metadata is rejected", () => {
	expect(
		readNestedPresentation({
			version: 1,
			omitted: 0,
			calls: [{ id: "id", name: "fixture", status: "bogus", args: {} }],
		}),
	).toBeUndefined();
});
test("native tool discovery uses the shared action and output presentation", () => {
	const component = new ToolExecutionComponent(
		"tool_search",
		"search",
		{ query: "filesystem shell" },
		{},
		nativeOrchestrationRenderers("tool_search", host),
		tui,
		"/tmp",
	);
	component.updateResult({ content: [{ type: "text", text: "No matching tools found." }], isError: false });
	const text = component.render(80).map(stripTerminalSequences).join("\n");
	expect(text).toContain("Search tools");
	expect(text).toContain("filesystem shell");
	expect(text).toContain("No matching tools found.");
});
