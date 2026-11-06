/**
 * CLI entry: builds the real packages into `build/dist`.
 */

import path from 'node:path'
import { PACKAGES, buildDist } from './build-dist'

/** Builds `build/dist` from the current working directory. */
async function main(): Promise<void> {
  const repoRoot = process.cwd()
  try {
    const built = await buildDist({
      repoRoot,
      outDir: path.join(repoRoot, 'build', 'dist'),
      packages: PACKAGES,
    })
    for (const item of built) {
      console.log(
        `${item.name}@${item.version}: ${item.patches.length} patch(es) applied`
      )
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

void main()
