import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEventBus,
	createExtensionRuntime,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	type TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { registerAction } from "@luan.sh/pi-libactions/sdk";
import { attachActionShortcuts } from "../src/runtime/actions.ts";

test.each([true, false])(
	"contextual keys preserve native handling across activity, replacement and cleanup (register first: %s)",
	async (registerFirst) => {
		const directory = await mkdtemp(join(tmpdir(), "pi-actions-"));
		let dispose = () => {};
		let unregister = () => {};
		let removeReplacement = () => {};
		try {
			const runtime = createExtensionRuntime();
			const models = await ModelRuntime.create({
				authPath: join(directory, "auth.json"),
				modelsPath: null,
				modelsStorePath: join(directory, "models.json"),
				refreshOnCreate: false,
			});
			let active = false;
			let calls = 0;
			const register = () =>
				registerAction({
					id: "test.contextual",
					description: "Contextual action",
					isActive: () => active,
					run: () => {
						calls++;
					},
				});
			if (registerFirst) unregister = register();
			const extension = await loadExtensionFromFactory(
				(pi) => {
					dispose = attachActionShortcuts(pi, { "test.contextual": ["ctrl+x", "alt+m"] });
				},
				directory,
				createEventBus(),
				runtime,
			);
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				directory,
				SessionManager.inMemory(directory),
				new ModelRegistry(models),
			);
			const inputs = new Set<TerminalInputHandler>();
			const errors: string[] = [];
			runner.setUIContext(
				{
					...runner.getUIContext(),
					notify(message) {
						errors.push(message);
					},
					onTerminalInput(handler) {
						inputs.add(handler);
						return () => {
							inputs.delete(handler);
						};
					},
				},
				"tui",
			);
			await runner.emit({ type: "session_start", reason: "startup" });
			if (!registerFirst) unregister = register();
			// Global Pi shortcuts consume keys unconditionally, so contextual keys must not be in this map.
			expect(runner.getShortcuts({ "app.message.copy": ["ctrl+x"] }).size).toBe(0);
			const input = (data: string) => [...inputs].map((handler) => handler(data));
			expect(input("\x18")).toEqual([undefined]);
			active = true;
			expect(input("ordinary typing")).toEqual([undefined]);
			expect(input("\x18")).toEqual([{ consume: true }]);
			expect(input("\x1bm")).toEqual([{ consume: true }]);
			expect(calls).toBe(2);
			active = false;
			expect(input("\x18")).toEqual([undefined]);
			expect(calls).toBe(2);
			removeReplacement = registerAction({
				id: "test.contextual",
				description: "Replacement",
				isActive: () => active,
				run() {
					calls += 10;
				},
			});
			unregister();
			active = true;
			await runner.emit({ type: "session_start", reason: "resume" });
			expect(inputs.size).toBe(1);
			expect(input("\x18")).toEqual([{ consume: true }]);
			expect(calls).toBe(12);
			removeReplacement();
			expect(input("\x18")).toEqual([undefined]);
			expect(errors).toEqual([]);
			dispose();
			expect(inputs.size).toBe(0);
			await runner.emit({ type: "session_start", reason: "reload" });
			expect(inputs.size).toBe(0);
		} finally {
			dispose();
			unregister();
			removeReplacement();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
