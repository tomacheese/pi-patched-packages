# Changelog

## 0.4.1

Correctness pass over the usage lookup, reset selection and auto mode. All changes have regression
tests (133 → 147).

### Fixed

- **A valid usage payload with a non-zero exit code was thrown away.** CodexBar exits `1` whenever
  one provider fails to refresh while still printing a usable JSON array for the others (observed
  roughly one run in five), so the lookup went blind at exactly the moment a provider was in
  trouble. A parseable array is now accepted regardless of the exit code.
- **A missing usage command was reported as a generic failure.** pi's `exec` resolves (never rejects)
  with `code: 1` and empty output for ENOENT, so the `command-missing` branch was dead code and the
  "Install CodexBar" hint never appeared. Empty output plus a non-zero exit is now classified as
  `command-missing`.
- **The handoff threshold silently moved the reset target.** `selectResetWindow` used
  `handoffThreshold` (10–99, a pre-generation knob) as the "window is exhausted" bar, so setting
  `/ac config threshold 50` could change the wait from the 5-hour reset to the weekly one (~2 days
  later). The exhaustion bar is now a separate constant (99%) and `handoffThreshold` only controls
  pre-generation.
- **Auto mode could loop.** A short `retry-after` (for example 60s) satisfied `automaxwait`, so the
  extension resumed straight back into the throttle, generating a fresh handoff on each round. Auto
  mode now requires a reset of at least 5 minutes and stops auto-resuming after 3 consecutive
  rate limits, falling back to the dialog.
- **A suffixed resume command could dispatch into another extension.** When a command-name collision
  makes pi register `_ac-resume:1`/`:2`, the name is no longer guessed; the extension falls back to
  an in-place resume instead of possibly invoking another handler.
- **A persisted wait was restored in non-interactive runs.** `--print`/`--mode json` now skip the
  restore, matching the documented behaviour.

### Added

- `test/integration.test.ts`: end-to-end wiring tests against a mock pi API (event gating, the
  rate-limit dialog, pending-wait persistence, the threshold decoupling and the auto-mode guard).

### Changed

- `package.json` gained `repository`, `homepage`, `bugs` and a `prepublishOnly` check; README install
  instructions are no longer machine-specific.

## 0.4.0

Correctness and efficiency pass: a full audit turned up two silent failures in the core flow, plus
several accuracy and cost issues. All fixes have regression tests (113 → 133).

### Fixed (silent failures)

- **Timeouts were reported as "invalid output".** pi's `exec` returns `code: 0, killed: true` for a
  signal-killed child (a signal makes `code` null and the wrapper coalesces it to 0), so the timeout
  branch was never taken and truncated JSON looked like a parse error. `killed` is now checked
  first, a `timeout` status is reported (with the command line and a hint to raise `timeout`), and a
  timed-out narrowed query no longer retries the slower full command (worst case was 2× the
  timeout).
- **Handoff cache hits silently resumed in-place.** The cache-hit branch returned `file: null`, so
  `armWait` persisted a handoff wait without a handoff file and `performResume` fell through to the
  in-place path — losing the KV-cache saving the feature exists for. The cache now remembers the
  file name (and rewrites it if a previous write failed) and the original `generatedBy`.

### Fixed (accuracy)

- **`overallMaxUsedPercent` only counted the matched provider**, while `/quota` labelled it "other
  model families". It now really covers every window in the payload, the label says so, and the
  value survives the "no provider matched" early return.
- **A payload entry without a `provider` field matched every provider** (`candidate.includes("")` is
  always true). Provider-less entries are skipped for matching but still counted for diagnostics.
- **`isRateLimitError` false positives.** Substring markers like `429` and `capacity` matched
  `"completed in 1429ms"` and `"network capacity error"`. Matching is now word-boundary anchored and
  still accepts `429`, `RESOURCE_EXHAUSTED`, `rate_limit_exceeded`, `insufficient capacity`, etc.

### Fixed (robustness)

- **Resuming while a turn was streaming dropped the resume.** The timer fired, cleared the pending
  wait, and then `sendUserMessage` threw "Agent is already processing". In-place resumes are now sent
  as a follow-up message, and `/_ac-resume` waits for the agent to become idle before switching.
  `/handoff` also waits for idle before snapshotting the branch.
- A restored pending wait is discarded when the active provider no longer matches the provider it
  was armed for.
- A pending wait is picked up whenever a wait is not already armed in memory, instead of only once
  per extension instance, so a file written by another pi process is not ignored.
- Stale error evidence is cleared on a successful settle, so a later manual `/ac` cannot parse a
  reset time out of an old failure.
- `performResume` reads the handoff file once instead of twice, and resolves the resume command's
  actual invocation name (pi suffixes duplicates as `_ac-resume:2`).

### Changed

- **Default usage-command timeout raised 20 s → 30 s**, and it is now configurable with
  `/ac config timeout <ms>` (500–60000). Existing config files keep their explicit value.
- Threshold pre-generation is skipped while a wait is armed and only notifies once per branch; a
  cache hit is silent.
- Overlapping spinners no longer clear each other's status: they share a stack and a single timer,
  and a finishing spinner restores the one below it.
