import { TruncatedText, visibleWidth } from "@earendil-works/pi-tui";

type PendingMessageTransformer = (text: string, width: number) => string;
const PROTOCOL = "pi-libtui/pending-message-bridge/v1";
const KEY = Symbol.for(PROTOCOL);
interface PendingMessageBridge {
	protocol: typeof PROTOCOL;
	register(transform: PendingMessageTransformer): () => void;
}
// type-boundary: Pi private fields and another installed copy's lease; validated before use below.
type NativeValue = unknown;

/** Pi 0.87.1 queues use TruncatedText, not Markdown. Retire when Pi exposes a pending-message transformer. */
export function installPendingMessageTransformer(transform: PendingMessageTransformer): () => void {
	const prototype = TruncatedText.prototype;
	const existing: NativeValue = Reflect.get(prototype, KEY);
	if (existing && typeof existing === "object") {
		const bridge = existing as Partial<PendingMessageBridge>;
		if (bridge.protocol === PROTOCOL && typeof bridge.register === "function") return bridge.register(transform);
	}
	const original = prototype.render;
	const transforms = new Set<{ project: PendingMessageTransformer }>();
	const render: typeof original = function (this: TruncatedText, width) {
		const text: NativeValue = Reflect.get(this, "text");
		if (typeof text !== "string" || Reflect.get(this, "paddingX") !== 1 || Reflect.get(this, "paddingY") !== 0)
			return original.call(this, width);
		const prefix = /^(?:\x1b\[[0-9;]*m)*(?:Steering|Follow-up): /.exec(text);
		if (!prefix) return original.call(this, width);
		let projected = text.slice(prefix[0].length);
		for (const { project } of transforms) {
			try {
				projected = project(projected, Math.max(1, width - 2 - visibleWidth(prefix[0])));
			} catch {
				// An optional projection must not break the queue or mutate its contents.
			}
		}
		return original.call(new TruncatedText(prefix[0] + projected, 1, 0), width);
	};
	const bridge: PendingMessageBridge = {
		protocol: PROTOCOL,
		register(project) {
			const entry = { project };
			transforms.add(entry);
			return () => {
				transforms.delete(entry);
				if (transforms.size) return;
				if (prototype.render === render) prototype.render = original;
				if (Reflect.get(prototype, KEY) === bridge) Reflect.deleteProperty(prototype, KEY);
			};
		},
	};
	prototype.render = render;
	Object.defineProperty(prototype, KEY, { configurable: true, value: bridge });
	return bridge.register(transform);
}
