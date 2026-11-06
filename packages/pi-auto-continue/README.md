# pi-auto-continue

A [pi](https://github.com/earendil-works/pi) extension that detects provider rate/usage limits,
waits for the quota reset, and then resumes the task — either in the current session (`inplace`) or
in a fresh session (`handoff`, the default) driven by a compact handoff document.

> **Name:** the package is about recovering from *quota limits*. It is not pi's built-in `/resume`
> (which switches to another session) and it does not auto-continue on unrelated stops such as
> context overflow.

## Why a fresh session

Waiting hours for a quota reset means the provider's prompt/KV cache for the old transcript is
gone. Resuming the old, bloated session makes the provider re-ingest the whole history and burn a
large part of the freshly restored quota. Handoff mode instead starts a new session that contains
only a handoff summary (goal, decisions, changed files, next steps), so the first request after the
reset is small.

## Install

```bash
pi install /path/to/pi-auto-continue     # or: pi install npm:pi-auto-continue
```

Auto-discovery also works: a checkout placed at `~/.pi/agent/extensions/pi-auto-continue` is loaded
without any install step, because pi loads `~/.pi/agent/extensions/*` entries and directories that
declare `pi.extensions` in `package.json` (see
[packages.md](https://github.com/earendil-works/pi/blob/main/docs/packages.md)).

The extension needs no runtime dependencies; pi provides `@earendil-works/pi-coding-agent`.

### Optional: CodexBar

Reset times are most accurate when [CodexBar](https://github.com/steipete/CodexBar) is installed
(`codexbar usage --json`). Without it the extension still works, but it can only recover reset times
from HTTP `429` headers and from provider error text, which are often missing or vague.

CodexBar queries provider APIs and takes ~5 s (≈15 s without `--provider`), so a **30-second
timeout** is used (adjust with `/ac config timeout <ms>`) and the query is narrowed with
`--provider <id>` when the default command is in use. If the command is still running when the
timeout elapses it is killed and reported as a `timeout` (not as unparseable output).

## Commands

| Command | Purpose |
| --- | --- |
| `/ac` (or `/auto-continue`) | Detect the limit, show reset options, wait, then resume. |
| `/ac [time] [prompt]` | Arm a wait directly. `time` accepts `45m`, `1h30m`, `2 hours`, `16:45`, or a bare number of minutes. |
| `/ac cancel` | Cancel active countdown (also clears the saved pending wait). |
| `/ac quota` (or `/quota`, `/usage`) | Show the applicable quota window and reset time. |
| `/ac handoff [goal]` (or `/handoff`) | Generate a handoff and switch to a fresh session immediately. |
| `/ac config [key] [value]` | Show or change settings (persisted to disk). |

Convenience shortcuts: `/handoff [goal]` (shorthand for `/ac handoff`), `/quota` and `/usage` (shorthand for `/ac quota`).

Configuration keys: `strategy`, `threshold`, `mode`, `automaxwait`, `usagecommand`, `timeout`,
`retention`, `maxturns`, `maxchars`, `resetcredits`.

```
/ac config strategy handoff     # handoff | inplace
/ac config threshold 85         # pre-generate the handoff at 85%
/ac config mode auto            # resume without asking (see automaxwait)
/ac config automaxwait 120      # only auto-wait for resets <= 2h
/ac config timeout 45000        # kill the usage command after 45s
/ac config usagecommand "codexbar usage --json --provider antigravity"
```

`threshold` only controls the *pre-generation* of the handoff. It does not influence which quota
window is treated as the one that hit the limit; that bar is fixed at 99%.

## How it behaves

1. **Detect.** `after_provider_response` (HTTP 429) and `turn_end` (error text) set evidence.
   `agent_settled` consumes it, but only when the run actually ended in an error — a 429 that pi
   retried internally never triggers a dialog.
2. **Resolve the reset time.** The exhausted CodexBar window for the *active model family* wins,
   then the 429 headers, then provider error text. Windows labelled for another family (for example
   a Claude/GPT weekly limit while a Gemini model is active) are ignored.
3. **Pre-generate.** From `threshold`% onward, a handoff is generated and cached (invalidated as
   soon as the branch grows) so the resume does not depend on a call that may fail at 100%. A cache
   hit still resumes through the handoff file, and no new model call is made until the branch moves.
4. **Wait.** A live countdown in the footer. `/ac cancel` stops it. In `auto` mode a *silent* wait
   only starts for resets between 5 minutes and `automaxwait`, and after 3 consecutive auto-resumes
   the extension asks instead of looping.
5. **Resume.** Handoff mode dispatches `/_ac-resume`, which waits for the agent to become idle and
   then starts a fresh session whose only context is the handoff. In-place mode sends a continue
   message to the current session (queued as a follow-up if a turn is still streaming).

### State

Everything lives under `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`) in `pi-auto-continue/`:

| File | Contents |
| --- | --- |
| `config.json` | Persisted settings. |
| `pending-wait.json` | The in-flight wait, restored on the next session start. |
| `handoffs/handoff-*.md` | Generated handoffs (newest `retention` kept). |
| `debug.log` | Diagnostic log (rotated past 512 KB). |

Handoffs are written **outside** your project so nothing lands in a user repository.

## Limitations

- **A pending wait only survives if pi keeps running or is restarted.** It is persisted and restored
  on the next session start; there is no cron/launchd integration, so nothing resumes while pi is
  closed.
- **Non-interactive runs (`--print`, `--mode json`) never schedule a wait.** They log the detected
  reset time to `debug.log` and stderr instead, and a persisted wait is not restored there. `--mode
  rpc` has a UI and behaves like the TUI.
- **In-place waits are abandoned after a session switch** (they belong to the old session file).
  Handoff waits are session-independent. A restored wait is also discarded when the active provider
  no longer matches the provider the wait was armed for.
- **A usage command that exceeds `timeout` is reported as `timeout`** (it used to surface as
  "invalid output"). Raise `timeout` if CodexBar is consistently slow on your machine.
- Reset parsing is heuristic. Relative phrases, `HH:MM` clock times and numeric
  `x-ratelimit-reset` values are all interpreted with plausibility bounds (a candidate must be in the
  future and within 60 days), so an unparseable value is rejected rather than producing a nonsense
  wait.
- The handoff model call is truncated to the last `maxturns` turns / `maxchars` characters, so very
  old details can be lost. When that call fails (which is likely at 100% quota) a locally assembled
  handoff is used instead — file lists stay accurate, the prose is thinner, and the previous
  model-written handoff is attached as a "may be stale" section.
- Only one CodexBar-style usage command is supported. Other providers can be wired up with
  `/ac config usagecommand ...` as long as the command prints a JSON array with the same
  shape.

## Development

```bash
npm install
npm run typecheck   # tsc --strict, erasableSyntaxOnly (node --test compatible)
npm test            # node --test, no extra runner
npm run check       # both
```

Source layout:

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Extension wiring: events, commands, resume dispatch. |
| `src/types.ts` | Shared types and constants. |
| `src/duration.ts` | Duration/clock parsing and formatting. |
| `src/config.ts` | Config defaults, validation, persistence. |
| `src/reset-parse.ts` | HTTP header / error body reset extraction. |
| `src/usage.ts` | Usage-command result classification (timeout / exit code / JSON). |
| `src/providers.ts` | CodexBar payload interpretation and window selection. |
| `src/handoff.ts` | Handoff generation, storage, retention. |
| `src/wait.ts` | Countdown scheduler. |
| `src/util.ts` | Agent dir, safe IO, logger, stale-context-safe UI. |

Everything except `src/index.ts` is pure or dependency-injected and covered by `node --test`;
`src/index.ts` is covered end-to-end by `test/integration.test.ts` against a mock pi API.

## License

MIT
