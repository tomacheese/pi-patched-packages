import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const REPOSITORY = "https://github.com/luan/agents";
const BUILDS_KEY = Symbol.for("pi-libtui/native-builds/v1");

/** A Rust binary from this repository's `crates/` that an extension shells out to. */
export interface NativeBinary {
	/** Cargo package name, as passed to `cargo install`. */
	readonly crate: string;
	/** Executable name without platform suffix. */
	readonly binaryName: string;
	/** Environment variable that overrides discovery with an explicit path. */
	readonly env: string;
}

export interface NativeBinaryOptions {
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly platform: NodeJS.Platform;
	/** Directory that holds per-crate, per-revision builds (`<root>/<crate>/<rev>/bin/<name>`). */
	readonly nativeRoot: string;
	/** Git revision of this repository the binary must be built from. */
	readonly rev: string;
	/** Directory to walk up from when looking for a development checkout. */
	readonly developmentStart?: string;
	isExecutable(path: string): boolean;
}

export type NativeBinaryLocation =
	| { readonly kind: "found"; readonly path: string }
	| { readonly kind: "build"; readonly installRoot: string; readonly path: string }
	| { readonly kind: "unbuilt-checkout"; readonly checkout: string };

export const TERMINAL_BRIDGE: NativeBinary = {
	crate: "terminal-bridge",
	binaryName: "terminal-bridge",
	env: "PI_TERMINAL_BRIDGE_BINARY",
};

/**
 * Locate a native binary without side effects. Order: the override env var, the managed build for
 * this revision, then a development checkout's `target/`. A miss says what would fix it.
 */
export function locateNativeBinary(binary: NativeBinary, options: NativeBinaryOptions): NativeBinaryLocation {
	const override = options.environment[binary.env];
	if (override !== undefined) {
		const path = override.trim();
		if (!path) throw new Error(`${binary.env} is set but empty`);
		if (!options.isExecutable(path)) throw new Error(`${binary.env} is not executable: ${path}`);
		return { kind: "found", path };
	}
	const binaryName = options.platform === "win32" ? `${binary.binaryName}.exe` : binary.binaryName;
	const installRoot = join(options.nativeRoot, binary.crate, options.rev);
	const managed = join(installRoot, "bin", binaryName);
	if (options.isExecutable(managed)) return { kind: "found", path: managed };
	const checkout = options.developmentStart ? findCheckoutRoot(options.developmentStart, binary.crate) : undefined;
	if (checkout) {
		for (const profile of ["release", "debug"]) {
			const candidate = resolve(checkout, "target", profile, binaryName);
			if (options.isExecutable(candidate)) return { kind: "found", path: candidate };
		}
		return { kind: "unbuilt-checkout", checkout };
	}
	return { kind: "build", installRoot, path: managed };
}

/** `cargo install` arguments that build `binary` at `rev` into `installRoot/bin`. */
export function nativeBuildArguments(binary: NativeBinary, rev: string, installRoot: string): readonly string[] {
	return ["install", "--git", REPOSITORY, "--rev", rev, "--root", installRoot, "--locked", binary.crate];
}

export interface EnsureNativeBinaryHooks {
	/** Called once when a build starts, so a UI can explain the delay. */
	onBuild?(message: string): void;
}

/**
 * Resolve a native binary for this process, building it on first use. Builds are keyed by crate and
 * revision under Pi's agent directory and shared by every installed pi-libtui copy.
 */
export async function ensureNativeBinary(binary: NativeBinary, hooks: EnsureNativeBinaryHooks = {}): Promise<string> {
	const options = processOptions();
	const location = locateNativeBinary(binary, options);
	if (location.kind === "found") return location.path;
	if (location.kind === "unbuilt-checkout") {
		throw new Error(
			`${binary.binaryName} is not built in ${location.checkout}. Run cargo build --release -p ${binary.crate}`,
		);
	}
	const builds = sharedBuilds();
	const existing = builds.get(location.path);
	if (existing) return existing;
	hooks.onBuild?.(`Building ${binary.binaryName} (first use); this takes a minute.`);
	const build = runCargo(nativeBuildArguments(binary, options.rev, location.installRoot), location.installRoot)
		.then(() => {
			if (!isExecutable(location.path)) throw new Error(`cargo install did not produce ${location.path}`);
			return location.path;
		})
		.finally(() => builds.delete(location.path));
	builds.set(location.path, build);
	return build;
}

export function terminalBridgeBinaryPath(): Promise<string> {
	return ensureNativeBinary(TERMINAL_BRIDGE);
}

/** The pack step records the exact source commit independently of npm versions. */
export function nativeRevision(): string {
	const revision = readFileSync(new URL("../native-revision", import.meta.url), "utf8").trim();
	if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid native source revision; reinstall the package.");
	return revision;
}

function processOptions(): NativeBinaryOptions {
	return {
		environment: process.env,
		platform: process.platform,
		nativeRoot: join(getAgentDir(), "native"),
		rev: nativeRevision(),
		developmentStart: import.meta.dirname,
		isExecutable,
	};
}

function sharedBuilds(): Map<string, Promise<string>> {
	const slots = globalThis as Record<PropertyKey, unknown>;
	const existing = slots[BUILDS_KEY];
	if (existing instanceof Map) return existing as Map<string, Promise<string>>;
	const created = new Map<string, Promise<string>>();
	slots[BUILDS_KEY] = created;
	return created;
}

function runCargo(args: readonly string[], installRoot: string): Promise<void> {
	mkdirSync(installRoot, { recursive: true });
	return new Promise((resolvePromise, reject) => {
		const child = spawn("cargo", args, { stdio: ["ignore", "ignore", "pipe"], env: process.env });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			reject(
				error.code === "ENOENT"
					? new Error("cargo was not found. Install Rust from https://rustup.rs to build native tools.")
					: error,
			);
		});
		child.on("close", (code) => {
			if (code === 0) resolvePromise();
			else
				reject(new Error(`cargo ${args.join(" ")} failed (code ${code})${stderr.trim() ? `:\n${stderr.trim()}` : ""}`));
		});
	});
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Walk up to the Cargo workspace that contains the crate, if the start directory lives in one. */
function findCheckoutRoot(start: string, crate: string): string | undefined {
	let current = resolve(start);
	for (;;) {
		if (isReadable(join(current, "Cargo.toml")) && isReadable(join(current, "crates", crate, "Cargo.toml"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function isReadable(path: string): boolean {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}
