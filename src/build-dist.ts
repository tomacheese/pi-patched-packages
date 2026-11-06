/**
 * Builds the `dist` tree: upstream npm packages (pinned in `package.json`)
 * with the local patches from `patches/<package>/*.patch` applied, plus a
 * generated root `package.json` that lists every extension.
 *
 * The output is a pure function of the repository content: it contains no
 * release number, date or commit SHA, so an unchanged tree can be detected.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'

/** Upstream packages that are patched and published together. */
export const PACKAGES = ['pi-better-goal', 'pi-better-subagents'] as const

/** Error raised when the build cannot produce a valid tree. */
export class BuildError extends Error {
  /**
   * @param message Human readable description including package, patch and version when known
   */
  constructor(message: string) {
    super(message)
    this.name = 'BuildError'
  }
}

/** Options of {@link buildDist}. */
export interface BuildOptions {
  /** Repository root: contains `node_modules`, `patches`, `README.md` and `LICENSE`. */
  repoRoot: string
  /** Output directory; must be inside `repoRoot`. */
  outDir: string
  /** Names of the upstream packages to include, in output order. */
  packages: readonly string[]
}

/** A patch that was applied to a package. */
export interface AppliedPatch {
  /** File name of the patch. */
  file: string
  /** SHA-256 of the patch file. */
  sha256: string
}

/** A file changed by the patches, with the hash of the built result. */
export interface TouchedFile {
  /** Path relative to the package directory (POSIX separators). */
  path: string
  /** SHA-256 of the built file, or `null` when a patch removed it. */
  sha256: string | null
}

/** Result of building one package. */
export interface BuiltPackage {
  /** Package name. */
  name: string
  /** Pinned upstream version. */
  version: string
  /** Patches in application order. */
  patches: AppliedPatch[]
  /** Files touched by the patches, sorted by path. */
  touched: TouchedFile[]
}

/** One `PATCHES.md` line describing a touched file. */
export interface PatchEffect {
  /** Package name. */
  packageName: string
  /** Path relative to the package directory. */
  path: string
  /** SHA-256 of the built file, or `null` when the file is removed. */
  sha256: string | null
}

/** Returns the SHA-256 (hex) of a file. */
async function sha256File(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex')
}

/** Converts OS path separators to POSIX. */
function toPosix(target: string): string {
  return target.split(path.sep).join('/')
}

/** Reads and parses a JSON file. */
async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
}

/** Returns true when the path exists. */
async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Finds the installed version of a dependency with the Node.js `node_modules`
 * lookup (every ancestor directory except `node_modules` itself). Under pnpm the
 * dependencies of a package are siblings of its real directory, so this reflects
 * `pnpm-lock.yaml`.
 * @param startDir Real directory of the dependent package
 * @param dependency Dependency name
 * @returns Installed version
 */
async function resolveInstalledVersion(
  startDir: string,
  dependency: string
): Promise<string> {
  let current = startDir
  for (;;) {
    if (path.basename(current) !== 'node_modules') {
      const manifest = path.join(
        current,
        'node_modules',
        dependency,
        'package.json'
      )
      if (await exists(manifest)) {
        const installed = await readJson(manifest)
        return installed.version as string
      }
    }
    const parent = path.dirname(current)
    if (parent === current) {
      throw new BuildError(
        `Cannot resolve dependency "${dependency}" from ${startDir}`
      )
    }
    current = parent
  }
}

/**
 * Copies a package directory, dereferencing symlinks and skipping nested `node_modules`.
 * @param source Real source directory
 * @param destination Destination directory
 */
async function copyPackage(source: string, destination: string): Promise<void> {
  await fs.cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (item) => path.basename(item) !== 'node_modules',
  })
}

/**
 * Lists the files that a unified diff touches.
 * @param patch Patch text
 * @returns Paths with `removed` set when the patch deletes or renames the file away
 */
function parsePatchedPaths(
  patch: string
): { path: string; removed: boolean }[] {
  const result: { path: string; removed: boolean }[] = []
  let currentPath: string | undefined
  let removed = false
  /** Appends the entry collected so far to the result. */
  const flush = (): void => {
    if (currentPath !== undefined) result.push({ path: currentPath, removed })
  }
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (header) {
      flush()
      currentPath = header[2]
      removed = false
    } else if (line.startsWith('deleted file mode')) {
      removed = true
    } else if (line.startsWith('rename from ')) {
      result.push({ path: line.slice('rename from '.length), removed: true })
    }
  }
  flush()
  return result
}

/**
 * Applies the patches of one package in lexical order.
 * `git apply` runs from the repository root with `--directory`, which is the
 * only form that applies correctly both inside and outside a git working tree.
 * @param options Build options
 * @param name Package name
 * @param version Pinned upstream version
 * @param destination Package directory in the output tree
 * @returns Applied patches and touched files
 */
