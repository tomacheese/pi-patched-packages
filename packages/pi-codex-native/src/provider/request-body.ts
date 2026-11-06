import {
	getInitialSystemMessage,
	getSystemMessageText,
	normalizeContext,
	resolveTranscript,
	clampThinkingLevel,
	type Api,
	type Context,
	type Model,
} from "@earendil-works/pi-ai";
import {
	CODEX_TOOL_CALL_PROVIDERS,
	convertResponsesMessages,
	convertResponsesTools,
	splitDeferredTools,
} from "../responses/shared.ts";
import { OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "./constants.ts";
import type { OpenAICodexStreamOptions, ResponsesBody } from "./types.ts";

function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

function clampReasoningEffort(modelId: string, effort: string): string {
	if (effort === "none") return effort;
	const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
	const gpt5MinorMatch = /^gpt-5\.(\d+)/.exec(id);
	const gpt5Minor = gpt5MinorMatch ? Number.parseInt(gpt5MinorMatch[1]!, 10) : undefined;
	if (gpt5Minor !== undefined && gpt5Minor >= 2 && effort === "minimal") return "low";
	if (id === "gpt-5.1" && effort === "xhigh") return "high";
	if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
	return effort;
}

export function buildRequestBody<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OpenAICodexStreamOptions,
): ResponsesBody {
	context = resolveTranscript(
		normalizeContext(context),
		model.compat && "supportsMidConvoSystemMessages" in model.compat
			? model.compat.supportsMidConvoSystemMessages
			: false,
	);
	const compat = model.compat as
		| {
				supportsStrictMode?: boolean | undefined;
				supportsAdditionalTools?: boolean | undefined;
				supportsToolSearch?: boolean | undefined;
		  }
		| undefined;
	const supportsStrictMode = compat?.supportsStrictMode ?? true;
	const deferredToolsMode = compat?.supportsAdditionalTools
		? "additional-tools"
		: compat?.supportsToolSearch
			? "tool-search"
			: undefined;
	const grammarToolInputProperties = options?.grammarToolInputProperties ?? new Map<string, string>();
	const supportsOpenAIGrammarTools = grammarToolInputProperties.size > 0;
	const allowedToolCallProviders =
		supportsOpenAIGrammarTools && !CODEX_TOOL_CALL_PROVIDERS.has(model.provider)
			? new Set([...CODEX_TOOL_CALL_PROVIDERS, model.provider])
			: CODEX_TOOL_CALL_PROVIDERS;
	const toolPlacement = splitDeferredTools(context, deferredToolsMode !== undefined);
	const messages = convertResponsesMessages(model, context, allowedToolCallProviders, {
		includeSystemPrompt: false,
		grammarToolInputProperties,
		deferredTools: toolPlacement.deferred,
		deferredToolsMode,
		toolOptions: { supportsStrictMode, supportsOpenAIGrammarTools },
	});

	const body: ResponsesBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: getSystemMessageText(
			getInitialSystemMessage(context.messages) ?? { role: "system", content: "", timestamp: 0 },
		),
		input: messages,
		text: {
			verbosity: ((options as { textVerbosity?: string | undefined } | undefined)?.textVerbosity ?? "low") as string,
		},
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: clampOpenAIPromptCacheKey(options?.sessionId),
		tool_choice: options?.toolChoice ?? "auto",
		parallel_tool_calls: true,
		...buildClientMetadata(options?.sessionId),
	};

	// The Codex ChatGPT-backed endpoint rejects output-token cap fields with
	// `Unsupported parameter: max_output_tokens`. Pi's branch summarizer passes
	// `maxTokens`, so forwarding it breaks `/tree` summaries and extensions that
	// use `ctx.navigateTree(..., { summarize: true })`.

	if ((options as { temperature?: number | undefined } | undefined)?.temperature !== undefined) {
		body.temperature = (options as { temperature?: number | undefined }).temperature;
	}

	const serviceTier = (options as { serviceTier?: string | undefined } | undefined)?.serviceTier;
	if (serviceTier !== undefined) {
		body.service_tier = serviceTier;
	}

	if (toolPlacement.immediate.length > 0) {
		body.tools = clockNamespace(
			convertResponsesTools(toolPlacement.immediate, {
				// The backend otherwise treats optional properties as required. Codex also sends false.
				strict: false,
				supportsStrictMode,
				supportsOpenAIGrammarTools,
			}),
		);
	}

	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = options?.reasoningEffort ?? (clampedReasoning === "off" ? undefined : clampedReasoning);
	if (reasoningEffort !== undefined) {
		const thinkingLevelMap = model.thinkingLevelMap as Record<string, string | null | undefined> | undefined;
		const effort =
			reasoningEffort === "none"
				? thinkingLevelMap?.["off"] === undefined
					? "none"
					: thinkingLevelMap["off"]
				: (thinkingLevelMap?.[reasoningEffort] ?? reasoningEffort);
		if (effort === null) return body;
		body.reasoning = {
			effort: clampReasoningEffort(model.id, effort),
			summary: ((options as { reasoningSummary?: string | undefined } | undefined)?.reasoningSummary ??
				"auto") as string,
		};
	}

	if (reasoningEffort === undefined && model.reasoning && model.thinkingLevelMap?.off !== null) {
		body.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
	}

	return body;
}

function buildClientMetadata(sessionId: string | undefined): Pick<ResponsesBody, "client_metadata"> {
	if (!sessionId) return {};
	const turnMetadata = {
		...(sessionId ? { session_id: sessionId, thread_id: sessionId } : {}),
	};
	return {
		client_metadata: {
			...(sessionId ? { session_id: sessionId, thread_id: sessionId } : {}),
			"x-codex-turn-metadata": JSON.stringify(turnMetadata),
		},
	};
}

function clockNamespace(tools: ReturnType<typeof convertResponsesTools>): ReturnType<typeof convertResponsesTools> {
	const clocks: ReturnType<typeof convertResponsesTools> = [];
	const result = tools.filter((tool) => {
		if (tool.type !== "function" || (tool.name !== "clock__sleep" && tool.name !== "clock__curr_time")) return true;
		clocks.push({
			...tool,
			name: tool.name.slice(7),
			strict: false,
			...(tool.name === "clock__curr_time"
				? {
						output_schema: {
							type: "object",
							properties: {
								current_time: { type: "string", description: "Current UTC time formatted as YYYY-MM-DD HH:MM:SS UTC." },
							},
							required: ["current_time"],
							additionalProperties: false,
						},
					}
				: {}),
		});
		return false;
	});
	if (clocks.length)
		result.push({
			type: "namespace",
			name: "clock",
			description: "Tools for reading and waiting on time.",
			tools: clocks,
		});
	return result;
}
