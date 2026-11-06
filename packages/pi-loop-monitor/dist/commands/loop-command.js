import { formatTrigger } from "../loop-format.js";
import { isValidCronExpression, parseInterval } from "../loop-parse.js";
function parseLoopCommandRoute(input) {
    const trimmed = input.trim();
    if (!trimmed)
        return { type: "menu" };
    const eventMatch = trimmed.match(/^(?:event|when)\s+(\S+)\s+(.+)$/i);
    if (eventMatch?.[1] && eventMatch[2]) {
        return { type: "event", source: eventMatch[1], prompt: eventMatch[2].trim() };
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length > 5) {
        const interval = parts.slice(0, 5).join(" ");
        const cronShaped = parts.slice(0, 5).every((part) => /^[\d*/,-]+$/.test(part));
        if (cronShaped) {
            if (!isValidCronExpression(interval))
                return { type: "invalid-cron", interval };
            return { type: "cron", interval, prompt: parts.slice(5).join(" "), notifyEvery: false };
        }
    }
    const intervalMatch = trimmed.match(/^(\d+\s*[smhdS]\b)/i);
    if (intervalMatch) {
        const interval = intervalMatch[1] ?? intervalMatch[0];
        const prompt = trimmed.slice(intervalMatch[0].length).trim();
        if (!prompt)
            return { type: "missing-interval-prompt" };
        return { type: "cron", interval, prompt, notifyEvery: true };
    }
    return { type: "dynamic", goal: trimmed };
}
export function registerLoopCommand(options) {
    const { pi, getStore, getTriggerSystem, updateWidget, onDynamicLoopActivated, onLoopStopped } = options;
    function createCronLoop(ui, interval, prompt, notifyEvery) {
        let entry;
        try {
            const parsed = parseInterval(interval);
            const trigger = { type: "cron", schedule: parsed.cron };
            entry = getStore().create(trigger, prompt, { recurring: true });
            getTriggerSystem().add(entry);
            updateWidget();
            const cadence = notifyEvery ? `every ${parsed.description}` : parsed.description;
            ui.notify(`Loop #${entry.id} created: ${cadence} — ${prompt.slice(0, 50)}`, "info");
        }
        catch (err) {
            if (entry) {
                getTriggerSystem().remove(entry.id);
                getStore().delete(entry.id);
                updateWidget();
            }
            ui.notify(err.message, "error");
        }
    }
    async function scheduleLoop(ui, prompt) {
        const p = prompt || await ui.input("Prompt (what should the agent check?)");
        if (!p)
            return;
        const interval = await ui.input("Interval (e.g., 5m, 2h, 1d)");
        if (!interval)
            return;
        createCronLoop(ui, interval, p, true);
    }
    async function eventLoop(ui, prompt, sourceOverride) {
        const p = prompt || await ui.input("Prompt");
        if (!p)
            return;
        const source = sourceOverride || await ui.input("Pi event source (e.g., tool_execution_start, before_agent_start)");
        if (!source)
            return;
        const trigger = { type: "event", source };
        const entry = getStore().create(trigger, p, { recurring: true });
        getTriggerSystem().add(entry);
        updateWidget();
        ui.notify(`Event loop #${entry.id} created: fires on "${source}"`, "info");
    }
    function dynamicLoop(ui, goal) {
        const trigger = { type: "dynamic" };
        const entry = getStore().create(trigger, goal, {
            recurring: true,
            dynamic: { goal, iteration: 0 },
        });
        getTriggerSystem().add(entry);
        updateWidget();
        ui.notify(`Dynamic loop #${entry.id} created — ${goal.slice(0, 50)}`, "info");
        onDynamicLoopActivated?.(entry);
    }
    async function viewLoops(ui) {
        const loops = getStore().list();
        if (loops.length === 0) {
            await ui.select("No loops configured", ["< Back"]);
            return;
        }
        const choices = loops.map((l) => {
            const icon = l.status === "active" ? "*" : l.status === "paused" ? "-" : "x";
            return `${icon} #${l.id} [${l.status}] ${l.prompt.slice(0, 50)} (${formatTrigger(l.trigger, "command")})`;
        });
        choices.push("< Back");
        const selected = await ui.select("Loops", choices);
        if (!selected || selected === "< Back")
            return;
        const match = selected.match(/#(\d+)/);
        if (match?.[1]) {
            const entry = getStore().get(match[1]);
            if (entry) {
                const actions = ["x Delete"];
                if (entry.status === "active")
                    actions.unshift("- Pause");
                else if (entry.status === "paused"
                    && Date.now() < entry.expiresAt)
                    actions.unshift("* Resume");
                actions.push("< Back");
                const detail = `#${entry.id}: ${entry.prompt}\nTrigger: ${JSON.stringify(entry.trigger)}`;
                const action = await ui.select(detail, actions);
                if (action === "x Delete") {
                    getTriggerSystem().remove(entry.id);
                    getStore().delete(entry.id);
                    updateWidget();
                    onLoopStopped?.(entry.id);
                    ui.notify(`Loop #${entry.id} deleted`, "info");
                }
                else if (action === "- Pause") {
                    getStore().pause(entry.id);
                    getTriggerSystem().remove(entry.id);
                    updateWidget();
                    onLoopStopped?.(entry.id);
                    ui.notify(`Loop #${entry.id} paused`, "info");
                }
                else if (action === "* Resume") {
                    const resumed = getStore().resume(entry.id);
                    if (!resumed)
                        return viewLoops(ui);
                    getTriggerSystem().add(resumed);
                    updateWidget();
                    ui.notify(`Loop #${entry.id} resumed`, "info");
                    if (resumed.trigger.type === "dynamic")
                        onDynamicLoopActivated?.(resumed);
                }
            }
        }
        return viewLoops(ui);
    }
    async function settings(ui) {
        const loops = getStore().list();
        const active = loops.filter((l) => l.status === "active").length;
        ui.notify(`${active}/${loops.length} active loops (max 25)`, "info");
    }
    pi.registerCommand("loop", {
        description: "Create a loop. Use /loop [interval] [prompt] for scheduled loops, /loop event <source> <prompt> for event loops, or /loop <goal> for a dynamic goal loop.",
        handler: async (args, ctx) => {
            const ui = ctx.ui;
            const route = parseLoopCommandRoute(args);
            if (route.type === "menu") {
                const choice = await ui.select("Loop", [
                    "Create scheduled loop",
                    "Create event-triggered loop",
                    "View loops",
                    "Settings",
                ]);
                if (!choice)
                    return;
                if (choice.startsWith("Create scheduled"))
                    return scheduleLoop(ui);
                if (choice.startsWith("Create event"))
                    return eventLoop(ui);
                if (choice.startsWith("View loops"))
                    return viewLoops(ui);
                return settings(ui);
            }
            if (route.type === "event")
                return eventLoop(ui, route.prompt, route.source);
            if (route.type === "cron")
                return createCronLoop(ui, route.interval, route.prompt, route.notifyEvery);
            if (route.type === "invalid-cron") {
                ui.notify(`Invalid cron expression: ${route.interval}`, "error");
                return;
            }
            if (route.type === "missing-interval-prompt") {
                ui.notify("Provide a prompt after the interval, e.g., /loop 5m check the deploy", "warning");
                return;
            }
            return dynamicLoop(ui, route.goal);
        },
    });
}
