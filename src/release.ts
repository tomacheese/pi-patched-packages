/**
 * Publishing of the `dist` branch, the `v<major>.<minor>.<patch>` tag and the GitHub Release.
 *
 * Rules: a run publishes only when it is built from the current
 * head of `master`; `dist` is replaced by the full build output and only grows
 * (no force push); the commit and its tag are pushed in one atomic push; the
 * GitHub Release for the tag on the `dist` head is created whenever it is
 * missing, so a run that failed after the push is repaired by the next run.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'
import type { BuiltPackage } from './build-dist'

/** Names that are never part of the published tree. */
const EXCLUDED_NAMES = new Set(['package-lock.json', '.git'])

/**
 * Whether a path inside a tree is the tree's own installed `node_modules`.
 * Only the root one is never published: a package that bundles its dependencies
 * (for example `packages/<name>/node_modules`) must keep them.
 * @param relative Path relative to the tree root
 * @returns True for the root `node_modules`
 */
function isRootNodeModules(relative: string): boolean {
  return relative === 'node_modules'
}

/** Author used for the release commits (GitHub Actions bot). */
const BOT_IDENTITY = [
  '-c',
  'user.name=github-actions[bot]',
  '-c',
  'user.email=41898282+github-actions[bot]@users.noreply.github.com',
] as const

/** Result of a release run. */
export type ReleaseOutcome =
  | { kind: 'superseded' }
  | { kind: 'unchanged'; tag: string | undefined }
  | { kind: 'released'; tag: string }

/** GitHub Release operations (replaced by a stub in tests). */
export interface ReleaseClient {
  /** Returns true when a GitHub Release exists for the tag. */
  exists(tag: string): boolean
  /** Creates a GitHub Release for the tag with the notes file as body. */
  create(tag: string, notesFile: string): void
}

/** Options of {@link runRelease}. */
export interface ReleaseOptions {
  /** Repository checkout (the pushed `master` commit). */
  repoRoot: string
  /** Built tree to publish; names in `EXCLUDED_NAMES` are ignored. */
  distDir: string
  /** Commit that was built. */
  sourceSha: string
  /** Packages in the built tree. */
  built: readonly BuiltPackage[]
  /** Remote name. */
  remote: string
  /** GitHub Release operations. */
  release: ReleaseClient
}

/** Upstream version and patch file names of one package. */
interface PackageState {
  version: string
  patches: string[]
}

/**
 * Parses the `upstream:` and `patch:` lines of `PATCHES.md`.
 * @param markdown Content of `PATCHES.md`
 * @returns Package name to its state
 */
export function parsePackageStates(
  markdown: string
): Map<string, PackageState> {
  const result = new Map<string, PackageState>()
  let current: PackageState | undefined
  for (const line of markdown.split('\n')) {
    const heading = /^## (.+)$/.exec(line)
    if (heading) {
      current = { version: '', patches: [] }
      result.set(heading[1], current)
      continue
    }
    const upstream = /^- upstream: (\S+)$/.exec(line)
    if (upstream && current) current.version = upstream[1]
    const patch = /^- patch: (\S+) sha256:/.exec(line)
    if (patch && current) current.patches.push(patch[1])
  }
  return result
}

/**
 * Computes the next version from the latest tag and the change in `PATCHES.md`.
 *
 * Breaking-level change (a major step from 1.0.0 on, a minor step in 0.x):
 * an upstream major bump, or a package added or removed. Feature-level change
 * (a minor step): an upstream minor bump, or a patch file added or removed.
 * Everything else that changes the tree (upstream patch bump, patch content,
 * tooling) is a patch step. From 0.x the breaking level maps to minor.
 * @param tags All tag names
 * @param previous `PATCHES.md` of the current `dist` head (undefined: none)
 * @param next `PATCHES.md` of the new build
 * @returns Next version without the `v` prefix
 */