async function applyPatches(
  options: BuildOptions,
  name: string,
  version: string,
  destination: string
): Promise<Pick<BuiltPackage, 'patches' | 'touched'>> {
  const patchDir = path.join(options.repoRoot, 'patches', name)
  const entries = (await exists(patchDir)) ? await fs.readdir(patchDir) : []
  const files = entries
    .filter((f) => f.endsWith('.patch'))
    .toSorted((a, b) => a.localeCompare(b))
  const relative = toPosix(path.relative(options.repoRoot, destination))
  const patches: AppliedPatch[] = []
  const touchedPaths = new Map<string, boolean>()
  for (const file of files) {
    const patchFile = path.join(patchDir, file)
    try {
      execFileSync('git', ['apply', `--directory=${relative}`, patchFile], {
        cwd: options.repoRoot,
        stdio: 'pipe',
      })
    } catch (error) {
      const detail =
        error instanceof Error && 'stderr' in error
          ? String((error as { stderr: unknown }).stderr).trim()
          : String(error)
      throw new BuildError(
        `Patch ${file} does not apply to ${name}@${version}: ${detail}`
      )
    }
    patches.push({ file, sha256: await sha256File(patchFile) })
    const patchText = await fs.readFile(patchFile, 'utf8')
    for (const item of parsePatchedPaths(patchText)) {
      touchedPaths.set(item.path, item.removed)
    }
  }
  const touched: TouchedFile[] = []
  const touchedSorted = touchedPaths
    .keys()
    .toArray()
    .toSorted((a, b) => a.localeCompare(b))
  for (const filePath of touchedSorted) {
    const full = path.join(destination, filePath)
    touched.push({
      path: filePath,
      sha256: (await exists(full)) ? await sha256File(full) : null,
    })
  }
  return { patches, touched }
}

/**
 * Renders `PATCHES.md`. The content depends only on the build inputs.
 * @param built Built packages
 * @returns Markdown text
 */
export function renderPatchesMd(built: readonly BuiltPackage[]): string {
  const lines = [
    '# Patches',
    '',
    'Upstream packages with the local patches applied (see `patches/` on `master`).',
    '',
  ]
  for (const item of built) {
    lines.push(`## ${item.name}`, '', `- upstream: ${item.version}`)
    for (const patch of item.patches) {
      lines.push(`- patch: ${patch.file} sha256:${patch.sha256}`)
    }
    for (const file of item.touched) {
      lines.push(`- file: ${file.path} sha256:${file.sha256 ?? 'removed'}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Parses the `file:` lines of `PATCHES.md`.
 * @param markdown Content of `PATCHES.md`
 * @returns One entry per touched file
 */
export function parsePatchEffects(markdown: string): PatchEffect[] {
  const result: PatchEffect[] = []
  let packageName = ''
  for (const line of markdown.split('\n')) {
    const heading = /^## (.+)$/.exec(line)
    if (heading) {
      packageName = heading[1]
      continue
    }
    const file = /^- file: (.+) sha256:([0-9a-f]{64}|removed)$/.exec(line)
    if (file) {
      result.push({
        packageName,
        path: file[1],
        sha256: file[2] === 'removed' ? null : file[2],
      })
    }
  }
  return result
}

/**
 * Builds the dist tree.
 * @param options Build options
 * @returns Built packages in output order
 */
export async function buildDist(
  options: BuildOptions
): Promise<BuiltPackage[]> {
  const repoRoot = path.resolve(options.repoRoot)
  const outDir = path.resolve(options.outDir)
  if (!outDir.startsWith(repoRoot + path.sep)) {
    throw new BuildError(
      `Output directory ${outDir} must be inside ${repoRoot}`
    )
  }
  const resolved: BuildOptions = { ...options, repoRoot, outDir }
  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(path.join(outDir, 'packages'), { recursive: true })

  const built: BuiltPackage[] = []
  const dependencies = new Map<string, { version: string; from: string }>()
  const extensions: string[] = []

  for (const name of options.packages) {
    const link = path.join(repoRoot, 'node_modules', name)
    if (!(await exists(link))) {
      throw new BuildError(`Package ${name} is not installed in node_modules`)
    }
    const realDir = await fs.realpath(link)
    const destination = path.join(outDir, 'packages', name)
    await copyPackage(realDir, destination)

    const manifest = await readJson(path.join(destination, 'package.json'))
    const version = manifest.version as string
    const applied = await applyPatches(resolved, name, version, destination)
    built.push({ name, version, ...applied })

    const patchedManifest = await readJson(
      path.join(destination, 'package.json')
    )
    const declared = (patchedManifest.dependencies ?? {}) as Record<
      string,
      string
    >
    const declaredNames = Object.keys(declared).toSorted((a, b) =>
      a.localeCompare(b)
    )
    for (const dependency of declaredNames) {
      const installed = await resolveInstalledVersion(realDir, dependency)
      const previous = dependencies.get(dependency)
      if (previous && previous.version !== installed) {
        throw new BuildError(
          `Dependency ${dependency} resolves to ${previous.version} for ${previous.from} but ${installed} for ${name}`
        )
      }
      dependencies.set(dependency, { version: installed, from: name })
    }
    const pi = (patchedManifest.pi ?? {}) as { extensions?: string[] }
    const entries = pi.extensions ?? []
    for (const entry of entries) {
      extensions.push(`./${path.posix.join('packages', name, entry)}`)
    }
  }

  const generated = {
    name: 'pi-patched-packages',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(
      [...dependencies]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([dependency, info]) => [dependency, info.version])
    ),
    pi: { extensions },
  }
  await fs.writeFile(
    path.join(outDir, 'package.json'),
    `${JSON.stringify(generated, null, 2)}\n`
  )
  await fs.copyFile(
    path.join(repoRoot, 'README.md'),
    path.join(outDir, 'README.md')
  )
  await fs.copyFile(
    path.join(repoRoot, 'LICENSE'),
    path.join(outDir, 'LICENSE')
  )
  await fs.writeFile(path.join(outDir, 'PATCHES.md'), renderPatchesMd(built))
  return built
}
