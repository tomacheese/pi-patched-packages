/**
 * Publishing of the `dist` branch, the `r<N>` tag and the GitHub Release.
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
const EXCLUDED_NAMES = new Set(['node_modules', 'package-lock.json', '.git'])

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

/**
 * Computes the next release number from the existing tags.
 * @param tags All tag names
 * @returns Highest `r<number>` plus one (1 when there is none)
 */
export function nextReleaseNumber(tags: readonly string[]): number {
  let highest = 0
  for (const tag of tags) {
    const match = /^r(\d+)$/.exec(tag)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

/**
 * Renders the release commit message.
 * @param number_ Release number
 * @param built Built packages
 * @param sourceSha Commit of `master` that was built
 * @returns Commit message
 */
export function renderCommitMessage(
  number_: number,
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
  return `release r${String(number_)}: ${parts.join(', ')}, source ${sourceSha}`
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
    filter: (item) => !EXCLUDED_NAMES.has(path.basename(item)),
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
        .find((t) => /^r\d+$/.test(t))
      console.log('dist is up to date; no release commit')
      if (tag) ensureRelease(options, tag)
      return { kind: 'unchanged', tag }
    }

    const number_ = nextReleaseNumber(
      git(repoRoot, ['tag', '--list', 'r*']).split('\n')
    )
    tag = `r${String(number_)}`
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
      renderCommitMessage(number_, options.built, options.sourceSha),
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
