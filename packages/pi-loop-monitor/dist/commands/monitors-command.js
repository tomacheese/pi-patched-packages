import { MonitorsDashboard } from "../ui/monitors-dashboard.js";
import { runMonitorsOverlay } from "../ui/overlay.js";
export function registerMonitorsCommand(options) {
    const { pi, getStore, getMonitorManager, getTriggerSystem, updateWidget, onDynamicLoopActivated, onLoopStopped, onMonitorStopping, } = options;
    let closeActiveDashboard;
    const refreshWidget = () => {
        try {
            updateWidget();
        }
        catch { /* dashboard actions remain authoritative */ }
    };
    pi.on("session_shutdown", () => {
        closeActiveDashboard?.();
        closeActiveDashboard = undefined;
    });
    pi.registerCommand("monitors", {
        description: "Open the loops and background monitors dashboard",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") {
                throw new Error("/monitors requires interactive TUI mode");
            }
            let commandClose;
            try {
                closeActiveDashboard?.();
                await runMonitorsOverlay(ctx, (tui, theme, keybindings, close) => {
                    const closeCurrent = () => {
                        if (closeActiveDashboard === closeCurrent)
                            closeActiveDashboard = undefined;
                        close();
                    };
                    commandClose = closeCurrent;
                    closeActiveDashboard = closeCurrent;
                    return new MonitorsDashboard(tui, theme, keybindings, {
                        listLoops: () => getStore().list(),
                        listMonitors: () => getMonitorManager().list(),
                        readMonitorOutput: (id, offset) => getMonitorManager().readOutput(id, offset),
                        pauseLoop: (id) => {
                            const entry = getStore().get(id);
                            if (entry?.status !== "active")
                                return false;
                            const paused = getStore().pause(id);
                            if (!paused)
                                return false;
                            try {
                                getTriggerSystem().remove(id);
                            }
                            catch { /* paused state remains authoritative */ }
                            onLoopStopped?.(id);
                            refreshWidget();
                            return true;
                        },
                        resumeLoop: (id) => {
                            const resumed = getStore().resume(id);
                            if (!resumed)
                                return false;
                            try {
                                getTriggerSystem().add(resumed);
                                if (resumed.trigger.type === "dynamic")
                                    onDynamicLoopActivated?.(resumed);
                            }
                            catch (error) {
                                try {
                                    getTriggerSystem().remove(id);
                                }
                                catch { /* rollback continues */ }
                                try {
                                    getStore().pause(id);
                                }
                                catch { /* preserve the original error */ }
                                throw error;
                            }
                            refreshWidget();
                            return true;
                        },
                        deleteLoop: (id) => {
                            const entry = getStore().get(id);
                            if (!entry)
                                return false;
                            const deleted = getStore().delete(id);
                            if (!deleted)
                                return false;
                            try {
                                getTriggerSystem().remove(id);
                            }
                            catch { /* deleted state remains authoritative */ }
                            onLoopStopped?.(id);
                            refreshWidget();
                            return true;
                        },
                        stopMonitor: async (id) => {
                            onMonitorStopping?.(id);
                            const stopped = await getMonitorManager().stop(id);
                            refreshWidget();
                            return stopped;
                        },
                    }, closeCurrent);
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "The monitor dashboard could not be opened.";
                ctx.ui.notify(message, "error");
            }
            finally {
                if (closeActiveDashboard === commandClose)
                    closeActiveDashboard = undefined;
            }
        },
    });
}