- New `src/usage.ts` (usage-command classification) keeps `src/index.ts` focused on wiring and makes
  the timeout handling unit testable. README corrected (the "5-minute 50-second timeout" line was
  wrong).

## 0.3.0

Command ergonomics and subcommand architecture pass (Plan A).

### Added & Improved (Ergonomics)

- **Subcommand system under `/ac` & `/auto-continue`**:
  - `/ac` (or `/auto-continue`): primary command; opens dialog or sets direct wait.
  - `/ac cancel`: cancels current wait countdown (replaces clunky `/cancel-wait`).
  - `/ac quota` (and `/ac usage`): checks quota window & reset times.
  - `/ac handoff [goal]`: generates handoff and switches session immediately.
  - `/ac config [key] [value]`: view or modify persistent settings.
- **Top-level shortcuts & aliases**:
  - `/ac`: short alias for `/auto-continue`.
  - `/handoff [goal]`: replaces `/handoff-now` (verb-as-command).
  - `/usage`: alias for `/quota` (aligned with Claude Code conventions).
- **Clean surface without legacy baggage**:
  - Dropped old prototype commands (`/cancel-wait`, `/handoff-now`, `/auto-continue-config`).
  - Internal resume command renamed to `/_ac-resume`.
- **Status & notification text updated** to reference `/ac cancel` and `/ac config`.

## 0.2.0

Fixes and hardening pass over the initial single-file prototype. It is a rewrite, but the commands
and the two strategies are unchanged.

### Fixed (breaking bugs)

- **Crash on session switch while waiting.** The countdown `setInterval`/`setTimeout` callbacks held
  a captured extension context and called into it unguarded. Any session replacement (`/new`,
  `/resume`, fork, `/handoff-now`, `/reload`) invalidates that context, and an uncaught throw inside
  a timer callback terminates pi. Every UI/API call is now guarded and the timers are cleared on
  `session_shutdown`.
- **Handoff mode never actually ran.** The timer called `ctx.newSession()`, which only exists on
  command contexts — from an event or timer it threw `TypeError`, was swallowed, and silently
  degraded to an in-place resume with a generic prompt. Resuming now goes through the
  `/auto-continue-resume` command, which has a real command context.
- **The usage lookup always failed.** The CodexBar command was run with a 6-second timeout, but
  CodexBar needs ~15 s (~5 s with `--provider`). Every lookup timed out and was swallowed, so reset
  detection, `/quota` and the threshold pre-generation were silently dead. The timeout is now 20 s
  and the default command is narrowed with `--provider <id>`.
- **A usage lookup per turn.** The threshold throttle only advanced when the warning fired, so a
  quota below the threshold re-ran the usage command on every single turn, blocking `agent_settled`
  for seconds each time. The check is now interval-throttled, cached, and not awaited.
- **A stale 429 could raise a dialog after a successful run.** Rate-limit evidence was a latch that
  was only cleared when consumed. It is now cleared on `agent_start`, and a dialog requires the run
  to have ended in an error.
- **`ctx.hasUI` on a stale context** threw; it is now read through a guarded helper.

### Fixed (wrong behaviour)

- **Wrong quota window (antigravity).** Untitled `primary`/`secondary` entries duplicated the
  labelled `extraRateWindows` entries, so the family filter could not exclude them and a Gemini
  session waited for the exhausted Claude/GPT weekly window. Duplicates are dropped, `tertiary` is
  handled, and labelled windows from another model family are ignored.
- **Hard-coded threshold.** The exhausted-window search used 90% regardless of `threshold`.
- **Stale handoff.** The handoff was cached per session id forever, so a pre-generated handoff was
  still used hours later. The cache key now includes the leaf id and branch length.
- **Config was never persisted** and was reset by every session replacement — including the handoff
  to a fresh session this extension performs itself. It now lives in
  `$PI_CODING_AGENT_DIR/pi-auto-continue/config.json`.
- **Silent in non-interactive runs.** `--print`/`--mode json` returned with no output at all. They
  now report the detected reset time to stderr and the debug log.
- **Local fallback used the first user message as the goal** (hours old in a long session) instead
  of the most recent one.
- **`1h30m` counted 30 minutes twice.**
- Numeric reset headers could be misread as an epoch and produce a wait ending in the year 2286;
  candidates are now plausibility-checked. Zone-less ISO timestamps from provider payloads are
  treated as UTC instead of local time.
- A `codexbar` warning line before the JSON no longer discards the whole payload.

### Added

- Pending waits are persisted and restored on the next session start.
- Reset-credit detection: when the provider reports unused reset credits, resuming immediately is
  offered.
- Self-clearing handoff retention, `debug.log` rotation, and atomic JSON writes.
- 105 unit tests, `tsc --strict` (with `erasableSyntaxOnly` so `node --test` can run the sources
  directly), README, LICENSE and CI.
- Multi-file layout instead of one ~940-line file.

### Changed

- Handoff files moved from `<project>/.pi/handoffs/` to
  `$PI_CODING_AGENT_DIR/pi-auto-continue/handoffs/`.
- `autoMode: auto` now only waits silently for resets within `automaxwait` (default 240 minutes);
  longer resets always prompt. The custom-duration choices let you pick the strategy explicitly
  instead of inheriting `strategy`.
