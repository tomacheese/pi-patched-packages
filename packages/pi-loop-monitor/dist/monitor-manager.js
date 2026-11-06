import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { MonitorOutputLog } from "./monitor-output-log.js";
import { reduceMonitorState, } from "./monitor-reducer.js";
import { isStaleExtensionContextError } from "./runtime/stale-context.js";
const OUTPUT_EVENT_INTERVAL_MS = 1000;
export const MAX_RUNNING_MONITORS = 25;
const MAX_OUTPUT_LINE_LENGTH = 4096;
const OUTPUT_RATE_WINDOW_MS = 60000;
export const MONITOR_RETENTION_MS = 15 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export class MonitorManager {
    pi;
    processes = new Map();
    outputLogs = new Map();
    nextId = 1;
    onChange;
    spawnFn;
    platform;
    taskkillSpawn;
    shutdownPromise;
    stopPromises = new Map();
    shuttingDown = false;
    constructor(pi, spawnFn, options = {}) {
        this.pi = pi;
        this.spawnFn = spawnFn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts));
        this.platform = options.platform ?? process.platform;
        this.taskkillSpawn = options.taskkillSpawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts));
    }
    /**
     * Register a callback fired when a monitor's status changes or it is pruned
     * (e.g. autonomous completion/error/stop/prune with no tool call). Used to
     * repaint the status widget, which otherwise only refreshes on turn
     * boundaries and explicit tool actions. Not fired for output lines.
     */
    setOnChange(cb) {
        if (!this.shuttingDown)
            this.onChange = cb;
    }
    toReducerState() {
        return {
            nextId: this.nextId,
            monitorsById: Object.fromEntries(Array.from(this.processes.entries()).map(([id, process]) => [id, process.entry])),
        };
    }
    applyReducerEvent(event) {
        const result = reduceMonitorState(this.toReducerState(), event);
        this.nextId = result.state.nextId;
        for (const [id, process] of [...this.processes.entries()]) {
            const updated = result.state.monitorsById[id];
            if (!updated) {
                this.processes.delete(id);
                this.disposeOutputLog(id);
                continue;
            }
            process.entry = updated;
        }
        // Repaint on status/progress transitions, but not on frequent output-line
        // events that do not change the visible status.
        if (event.type !== "MONITOR_OUTPUT"
            && event.type !== "MONITOR_ONDONE_REGISTERED"
            && event.type !== "MONITOR_PROGRESS_UPDATED") {
            this.notifyChange();
        }
        return result;
    }
    notifyChange() {
        if (this.shuttingDown)
            return;
        try {
            this.onChange?.();
        }
        catch (error) {
            if (!isStaleExtensionContextError(error))
                throw error;
        }
    }
    emit(event, payload) {
        if (this.shuttingDown)
            return;
        try {
            this.pi.events.emit(event, payload);
        }
        catch (error) {
            if (!isStaleExtensionContextError(error))
                throw error;
        }
    }
    notifyTerminal(bp, monitor) {
        bp.terminalReady = true;
        if (this.shuttingDown)
            return;
        for (const callback of bp.terminalCallbacks)
            callback(monitor);
        bp.terminalCallbacks = [];
    }
    clearDeadline(bp) {
        if (!bp.deadlineTimer)
            return;
        clearTimeout(bp.deadlineTimer);
        bp.deadlineTimer = undefined;
    }
    markActivity(bp) {
        if (this.shuttingDown || bp.entry.status !== "running")
            return;
        bp.lastActivityAt = Date.now();
        bp.lastActivityMonotonic = globalThis.performance.now();
    }
    scheduleInactivityCheck(id, bp, delay = bp.entry.timeout) {
        if (bp.deadlineTimer || this.shuttingDown || bp.entry.status !== "running" || bp.entry.timeout <= 0)
            return;
        const deadlineTimer = setTimeout(() => {
            if (bp.deadlineTimer !== deadlineTimer)
                return;
            bp.deadlineTimer = undefined;
            if (this.shuttingDown || bp.entry.status !== "running")
                return;
            const remaining = bp.entry.timeout - (globalThis.performance.now() - bp.lastActivityMonotonic);
            if (remaining > 0) {
                this.scheduleInactivityCheck(id, bp, remaining);
                return;
            }
            void this.stop(id, "timeout");
        }, Math.min(Math.max(1, delay), MAX_TIMER_DELAY_MS));
        deadlineTimer.unref?.();
        bp.deadlineTimer = deadlineTimer;
    }
    signalProcessTree(bp, signal) {
        let fellBack = false;
        const fallback = () => {
            if (fellBack)
                return;
            fellBack = true;
            try {
                bp.proc.kill(signal);
            }
            catch { /* already dead */ }
        };
        if (this.platform === "win32") {
            try {
                const taskkill = this.taskkillSpawn("taskkill", ["/pid", String(bp.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
                taskkill.once("error", fallback);
                taskkill.once("close", (code) => {
                    if (code !== 0)
                        fallback();
                });
                return;
            }
            catch {
                fallback();
                return;
            }
        }
        try {
            process.kill(-bp.pid, signal);
        }
        catch {
            fallback();
        }
    }
    // Retain terminal state long enough for a completion wake to inspect it.
    schedulePrune(id) {
        if (this.shuttingDown)
            return;
        // unref so a pending prune never keeps a one-shot (`pi -p`) process alive.
        const timer = setTimeout(() => {
            if (this.shuttingDown)
                return;
            this.applyReducerEvent({
                type: "MONITOR_PRUNED",
                at: Date.now(),
                source: "system",
                entityType: "monitor",
                entityId: id,
                payload: { id },
            });
        }, MONITOR_RETENTION_MS);
        timer.unref?.();
    }
    create(command, description, timeout = 300000) {
        if (this.list().filter((monitor) => monitor.status === "running").length >= MAX_RUNNING_MONITORS) {
            throw new Error(`Maximum of ${MAX_RUNNING_MONITORS} running monitors reached. Stop some before creating new ones.`);
        }
        if (!Number.isFinite(timeout) || timeout < 0) {
            throw new Error("Monitor timeout must be a finite nonnegative number");
        }
        const now = Date.now();
        const result = reduceMonitorState(this.toReducerState(), {
            type: "MONITOR_CREATED",
            at: now,
            source: "tool",
            entityType: "monitor",
            payload: {
                command,
                description,
                timeout,
            },
        });
        this.nextId = result.state.nextId;
        const id = String(this.nextId - 1);
        const entry = result.state.monitorsById[id];
        const abortController = new AbortController();
        const log = new MonitorOutputLog();
        let child;
        try {
            child = this.spawnFn("sh", ["-c", command], {
                stdio: ["ignore", "pipe", "pipe"],
                signal: abortController.signal,
                env: { ...process.env },
                detached: this.platform !== "win32",
            });
        }
        catch (error) {
            log.dispose();
            throw error;
        }
        this.outputLogs.set(id, log);
        const bp = {
            entry,
            pid: child.pid,
            proc: child,
            abortController,
            waiters: [],
            completionCallbacks: [],
            terminalCallbacks: [],
            terminalReady: false,
            lastActivityAt: now,
            lastActivityMonotonic: globalThis.performance.now(),
            lastOutputEventAt: 0,
            lastProgressChangeAt: 0,
            pendingOutputLines: 0,
            outputBuckets: [],
            stdoutDecoder: new StringDecoder("utf8"),
            stderrDecoder: new StringDecoder("utf8"),
            stdoutRemainder: "",
            stderrRemainder: "",
        };
        child.stdout?.on("data", (data) => this.handleOutput(id, bp, "stdout", data));
        child.stderr?.on("data", (data) => this.handleOutput(id, bp, "stderr", data));
        const finish = (code, status) => {
            if (this.shuttingDown)
                return;
            this.flushOutput(id, bp);
            this.clearDeadline(bp);
            this.emitOutputProgress(id, bp);
            this.applyReducerEvent({
                type: status === "completed" ? "MONITOR_COMPLETED" : "MONITOR_ERRORED",
                at: Date.now(),
                source: "monitor",
                entityType: "monitor",
                entityId: id,
                payload: {
                    id,
                    exitCode: code ?? undefined,
                },
            });
            const current = this.get(id);
            this.emit("monitor:finished", {
                monitorId: id,
                status: current.status,
                exitCode: current.exitCode,
                outputLines: current.outputLines,
                reportedOutcome: current.reportedOutcome,
            });
            this.emit(status === "completed" ? "monitor:done" : "monitor:error", {
                monitorId: id,
                exitCode: code,
                outputLines: current.outputLines,
                reportedOutcome: current.reportedOutcome,
            });
            for (const callback of bp.completionCallbacks)
                callback(current);
            bp.completionCallbacks = [];
            this.notifyTerminal(bp, current);
            for (const resolve of bp.waiters)
                resolve();
            bp.waiters = [];
            this.schedulePrune(id);
        };
        child.on("close", (code) => {
            if (this.shuttingDown)
                return;
            this.flushOutput(id, bp);
            if (bp.entry.status === "running") {
                finish(code, code === 0 ? "completed" : "error");
            }
        });
        child.on("error", (err) => {
            if (!this.shuttingDown && bp.entry.status === "running") {
                this.flushOutput(id, bp);
                this.clearDeadline(bp);
                this.emitOutputProgress(id, bp);
                this.applyReducerEvent({
                    type: "MONITOR_ERRORED",
                    at: Date.now(),
                    source: "monitor",
                    entityType: "monitor",
                    entityId: id,
                    payload: {
                        id,
                        error: err.message,
                    },
                });
                const current = this.get(id);
                this.emit("monitor:finished", {
                    monitorId: id,
                    status: current.status,
                    error: err.message,
                    outputLines: current.outputLines,
                    reportedOutcome: current.reportedOutcome,
                });
                this.emit("monitor:error", {
                    monitorId: id,
                    error: err.message,
                    reportedOutcome: current.reportedOutcome,
                });
                for (const callback of bp.completionCallbacks)
                    callback(current);
                bp.completionCallbacks = [];
                this.notifyTerminal(bp, current);
                for (const resolve of bp.waiters)
                    resolve();
                bp.waiters = [];
                this.schedulePrune(id);
            }
        });
        this.scheduleInactivityCheck(id, bp);
        this.processes.set(id, bp);
        this.emit("monitor:started", {
            monitorId: id,
            command,
            description,
            timeout,
            timestamp: now,
        });
        return entry;
    }
    get(id) {
        const bp = this.processes.get(id);
        return bp?.entry;
    }
    list() {
        return Array.from(this.processes.values())
            .map(bp => ({ ...bp.entry, lastActivityAt: bp.lastActivityAt }))
            .sort((a, b) => Number(a.id) - Number(b.id));
    }
    readOutput(id, offset) {
        const log = this.outputLogs.get(id);
        if (!log)
            throw new Error("Monitor output is no longer available");
        return log.read(offset);
    }
    disposeOutputLog(id) {
        const log = this.outputLogs.get(id);
        this.outputLogs.delete(id);
        try {
            log?.dispose();
        }
        catch { /* best-effort temporary file cleanup */ }
    }
    shutdown() {
        if (this.shutdownPromise)
            return this.shutdownPromise;
        this.shuttingDown = true;
        const processes = Array.from(this.processes.values());
        for (const bp of processes)
            this.clearDeadline(bp);
        const running = processes.filter((bp) => bp.entry.status === "running");
        const stopping = Array.from(this.stopPromises.values());
        const shutdown = Promise.allSettled([...stopping, ...running.map((bp) => this.stop(bp.entry.id))])
            .then(() => {
            for (const bp of processes) {
                if (bp.progressChangeTimer)
                    clearTimeout(bp.progressChangeTimer);
                bp.completionCallbacks = [];
                bp.terminalCallbacks = [];
                for (const resolve of bp.waiters)
                    resolve();
                bp.waiters = [];
            }
            this.processes.clear();
            for (const id of this.outputLogs.keys())
                this.disposeOutputLog(id);
            this.shuttingDown = false;
            this.shutdownPromise = undefined;
        });
        this.shutdownPromise = shutdown;
        return shutdown;
    }
    stop(id, reason = "manual") {
        const existing = this.stopPromises.get(id);
        if (existing)
            return existing;
        const tracked = Promise.resolve()
            .then(() => this.stopProcess(id, reason))
            .finally(() => this.stopPromises.delete(id));
        this.stopPromises.set(id, tracked);
        return tracked;
    }
    async stopProcess(id, reason) {
        const bp = this.processes.get(id);
        if (!bp || bp.entry.status !== "running")
            return false;
        this.clearDeadline(bp);
        this.emitOutputProgress(id, bp);
        this.applyReducerEvent({
            type: "MONITOR_STOPPED",
            at: Date.now(),
            source: "tool",
            entityType: "monitor",
            entityId: id,
            payload: {
                id,
                reason,
            },
        });
        this.emit("monitor:finished", {
            monitorId: id,
            status: "stopped",
            reason,
            outputLines: bp.entry.outputLines,
            reportedOutcome: bp.entry.reportedOutcome,
        });
        if (!this.shuttingDown)
            this.schedulePrune(id);
        this.signalProcessTree(bp, "SIGTERM");
        if (reason === "timeout") {
            this.emit("monitor:error", {
                monitorId: id,
                error: `No monitor activity for ${bp.entry.timeout}ms`,
                outputLines: bp.entry.outputLines,
                reportedOutcome: bp.entry.reportedOutcome,
            });
            for (const callback of bp.completionCallbacks)
                callback(bp.entry);
            bp.completionCallbacks = [];
        }
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.signalProcessTree(bp, "SIGKILL");
                resolve();
            }, 5000);
            bp.proc.on("close", () => {
                clearTimeout(timer);
                resolve();
            });
        });
        this.notifyTerminal(bp, bp.entry);
        bp.completionCallbacks = [];
        for (const resolve of bp.waiters)
            resolve();
        bp.waiters = [];
        return true;
    }
    onComplete(id, callback) {
        if (this.shuttingDown)
            return false;
        const bp = this.processes.get(id);
        if (!bp)
            return false;
        if (bp.entry.status === "completed" || bp.entry.status === "error") {
            callback(bp.entry);
            return true;
        }
        if (bp.entry.status !== "running")
            return false;
        this.applyReducerEvent({
            type: "MONITOR_ONDONE_REGISTERED",
            at: Date.now(),
            source: "tool",
            entityType: "monitor",
            entityId: id,
            payload: { id },
        });
        bp.completionCallbacks.push(callback);
        return true;
    }
    onTerminal(id, callback) {
        if (this.shuttingDown)
            return false;
        const bp = this.processes.get(id);
        if (!bp)
            return false;
        if (bp.entry.status !== "running") {
            if (bp.terminalReady)
                callback(bp.entry);
            else
                bp.terminalCallbacks.push(callback);
            return true;
        }
        bp.terminalCallbacks.push(callback);
        return true;
    }
    getProcess(id) {
        return this.processes.get(id);
    }
    updateProgress(id, progress) {
        const bp = this.processes.get(id);
        if (!bp || bp.entry.status !== "running")
            return undefined;
        this.applyProgress(id, { ...progress, source: "agent" });
        return this.get(id);
    }
    handleOutput(id, bp, stream, data) {
        this.outputLogs.get(id)?.append(data);
        if (this.shuttingDown)
            return;
        if (data.length > 0)
            this.markActivity(bp);
        const decoder = stream === "stdout" ? bp.stdoutDecoder : bp.stderrDecoder;
        const text = decoder.write(data);
        const remainderKey = stream === "stdout" ? "stdoutRemainder" : "stderrRemainder";
        const records = `${bp[remainderKey]}${text}`.split("\n");
        // The complete text is already on disk; only the bounded tool tail needs this remainder.
        bp[remainderKey] = (records.pop() ?? "").slice(0, MAX_OUTPUT_LINE_LENGTH + 1);
        this.recordOutputLines(id, bp, records);
    }
    flushOutput(id, bp) {
        if (this.shuttingDown)
            return;
        const stdout = `${bp.stdoutRemainder}${bp.stdoutDecoder.end()}`;
        const stderr = `${bp.stderrRemainder}${bp.stderrDecoder.end()}`;
        bp.stdoutRemainder = "";
        bp.stderrRemainder = "";
        this.recordOutputLines(id, bp, [stdout, stderr]);
    }
    recordOutputLines(id, bp, records) {
        if (this.shuttingDown)
            return;
        const lines = records
            .map(line => line.endsWith("\r") ? line.slice(0, -1) : line)
            .filter(Boolean)
            .map(line => line.length <= MAX_OUTPUT_LINE_LENGTH ? line : `${line.slice(0, MAX_OUTPUT_LINE_LENGTH)}... [truncated]`);
        if (lines.length === 0)
            return;
        const now = Date.now();
        const second = Math.floor(now / 1000);
        const bucket = bp.outputBuckets.find(candidate => candidate.second === second);
        if (bucket)
            bucket.count += lines.length;
        else
            bp.outputBuckets.push({ second, count: lines.length });
        bp.outputBuckets = bp.outputBuckets.filter(candidate => candidate.second > second - OUTPUT_RATE_WINDOW_MS / 1000);
        const ratePerMinute = bp.outputBuckets.reduce((total, candidate) => total + candidate.count, 0);
        this.applyReducerEvent({
            type: "MONITOR_OUTPUT",
            at: now,
            source: "monitor",
            entityType: "monitor",
            entityId: id,
            payload: { id, lines, ratePerMinute },
        });
        bp.pendingOutputLines += lines.length;
        bp.latestOutputLine = lines.at(-1);
        for (const line of lines) {
            const progress = parseJsonlProgress(line);
            if (progress)
                this.applyProgress(id, { ...progress, source: "jsonl" });
            const outcome = parseJsonlOutcome(line);
            if (outcome) {
                this.applyReducerEvent({
                    type: "MONITOR_OUTCOME_REPORTED", at: Date.now(), source: "monitor",
                    entityType: "monitor", entityId: id, payload: { id, outcome },
                });
                this.emit("monitor:signal", { monitorId: id, outcome, timestamp: Date.now() });
            }
        }
        if (Date.now() - bp.lastOutputEventAt >= OUTPUT_EVENT_INTERVAL_MS) {
            this.emitOutputProgress(id, bp);
        }
    }
    emitOutputProgress(id, bp) {
        if (!bp.latestOutputLine || bp.pendingOutputLines === 0)
            return;
        const current = this.get(id);
        if (!current)
            return;
        this.emit("monitor:output", {
            monitorId: id,
            line: bp.latestOutputLine,
            outputLines: current.outputLines,
            droppedLines: bp.pendingOutputLines - 1,
            timestamp: Date.now(),
        });
        bp.lastOutputEventAt = Date.now();
        bp.pendingOutputLines = 0;
        bp.latestOutputLine = undefined;
    }
    applyProgress(id, progress) {
        if (this.shuttingDown)
            return;
        this.applyReducerEvent({
            type: "MONITOR_PROGRESS_UPDATED",
            at: Date.now(),
            source: progress.source === "agent" ? "tool" : "monitor",
            entityType: "monitor",
            entityId: id,
            payload: { id, progress },
        });
        const bp = this.processes.get(id);
        if (bp) {
            this.markActivity(bp);
            this.scheduleProgressChange(bp);
        }
    }
    scheduleProgressChange(bp) {
        if (this.shuttingDown)
            return;
        const now = Date.now();
        const delay = OUTPUT_EVENT_INTERVAL_MS - (now - bp.lastProgressChangeAt);
        if (delay <= 0) {
            bp.lastProgressChangeAt = now;
            this.notifyChange();
            return;
        }
        if (bp.progressChangeTimer)
            return;
        bp.progressChangeTimer = setTimeout(() => {
            bp.progressChangeTimer = undefined;
            if (this.shuttingDown)
                return;
            bp.lastProgressChangeAt = Date.now();
            this.notifyChange();
        }, delay);
        bp.progressChangeTimer.unref?.();
    }
}
function parseJsonlOutcome(line) {
    try {
        const value = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const outcome = value.monitorOutcome;
        if (!outcome || typeof outcome !== "object" || Array.isArray(outcome))
            return undefined;
        const { status, message } = outcome;
        if (typeof status !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/i.test(status))
            return undefined;
        if (message !== undefined && (typeof message !== "string" || message.length > 1000))
            return undefined;
        return { status, ...(message === undefined ? {} : { message }) };
    }
    catch {
        return undefined;
    }
}
function parseJsonlProgress(line) {
    try {
        const value = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const progress = value.progress;
        if (!progress || typeof progress !== "object" || Array.isArray(progress))
            return undefined;
        const { current, total, message } = progress;
        if ((current !== undefined && (typeof current !== "number" || !Number.isFinite(current)))
            || (total !== undefined && (typeof total !== "number" || !Number.isFinite(total)))
            || (message !== undefined && typeof message !== "string")
            || (current === undefined && total === undefined && message === undefined))
            return undefined;
        return { current, total, message };
    }
    catch {
        return undefined;
    }
}
