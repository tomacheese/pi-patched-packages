import { expect, test } from "bun:test";
import { join } from "node:path";
import { locateNativeBinary, nativeBuildArguments, TERMINAL_BRIDGE } from "../src/native-binary.ts";

const ENV = TERMINAL_BRIDGE.env;
const options = (executables: readonly string[], environment: Record<string, string | undefined> = {}) => ({
	environment,
	platform: "linux" as const,
	nativeRoot: "/agent/native",
	rev: "v1.2.3",
	isExecutable: (path: string) => executables.includes(path),
});
const managed = join("/agent/native", "terminal-bridge", "v1.2.3", "bin", "terminal-bridge");

test("env override wins and must be executable", () => {
	expect(locateNativeBinary(TERMINAL_BRIDGE, options(["/x/bridge"], { [ENV]: "/x/bridge" }))).toEqual({
		kind: "found",
		path: "/x/bridge",
	});
	expect(() => locateNativeBinary(TERMINAL_BRIDGE, options([], { [ENV]: "/x/missing" }))).toThrow("not executable");
});

test("a managed build for the pinned revision is used when present", () => {
	expect(locateNativeBinary(TERMINAL_BRIDGE, options([managed]))).toEqual({ kind: "found", path: managed });
});

test("a miss outside a checkout asks for a build into the revision root", () => {
	expect(locateNativeBinary(TERMINAL_BRIDGE, options([]))).toEqual({
		kind: "build",
		installRoot: join("/agent/native", "terminal-bridge", "v1.2.3"),
		path: managed,
	});
});

test("a checkout without a built binary is reported instead of built", () => {
	const location = locateNativeBinary(TERMINAL_BRIDGE, { ...options([]), developmentStart: import.meta.dirname });
	expect(location.kind).toBe("unbuilt-checkout");
});

test("build arguments pin the revision and install root", () => {
	expect(nativeBuildArguments(TERMINAL_BRIDGE, "v1.2.3", "/agent/native/terminal-bridge/v1.2.3")).toEqual([
		"install",
		"--git",
		"https://github.com/luan/agents",
		"--rev",
		"v1.2.3",
		"--root",
		"/agent/native/terminal-bridge/v1.2.3",
		"--locked",
		"terminal-bridge",
	]);
});
