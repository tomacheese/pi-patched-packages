# AGENTS.md

Guidance for AI coding agents working in this repository. See `README.md` for usage.

## Language

- All deliverables are written in English: commit messages, PR/Issue titles and bodies, review comments, code comments, JSDoc, and documentation.
- Exceptions: quotations, technical identifiers, generated files, and external source text.
- Error and warning messages are English.
- Conversation with the maintainer may be in Japanese; that does not change the deliverable language.
- Do not rewrite Git history to change the language of existing commits.

## Overview

This repository carries local patches on top of the upstream npm packages `pi-better-goal` and `pi-better-subagents` (from `1aboveio/pi-better-harness`). `src/build.ts` applies `patches/<package>/*.patch` to the pinned upstream packages and writes the result to `build/dist`; `release.yml` publishes that tree to the `dist` branch, which pi installs with `git:github.com/tomacheese/pi-patched-packages@dist`.

## Rules

- `master` contains hand-written files only. Generated output exists only on `dist` and in the git-ignored `build/` directory. Never commit generated files to `master`, and never push to `dist`, `v*` tags or Renovate branches by hand.
- Do not add commits to Renovate-created PRs. When a Renovate bump needs a rebased patch, open a separate maintainer PR that bumps the exact pin and the lockfile together with the rebased patches.
- Upstream versions are pinned exactly in `package.json` (`pi-better-goal`, `pi-better-subagents`, `@earendil-works/pi-coding-agent`). Keep them exact.
- Patch files are package-root-relative (`a/src/index.ts`, not `a/packages/...`) and contain no test files. They are applied with `git apply --directory=<package dir>` from the repository root. Do not run `git apply` inside a package subdirectory of a git working tree: it silently skips the files.
- Patches are developed and tested in a checkout of the upstream repository, then exported (see `README.md`). Do not copy upstream test files here, and keep `README.md` hunks out of patches.
- The generated `package.json` and `PATCHES.md` must not contain a release number, date or commit SHA, so unchanged trees can be detected.
- Never commit secrets or machine-specific paths.

## Commands

pnpm is required (`preinstall` runs `only-allow pnpm`). The Node.js version is in `.node-version`.

```bash
pnpm install        # install dependencies
pnpm build          # build/dist
pnpm smoke          # build, install into a scratch pi agent directory, check goal/agents commands
pnpm release        # publish build/dist (CI only: needs a push-capable origin and GH_TOKEN)
pnpm lint           # prettier --check + eslint + tsc
pnpm fix            # prettier --write + eslint --fix
pnpm test           # jest with coverage
```

CI: the shared `book000/templates` Node.js pnpm workflow (`.github/workflows/nodejs-ci-pnpm.yml`), `verify.yml` (build + smoke, required check `verify`) and `release.yml` (publishes `dist`).

## Code layout

| File | Purpose |
|---|---|
| `src/build-dist.ts` | Build logic: copy pinned packages, apply patches, generate `package.json` and `PATCHES.md` |
| `src/build.ts` | CLI entry of `pnpm build` |
| `src/smoke.ts` | Smoke test used by `verify.yml` and `release.yml` |
| `src/release.ts` | Publishing logic: supersession guard, `dist` commit, atomic push of `dist` and `v<major>.<minor>.<patch>`, GitHub Release |
| `src/release-cli.ts` | CLI entry of `pnpm release` (used by `release.yml`) |
| `patches/<package>/` | Ordered patches (`NNNN-<slug>.patch`) |

## Conventions

- TypeScript with prettier and eslint (`@book000/eslint-config`); prefer `node:`-prefixed built-in imports.
- `pnpm lint` and `pnpm test` must pass before committing.
- Every function, interface and class has a JSDoc comment; keep comments to intent and constraints.
- Tests are adjacent `*.test.ts` files (Jest + ts-jest) using temp directories under `os.tmpdir()`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/); branches follow [Conventional Branch](https://conventional-branch.github.io) short form (`feat/...`, `fix/...`).
- Research other GitHub repositories by cloning them into a temporary directory.
