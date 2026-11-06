import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAction } from "@luan.sh/pi-libactions/sdk";

export function changeEffort(
	pi: Pick<ExtensionAPI, "getThinkingLevel" | "setThinkingLevel">,
	model: ExtensionContext["model"],
	direction: -1 | 1,
): void {
	if (!model) return;
	const levels = getSupportedThinkingLevels(model);
	const current = pi.getThinkingLevel();
	const index = levels.indexOf(current);
	if (index < 0) return;
	const next = levels[index + direction];
	if (next !== undefined) pi.setThinkingLevel(next);
}

export function registerEffortActions(pi: ExtensionAPI): () => void {
	const removeDecrease = registerAction({
		id: "xsettings.effort.decrease",
		description: "Decrease reasoning effort",
		run: (ctx) => changeEffort(pi, ctx.model, -1),
	});
	const removeIncrease = registerAction({
		id: "xsettings.effort.increase",
		description: "Increase reasoning effort",
		run: (ctx) => changeEffort(pi, ctx.model, 1),
	});
	return () => {
		removeDecrease();
		removeIncrease();
	};
}
