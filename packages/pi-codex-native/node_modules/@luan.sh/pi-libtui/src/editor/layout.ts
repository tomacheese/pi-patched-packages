import { type Component, Spacer, type TUI } from "@earendil-works/pi-tui";

// type-boundary: Pi 0.84.x keeps its active layout root and stack entries private; the guards below narrow them.
type PiLayoutValue = unknown;

interface LayoutEntry {
	component: Component;
	minSize?: number;
}

export interface EditorMinimumRowsLease {
	reconcile(editor: Component): void;
	dispose(): void;
}

function isComponent(value: PiLayoutValue): value is Component {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "render") === "function";
}

function isLayoutEntry(value: PiLayoutValue): value is LayoutEntry {
	return typeof value === "object" && value !== null && isComponent(Reflect.get(value, "component"));
}

function childComponents(component: Component): readonly Component[] {
	const children = Reflect.get(component, "children") as PiLayoutValue;
	return Array.isArray(children) ? children.filter(isComponent) : [];
}

function layoutEntries(component: Component): readonly LayoutEntry[] {
	const entries = Reflect.get(component, "entries") as PiLayoutValue;
	return Array.isArray(entries) ? entries.filter(isLayoutEntry) : [];
}

function contains(root: Component, target: Component, seen = new Set<object>()): boolean {
	if (root === target) return true;
	if (seen.has(root)) return false;
	seen.add(root);
	return childComponents(root).some((child) => contains(child, target, seen));
}

function editorEntry(root: Component, editor: Component, seen = new Set<object>()): LayoutEntry | undefined {
	if (seen.has(root)) return undefined;
	seen.add(root);
	for (const entry of layoutEntries(root)) {
		const nested = editorEntry(entry.component, editor, seen);
		if (nested) return nested;
		if (contains(entry.component, editor)) return entry;
	}
	for (const child of childComponents(root)) {
		const nested = editorEntry(child, editor, seen);
		if (nested) return nested;
	}
	return undefined;
}

/** Adapt Pi's dock allocation to a borderless editor while tolerating hosts without the expected private layout shape. */
export function installEditorMinimumRows(
	tui: TUI,
	minimumRows: number,
	hideGap: () => boolean = () => false,
): EditorMinimumRowsLease {
	const rows = Math.max(0, Math.floor(minimumRows));
	let active = true;
	let entry: LayoutEntry | undefined;
	let originalMinimum: number | undefined;
	let restoreGap: (() => void) | undefined;
	return {
		reconcile(editor) {
			if (!active) return;
			if (!restoreGap) {
				const root = Reflect.get(tui as object, "layoutRoot") as PiLayoutValue;
				const widgets = precedingEditorSibling(isComponent(root) ? root : tui, editor);
				if (widgets) {
					restoreGap = hideWidgetSpacer(widgets, hideGap);
					tui.requestRender();
				}
			}
			if (!entry || !contains(entry.component, editor)) {
				const root = Reflect.get(tui as object, "layoutRoot") as PiLayoutValue;
				if (!isComponent(root)) return;
				entry = editorEntry(root, editor);
				if (!entry) return;
				originalMinimum = entry.minSize;
			}
			entry.minSize = rows;
		},
		dispose() {
			if (!active) return;
			active = false;
			restoreGap?.();
			if (entry?.minSize === rows) entry.minSize = originalMinimum;
			tui.requestRender();
		},
	};
}

// Pi 0.87.1 places widgetsAbove immediately before the editor in both renderer trees.
function precedingEditorSibling(root: Component, editor: Component, seen = new Set<object>()): Component | undefined {
	if (seen.has(root)) return undefined;
	seen.add(root);
	const entries = layoutEntries(root);
	const children = entries.length ? entries.map((entry) => entry.component) : childComponents(root);
	for (let index = 0; index < children.length; index++) {
		const child = children[index];
		if (!child) continue;
		const nested = precedingEditorSibling(child, editor, seen);
		if (nested) return nested;
		if (childComponents(child).includes(editor)) return children[index - 1];
	}
	return undefined;
}

function hideWidgetSpacer(widgets: Component, hidden: () => boolean): () => void {
	const original = widgets.render;
	let active = true;
	let spacer: Spacer | undefined;
	const restoreSpacer = () => {
		if (spacer?.render(1).length === 0) spacer.setLines(1);
		spacer = undefined;
	};
	const render: Component["render"] = (width) => {
		if (!active) return original.call(widgets, width);
		const first = childComponents(widgets)[0];
		if (first !== spacer) restoreSpacer();
		// Only Pi's leading one-row Spacer is ours; never trim widget output.
		if (first instanceof Spacer && (first === spacer || first.render(width).length === 1)) {
			spacer = first;
			spacer.setLines(hidden() ? 0 : 1);
		}
		return original.call(widgets, width);
	};
	widgets.render = render;
	return () => {
		active = false;
		if (widgets.render === render) widgets.render = original;
		restoreSpacer();
	};
}
