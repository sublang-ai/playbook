<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# RELEASE: Release Workflow

## Intent

This spec defines the release workflow for publishing the
`@sublang/playbook` package — the reference CODE playbook
runtime, Playbook Captain shell, tmux-play compatibility shim,
the host-agnostic `@sublang/playbook/runtime` type contract, and the
authored `slc/*` specs, all at the repo root —
to npm and tagging the corresponding GitHub release.
It also covers the public, semver-stable package surfaces
([RELEASE-15](#release-15), [RELEASE-16](#release-16)).

## Versioning

### RELEASE-1

The project shall follow Semantic Versioning 2.0.0 [[1]]:
`MAJOR.MINOR.PATCH` where MAJOR indicates breaking changes, MINOR
indicates new features, and PATCH indicates bug fixes.

### RELEASE-2

The `version` in `package.json` shall
match the git tag (without the `v` prefix). The release workflow
shall verify this match before publishing.

## Changelog

### RELEASE-3

All notable changes shall be documented in `CHANGELOG.md` at the
repository root, following the Keep a Changelog format [[2]].

### RELEASE-4

Before creating a release tag, the developer/agent shall:

1. Review all commits since the last release (`git log <last-tag>..HEAD`).
2. Ensure all notable changes are documented in `[Unreleased]`.
3. Add a new version section to `CHANGELOG.md` with the release date.
4. Move items from `[Unreleased]` to the new version section.
5. Update the comparison links at the bottom of the file.

### RELEASE-5

Changelog entries shall be grouped under these headings (in
order): `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
`Security`.

## Development dependency override

### RELEASE-11

A local-development link of `@sublang/cligent` to a local
checkout shall be applied only by copying the tracked
`pnpm-workspace.yaml.example` to `pnpm-workspace.yaml`, which
overrides the registry version pinned in `pnpm-lock.yaml`.

That override is local-only: `pnpm-workspace.yaml` shall stay
git-ignored and the `pnpm-lock.yaml` mutation it induces shall
not be committed, so the override is absent from the published
package and from every production and CI install — the release
workflow drops it before install ([RELEASE-7](#release-7)).

## Release Process

### RELEASE-6

Releases shall be triggered by pushing a git tag matching the
pattern `vMAJOR.MINOR.PATCH` (e.g., `v0.1.0`).

### RELEASE-7

The release workflow on GitHub shall:

1. Verify the tag version matches the `version` field in
   `package.json`.
2. Drop the dev-only `pnpm-workspace.yaml` override before install
   so the build sees the registry-pinned `@sublang/cligent` rather
   than the contributor-machine local link (see
   [RELEASE-11](#release-11)).
3. Install with `pnpm install --frozen-lockfile`, then `pnpm build`
   and `pnpm test`.
4. Extract release notes for the tag version from the root
   `CHANGELOG.md` into a file (not a shell variable), so backticks
   and `$()` in the notes can't be interpreted as commands when the
   release is created.
5. Publish to npm with provenance attestation.
6. Create a GitHub Release with the extracted notes attached.

### RELEASE-8

The npm package shall be published with the `--provenance` flag
for supply-chain attestation. Authentication shall use npm OIDC
trusted publishing — static npm tokens shall not be used.

### RELEASE-9

The scoped `@sublang/playbook` package shall be published with
`--access public` to ensure public availability.

## Install closure

### RELEASE-12

The published `@sublang/playbook` package shall declare
`@sublang/cligent` and every adapter SDK wired by the bundled
production config (currently `@anthropic-ai/claude-agent-sdk`
and `@openai/codex-sdk`) as regular runtime `dependencies`, not
as optional or peer dependencies.

A global install of the package shall therefore yield a
self-contained closure: `@sublang/cligent` nests inside
`@sublang/playbook`'s module tree, and each adapter SDK resolves
from `@sublang/cligent`'s installed location.

### RELEASE-14

Where the published `@sublang/playbook` `package.json` declares
`@sublang/cligent` per [RELEASE-12](#release-12), the declared
version specifier shall be the `latest` dist-tag rather than a
single SemVer line, so any fresh install (no lockfile present)
resolves the cligent release currently tagged `latest` at install
time.

The repo-local `pnpm-lock.yaml` shall continue to pin a specific
resolved cligent version, so the CI install in
[RELEASE-7](#release-7) and contributor `pnpm install
--frozen-lockfile` runs stay reproducible until a developer
deliberately refreshes the pin.

## Public surfaces

### RELEASE-15

The published package shall expose `@sublang/playbook/runtime` as a
public, semver-stable subpath export backed by committed `.d.ts` and
`.js` artifacts listed in `files` and mapped under
`exports['./runtime']` (`types` and `default`).
That module shall carry only the runtime contract types
([PBRT-34](playbook-runtime.md#pbrt-34)) — no runtime engine and no
linker. A breaking change to its exported type names or shapes shall
be released under [RELEASE-1](#release-1) SemVer.

### RELEASE-16

The published package shall ship the authored compiler-phase specs
`slc/link.md`, `slc/gears2fsm.md`, and `slc/text2gears.md` as package
files and expose them through a public, semver-stable `exports['./slc/*']`
mapping (`'./slc/*': './slc/*'`).
A consumer shall be able to locate a spec by resolving
`@sublang/playbook/slc/<name>.md` via `import.meta.resolve` and reading
the resolved file from disk.
Removing or renaming a published `slc/*` path shall be released under
[RELEASE-1](#release-1) SemVer.

## Pre-release Checklist

### RELEASE-10

Before tagging a release, the developer/agent shall verify:

- [ ] All tests pass (`pnpm test` from the repo root).
- [ ] The compiled `.js` / `.d.ts` siblings are in sync with their
      `.ts` sources (the CI drift check from
      [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)).
- [ ] `CHANGELOG.md` is updated with the new version and date.
- [ ] `package.json` `version` is
      bumped and `private` is unset (or `false`).
- [ ] All changes are committed and pushed to `main`.

## References

[1]: https://semver.org/spec/v2.0.0.html "Semantic Versioning 2.0.0"
[2]: https://keepachangelog.com/en/1.1.0/ "Keep a Changelog 1.1.0"