export function nextVersion(
  tags: readonly string[],
  previous: string | undefined,
  next: string
): string {
  let latest: [number, number, number] | undefined
  for (const tag of tags) {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)
    if (!match) continue
    const version: [number, number, number] = [
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    ]
    const newer =
      !latest ||
      version[0] > latest[0] ||
      (version[0] === latest[0] &&
        (version[1] > latest[1] ||
          (version[1] === latest[1] && version[2] > latest[2])))
    if (newer) latest = version
  }
  if (!latest || previous === undefined) return '0.1.0'

  const before = parsePackageStates(previous)
  const after = parsePackageStates(next)
  const ranks = { patch: 0, minor: 1, major: 2 } as const
  const levels = ['patch', 'minor', 'major'] as const
  let rank = 0
  const names = new Set([...before.keys(), ...after.keys()])
  for (const name of names) {
    const old = before.get(name)
    const now = after.get(name)
    if (!old || !now) {
      rank = ranks.major
      continue
    }
    const [oldMajor, oldMinor] = old.version.split('.').map(Number)
    const [newMajor, newMinor] = now.version.split('.').map(Number)
    let step: number = ranks.patch
    if (oldMajor !== newMajor) step = ranks.major
    else if (
      oldMinor !== newMinor ||
      old.patches.join('\n') !== now.patches.join('\n')
    )
      step = ranks.minor
    rank = Math.max(rank, step)
  }
  const level = levels[rank]
  const [major, minor, patch] = latest
  if (major === 0) {
    return level === 'patch'
      ? `0.${String(minor)}.${String(patch + 1)}`
      : `0.${String(minor + 1)}.0`
  }
  if (level === 'major') return `${String(major + 1)}.0.0`
  if (level === 'minor') return `${String(major)}.${String(minor + 1)}.0`
  return `${String(major)}.${String(minor)}.${String(patch + 1)}`
}

/**
 * Renders the release commit message.
 * @param tag Release tag
 * @param built Built packages
 * @param sourceSha Commit of `master` that was built
 * @returns Commit message
 */
export function renderCommitMessage(
  tag: string,
  built: readonly BuiltPackage[],
  sourceSha: string
): string {
  const parts = built.map((item) => {
    const patches =
      item.patches.length > 0
        ? item.patches.map((p) => p.file).join(', ')
        : 'no patches'
    return `${item.name.replace(/^pi-better-/, '')} ${item.version} (${patches})`
  })
  return `release ${tag}: ${parts.join(', ')}, source ${sourceSha}`
}

/**
 * Hashes every file of a tree, skipping the names in `EXCLUDED_NAMES`.
 * @param root Tree root
 * @returns Map of POSIX relative path to SHA-256
 */
export async function hashTree(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  /** Walks one directory. */
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (EXCLUDED_NAMES.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (isRootNodeModules(path.relative(root, full))) continue
      if (entry.isDirectory()) {
        await walk(full)
      } else {
        const relative = path.relative(root, full).split(path.sep).join('/')
        result.set(
          relative,
          createHash('sha256')
            .update(await fs.readFile(full))
            .digest('hex')
        )
      }
    }
  }
  await walk(root)
  return result
}

/**
 * Compares two hashed trees.
 * @param a First tree
 * @param b Second tree
 * @returns True when both contain the same paths with the same content
 */
export function treesEqual(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>
): boolean {
  if (a.size !== b.size) return false
  for (const [file, hash] of a) {
    if (b.get(file) !== hash) return false
  }
  return true
}

/** Runs git and returns trimmed stdout. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/**
 * Copies a tree, skipping excluded names.
 * @param source Source directory
 * @param destination Destination directory
 */
async function copyTree(source: string, destination: string): Promise<void> {
  await fs.cp(source, destination, {
    recursive: true,
    filter: (item) =>
      !EXCLUDED_NAMES.has(path.basename(item)) &&
      !isRootNodeModules(path.relative(source, item)),
  })
}

