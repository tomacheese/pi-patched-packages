import { compactionModelOverrides, modelOverrideRows } from "./pi-compaction.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type SettingDefinition, type SettingOption, type SettingValue, settingPath } from "../protocol/settings.ts";
import { getPath, type SettingsRecord } from "./store.ts";

const option = (value: SettingOption["value"], label: string, description = ""): SettingOption => ({
	value,
	label,
	description,
});
const numbers = (...values: number[]): SettingOption[] => values.map((value) => option(value, String(value)));

export const PI_SETTINGS = [
	compactionModelOverrides,
	{
		key: "cacheWarming",
		label: "Prompt cache warming",
		description: "Keep eligible prompt caches warm during runs or while idle.",
		category: "behavior",
		section: "Models",
		type: "enum",
		default: "streaming",
		options: [option("off", "Off"), option("streaming", "During runs"), option("idle", "During runs and while idle")],
	},
	{
		key: "theme",
		label: "Theme",
		description: "Color theme used by Pi.",
		category: "appearance",
		section: "Style",
		apply: "live",
		type: "enum",
		default: "dark",
		options: [],
	},
	{
		key: "quietStartup",
		label: "Startup display",
		description: "Show startup details, only the header, or nothing.",
		category: "appearance",
		page: "ux",
		section: "Transcript",
		type: "enum",
		default: false,
		options: [option(false, "Full"), option("header", "Header only"), option(true, "Hidden")],
	},
	{
		key: "hideThinkingBlock",
		label: "Hide thinking",
		description: "Hide thinking blocks in the transcript.",
		category: "appearance",
		page: "ux",
		section: "Transcript",
		type: "boolean",
		default: false,
	},
	{
		key: "showCacheMissNotices",
		label: "Cache miss notices",
		description: "Show significant prompt-cache misses.",
		category: "appearance",
		page: "ux",
		section: "Transcript",
		type: "boolean",
		default: false,
	},
	{
		key: "collapseChangelog",
		label: "Compact changelog",
		description: "Condense changelog output after updates.",
		category: "appearance",
		page: "ux",
		section: "Transcript",
		type: "boolean",
		default: false,
	},
	{
		key: "editorPaddingX",
		label: "Editor padding",
		description: "Horizontal editor padding.",
		category: "appearance",
		section: "Layout",
		type: "enum",
		default: 0,
		options: numbers(0, 1, 2, 3),
	},
	{
		key: "outputPad",
		label: "Output padding",
		description: "Horizontal transcript padding.",
		category: "appearance",
		section: "Layout",
		type: "enum",
		default: 1,
		options: numbers(0, 1),
	},
	{
		key: "autocompleteMaxVisible",
		label: "Autocomplete rows",
		description: "Maximum visible autocomplete results.",
		category: "appearance",
		section: "Layout",
		type: "enum",
		default: 5,
		options: numbers(3, 5, 8, 10, 15, 20),
	},
	{
		key: "showHardwareCursor",
		label: "Hardware cursor",
		description: "Show the terminal cursor for IME positioning.",
		category: "appearance",
		page: "terminal",
		section: "Cursor",
		type: "boolean",
		default: false,
	},
	{
		key: "tuiMode",
		label: "TUI mode",
		description: "Choose regular or fullscreen rendering.",
		category: "appearance",
		page: "terminal",
		section: "Fullscreen",
		type: "enum",
		default: "regular",
		options: [option("regular", "Regular"), option("fullscreen", "Fullscreen")],
	},
	{
		key: "fullscreenExitOutput",
		label: "Fullscreen exit",
		description: "Output left after fullscreen Pi exits.",
		category: "appearance",
		page: "terminal",
		section: "Fullscreen",
		type: "enum",
		default: "transcript",
		options: [option("transcript", "Transcript"), option("resume-hint", "Resume hint")],
	},
	{
		key: "fullscreenScrollbar",
		label: "Fullscreen scrollbar",
		description: "Scrollbar behavior in fullscreen mode.",
		category: "appearance",
		page: "terminal",
		section: "Fullscreen",
		type: "enum",
		default: "auto",
		options: [option("auto", "Automatic"), option("always", "Always"), option("hidden", "Hidden")],
	},
	{
		key: "markdown.codeBlockIndent",
		label: "Code block indent",
		description: "Indent used for rendered fenced code.",
		category: "appearance",
		section: "Markdown",
		type: "enum",
		default: "  ",
		options: [option("", "None"), option("  ", "Two spaces"), option("    ", "Four spaces")],
	},
	{
		key: "markdown.mermaid",
		label: "Mermaid",
		description: "When Mermaid diagrams render.",
		category: "appearance",
		section: "Markdown",
		type: "enum",
		default: "streaming",
		options: [option("off", "Off"), option("final", "Final"), option("streaming", "Streaming")],
	},
	{
		key: "terminal.showImages",
		label: "Terminal images",
		description: "Show images in supported terminals.",
		category: "appearance",
		page: "terminal",
		section: "Images",
		type: "boolean",
		default: true,
	},
	{
		key: "terminal.imageWidthCells",
		label: "Image width",
		description: "Preferred inline image width in cells.",
		category: "appearance",
		page: "terminal",
		section: "Images",
		type: "enum",
		default: 60,
		options: numbers(30, 45, 60, 80, 100),
	},
	{
		key: "terminal.clearOnShrink",
		label: "Clear on shrink",
		description: "Clear rows when rendered content becomes shorter.",
		category: "appearance",
		page: "terminal",
		section: "Images",
		type: "boolean",
		default: false,
	},
	{
		key: "terminal.showTerminalProgress",
		label: "Terminal progress",
		description: "Use terminal-native progress reporting when available.",
		category: "appearance",
		page: "terminal",
		section: "Images",
		type: "boolean",
		default: false,
	},
	{
		key: "images.autoResize",
		label: "Resize images",
		description: "Resize large images before sending them.",
		category: "appearance",
		page: "terminal",
		section: "Images",
		type: "boolean",
		default: true,
	},
	{
		key: "images.blockImages",
		label: "Block images",
		description: "Prevent images from reaching the model.",
		category: "appearance",
		page: "terminal",
		section: "Images",
		type: "boolean",
		default: false,
	},
	{
		key: "compaction.enabled",
		label: "Auto compaction",
		description: "Compact automatically near the context limit.",
		category: "behavior",
		section: "Compaction",
		type: "boolean",
		default: true,
	},
	{
		key: "compaction.reserveTokens",
		label: "Response reserve",
		description: "Tokens reserved for the next response.",
		category: "behavior",
		section: "Compaction",
		type: "enum",
		default: 16384,
		options: numbers(8192, 16384, 32768, 65536),
	},
	{
		key: "compaction.keepRecentTokens",
		label: "Recent tokens",
		description: "Recent tokens kept outside the summary.",
		category: "behavior",
		section: "Compaction",
		type: "enum",
		default: 20000,
		options: numbers(10000, 20000, 40000, 80000),
	},
	{
		key: "branchSummary.reserveTokens",
		label: "Branch reserve",
		description: "Tokens reserved for branch summaries.",
		category: "behavior",
		section: "Branch Summary",
		type: "enum",
		default: 16384,
		options: numbers(8192, 16384, 32768),
	},
	{
		key: "branchSummary.skipPrompt",
		label: "Skip branch prompt",
		description: "Navigate without asking to summarize.",
		category: "behavior",
		section: "Branch Summary",
		type: "boolean",
		default: false,
	},
	{
		key: "retry.enabled",
		label: "Automatic retry",
		description: "Retry transient agent failures.",
		category: "behavior",
		section: "Retry",
		type: "boolean",
		default: true,
	},
	{
		key: "retry.maxRetries",
		label: "Retry attempts",
		description: "Maximum agent retry attempts.",
		category: "behavior",
		section: "Retry",
		type: "enum",
		default: 3,
		options: numbers(0, 1, 2, 3, 5),
	},
	{
		key: "retry.baseDelayMs",
		label: "Retry delay",
		description: "Initial retry backoff in milliseconds.",
		category: "behavior",
		section: "Retry",
		type: "enum",
		default: 2000,
		options: numbers(500, 1000, 2000, 5000, 10000),
	},
	{
		key: "retry.provider.maxRetries",
		label: "Provider retries",
		description: "Provider SDK retry attempts. Keep at zero unless explicitly needed.",
		category: "behavior",
		section: "Retry",
		type: "enum",
		default: 0,
		options: numbers(0, 1, 2, 3),
	},
	{
		key: "retry.provider.maxRetryDelayMs",
		label: "Provider retry delay",
		description: "Maximum server-requested retry delay in milliseconds.",
		category: "behavior",
		section: "Retry",
		type: "enum",
		default: 60000,
		options: numbers(0, 10000, 30000, 60000, 120000),
	},
	{
		key: "enabledModels",
		label: "Model cycle",
		description: "Ordered model patterns used for model cycling.",
		category: "behavior",
		section: "Model Cycling",
		type: "multi-enum",
		default: [],
		options: [],
		ordered: true,
	},
	{
		key: "steeringMode",
		label: "Steering delivery",
		description: "How queued steering messages are delivered.",
		category: "interaction",
		section: "Message Delivery",
		type: "enum",
		default: "one-at-a-time",
		options: [option("one-at-a-time", "One at a time"), option("all", "All")],
	},
	{
		key: "followUpMode",
		label: "Follow-up delivery",
		description: "How queued follow-up messages are delivered.",
		category: "interaction",
		section: "Message Delivery",
		type: "enum",
		default: "one-at-a-time",
		options: [option("one-at-a-time", "One at a time"), option("all", "All")],
	},
	{
		key: "transport",
		label: "Transport",
		description: "Preferred provider transport.",
		category: "interaction",
		section: "Message Delivery",
		type: "enum",
		default: "auto",
		options: [
			option("auto", "Automatic"),
			option("sse", "SSE"),
			option("websocket", "WebSocket"),
			option("websocket-cached", "Cached WebSocket"),
		],
	},
	{
		key: "httpIdleTimeoutMs",
		label: "HTTP idle timeout",
		description: "Header and body idle timeout in milliseconds.",
		category: "interaction",
		section: "Message Delivery",
		type: "enum",
		default: 300000,
		options: numbers(0, 60000, 300000, 600000),
	},
	{
		key: "websocketConnectTimeoutMs",
		label: "WebSocket timeout",
		description: "WebSocket connection timeout in milliseconds.",
		category: "interaction",
		section: "Message Delivery",
		type: "enum",
		default: 15000,
		options: numbers(0, 5000, 15000, 30000, 60000),
	},
	{
		key: "defaultTools",
		label: "Session tools",
		description: "Tool baseline applied on startup, resume, reload, and branch navigation.",
		category: "tools",
		section: "Tools",
		type: "multi-enum",
		default: [],
		options: [],
		ordered: false,
	},
	{
		key: "codemode.mode",
		label: "Codemode presentation",
		description: "Keep direct tools alongside scripts, or reach callable tools only through scripts.",
		category: "tools",
		section: "Codemode",
		type: "enum",
		default: "on",
		options: [option("on", "Direct tools and scripts"), option("only", "Scripts only")],
	},
	{
		key: "codemode.inlineBudget",
		label: "Inline tool budget",
		description: "Estimated tokens for script tool declarations; searchTools finds tools beyond the budget.",
		category: "tools",
		section: "Codemode",
		type: "enum",
		default: 3000,
		options: numbers(0, 1000, 3000, 10000),
	},
] satisfies readonly SettingDefinition[];

