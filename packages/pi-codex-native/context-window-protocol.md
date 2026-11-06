# Context-window preference capability

The Codex provider owns this UI-free protocol. Import its public helpers from
`@luan.sh/pi-codex-native/context-window`, or contribute through the versioned
structural registry without a runtime dependency on the provider. The original
`pi-codex-native/sources/v1` identity is retained so older SDK copies continue to
interoperate.

## Presets

`ContextWindowPreset` is one of these exact lowercase values, in increasing
size order:

```ts
const CONTEXT_WINDOW_PRESETS = ["smart", "balanced", "enhanced", "large", "max"] as const;
```

`ContextWindowPreference` adds `"default"` at the front:

```ts
const CONTEXT_WINDOW_PREFERENCES = ["default", "smart", "balanced", "enhanced", "large", "max"] as const;
```

`"default"` means the provider's own setting should win. It is a preference
value for provider-side settings, not a preset, and is never returned by
`requestedContextWindowPreset()`.

`isContextWindowPreset(value)` validates an untyped value. It accepts only the
five strings in `CONTEXT_WINDOW_PRESETS`; `"default"`, `undefined`, and any
other value are rejected.

## Publishing a request (source side)

A source has an `id` and a `preset(ctx)` function that derives a preset for the
current `ExtensionContext`, or returns `undefined` to make no request:

```ts
import { ensureContextWindowSourceRegistry, type ContextWindowPreset } from "@luan.sh/pi-codex-native/context-window";

const unregister = ensureContextWindowSourceRegistry().register({
  id: "example",
  preset(_ctx): ContextWindowPreset | undefined {
    return "large";
  },
});

// Call when the contributing extension is disposed or reloaded.
unregister();
```

`register()` returns a disposer. Register and dispose with your extension
lifecycle so reloads do not leave stale sources behind.

Registrations are keyed by source object identity, not by `id`. Registering a
second source with the same `id` does not replace the first; both stay active,
and each disposer removes only the object it was created for. The `id` is
descriptive only.

## Reading a request (provider side)

```ts
const requested = requestedContextWindowPreset(ctx);
```

Sources are checked in registration order. The first source whose `preset()`
returns a valid preset wins. A source that returns `undefined` or an invalid
value is skipped. A source that throws is also skipped and the error is
swallowed, so a broken contributor cannot break the provider. If no source
returns a valid preset, the result is `undefined`.

The library has no built-in default and never applies a context window itself.
The provider owns model eligibility, numeric window sizes, fallback behaviour,
and any stronger provider-side override.

## Registry details

The registry lives on `globalThis` under `Symbol.for("pi-codex-native/sources/v1")`
(exported as `CONTEXT_WINDOW_SOURCES_KEY`). It exposes:

| Member | Value |
| --- | --- |
| `protocol` | `"pi-codex-native/sources/v1"` (`CONTEXT_WINDOW_SOURCES_PROTOCOL`) |
| `version` | `1` |
| `register(source)` | returns a disposer function |

`ensureContextWindowSourceRegistry()` creates the registry on first call and
returns the existing one afterwards. Because the key uses `Symbol.for`,
separate copies of this package loaded in the same JavaScript realm (for
example two extensions that each bundle it) share one registry and one source
list. An existing value at that key is reused only if it has the matching
`protocol`, `version`, and a `register` function; otherwise it is replaced.

`ensureContextWindowSourceRegistry(scope)` accepts a custom global-like object
instead of `globalThis` when an isolated registry is needed, such as in tests.
`requestedContextWindowPreset()` always reads the `globalThis` registry.

The SDK also exports the `ContextWindowSource` and
`ContextWindowSourceRegistry` types for hosts that inspect the capability
directly.
