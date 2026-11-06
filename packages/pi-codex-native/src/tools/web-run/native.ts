import { spawn } from "node:child_process";
import { type EnsureNativeBinaryHooks, ensureNativeBinary, type NativeBinary } from "@luan.sh/pi-libtui";
import type { WebRunParameters } from "./schema.ts";

const MAX_DIAGNOSTIC_CHARS = 8_192;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const WEB_RUN: NativeBinary = { crate: "web-run", binaryName: "web-run", env: "PI_CODEX_WEB_RUN_BIN" };

export function resolveWebRunBinary(hooks?: EnsureNativeBinaryHooks): Promise<string> {
	return ensureNativeBinary(WEB_RUN, hooks);
}

export function boundedWebRunDiagnostic(value: string): string {
	const normalized = value.trim();
	return normalized.length <= MAX_DIAGNOSTIC_CHARS ? normalized : `${normalized.slice(0, MAX_DIAGNOSTIC_CHARS)}…`;
}

export function runWebRunBinary(binary: string, input: WebRunParameters, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, ["-"], { stdio: ["pipe", "pipe", "pipe"], signal });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (callback: () => void) => {
			if (!settled) {
				settled = true;
				callback();
			}
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > MAX_STDOUT_BYTES) {
				child.kill();
				finish(() => reject(new Error(`web_run stdout exceeded ${MAX_STDOUT_BYTES} bytes`)));
			} else stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < MAX_DIAGNOSTIC_CHARS + 1) stderr += chunk;
		});
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) =>
			finish(() =>
				code === 0
					? resolve(stdout)
					: reject(new Error(boundedWebRunDiagnostic(stderr) || `web_run exited with code ${code ?? "unknown"}`)),
			),
		);
		child.stdin.on("error", (error) => {
			child.kill();
			finish(() => reject(error));
		});
		child.stdin.end(JSON.stringify(input));
	});
}
