import { expect, test } from "bun:test";
import { markdownCodeRanges } from "../src/content/markdown-code.ts";

test("finds fenced and inline Markdown code without hiding ordinary text", () => {
	expect(
		markdownCodeRanges([
			"before `$inline` after",
			"```ts",
			"$fenced",
			"``` still fenced",
			"```",
			"$ordinary",
			String.raw`escaped \`$ordinary`,
		]),
	).toEqual([
		[{ start: 7, end: 16 }],
		[{ start: 0, end: 5 }],
		[{ start: 0, end: 7 }],
		[{ start: 0, end: 16 }],
		[{ start: 0, end: 3 }],
		[],
		[],
	]);
});
