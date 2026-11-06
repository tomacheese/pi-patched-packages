import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { hasCapturingOverlay } from "../host/pi-layout-adapter.ts";
import { parseMouse } from "../host/mouse-input.ts";
import type { MouseRect, MouseRegistry } from "../mouse.ts";
import { placeAnchoredOverlay } from "./anchored.ts";

export interface HoverPreviewTarget {
	readonly id: string;
	readonly rect: MouseRect;
}

export interface HoverPreviewOptions {
	readonly id: string;
	readonly tui: TUI;
	readonly registry: MouseRegistry;
	getTargets(screen: readonly string[]): readonly HoverPreviewTarget[];
	load(target: HoverPreviewTarget, size: { width: number; height: number }, signal: AbortSignal): Promise<Component>;
}

/** A passive, cancellable native overlay; pointer presses and keyboard input remain native. */
export function mountHoverPreview(options: HoverPreviewOptions): () => void {
	let active: HoverPreviewTarget | undefined;
	let pending: AbortController | undefined;
	let overlay: OverlayHandle | undefined;
	let size = { width: 0, height: 0 };
	const regions = new Map<string, { remove(): void }>();
	const key = (target: HoverPreviewTarget) => `${target.id}:${target.rect.x}:${target.rect.y}:${target.rect.width}`;
	const close = () => {
		active = undefined;
		pending?.abort();
		pending = undefined;
		overlay?.hide();
		overlay = undefined;
	};
	const open = async (target: HoverPreviewTarget) => {
		if (active && key(active) === key(target)) return;
		close();
		active = target;
		const request = new AbortController();
		pending = request;
		// Keep the preview beside, never on top of, its pointer target.
		const above = target.rect.y;
		const below = size.height - target.rect.y - target.rect.height;
		const width = Math.min(60, size.width);
		const height = Math.min(18, Math.max(above, below));
		if (width < 4 || height < 1) return;
		try {
			const component = await options.load(target, { width, height }, request.signal);
			if (request.signal.aborted || hasCapturingOverlay(options.tui)) return;
			const rows = Math.min(height, component.render(width).length);
			const placement = placeAnchoredOverlay({
				terminalCols: size.width,
				terminalRows: size.height,
				anchorRow: target.rect.y,
				anchorCol: target.rect.x,
				desiredWidth: width,
				height: rows,
			});
			overlay = options.tui.showOverlay(component, { ...placement.options, nonCapturing: true });
		} catch {
			// A failed or cancelled preview must not affect editing.
		}
	};
	const removeDecorator = options.registry.registerScreenDecorator({
		id: options.id,
		decorate(screen, context) {
			if (size.width !== context.width || size.height !== context.height) close();
			size = { width: context.width, height: context.height };
			const blocked = context.selectionActive || (context.hasOverlay && (!overlay || hasCapturingOverlay(options.tui)));
			const targets = blocked ? [] : options.getTargets(screen);
			const next = new Set(targets.map(key));
			if (active && !next.has(key(active))) close();
			for (const [id, region] of regions) {
				if (next.has(id)) continue;
				region.remove();
				regions.delete(id);
			}
			for (const target of targets) {
				const id = key(target);
				if (regions.has(id)) continue;
				const remove = options.registry.registerOverlayRegion({
					id: `${options.id}:${id}`,
					getRect: () => target.rect,
					onMouse(event) {
						if (event.type === "enter" || event.type === "move") {
							void open(target);
							return true;
						}
						if (active && key(active) === id) close();
						return false;
					},
				});
				regions.set(id, { remove });
			}
			return screen;
		},
	});
	const removeInput = options.tui.addInputListener((data) => {
		// Pointer motion maintains hover. Every other input dismisses without consuming it.
		const mouse = parseMouse(data);
		if (mouse.kind !== "event" || mouse.event.type !== "move") close();
	});
	return () => {
		close();
		removeInput();
		removeDecorator();
		for (const region of regions.values()) region.remove();
		regions.clear();
	};
}
