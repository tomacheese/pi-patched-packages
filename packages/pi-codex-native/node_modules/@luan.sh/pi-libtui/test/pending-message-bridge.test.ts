import { expect, test } from "bun:test";
import { TruncatedText } from "@earendil-works/pi-tui";
import { installPendingMessageTransformer } from "../src/host/pending-message-bridge.ts";

test("queue projections compose, tolerate failures, and release only their own registration", () => {
	const original = TruncatedText.prototype.render;
	const queue = new TruncatedText("Steering: FIRST SECOND", 1, 0);
	const removeFirst = installPendingMessageTransformer((text) => text.replace("FIRST", "one"));
	const removeBroken = installPendingMessageTransformer(() => {
		throw new Error("optional");
	});
	const second = (text: string) => text.replace("SECOND", "two");
	const removeSecond = installPendingMessageTransformer(second);
	const removeDuplicate = installPendingMessageTransformer(second);
	try {
		expect(queue.render(40)[0]).toContain("Steering: one two");
		expect(new TruncatedText("Steering: FIRST SECOND").render(40)[0]).toContain("FIRST SECOND");
		removeFirst();
		removeSecond();
		expect(queue.render(40)[0]).toContain("Steering: FIRST two");
		removeFirst();
		expect(queue.render(40)[0]).toContain("Steering: FIRST two");
	} finally {
		removeFirst();
		removeSecond();
		removeDuplicate();
		removeBroken();
	}
	expect(TruncatedText.prototype.render).toBe(original);
	expect(queue.render(40)[0]).toContain("FIRST SECOND");
});
