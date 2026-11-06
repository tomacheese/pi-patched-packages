import { compact, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
/** Use Pi's cumulative summarizer on an isolated SSE request, without touching the live continuation. */
export async function portableSummary(
	event: Pick<SessionBeforeCompactEvent, "preparation" | "signal" | "customInstructions">,
	ctx: ExtensionContext,
) {
	if (!ctx.model) throw new Error("No model for portable compaction");
	return compact(
		event.preparation,
		ctx.model,
		undefined,
		undefined,
		event.customInstructions,
		event.signal,
		"low",
		(model, context, options) =>
			ctx.modelRegistry.streamSimple(model, context, { ...options, sessionId: undefined, transport: "sse" }),
	);
}
