import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'
import {
  BuildError,
  buildDist,
  parsePatchEffects,
  renderPatchesMd,
} from './build-dist'

/** Writes a file, creating parent directories. */
async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

/** Builds a unified diff that replaces `from` with `to` in `file`. */
function lineReplacePatch(file: string, from: string, to: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    '--- a/' + file,
    '+++ b/' + file,
    '@@ -1 +1 @@',
    `-${from}`,
    `+${to}`,
    '',
  ].join('\n')
}

/** Temporary source and output directories used by the build tests. */
interface Fixture {
  root: string
  outDir: string
}

/**
 * Creates a fake repository with a pnpm-style node_modules layout:
 * `node_modules/<pkg>` is a symlink into `.pnpm/<id>/node_modules/<pkg>`,
 * and the package dependencies are siblings of the real directory.
 * @param root Repository root (temp directory)
 * @returns Fixture paths
 */
async function createFixture(root: string): Promise<Fixture> {
  const store = path.join(root, 'node_modules', '.pnpm')
  const packages: Record<
    string,
    { version: string; deps: Record<string, string> }
  > = {
    'pkg-a': { version: '1.2.3', deps: { 'dep-x': '4.0.0' } },
    'pkg-b': { version: '2.0.0', deps: { 'dep-x': '4.0.0', 'dep-y': '5.1.0' } },
  }
  for (const [name, info] of Object.entries(packages)) {
    const nm = path.join(store, `${name}@${info.version}`, 'node_modules')
    await write(
      path.join(nm, name, 'package.json'),
      JSON.stringify({
        name,
        version: info.version,
        dependencies: Object.fromEntries(
          Object.keys(info.deps).map((d) => [d, '^1.0.0'])
        ),
        pi: { extensions: ['./src/index.ts'] },
      })
    )
    await write(path.join(nm, name, 'src', 'index.ts'), `${name}-line\n`)
    await write(path.join(nm, name, 'LICENSE'), `${name} upstream license\n`)
    await write(path.join(nm, name, 'node_modules', 'ignored.txt'), 'x')
    for (const [dep, version] of Object.entries(info.deps)) {
      await write(
        path.join(nm, dep, 'package.json'),
        JSON.stringify({ name: dep, version })
      )
    }
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
    await fs.symlink(
      path.relative(path.join(root, 'node_modules'), path.join(nm, name)),
      path.join(root, 'node_modules', name)
    )
  }
  await write(path.join(root, 'README.md'), 'repo readme\n')
  await write(path.join(root, 'LICENSE'), 'repo license\n')
  return { root, outDir: path.join(root, 'build', 'dist') }
}

