import { expect, test } from "bun:test";
import { ProcessTerminal, Text, TuiAltScreen, type Component } from "@earendil-works/pi-tui";
import { mountHoverPreview } from "../src/overlay/hover-preview.ts";
import { ensureMouseRegistry, type TuiMouseEvent } from "../src/mouse.ts";
import { getMouseRegistryState } from "../src/mouse/registry.ts";

test("hover previews dismiss stale loads and yield to selection, resize, clicks, and dialogs", async () => {
	const terminal = new ProcessTerminal();
	terminal.write = () => {};
	const tui = new TuiAltScreen(terminal);
	const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
	const loads: { resolve(component: Component): void; signal: AbortSignal }[] = [];
	const target = { id: "image", rect: { x: 2, y: 10, width: 12, height: 1 } };
	const dispose = mountHoverPreview({
		id: "preview",
		tui,
		registry,
		getTargets: () => [target],
		load: (_target, _size, signal) => new Promise((resolve) => loads.push({ resolve, signal })),
	});
	const frame = (extra = {}) =>
		registry.dispatchScreenDecorators([], { width: 80, height: 30, hasOverlay: tui.hasOverlay(), ...extra });
	const event = (type: TuiMouseEvent["type"]): TuiMouseEvent => ({
		type,
		row: 0,
		col: 0,
		screenRow: 10,
		screenCol: 2,
		button: undefined,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	});
	const point = () => getMouseRegistryState(registry).regions[0]!;
	const ready = async () => {
		loads.at(-1)!.resolve(new Text("preview", 0, 0));
		await Promise.resolve();
	};
	try {
		frame();
		expect(point().onMouse(event("enter"))).toBe(true);
		point().onMouse(event("leave"));
		expect(loads[0]!.signal.aborted).toBe(true);
		await ready();
		expect(tui.hasOverlay()).toBe(false);
		point().onMouse(event("enter"));
		await ready();
		expect(tui.hasOverlay()).toBe(true);
		frame(); // Its own non-capturing overlay must not dismiss the preview.
		expect(tui.hasOverlay()).toBe(true);
		expect(point().onMouse(event("press"))).toBe(false);
		expect(tui.hasOverlay()).toBe(false);
		for (const changed of [{ selectionActive: true }, { width: 60 }, { dialog: true }]) {
			frame();
			point().onMouse(event("enter"));
			await ready();
			const dialog = "dialog" in changed ? tui.showOverlay(new Text("dialog")) : undefined;
			frame(changed);
			expect(loads.at(-1)!.signal.aborted).toBe(true);
			dialog?.hide();
			expect(tui.hasOverlay()).toBe(false);
		}
		frame();
		point().onMouse(event("enter"));
		dispose();
		await ready();
		expect(tui.hasOverlay()).toBe(false);
		expect(getMouseRegistryState(registry).regions).toHaveLength(0);
	} finally {
		dispose();
	}
});
