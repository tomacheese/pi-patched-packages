import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
type OverlayComponent = Component & Focusable & {
    dispose?(): void;
};
export declare function runMonitorsOverlay(ctx: ExtensionCommandContext, createComponent: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, close: () => void) => OverlayComponent): Promise<void>;
export {};
