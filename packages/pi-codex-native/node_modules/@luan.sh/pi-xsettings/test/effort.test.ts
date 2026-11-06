import { expect, test } from "bun:test";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { changeEffort } from "../src/runtime/effort.ts";

const model: NonNullable<ExtensionContext["model"]> = {
	id: "reasoning-model",
	name: "Reasoning model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
	thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
};

test.each<{
	current: ModelThinkingLevel;
	direction: -1 | 1;
	expected: ModelThinkingLevel | undefined;
}>([
	{ current: "medium", direction: -1, expected: "low" },
	{ current: "medium", direction: 1, expected: "high" },
	{ current: "off", direction: 1, expected: "low" },
	{ current: "low", direction: -1, expected: "off" },
	{ current: "high", direction: 1, expected: "xhigh" },
	{ current: "xhigh", direction: 1, expected: "max" },
	{ current: "max", direction: -1, expected: "xhigh" },
	{ current: "off", direction: -1, expected: undefined },
	{ current: "max", direction: 1, expected: undefined },
])("changes effort from $current by $direction to $expected", ({ current, direction, expected }) => {
	const changes: ModelThinkingLevel[] = [];
	changeEffort({ getThinkingLevel: () => current, setThinkingLevel: (level) => changes.push(level) }, model, direction);
	expect(changes).toEqual(expected ? [expected] : []);
});

test.each<{ model: ExtensionContext["model"]; direction: -1 | 1 }>([
	{ model: undefined, direction: -1 },
	{ model: undefined, direction: 1 },
	{ model: { ...model, reasoning: false }, direction: -1 },
	{ model: { ...model, reasoning: false }, direction: 1 },
])("does not change effort without a reasoning model ($direction)", ({ model, direction }) => {
	const changes: ModelThinkingLevel[] = [];
	changeEffort({ getThinkingLevel: () => "off", setThinkingLevel: (level) => changes.push(level) }, model, direction);
	expect(changes).toEqual([]);
});