function stringOptions(values: readonly string[]): SettingOption[] {
	return values.map((value) => option(value, value));
}

export function piSettingDefinitions(
	pi: Pick<ExtensionAPI, "getAllTools">,
	ctx: ExtensionContext,
): SettingDefinition[] {
	const modelOptions = stringOptions(
		(ctx.scopedModels.length > 0
			? ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)
			: ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`)
		)
			.filter((value, index, all) => all.indexOf(value) === index)
			.sort(),
	);
	const toolOptions = stringOptions(
		pi
			.getAllTools()
			.filter((tool) => tool.sourceInfo.source === "builtin")
			.map((tool) => tool.name)
			.sort(),
	);
	const themes = stringOptions(
		ctx.ui
			.getAllThemes()
			.map(({ name }) => name)
			.sort(),
	);
	return PI_SETTINGS.map((template): SettingDefinition => {
		if (template.type === "enum" && template.key === "theme") return { ...template, options: themes };
		if (template.type === "multi-enum" && template.key === "enabledModels")
			return { ...template, options: modelOptions };
		if (template.type === "multi-enum" && template.key === "defaultTools") return { ...template, options: toolOptions };
		return template;
	});
}

export function configuredPiValues(document: SettingsRecord): Record<string, SettingValue> {
	const result: Record<string, SettingValue> = {};
	for (const definition of PI_SETTINGS) {
		const value = getPath(document, settingPath(definition));
		if (definition.key === "compaction.modelOverrides" && value !== undefined) {
			result[definition.key] = modelOverrideRows(value as SettingValue);
			continue;
		}
		if (typeof value === "boolean" || typeof value === "number" || typeof value === "string")
			result[definition.key] = value;
		else if (Array.isArray(value) && value.every((item) => typeof item === "string")) result[definition.key] = value;
	}
	return result;
}
