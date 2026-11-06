/**
 * CLI entry of `pnpm release` (used by `release.yml`): publishes `build/dist`
 * to the `dist` branch, the `v0.<N>.0` tag and the GitHub Release.
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { PACKAGES, buildDist } from './build-dist'
import { runRelease, type ReleaseClient } from './release'

/** GitHub Release operations through the `gh` CLI (needs `GH_TOKEN`). */
const client: ReleaseClient = {
  exists(tag) {
    try {
      execFileSync('gh', ['release', 'view', tag], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  },
  create(tag, notesFile) {
    execFileSync(
      'gh',
      [
        'release',
        'create',
        tag,
        '--title',
        tag,
        '--notes-file',
        notesFile,
        '--verify-tag',
      ],
      { stdio: 'inherit' }
    )
  },
}

/** Rebuilds the (deterministic) tree and publishes it. */
async function main(): Promise<void> {
  const repoRoot = process.cwd()
  const distDir = path.join(repoRoot, 'build', 'dist')
  try {
    const sourceSha =
      process.env.GITHUB_SHA ??
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim()
    const built = await buildDist({
      repoRoot,
      outDir: distDir,
      packages: PACKAGES,
    })
    const outcome = await runRelease({
      repoRoot,
      distDir,
      sourceSha,
      built,
      remote: 'origin',
      release: client,
    })
    console.log(JSON.stringify(outcome))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

void main()
