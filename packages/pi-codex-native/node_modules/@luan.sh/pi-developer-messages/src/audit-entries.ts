import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { ComponentStack, icon, MarkdownText, sanitizeTuiField, tuiTheme } from "@luan.sh/pi-libtui";
import { ToolActivity } from "@luan.sh/pi-libtui/tool";
import type { PromptAuditRole } from "./contributions/xsettings.ts";
import type { PromptEnvelope } from "./prompt-envelope.ts";

export const DEVELOPER_AUDIT_ENTRY_TYPE = "pi-developer-messages/developer";
export const CONTEXT_USER_AUDIT_ENTRY_TYPE = "pi-developer-messages/context-user";
export const PROMPT_AUDIT_GROUP_ENTRY_TYPE = "pi-developer-messages/group";

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

interface AgentMessageLike {
	role?: string;
	customType?: string;
}

interface PromptAuditData {
	role: "developer" | "user";
	id: string;
	content: string;
}

export interface PromptAuditGroupData {
	entries: PromptAuditData[];
}

export function registerPromptAuditEntryRenderers(pi: Pick<ExtensionAPI, "registerEntryRenderer">): void {
	for (const customType of [DEVELOPER_AUDIT_ENTRY_TYPE, CONTEXT_USER_AUDIT_ENTRY_TYPE])
		pi.registerEntryRenderer(customType, (entry, { expanded }, theme) => {
			const data = promptAuditData(entry.data);
			return data ? renderAuditRow(data, theme, expanded) : invalidAuditEntry(theme);
		});
	pi.registerEntryRenderer(PROMPT_AUDIT_GROUP_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = promptAuditGroupData(entry.data);
		if (!data) return invalidAuditEntry(theme);
		return new ComponentStack(data.entries.map((item) => renderAuditRow(item, theme, expanded)));
	});
}

export function publishPromptAuditEntries(
	pi: Pick<ExtensionAPI, "appendEntry">,
	entries: readonly SessionEntryLike[],
	envelope: PromptEnvelope,
	roles: readonly PromptAuditRole[],
): void {
	const auditEntries: PromptAuditData[] = [];
	if (roles.includes("developer")) {
		for (const message of envelope.developerMessages)
			auditEntries.push({ role: "developer", id: message.id, content: message.content });
	}
	if (roles.includes("context-user")) {
		for (const message of envelope.contextualUserMessages)
			auditEntries.push({ role: "user", id: message.id, content: message.content });
	}
	const changedEntries = auditEntries.filter((item) => !isCurrentAuditEntry(entries, item));
	if (changedEntries.length === 0) return;
	try {
		pi.appendEntry(PROMPT_AUDIT_GROUP_ENTRY_TYPE, { entries: changedEntries });
	} catch {
		// Audit persistence must not change the model request.
	}
}

export function removePromptAuditMessages<T extends AgentMessageLike>(messages: readonly T[]): T[] | undefined {
	const filtered = messages.filter((message) => message.role !== "custom" || !isPromptAuditType(message.customType));
	return filtered.length === messages.length ? undefined : filtered;
}

export function removePromptAuditEntries<T extends SessionEntryLike>(entries: readonly T[]): T[] | undefined {
	const filtered = entries.filter((entry) => entry.type !== "custom_message" || !isPromptAuditType(entry.customType));
	return filtered.length === entries.length ? undefined : filtered;
}

function isPromptAuditType(customType: string | undefined): boolean {
	return (
		customType === DEVELOPER_AUDIT_ENTRY_TYPE ||
		customType === CONTEXT_USER_AUDIT_ENTRY_TYPE ||
		customType === PROMPT_AUDIT_GROUP_ENTRY_TYPE
	);
}

function isCurrentAuditEntry(entries: readonly SessionEntryLike[], expected: PromptAuditData): boolean {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || !isPromptAuditType(entry.customType)) continue;
		const candidates =
			entry.customType === PROMPT_AUDIT_GROUP_ENTRY_TYPE
				? (promptAuditGroupData(entry.data)?.entries ?? [])
				: [promptAuditData(entry.data)];
		const previous = candidates.find((item) => item?.role === expected.role && item.id === expected.id);
		if (previous) return previous.content === expected.content;
	}
	return false;
}

function renderAuditRow(data: PromptAuditData, theme: Theme, expanded: boolean): Component {
	const body = new MarkdownText({ theme, text: data.content });
	return new ToolActivity({
		theme,
		requestRender() {},
		maxHeight: 20,
		action: new PromptAuditAction(theme, data),
		view: {
			action: { verb: data.role, status: "succeeded", marker: false },
			mode: expanded ? "full" : "preview",
			// The audit header is the disclosure control. Keep the preview empty so
			// prompt content never gets duplicated or replaced by an omission row.
			payload: { kind: "component", preview: EMPTY_AUDIT_PREVIEW, full: body },
		},
	});
}

const EMPTY_AUDIT_PREVIEW: Component = {
	render: () => [],
	invalidate() {},
};

class PromptAuditAction implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly data: PromptAuditData,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const colors = tuiTheme(this.theme);
		const heading = `${colors.fg(
			{ hue: "blue", shade: 2 },
			icon(this.data.role === "developer" ? "developer" : "user"),
		)} ${colors.fg("text.muted", sanitizeTuiField(this.data.role))} ${colors.fg("text.muted", "·")} ${colors.fg(
			{ hue: "green", shade: 3 },
			sanitizeTuiField(this.data.id),
		)}`;
		return [truncateToWidth(heading, Math.floor(width), "…")];
	}

	invalidate(): void {}
}

function invalidAuditEntry(theme: Theme): Text {
	return new Text(tuiTheme(theme).fg("negative", "Invalid prompt audit entry"), 0, 0);
}

function promptAuditData(value: unknown): PromptAuditData | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const data = value as Partial<PromptAuditData>;
	if (
		(data.role !== "developer" && data.role !== "user") ||
		typeof data.id !== "string" ||
		typeof data.content !== "string"
	)
		return undefined;
	return {
		role: data.role,
		id: data.id,
		content: data.content,
	};
}

function promptAuditGroupData(value: unknown): PromptAuditGroupData | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = (value as { entries?: unknown }).entries;
	if (!Array.isArray(entries)) return undefined;
	const parsed = entries.map(promptAuditData);
	return parsed.every((entry): entry is PromptAuditData => entry !== undefined) ? { entries: parsed } : undefined;
}
