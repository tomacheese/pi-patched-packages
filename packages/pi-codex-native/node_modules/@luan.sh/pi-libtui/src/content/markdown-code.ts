export interface TextRange {
	readonly start: number;
	readonly end: number;
}

interface Fence {
	readonly marker: "`" | "~";
	readonly length: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

/** Find fenced and inline Markdown code ranges without parsing unrelated Markdown syntax. */
export function markdownCodeRanges(lines: readonly string[]): readonly (readonly TextRange[])[] {
	let fence: Fence | undefined;
	return lines.map((line) => {
		const marker = FENCE.exec(line)?.[1];
		if (fence) {
			if (
				marker?.[0] === fence.marker &&
				marker.length >= fence.length &&
				/^[ \t]*$/u.test(line.slice(line.indexOf(marker) + marker.length))
			) {
				fence = undefined;
			}
			return [{ start: 0, end: line.length }];
		}
		if (marker) {
			fence = { marker: marker[0] as Fence["marker"], length: marker.length };
			return [{ start: 0, end: line.length }];
		}
		return inlineCodeRanges(line);
	});
}

function inlineCodeRanges(line: string): TextRange[] {
	const ranges: TextRange[] = [];
	for (let start = 0; start < line.length; start += 1) {
		if (line[start] !== "`" || escaped(line, start)) continue;
		const length = markerLength(line, start);
		const marker = "`".repeat(length);
		const end = line.indexOf(marker, start + length);
		if (end < 0) continue;
		ranges.push({ start, end: end + length });
		start = end + length - 1;
	}
	return ranges;
}

function markerLength(line: string, start: number): number {
	let end = start + 1;
	while (line[end] === "`") end += 1;
	return end - start;
}

function escaped(line: string, index: number): boolean {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) slashes += 1;
	return slashes % 2 === 1;
}
