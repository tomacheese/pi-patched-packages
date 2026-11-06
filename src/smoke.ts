/**
 * Smoke test: builds the dist tree, installs it into a scratch pi agent
 * directory with the pinned pi CLI, and checks that every patched extension loads.
 *
 * Run by `verify.yml` and `release.yml`; exits non-zero on any failure.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'
import { PACKAGES, buildDist, parsePatchEffects } from './build-dist'

/** Command registered by an extension, as reported by pi's rpc `get_commands`. */
interface RpcCommand {
  name: string
  sourceInfo?: { path?: string }
}

/** Extension commands that must come from each package (command name, package). */
const EXPECTED_COMMANDS = [
  { command: 'ac', packageName: 'pi-auto-continue' },
  { command: 'goal', packageName: 'pi-better-goal' },
  { command: 'agents', packageName: 'pi-better-subagents' },
] as const

/** Time allowed for pi to answer `get_commands`. */
const RPC_TIMEOUT_MS = 60_000

/** Returns the SHA-256 (hex) of a file. */
async function sha256File(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex')
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
 * Asks pi (rpc mode) for its registered commands.
 * @param piBin Path of the pi CLI
 * @param env Environment for the child process
 * @param cwd Working directory for the child process
 * @returns Registered commands
 */
async function fetchCommands(
  piBin: string,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<RpcCommand[]> {
  const child = spawn(piBin, ['--mode', 'rpc', '--no-session', '--offline'], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  try {
    return await new Promise<RpcCommand[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for the rpc get_commands response'))
      }, RPC_TIMEOUT_MS)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`pi exited early with code ${String(code)}`))
      })
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => {
        let message: {
          type?: string
          id?: string
          success?: boolean
          data?: { commands?: RpcCommand[] }
        } | null
        try {
          message = JSON.parse(line) as typeof message
        } catch {
          return
        }
        if (message?.type !== 'response' || message.id !== '1') {
          return
        }

        clearTimeout(timer)
        if (message.success === true && message.data?.commands) {
          resolve(message.data.commands)
        } else {
          reject(new Error(`get_commands failed: ${line}`))
        }
      })
      child.stdin.write(
        `${JSON.stringify({ id: '1', type: 'get_commands' })}\n`
      )
    })
  } finally {
    child.kill()
  }
}

/**
 * Checks that every file touched by a patch has the hash recorded in
 * `PATCHES.md` and differs from the upstream file (guards against a patch that
 * was silently skipped).
 * @param repoRoot Repository root
 * @param outDir Dist directory
 */
async function checkPatchEffects(
  repoRoot: string,
  outDir: string
): Promise<number> {
  const markdown = await fs.readFile(path.join(outDir, 'PATCHES.md'), 'utf8')
  const effects = parsePatchEffects(markdown)
  for (const effect of effects) {
    const built = path.join(outDir, 'packages', effect.packageName, effect.path)
    const upstream = path.join(
      await fs.realpath(
        path.join(repoRoot, 'node_modules', effect.packageName)
      ),
      effect.path
    )
    if (effect.sha256 === null) {
      if (await exists(built)) {
        throw new Error(
          `${effect.packageName}/${effect.path} should be removed`
        )
      }
      continue
    }
    if ((await sha256File(built)) !== effect.sha256) {
      throw new Error(
        `${effect.packageName}/${effect.path} does not match PATCHES.md`
      )
    }
    if (
      (await exists(upstream)) &&
      (await sha256File(upstream)) === effect.sha256
    ) {
      throw new Error(
        `${effect.packageName}/${effect.path} is identical to upstream: patch not applied`
      )
    }
  }
  return effects.length
}

/**
 * Guards the patched `pi-better-subagents` failure model: a bash failure
 * summary must end with the output tail, and a failure repeated after a file
 * edit must start a new group that is recovered with the rest. Throws when the
 * child script exits non-zero.
 * @param outDir Dist directory
 */
