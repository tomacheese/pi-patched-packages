import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

type CodexResponsesModel = Model<"openai-codex-responses">;
type CodexResponsesCompat = NonNullable<CodexResponsesModel["compat"]> & {
	supportsImageDetailOriginal?: boolean;
};
export type CodexModel = Omit<CodexResponsesModel, "compat"> & { compat?: CodexResponsesCompat };

/** Pi owns catalog availability, pricing, reasoning and input limits. */
export function getCodexModels(): readonly CodexModel[] {
	return getBuiltinModels("openai-codex").map((model) => ({
		...structuredClone(model),
		compat: {
			...model.compat,
			...(model.input.includes("image") ? { supportsImageDetailOriginal: true } : {}),
		},
	}));
}
