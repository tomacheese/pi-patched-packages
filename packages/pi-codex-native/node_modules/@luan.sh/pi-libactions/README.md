# @luan.sh/pi-libactions&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-libactions)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-libactions)

`@luan.sh/pi-libactions` is a UI-free action registry and keybinding loader
for Pi extensions. It is a library, not a Pi extension: importing it registers
no commands, shortcuts, tools, or UI, and it is not installed with `pi install`
on its own. It reaches users as a dependency of the extensions that use it.

The registry lets an extension publish a named action without knowing which
host will expose it. A shortcut host (currently `@luan.sh/pi-xsettings`) reads
the user's `keybindings.json` and binds each configured key to the matching
action. Modal features such as `@luan.sh/pi-copy-mode` read the same snapshot
without registering their keys as global editor shortcuts.

## Preview

Actions registered by Side Panel and Side Chat, bound by Xsettings, and listed in Pi's `/hotkeys`. The library itself registers no UI.

![@luan.sh/pi-libactions in Bootty](https://pi.luan.sh/media/previews/pi-libactions-bbaab600e262.png)

[Watch the demo](https://pi.luan.sh/media/previews/pi-libactions-c0f46f189045.mp4).

## For users: `keybindings.json`

Actions registered through this library have no default keys. You choose every
binding in one file in Pi's agent directory:

```text
<Pi agent directory>/keybindings.json
```

For a normal local install this is `~/.pi/agent/keybindings.json` (the path is
`join(getAgentDir(), "keybindings.json")`, so it follows Pi's agent directory).

The file is a JSON object. Each property name is an action ID; each value is a
single key ID string or an array of key ID strings:

```json
{
  "example.open": "ctrl+o",
  "xsettings.effort.increase": ["alt+."],
  "codex.context.cycle": "ctrl+shift+w"
}
```

A key ID is a base key optionally preceded by modifiers, joined with `+`, for
example `ctrl+shift+p`. Modifiers are `ctrl`, `shift`, `alt`, and `super`, and
each may appear once. Accepted base keys are:

- lowercase letters `a`-`z` and digits `0`-`9`
- punctuation: `` ` `` `-` `=` `[` `]` `\` `;` `'` `,` `.` `/` `!` `@` `#` `$`
  `%` `^` `&` `*` `(` `)` `_` `+` `|` `~` `{` `}` `:` `<` `>` `?`
- `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`,
  `insert`, `clear`, `home`, `end`, `pageUp`, `pageDown`
- `up`, `down`, `left`, `right`
- `f1` through `f12`

Rules the loader applies:

- Base keys are case-sensitive (`pageUp`, not `pageup`). Array order is kept.
- Invalid key IDs inside a value are dropped; the remaining keys are kept. A
  value that is not a string or array leaves the action with no keys.
- Collisions between two action IDs bound to the same key are not resolved
  here; the host decides.
- Malformed JSON, an unreadable or missing file, or a top-level value that is
  not an object yields an empty map, so nothing is bound.
- The file is read on load, not watched. Reload extensions after editing.

Which action IDs exist depends on the extensions you have installed; each
extension's README lists its IDs. Bindings only take effect when a shortcut
host is installed: `pi install npm:@luan.sh/pi-xsettings` provides one that
uses Pi shortcuts for global actions and terminal input listeners for contextual actions. Without a host, the
registry still works but nothing binds global keys.

## For extension authors

### Install and import

Add the library to your package's `dependencies` and `bundledDependencies` so it
ships inside your published package:

```json
{
  "dependencies": {
    "@luan.sh/pi-libactions": "^0.1.0"
  },
  "bundledDependencies": ["@luan.sh/pi-libactions"]
}
```

Then import the public SDK:

```ts
import { registerAction } from "@luan.sh/pi-libactions/sdk";
```

The package has no runtime dependencies; `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-tui` are peer dependencies that Pi provides. The root
export and `/sdk` expose the same symbols: `ACTIONS_PROTOCOL`,
`ACTIONS_REGISTRY_KEY`, `ensureActionsRegistry`, `registerAction`,
`loadActionKeybindings`, `isActionKeyId`, and the types `ActionRegistration`,
`ActionsRegistry`, `ActionKeybindings`.

### Action registry

The registry protocol is `pi-libactions/registry/v1`, stored on `globalThis`
under `Symbol.for("pi-libactions/registry/v1")`.

An action has this shape:

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ActionRegistration = {
  id: string;
  description: string;
  isActive?(): boolean;
  run(ctx: ExtensionContext): void | Promise<void>;
};
```

An optional `isActive` predicate makes a shortcut contextual. The host checks it
on each keypress; when false, the key reaches Pi's normal handling. For example,
a voice mute action can share a key with copy while no call is active. Keep the
presence of the predicate fixed for an action ID until extensions reload. These
contextual keys work throughout the TUI and are not listed by Pi's `/hotkeys`;
the feature should show them in its active controls. Hosts predating this optional
field treat actions as global, so contextual actions require an updated host.

Use a stable, namespaced ID (for example `myext.panel.open`). Register during
extension setup and keep the disposer for reload and shutdown:

```ts
import { registerAction } from "@luan.sh/pi-libactions/sdk";

const unregister = registerAction({
  id: "example.open",
  description: "Open the example panel",
  async run(ctx) {
    await openExamplePanel(ctx);
  },
});

// Call when the extension is disposed or reloaded.
unregister();
```

`registerAction()` uses the process-wide registry returned by
`ensureActionsRegistry()`. A host that needs to inspect or listen to the
registry uses the full API:

```ts
import { ensureActionsRegistry } from "@luan.sh/pi-libactions/sdk";

const actions = ensureActionsRegistry();
const stopListening = actions.onRegister((action) => {
  console.log(action.id, action.description);
});
const action = actions.find("example.open");
```

Behaviour, as implemented in `src/protocol/actions.ts`:

- The registry exposes `protocol` and `version` (`1`). `register()` and
  `onRegister()` each return a disposer.
- `onRegister()` receives registrations made after the listener is attached;
  it does not replay existing actions. The registry never calls `run()` itself.
- Registering an existing ID replaces its action. A disposer only removes the
  exact action instance it registered, so disposing an older registration
  cannot remove a newer replacement.
- Listener errors are swallowed so an optional host cannot break registration.
- `registerAction()` returns a no-op disposer if the global capability cannot
  be created.
- Action fields are not validated at runtime; callers must provide the
  documented shape.
- Separate copies of this package in the same JavaScript realm find the same
  registry through `Symbol.for`. `ensureActionsRegistry(scope)` accepts a
  custom global-like object when an isolated scope is required.

### Reading keybindings from an extension

```ts
import { loadActionKeybindings, isActionKeyId } from "@luan.sh/pi-libactions/sdk";

const bindings = loadActionKeybindings(); // defaults to <agent dir>/keybindings.json
const keys = bindings["example.open"] ?? []; // readonly KeyId[], frozen
```

`loadActionKeybindings(path?)` returns `ActionKeybindings`, a frozen
`Readonly<Record<string, readonly KeyId[]>>` with frozen inner arrays.
`isActionKeyId(value)` validates one key ID without touching the filesystem.

## Layout

| Responsibility | File |
| --- | --- |
| Public SDK re-exports | `src/sdk.ts` (root `src/index.ts` re-exports it) |
| Action registry protocol and `Symbol.for` capability | `src/protocol/actions.ts` |
| `keybindings.json` loader and key ID validation | `src/keybindings.ts` |

## Develop

Source: https://github.com/luan/agents, directory
harnesses/pi/agent/packages/pi-libactions. Run `bun run typecheck` and
`bun test test` in that directory.
