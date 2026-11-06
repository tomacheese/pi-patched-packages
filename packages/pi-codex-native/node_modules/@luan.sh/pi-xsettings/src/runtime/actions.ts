import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ActionKeybindings, type ActionRegistration, ensureActionsRegistry } from "@luan.sh/pi-libactions/sdk";

export function attachActionShortcuts(
	pi: Pick<ExtensionAPI, "registerShortcut" | "on">,
	bindings: ActionKeybindings,
): () => void {
	// Pi shortcuts always consume input. Contextual actions use its public input
	// listener so inactive actions leave native bindings and focused UI intact.
	const registry = ensureActionsRegistry();
	const registered = new Set<string>();
	const register = (action: ActionRegistration): void => {
		if (action.isActive) return;
		for (const key of bindings[action.id] ?? []) {
			const identity = `${action.id}\0${key}`;
			if (registered.has(identity)) continue;
			registered.add(identity);
			pi.registerShortcut(key, {
				description: action.description,
				handler: (ctx) => registry.find(action.id)?.run(ctx),
			});
		}
	};
	for (const id of Object.keys(bindings)) {
		const action = registry.find(id);
		if (action) register(action);
	}
	const detachRegistration = registry.onRegister(register);
	let detachInput: (() => void) | undefined;
	const detachSession = pi.on("session_start", (_event, ctx) => {
		detachInput?.();
		if (ctx.mode !== "tui") return;
		detachInput = ctx.ui.onTerminalInput((data) => {
			for (const [id, keys] of Object.entries(bindings)) {
				const action = registry.find(id);
				if (!action?.isActive || !keys.some((key) => matchesKey(data, key))) continue;
				try {
					if (!action.isActive()) continue;
					void Promise.resolve(action.run(ctx)).catch((error) =>
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"),
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return { consume: true };
			}
			return undefined;
		});
	});
	return () => {
		detachSession();
		detachRegistration();
		detachInput?.();
	};
}
