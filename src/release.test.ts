import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'
import type { BuiltPackage } from './build-dist'
import {
  hashTree,
  nextVersion,
  parsePackageStates,
  renderCommitMessage,
  runRelease,
  treesEqual,
  type ReleaseClient,
} from './release'

const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.com']

/** Runs git and returns trimmed stdout. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** Writes a file, creating parent directories. */
async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

const BUILT: BuiltPackage[] = [
  {
    name: 'pi-better-goal',
    version: '0.8.4',
    patches: [{ file: '0001-x.patch', sha256: 'a'.repeat(64) }],
    touched: [],
  },
  { name: 'pi-better-subagents', version: '0.18.0', patches: [], touched: [] },
]

describe('pure helpers', () => {
  const md = (goal: string, patches: string[], agents = '0.18.0'): string =>
    [
      '## pi-better-goal',
      '',
      `- upstream: ${goal}`,
      ...patches.map((p) => `- patch: ${p} sha256:${'a'.repeat(64)}`),
      '',
      '## pi-better-subagents',
      '',
      `- upstream: ${agents}`,
      '',
    ].join('\n')
  const base = md('0.8.4', ['0001.patch'])

  it('parses upstream versions and patch names', () => {
    expect(parsePackageStates(base).get('pi-better-goal')).toStrictEqual({
      version: '0.8.4',
      patches: ['0001.patch'],
    })
  })

  it('starts at 0.1.0 without a previous release or version tag', () => {
    expect(nextVersion([], undefined, base)).toBe('0.1.0')
    expect(nextVersion(['v0.1.0'], undefined, base)).toBe('0.1.0')
    expect(nextVersion(['r5', 'latest'], base, base)).toBe('0.1.0')
  })

  it('bumps the patch for upstream patch bumps and patch content changes', () => {
    const tags = ['v0.2.0', 'v0.10.1', 'v0.9.0', 'r99']
    expect(nextVersion(tags, base, md('0.8.5', ['0001.patch']))).toBe('0.10.2')
    expect(nextVersion(tags, base, base)).toBe('0.10.2')
  })

  it('bumps the minor in 0.x for upstream minor bumps and patch file changes', () => {
    const tags = ['v0.3.0']
    expect(nextVersion(tags, base, md('0.9.0', ['0001.patch']))).toBe('0.4.0')
    expect(
      nextVersion(tags, base, md('0.8.4', ['0001.patch', '0002.patch']))
    ).toBe('0.4.0')
    expect(nextVersion(tags, base, md('0.8.4', []))).toBe('0.4.0')
  })

  it('treats an upstream major bump or a package change as breaking', () => {
    expect(nextVersion(['v0.3.0'], base, md('1.0.0', ['0001.patch']))).toBe(
      '0.4.0'
    )
    expect(
      nextVersion(
        ['v0.3.0'],
        base,
        '## pi-better-goal\n\n- upstream: 0.8.4\n- patch: 0001.patch sha256:x'
      )
    ).toBe('0.4.0')
    expect(nextVersion(['v1.2.3'], base, md('1.0.0', ['0001.patch']))).toBe(
      '2.0.0'
    )
    expect(nextVersion(['v1.2.3'], base, md('0.9.0', ['0001.patch']))).toBe(
      '1.3.0'
    )
    expect(nextVersion(['v1.2.3'], base, md('0.8.5', ['0001.patch']))).toBe(
      '1.2.4'
    )
  })

  it('renders the commit message with versions, patches and source', () => {
    expect(renderCommitMessage('v0.3.0', BUILT, 'abc123')).toBe(
      'release v0.3.0: goal 0.8.4 (0001-x.patch), subagents 0.18.0 (no patches), source abc123'
    )
  })

  it('hashes trees ignoring node_modules, lock files and .git, and compares them', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ppp-tree-'))
    try {
      await write(path.join(tmp, 'a', 'x.txt'), 'x')
      await write(path.join(tmp, 'node_modules', 'm', 'i.js'), 'ignored')
      await write(
        path.join(tmp, 'packages', 'p', 'node_modules', 'b', 'i.js'),
        'bundled'
      )
      await write(path.join(tmp, 'package-lock.json'), 'ignored')
      await write(path.join(tmp, '.git', 'HEAD'), 'ignored')
      const first = await hashTree(tmp)
      expect(
        first
          .keys()
          .toArray()
          .toSorted((a, b) => a.localeCompare(b))
      ).toStrictEqual(['a/x.txt', 'packages/p/node_modules/b/i.js'])
      expect(treesEqual(first, await hashTree(tmp))).toBe(true)
      await write(path.join(tmp, 'a', 'x.txt'), 'changed')
      expect(treesEqual(first, await hashTree(tmp))).toBe(false)
      expect(treesEqual(first, new Map())).toBe(false)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('runRelease against a bare remote', () => {
  let tmp: string
  let remote: string
  let work: string
  let distDir: string
  let sourceSha: string
  let created: string[]
  let existing: Set<string>
  let client: ReleaseClient

  /** Runs a release with the current fixture state. */
  function run(sha = sourceSha): ReturnType<typeof runRelease> {
    return runRelease({
      repoRoot: work,
      distDir,
      sourceSha: sha,
      built: BUILT,
      remote: 'origin',
      release: client,
    })
  }

  /** Lists the files of the remote `dist` head. */
  function distFiles(): string[] {
    return git(remote, 'ls-tree', '-r', '--name-only', 'dist').split('\n')
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ppp-release-test-'))
    remote = path.join(tmp, 'remote.git')
    work = path.join(tmp, 'work')
    distDir = path.join(tmp, 'build', 'dist')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'master', remote])
    execFileSync('git', ['init', '-q', '-b', 'master', work])
    git(work, 'remote', 'add', 'origin', remote)
    await write(path.join(work, 'file.txt'), 'master')
    git(work, 'add', 'file.txt')
    git(work, 'commit', '-q', '-m', 'init')
    git(work, 'push', '-q', 'origin', 'master')
    sourceSha = git(work, 'rev-parse', 'HEAD')
    await write(path.join(distDir, 'package.json'), '{"v":1}')
    await write(path.join(distDir, 'PATCHES.md'), 'notes')
    await write(path.join(distDir, 'node_modules', 'm', 'i.js'), 'ignored')
    await write(path.join(distDir, 'package-lock.json'), 'ignored')
    await write(
      path.join(distDir, 'packages', 'p', 'node_modules', 'b', 'i.js'),
      'bundled'
    )
    created = []
    existing = new Set()
    client = {
      exists: (tag) => existing.has(tag),
      create: (tag) => {
        created.push(tag)
        existing.add(tag)
      },
    }
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('creates an orphan dist and v0.1.0 on the first run, without touching master', async () => {
    const outcome = await run()
    expect(outcome).toStrictEqual({ kind: 'released', tag: 'v0.1.0' })
    expect(distFiles().toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      'package.json',
      'packages/p/node_modules/b/i.js',
      'PATCHES.md',
    ])
    expect(git(remote, 'rev-parse', 'master')).toBe(sourceSha)
    expect(git(remote, 'rev-parse', 'v0.1.0^{commit}')).toBe(
      git(remote, 'rev-parse', 'dist')
    )
    expect(git(remote, 'log', '-1', '--format=%s', 'dist')).toContain(
      `release v0.1.0: goal 0.8.4 (0001-x.patch)`
    )
    expect(git(remote, 'log', '-1', '--format=%an', 'dist')).toBe(
      'github-actions[bot]'
    )
    expect(git(remote, 'rev-list', '--count', 'dist')).toBe('1')
    expect(created).toStrictEqual(['v0.1.0'])
  })

  it('ignores unrelated branches whose name ends with /dist', async () => {
    git(work, 'push', '-q', 'origin', 'master:refs/heads/foo/dist')
    const outcome = await run()
    expect(outcome).toStrictEqual({ kind: 'released', tag: 'v0.1.0' })
    expect(git(remote, 'rev-parse', '--verify', 'refs/heads/dist')).not.toBe('')
  })

  it('creates nothing when the tree is unchanged', async () => {
    await run()
    const head = git(remote, 'rev-parse', 'dist')
    const outcome = await run()
    expect(outcome).toStrictEqual({ kind: 'unchanged', tag: 'v0.1.0' })
    expect(git(remote, 'rev-parse', 'dist')).toBe(head)
    expect(git(remote, 'tag', '--list')).toBe('v0.1.0')
    expect(created).toStrictEqual(['v0.1.0'])
  })

  it('repairs a missing GitHub Release for the dist head tag', async () => {
    await run()
    existing.clear()
    created = []
    const outcome = await run()
    expect(outcome).toStrictEqual({ kind: 'unchanged', tag: 'v0.1.0' })
    expect(created).toStrictEqual(['v0.1.0'])
  })

  it('creates a patch release as a fast-forward when the tree changed', async () => {
    await run()
    const first = git(remote, 'rev-parse', 'dist')
    await write(path.join(distDir, 'package.json'), '{"v":2}')
    const outcome = await run()
    expect(outcome).toStrictEqual({ kind: 'released', tag: 'v0.1.1' })
    const second = git(remote, 'rev-parse', 'dist')
    expect(second).not.toBe(first)
    expect(git(remote, 'merge-base', '--is-ancestor', first, second)).toBe('')
    expect(git(remote, 'rev-list', '--count', 'dist')).toBe('2')
    expect(
      git(remote, 'tag', '--list')
        .split('\n')
        .toSorted((a, b) => a.localeCompare(b))
    ).toStrictEqual(['v0.1.0', 'v0.1.1'])
  })

  it('does nothing when the checked-out commit is not the head of master', async () => {
    await run()
    const head = git(remote, 'rev-parse', 'dist')
    await write(path.join(work, 'file.txt'), 'newer master')
    git(work, 'commit', '-q', '-am', 'newer')
    git(work, 'push', '-q', 'origin', 'master')
    await write(path.join(distDir, 'package.json'), '{"v":3}')
    created = []
    const outcome = await run(sourceSha)
    expect(outcome).toStrictEqual({ kind: 'superseded' })
    expect(git(remote, 'rev-parse', 'dist')).toBe(head)
    expect(git(remote, 'tag', '--list')).toBe('v0.1.0')
    expect(created).toStrictEqual([])
  })
})
