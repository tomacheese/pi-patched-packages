import { describe, expect, test } from "bun:test";
import {
	Container,
	type Component,
	ProcessTerminal,
	Spacer,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { installEditorMinimumRows } from "../src/editor/layout.ts";

function rows(...lines: string[]): Component {
	return { render: () => lines, invalidate() {} };
}

describe("editor layout", () => {
	test.each(["fullscreen", "inline"])("toggles only the native gap and preserves widgets in %s", (mode) => {
		const terminal = new ProcessTerminal();
		terminal.write = () => {};
		const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
		const editor = rows("prompt");
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const widgets = new Container();
		widgets.addChild(new Spacer(1));
		const children = [rows("transcript"), widgets, editorContainer];
		if (tui instanceof TuiAltScreen) tui.setLayoutRoot(new VStack(children.map((component) => ({ component }))));
		else for (const child of children) tui.addChild(child);
		let hidden = true;
		const lease = installEditorMinimumRows(tui, 1, () => hidden);
		lease.reconcile(editor);
		expect(tui.render(80)).toEqual(["transcript", "prompt"]);
		// Pi replaces the spacer whenever extension widgets change.
		widgets.clear();
		widgets.addChild(new Spacer(1));
		widgets.addChild(rows("", "widget"));
		expect(tui.render(80)).toEqual(["transcript", "", "widget", "prompt"]);
		hidden = false;
		expect(tui.render(80)).toEqual(["transcript", "", "", "widget", "prompt"]);
		hidden = true;
		expect(tui.render(80)).toEqual(["transcript", "", "widget", "prompt"]);
		lease.dispose();
		expect(tui.render(80)).toEqual(["transcript", "", "", "widget", "prompt"]);
	});
	test("removes Pi's reserved border row for a borderless editor and restores it on dispose", () => {
		const editor = rows("transition", "prompt");
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const dock = new VStack([
			{ component: editorContainer, minSize: 3 },
			{ component: rows("footer"), minSize: 1 },
		]);
		let renders = 0;
		const tui = { layoutRoot: dock, requestRender: () => renders++ } as never as TUI;
		const lease = installEditorMinimumRows(tui, 2);

		expect(dock.render(80)).toEqual(["transition", "prompt", "", "footer"]);
		lease.reconcile(editor);
		expect(dock.render(80)).toEqual(["transition", "prompt", "footer"]);

		lease.dispose();
		expect(dock.render(80)).toEqual(["transition", "prompt", "", "footer"]);
		expect(renders).toBe(1);
	});
});
