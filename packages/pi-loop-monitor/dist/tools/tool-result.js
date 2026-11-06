import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
export function displayRows(rows, limit = 8) {
    const lines = rows.flatMap((row) => row.split("\n"));
    if (lines.length <= limit)
        return lines;
    return [...lines.slice(0, limit), `… ${lines.length - limit} more`];
}
function truncateToolContent(content) {
    const result = truncateHead(content, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
    if (!result.truncated)
        return content;
    const fullOutputPath = join(tmpdir(), `pi-loop-tool-${randomUUID()}.log`);
    writeFileSync(fullOutputPath, content, { encoding: "utf8", mode: 0o600 });
    return `${result.content}\n\n[Output truncated: ${result.outputLines} of ${result.totalLines} lines (${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}). Full output: ${fullOutputPath}]`;
}
export function textResult(msg, details) {
    const display = details
        ? { ...details, expandable: details.expandable ?? Boolean(details.expanded?.length) }
        : undefined;
    return { content: [{ type: "text", text: truncateToolContent(msg) }], details: display };
}