function checkIncidentModel(outDir: string): void {
  const script = String.raw`
    import { newIncidentModel, foldToolEnd, toolOperation } from ${JSON.stringify(
      path.join(outDir, 'packages', 'pi-better-subagents', 'incident-model.ts')
    )}
    const events = []
    const sink = {
      observe: (batch) => { events.push(...batch); return { observations: {} } },
      state: () => ({ observations: {} }),
      dispose() {},
    }
    const model = newIncidentModel(false)
    let n = 0
    const fail = () => ({ toolCallId: 'b' + (++n), toolName: 'bash', isError: true,
      args: { command: 'pytest -x tests/' },
      result: { content: [{ type: 'text', text: '....F [100%]\n=== 1 failed, 5 passed ===\n\nCommand exited with code 1' }], details: { exitCode: 1 } } })
    const edit = () => ({ toolCallId: 'e' + (++n), toolName: 'edit', isError: false, args: {}, result: { content: [{ type: 'text', text: 'ok' }] } })
    foldToolEnd(model, fail(), '/w', 'ev', sink)
    foldToolEnd(model, edit(), '/w', 'ev', sink)
    foldToolEnd(model, fail(), '/w', 'ev', sink)
    foldToolEnd(model, fail(), '/w', 'ev', sink)
    const failures = events.filter((e) => e.kind === 'failure')
    if (!failures[0].summary.includes('1 failed, 5 passed')) throw new Error('summary lost the output tail: ' + failures[0].summary)
    if (failures[0].operation === failures[1].operation || failures[1].operation !== failures[2].operation) {
      throw new Error('failures were not grouped per edit epoch')
    }
    const recovered = []
    sink.observe = (batch) => { recovered.push(...batch.filter((e) => e.kind === 'recovered')); return { observations: {} } }
    const operation = toolOperation('bash', { command: 'pytest -x tests/' }, '/w')
    model.open.set('ok', { toolCallId: 'ok', toolName: 'bash', operation, intent: {}, startSequence: model.sequence + 1 })
    foldToolEnd(model, { toolCallId: 'ok', toolName: 'bash', isError: false, args: { command: 'pytest -x tests/' },
      result: { content: [{ type: 'text', text: 'ok' }], details: { exitCode: 0 } } }, '/w', 'ev', sink)
    if (recovered.length !== 2) throw new Error('expected a recovery per failure group, got ' + recovered.length)
  `
  execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { stdio: 'inherit' }
  )
  console.log('incident model: ok')
}

/**
 * Guards the patched `pi-auto-continue` reset parser: it must accept a `~`
 * prefix and compact durations, and must stay linear on long whitespace runs.
 * Throws (non-zero child exit) when a case fails.
 * @param outDir Dist directory
 */
function checkResetParse(outDir: string): void {
  const script = `
    import { parseErrorBodyReset } from ${JSON.stringify(
      path.join(outDir, 'packages', 'pi-auto-continue', 'src', 'reset-parse.ts')
    )}
    const cases = [
      ['Codex usage limit reached (plus plan). Resets in ~125h.', 125],
      ['Resets in ~2.5h.', 2.5],
      ['try again in 1h30m', 1.5],
    ]
    const started = Date.now()
    if (parseErrorBodyReset('in' + ' '.repeat(50000) + 'x', 'p', Date.now()) !== null || Date.now() - started > 1000) {
      throw new Error('reset parse is not linear on whitespace runs')
    }
    for (const [text, hours] of cases) {
      const info = parseErrorBodyReset(text, 'p', Date.now())
      const actual = info ? (info.resetsAt.getTime() - Date.now()) / 3600000 : null
      if (actual === null || Math.abs(actual - hours) > 0.01) {
        throw new Error('reset parse failed for: ' + text + ' => ' + actual)
      }
    }
  `
  execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { stdio: 'inherit' }
  )
  console.log('reset parser: ok')
}

/** Runs the smoke test. */
async function main(): Promise<void> {
  const repoRoot = process.cwd()
  const outDir = path.join(repoRoot, 'build', 'dist')
  const piBin = path.join(repoRoot, 'node_modules', '.bin', 'pi')

  await buildDist({ repoRoot, outDir, packages: PACKAGES })
  console.log('build: ok')

  execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts'], {
    cwd: outDir,
    stdio: 'inherit',
  })

  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppp-smoke-'))
  try {
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_TELEMETRY: '0',
    }
    execFileSync(piBin, ['install', outDir], {
      cwd: agentDir,
      env,
      stdio: 'inherit',
    })
    const commands = await fetchCommands(piBin, env, agentDir)
    const realOut = await fs.realpath(outDir)
    for (const expected of EXPECTED_COMMANDS) {
      const found = commands.find((c) => c.name === expected.command)
      const source = found?.sourceInfo?.path
      if (!source) {
        throw new Error(`Command /${expected.command} is not registered`)
      }
      const root =
        path.join(realOut, 'packages', expected.packageName) + path.sep
      const realSource = (await exists(source))
        ? await fs.realpath(source)
        : source
      if (!realSource.startsWith(root)) {
        throw new Error(
          `Command /${expected.command} comes from ${source}, expected under ${root}`
        )
      }
      console.log(`command /${expected.command}: ${source}`)
    }
    checkIncidentModel(outDir)

    checkResetParse(outDir)
    const checked = await checkPatchEffects(repoRoot, outDir)
    console.log(`patch effects: ${String(checked)} file(s) verified`)
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true })
  }
  console.log('smoke: ok')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