/**
 * Creates the GitHub Release for a tag when it does not exist yet.
 * @param options Release options
 * @param tag Tag on the dist head
 */
function ensureRelease(options: ReleaseOptions, tag: string): void {
  if (options.release.exists(tag)) return
  options.release.create(tag, path.join(options.distDir, 'PATCHES.md'))
}

/**
 * Publishes the built tree.
 * @param options Release options
 * @returns What happened
 */
export async function runRelease(
  options: ReleaseOptions
): Promise<ReleaseOutcome> {
  const { repoRoot, remote } = options

  const masterHead = git(repoRoot, [
    'ls-remote',
    remote,
    'refs/heads/master',
  ]).split(/\s+/, 1)[0]
  if (masterHead !== options.sourceSha) {
    console.log(
      `Skipping: ${options.sourceSha} is not the head of master (${masterHead})`
    )
    return { kind: 'superseded' }
  }

  git(repoRoot, ['fetch', '--tags', '--force', remote])
  const hasDist =
    git(repoRoot, ['ls-remote', '--heads', remote, 'refs/heads/dist']).length >
    0
  if (hasDist) {
    git(repoRoot, [
      'fetch',
      remote,
      '+refs/heads/dist:refs/remotes/' + remote + '/dist',
    ])
  }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ppp-release-'))
  const worktree = path.join(work, 'dist')
  try {
    git(repoRoot, [
      'worktree',
      'add',
      '--detach',
      worktree,
      hasDist ? `refs/remotes/${remote}/dist` : options.sourceSha,
    ])
    if (!hasDist) {
      git(worktree, ['checkout', '--orphan', 'dist-release'])
      git(worktree, ['rm', '-r', '-q', '-f', '--ignore-unmatch', '.'])
    }

    const next = await hashTree(options.distDir)
    const current = hasDist
      ? await hashTree(worktree)
      : new Map<string, string>()
    let tag: string | undefined

    if (hasDist && treesEqual(next, current)) {
      const head = git(worktree, ['rev-parse', 'HEAD'])
      tag = git(repoRoot, ['tag', '--points-at', head])
        .split('\n')
        .find((t) => /^v\d+\.\d+\.\d+$/.test(t))
      console.log('dist is up to date; no release commit')
      if (tag) ensureRelease(options, tag)
      return { kind: 'unchanged', tag }
    }

    const previousMd = hasDist
      ? await fs.readFile(path.join(worktree, 'PATCHES.md'), 'utf8')
      : undefined
    const nextMd = await fs.readFile(
      path.join(options.distDir, 'PATCHES.md'),
      'utf8'
    )
    tag = `v${nextVersion(git(repoRoot, ['tag', '--list', 'v*']).split('\n'), previousMd, nextMd)}`
    const stale = await fs.readdir(worktree)
    for (const entry of stale) {
      if (entry !== '.git') {
        await fs.rm(path.join(worktree, entry), {
          recursive: true,
          force: true,
        })
      }
    }
    await copyTree(options.distDir, worktree)
    git(worktree, ['add', '-A', '-f'])
    git(worktree, [
      ...BOT_IDENTITY,
      'commit',
      '-q',
      '-m',
      renderCommitMessage(tag, options.built, options.sourceSha),
    ])
    git(worktree, [...BOT_IDENTITY, 'tag', tag])
    git(worktree, [
      'push',
      '--atomic',
      remote,
      'HEAD:refs/heads/dist',
      `refs/tags/${tag}`,
    ])
    console.log(`Published dist as ${tag}`)
    ensureRelease(options, tag)
    return { kind: 'released', tag }
  } finally {
    try {
      git(repoRoot, ['worktree', 'remove', '--force', worktree])
    } catch {
      // The worktree may not have been created.
    }
    try {
      git(repoRoot, ['branch', '-D', 'dist-release'])
    } catch {
      // The orphan branch only exists after a first release attempt.
    }
    await fs.rm(work, { recursive: true, force: true })
  }
}
