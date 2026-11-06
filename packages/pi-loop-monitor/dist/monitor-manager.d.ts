import { type ChildProcess, type SpawnOptions } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type MonitorOutputPage } from "./monitor-output-log.js";
import type { MonitorEntry, MonitorProcess, MonitorProgress } from "./types.js";
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface MonitorManagerOptions {
    platform?: NodeJS.Platform;
    taskkillSpawn?: SpawnFn;
}
export declare const MAX_RUNNING_MONITORS = 25;
export declare const MONITOR_RETENTION_MS: number;
export declare class MonitorManager {
    private pi;
    private processes;
    private readonly outputLogs;
    private nextId;
    private onChange;
    private spawnFn;
    private platform;
    private taskkillSpawn;
    private shutdownPromise;
    private readonly stopPromises;
    private shuttingDown;
    constructor(pi: ExtensionAPI, spawnFn?: SpawnFn, options?: MonitorManagerOptions);
    /**
     * Register a callback fired when a monitor's status changes or it is pruned
     * (e.g. autonomous completion/error/stop/prune with no tool call). Used to
     * repaint the status widget, which otherwise only refreshes on turn
     * boundaries and explicit tool actions. Not fired for output lines.
     */
    setOnChange(cb: () => void): void;
    private toReducerState;
    private applyReducerEvent;
    private notifyChange;
    private emit;
    private notifyTerminal;
    private clearDeadline;
    private markActivity;
    private scheduleInactivityCheck;
    private signalProcessTree;
    private schedulePrune;
    create(command: string, description?: string, timeout?: number): MonitorEntry;
    get(id: string): MonitorEntry | undefined;
    list(): MonitorEntry[];
    readOutput(id: string, offset?: number): MonitorOutputPage;
    private disposeOutputLog;
    shutdown(): Promise<void>;
    stop(id: string, reason?: "manual" | "timeout"): Promise<boolean>;
    private stopProcess;
    onComplete(id: string, callback: (monitor: MonitorEntry) => void): boolean;
    onTerminal(id: string, callback: (monitor: MonitorEntry) => void): boolean;
    getProcess(id: string): MonitorProcess | undefined;
    updateProgress(id: string, progress: Omit<MonitorProgress, "source" | "updatedAt">): MonitorEntry | undefined;
    private handleOutput;
    private flushOutput;
    private recordOutputLines;
    private emitOutputProgress;
    private applyProgress;
    private scheduleProgressChange;
}
