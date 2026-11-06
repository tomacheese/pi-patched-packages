import { describe, expect, test } from "bun:test";

const PUBLIC_ENTRYPOINTS = [
	"@luan.sh/pi-libtui",
	"@luan.sh/pi-libtui/diff",
	"@luan.sh/pi-libtui/editor",
	"@luan.sh/pi-libtui/folding",
	"@luan.sh/pi-libtui/mouse",
	"@luan.sh/pi-libtui/selection",
	"@luan.sh/pi-libtui/stream",
	"@luan.sh/pi-libtui/terminal",
	"@luan.sh/pi-libtui/tool",
] as const;

const CAPABILITY_KEYS = [
	Symbol.for("pi-libtui/editor/registry/v1"),
	Symbol.for("pi-libtui/folding/registry/v2"),
	Symbol.for("pi-libtui/mouse/registry/v1"),
	Symbol.for("pi-libtui/selection/v1"),
	Symbol.for("pi-libtui/split-panes/v2"),
	Symbol.for("pi-libtui.motionScheduler.v1"),
] as const;

describe("public module boundaries", () => {
	test("loads every documented public entrypoint without loading the host extension", async () => {
		const before = CAPABILITY_KEYS.map((key) => Object.hasOwn(globalThis, key));
		for (const entrypoint of PUBLIC_ENTRYPOINTS) {
			const module = await import(entrypoint);
			expect(typeof module).toBe("object");
		}
		const after = CAPABILITY_KEYS.map((key) => Object.hasOwn(globalThis, key));
		expect(after).toEqual(before);
		const mouse = await import("@luan.sh/pi-libtui/mouse");
		expect(Object.keys(mouse).sort()).toEqual([
			"FULLSCREEN_LAYOUT_CAPABILITY_KEY",
			"FULLSCREEN_LAYOUT_PROTOCOL",
			"MOUSE_PROTOCOL",
			"MOUSE_REGISTRY_KEY",
			"TEXT_INTERACTION_TARGET",
			"ensureMouseRegistry",
			"getFullscreenLayoutCapability",
			"preserveViewportOnResize",
			"publishFullscreenLayoutCapability",
			"registerModalPointerShield",
			"resolveFullscreenLayout",
		]);
		const editor = await import("@luan.sh/pi-libtui/editor");
		expect(Object.keys(editor).sort()).toEqual([
			"EDITOR_PROTOCOL",
			"EDITOR_REGISTRY_KEY",
			"SemanticEditor",
			"composeEditorStatus",
			"dispatchEditorPaste",
			"dispatchEditorRender",
			"editorCompositionCadenceMs",
			"editorCompositionContentWidth",
			"editorStatusSeparator",
			"ensureEditorRegistry",
			"installEditorLayer",
			"installEditorMinimumRows",
			"renderEditorComposition",
			"renderEditorCompositionPreview",
			"renderEditorCompositionStatus",
			"semanticEditorTheme",
		]);
	});

	test("keeps extension activation explicit", async () => {
		const before = CAPABILITY_KEYS.map((key) => Object.hasOwn(globalThis, key));
		const extension = await import("../src/extension.ts");
		expect(typeof extension.default).toBe("function");
		const after = CAPABILITY_KEYS.map((key) => Object.hasOwn(globalThis, key));
		expect(after).toEqual(before);
	});
});