describe('buildDist', () => {
  let tmp: string
  let fixture: Fixture

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ppp-build-'))
    fixture = await createFixture(tmp)
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  /** Runs the build for both fake packages. */
  function run(): ReturnType<typeof buildDist> {
    return buildDist({
      repoRoot: fixture.root,
      outDir: fixture.outDir,
      packages: ['pkg-a', 'pkg-b'],
    })
  }

  it('applies patches in lexical order', async () => {
    const dir = path.join(fixture.root, 'patches', 'pkg-a')
    await write(
      path.join(dir, '0010-third.patch'),
      lineReplacePatch('src/index.ts', 'second', 'third')
    )
    await write(
      path.join(dir, '0002-second.patch'),
      lineReplacePatch('src/index.ts', 'pkg-a-line', 'second')
    )
    await run()
    const built = await fs.readFile(
      path.join(fixture.outDir, 'packages', 'pkg-a', 'src', 'index.ts'),
      'utf8'
    )
    expect(built).toBe('third\n')
  })

  it('fails with package, patch and version when a patch does not apply', async () => {
    await write(
      path.join(fixture.root, 'patches', 'pkg-b', '0001-broken.patch'),
      lineReplacePatch('src/index.ts', 'not-present', 'x')
    )
    const error = await run().then(
      () => undefined,
      (error_: unknown) => error_
    )
    expect(error).toBeInstanceOf(BuildError)
    const message = (error as BuildError).message
    expect(message).toContain('pkg-b')
    expect(message).toContain('0001-broken.patch')
    expect(message).toContain('2.0.0')
  })

  it('applies patches relative to the package even when the output is inside a git working tree', async () => {
    execFileSync('git', ['init', '-q'], { cwd: fixture.root })
    await write(
      path.join(fixture.root, 'patches', 'pkg-a', '0001-x.patch'),
      lineReplacePatch('src/index.ts', 'pkg-a-line', 'patched')
    )
    await run()
    const built = await fs.readFile(
      path.join(fixture.outDir, 'packages', 'pkg-a', 'src', 'index.ts'),
      'utf8'
    )
    expect(built).toBe('patched\n')
  })

  it('generates package.json with exact dependencies and re-based extensions', async () => {
    await run()
    const generated = JSON.parse(
      await fs.readFile(path.join(fixture.outDir, 'package.json'), 'utf8')
    ) as Record<string, unknown>
    expect(generated).toMatchObject({
      name: 'pi-patched-packages',
      private: true,
      type: 'module',
      version: '0.0.0',
      dependencies: { 'dep-x': '4.0.0', 'dep-y': '5.1.0' },
      pi: {
        extensions: [
          './packages/pkg-a/src/index.ts',
          './packages/pkg-b/src/index.ts',
        ],
      },
    })
  })

  it('fails when two packages resolve the same dependency to different versions', async () => {
    const nm = path.join(
      fixture.root,
      'node_modules',
      '.pnpm',
      'pkg-b@2.0.0',
      'node_modules'
    )
    await write(
      path.join(nm, 'dep-x', 'package.json'),
      JSON.stringify({ name: 'dep-x', version: '4.0.1' })
    )
    await expect(run()).rejects.toThrow(/dep-x/)
  })

  it('is deterministic and keeps release data out of PATCHES.md', async () => {
    await write(
      path.join(fixture.root, 'patches', 'pkg-a', '0001-x.patch'),
      lineReplacePatch('src/index.ts', 'pkg-a-line', 'patched')
    )
    /** Reads every file under a directory into a path to content map. */
    const readTree = async (dir: string): Promise<Record<string, string>> => {
      const out: Record<string, string> = {}
      /** Walks one directory. */
      const walk = async (current: string): Promise<void> => {
        const entries = await fs.readdir(current, { withFileTypes: true })
        for (const entry of entries) {
          const full = path.join(current, entry.name)
          if (entry.isDirectory()) await walk(full)
          else out[path.relative(dir, full)] = await fs.readFile(full, 'utf8')
        }
      }
      await walk(dir)
      return out
    }
    await run()
    const first = await readTree(fixture.outDir)
    await run()
    const second = await readTree(fixture.outDir)
    expect(second).toStrictEqual(first)
    const patchesMd = first['PATCHES.md']
    expect(patchesMd).toContain('pkg-a')
    expect(patchesMd).toContain('0001-x.patch')
    expect(patchesMd).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(patchesMd).not.toMatch(/\b[0-9a-f]{40}\b/)
    expect(patchesMd).not.toMatch(/\br\d+\b/)
  })

  it('copies symlinked (pnpm) package directories as real files and skips nested node_modules', async () => {
    await run()
    const dest = path.join(fixture.outDir, 'packages', 'pkg-a')
    const destStat = await fs.lstat(dest)
    const fileStat = await fs.lstat(path.join(dest, 'src', 'index.ts'))
    expect(destStat.isSymbolicLink()).toBe(false)
    expect(fileStat.isFile()).toBe(true)
    await expect(fs.access(path.join(dest, 'node_modules'))).rejects.toThrow()
    expect(await fs.readFile(path.join(dest, 'LICENSE'), 'utf8')).toBe(
      'pkg-a upstream license\n'
    )
    expect(
      await fs.readFile(path.join(fixture.outDir, 'LICENSE'), 'utf8')
    ).toBe('repo license\n')
  })

  it('records the touched files with built hashes that parsePatchEffects can read back', async () => {
    await write(
      path.join(fixture.root, 'patches', 'pkg-a', '0001-x.patch'),
      lineReplacePatch('src/index.ts', 'pkg-a-line', 'patched')
    )
    const built = await run()
    const md = renderPatchesMd(built)
    const effects = parsePatchEffects(md)
    const pkgA = built.find((b) => b.name === 'pkg-a')
    expect(pkgA?.touched).toHaveLength(1)
    expect(effects).toContainEqual({
      packageName: 'pkg-a',
      path: 'src/index.ts',
      sha256: pkgA?.touched[0].sha256,
    })
  })
})
