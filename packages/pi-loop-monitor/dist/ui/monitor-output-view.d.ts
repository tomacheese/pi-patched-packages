import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { MonitorOutputPage } from "../monitor-output-log.js";
import type { MonitorEntry } from "../types.js";
/** One isolated monitor screen; the dashboard owns its refresh and back navigation. */
export declare class MonitorOutputView {
    private readonly theme;
    private readonly keybindings;
    private readonly read;
    private page;
    private following;
    private offset;
    private row;
    private bottomOnLoad;
    private rows;
    private bodyHeight;
    private cachedText;
    private cachedWidth;
    constructor(theme: Theme, keybindings: KeybindingsManager, read: (offset?: number) => MonitorOutputPage);
    invalidate(): void;
    render(width: number, height: number, monitor: MonitorEntry | undefined): string[];
    handleInput(data: string): void;
    private scroll;
}
