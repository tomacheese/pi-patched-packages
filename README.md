# pi-patched-packages

Local patches on top of upstream [pi](https://github.com/earendil-works) extension packages, rebuilt automatically when upstream releases a new version.

Currently patched (`pi-better-*` from [1aboveio/pi-better-harness](https://github.com/1aboveio/pi-better-harness), `pi-auto-continue` from [chxsong/pi-auto-continue](https://github.com/chxsong/pi-auto-continue), all MIT):

| Package | Pinned upstream version | Patches |
|---|---|---|
| `pi-auto-continue` | see `package.json` | `patches/pi-auto-continue/` |
| `pi-loop-monitor` | see `package.json` | `patches/pi-loop-monitor/` |
| `pi-better-goal` | see `package.json` | `patches/pi-better-goal/` |
| `pi-better-subagents` | see `package.json` | `patches/pi-better-subagents/` |

## Use

Add one entry to `packages` in `~/.pi/agent/settings.json`, in place of the upstream packages:

```json
"git:github.com/tomacheese/pi-patched-packages@dist"
```

Update with `pi update --extensions`. Use the branch `dist` (not a tag): pi does not move packages pinned to a tag.

The `dist` branch contains the generated tree (`packages/<name>/`, a root `package.json` listing every extension, `PATCHES.md`). It is never edited by hand. Every change of `dist` has a matching tag `v<major>.<minor>.<patch>` and GitHub Release.

## Versioning

The version is derived from what changed in `PATCHES.md` since the previous release. While the major version is 0 (until the project is declared stable, which is done by tagging `v1.0.0` by hand), a "major" change is released as a minor bump.

| Change | From 1.0.0 | In 0.x |
|---|---|---|
| Upstream major bump, or a package added/removed | major | minor |
| Upstream minor bump, or a patch file added/removed | minor | minor |
| Anything else that changes the tree (upstream patch bump, patch content) | patch | patch |

## How it works

- `master` holds hand-written files only: `package.json` pins the upstream packages exactly, `patches/<package>/NNNN-<slug>.patch` holds the local changes as package-root-relative diffs.
- Renovate bumps the pins. The `verify` workflow builds the tree (`pnpm build`) and smoke-tests it with the pinned pi CLI (`pnpm smoke`); a patch that no longer applies makes it fail, so the bump is not merged.
- After a merge to `master`, `release.yml` rebuilds the tree and publishes it to `dist` and a new `v<major>.<minor>.<patch>` tag.

## Develop

```bash
pnpm install
pnpm build   # build/dist
pnpm smoke   # build + load the patched extensions through pi (rpc get_commands)
pnpm lint
pnpm test
```

Patches are developed and tested in a checkout of the upstream repository (the upstream test suites are not part of the npm packages), then exported with paths relative to the package root:

```bash
git -C <upstream checkout> diff --relative=packages/<package> <base> <target> -- packages/<package>/src \
  > patches/<package>/NNNN-<slug>.patch
```

Do not include `README.md` in a patch: upstream documentation changes would make every upstream bump conflict.

`pi-auto-continue` is a single-package upstream (`chxsong/pi-auto-continue`): export from its repository root with `-- src` instead of `--relative=packages/<package>`.

See `AGENTS.md` for the full workflow.

## License

MIT for the files of this repository. The upstream packages keep their own MIT license (`LICENSE` inside each generated package directory).
