import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { MonitorManager } from "../monitor-manager.js";
import type { LoopStore } from "../store.js";
export declare class LoopWidget {
    private store;
    private monitorManager;
    private uiCtx;
    constructor(store: LoopStore, monitorManager: MonitorManager);
    setUICtx(ctx: ExtensionUIContext): void;
    setStore(store: LoopStore): void;
    update(): void;
    private computeStatus;
    dispose(): void;
}
