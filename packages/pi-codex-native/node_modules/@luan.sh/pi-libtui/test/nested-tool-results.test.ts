import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	createReadToolDefinition,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { jsonObject, NestedToolResults, readNestedPresentation } from "../src/host/nested-tool-results.ts";

test("native codemode keeps nested presentation results across reload without changing content or policy", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-nested-results-"));
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const records = new NestedToolResults();
	const manager = SessionManager.inMemory(root);
	const runtime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(root, "models.json"),
		refreshOnCreate: false,
	});
	let step = 0;
	let executions = 0;
	runtime.registerProvider("nested-presentation", {
		baseUrl: "https://test.invalid",
		apiKey: "fixture",
		api: "openai-responses",
		models: [
			{
				id: "fixture",
				name: "Fixture",
				reasoning: false,
				input: ["text"],
				cost,
				contextWindow: 10000,
				maxTokens: 1000,
			},
		],
		streamSimple(model) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const code =
					step++ === 0
						? 'text(await tools.fixture({path:"normal"})); try { await tools.fixture({path:"blocked"}); } catch (error) { text(error.message); }'
						: undefined;
				const stopReason = code ? "toolUse" : "stop";
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: code
						? [{ type: "toolCall", id: "script", name: "codemode", arguments: { code } }]
						: [{ type: "text", text: "Done" }],
					stopReason,
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } },
					timestamp: 0,
				};
				stream.push({ type: "done", reason: stopReason, message });
				stream.end();
			});
			return stream;
		},
	});
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noContextFiles: true,
		noPromptTemplates: true,
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				records.register(pi);
				pi.registerTool({
					name: "fixture",
					label: "Fixture",
					description: "Presentation fixture",
					parameters: createReadToolDefinition(root).parameters,
					execute: async (_id, args, _signal, onUpdate) => {
						executions++;
						onUpdate?.({
							content: [{ type: "text", text: "PARTIAL" }],
							details: { path: args.path, phase: "partial" },
						});
						return { content: [{ type: "text", text: "RESULT" }], details: { path: args.path, phase: "final" } };
					},
				});
				pi.on("tool_call", (event) =>
					event.toolName === "fixture" && event.input.path === "blocked"
						? { block: true, reason: "Fixture policy" }
						: undefined,
				);
				pi.on("tool_result", (event) =>
					event.toolName === "fixture"
						? { content: [{ type: "text", text: "SANITIZED" }], details: { path: "sanitized", phase: "final" } }
						: undefined,
				);
			},
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		settingsManager: settings,
		modelRuntime: runtime,
		resourceLoader: loader,
		sessionManager: manager,
		model: runtime.getModel("nested-presentation", "fixture"),
	});
	try {
		await session.bindExtensions({ mode: "rpc" });
		session.setActiveToolsByName(["codemode", "fixture"]);
		await session.prompt("Run the fixture.");
		expect(executions).toBe(1);
		const parent = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
		if (parent?.role !== "toolResult" || !jsonObject(parent.details)) throw new Error("Missing native parent result");
		const saved = readNestedPresentation(parent.details.libtuiNestedCalls);
		expect(saved?.calls.map((call) => call.status)).toEqual(["succeeded", "failed"]);
		expect(saved?.calls[0]?.result).toEqual({
			content: [{ type: "text", text: "SANITIZED" }],
			details: { path: "sanitized", phase: "final" },
			isError: false,
		});
		expect(saved?.calls[1]?.result?.content[0]?.text).toContain("Fixture policy");
		const content = parent.content;
		expect(content.some((block) => block.type === "text" && block.text.includes("SANITIZED"))).toBe(true);
		await session.reload();
		const restored = session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "codemode",
		);
		if (restored?.role !== "toolResult" || !jsonObject(restored.details)) throw new Error("Missing restored parent");
		expect(readNestedPresentation(restored.details.libtuiNestedCalls)).toEqual(saved);
		expect(restored.content).toEqual(content);
	} finally {
		session.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
