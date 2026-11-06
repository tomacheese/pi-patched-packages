# pi-patched-packages

Local patches on top of upstream [pi](https://github.com/earendil-works) extension packages, rebuilt automatically when upstream releases a new version.

Currently patched (both from [1aboveio/pi-better-harness](https://github.com/1aboveio/pi-better-harness), MIT):

| Package | Pinned upstream version | Patches |
|---|---|---|
| `pi-better-goal` | see `package.json` | `patches/pi-better-goal/` |
| `pi-better-subagents` | see `package.json` | `patches/pi-better-subagents/` |

## Use

Add one entry to `packages` in `~/.pi/agent/settings.json`, in place of the upstream packages:

```json
"git:github.com/tomacheese/pi-patched-packages@dist"
```

Update with `pi update --extensions`. Use the branch `dist` (not a tag): pi does not move packages pinned to a tag.

The `dist` branch contains the generated tree (`packages/<name>/`, a root `package.json` listing every extension, `PATCHES.md`). It is never edited by hand. Every change of `dist` has a matching tag `r<N>` and GitHub Release.

## How it works

- `master` holds hand-written files only: `package.json` pins the upstream packages exactly, `patches/<package>/NNNN-<slug>.patch` holds the local changes as package-root-relative diffs.
- Renovate bumps the pins. The `verify` workflow builds the tree (`pnpm build`) and smoke-tests it with the pinned pi CLI (`pnpm smoke`); a patch that no longer applies makes it fail, so the bump is not merged.
- After a merge to `master`, `release.yml` rebuilds the tree and publishes it to `dist` and a new `r<N>` tag.

## Develop

```bash
pnpm install
pnpm build   # build/dist
pnpm smoke   # build + load both extensions through pi (rpc get_commands)
pnpm lint
pnpm test
```

Patches are developed and tested in a checkout of the upstream repository (the upstream test suites are not part of the npm packages), then exported with paths relative to the package root:

```bash
git -C <upstream checkout> diff --relative=packages/<package> <base> <target> -- packages/<package>/src packages/<package>/README.md \
  > patches/<package>/NNNN-<slug>.patch
```

See `AGENTS.md` for the full workflow.

## License

MIT for the files of this repository. The upstream packages keep their own MIT license (`LICENSE` inside each generated package directory).
