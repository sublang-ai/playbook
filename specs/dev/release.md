<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# RELEASE: Release Workflow

## Intent

This spec defines the release workflow for publishing the
`@sublang/playbook` package — the reference CODE playbook
runtime, compiled default Captain playbook, Playbook Captain shell, the generic `playbook` CLI,
the host-agnostic `@sublang/playbook/runtime` type contract, and the
shared `@sublang/playbook/xstate-runtime` engine plus authored `slc/*` specs,
all at the repo root —
to npm and tagging the corresponding GitHub release.
It also covers the public, semver-stable package surfaces
([RELEASE-15](#release-15), [RELEASE-16](#release-16),
[RELEASE-20](#release-20)).

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
3. Install with `pnpm install --frozen-lockfile`, run `pnpm build`, verify
   that the build changed no committed `.js` or `.d.ts` shipping artifact,
   and then run `pnpm test`.
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
version specifier shall be a caret SemVer range, not a moving
registry dist-tag such as `latest`.
The declared range shall admit cligent's tmux-play dynamic
visible-player surface used by the Playbook Captain shell, first
available in `@sublang/cligent` 0.13.0, and shall admit the explicit
`CallPlayerOptions.resume` surface required by
[CAPTAIN-26](playbook-captain.md#captain-26), the pre-close
`Captain.prepareDispose()` lifecycle used by
[CAPTAIN-16](playbook-captain.md#captain-16), and the isolated
`CallCaptainOptions.resume` and `CallCaptainOptions.allowedTools`
surface required by [CAPTAIN-31](playbook-captain.md#captain-31).

The repo-local `pnpm-lock.yaml` root importer shall use the same
specifier and continue to pin a specific resolved cligent version,
so the CI install in [RELEASE-7](#release-7) and contributor
`pnpm install --frozen-lockfile` runs stay reproducible until a
developer deliberately refreshes the pin within the declared range.
That pinned version shall itself expose explicit player resume,
the pre-close Captain lifecycle, and isolated fresh, tool-restricted
Captain calls, first released together in `@sublang/cligent` 0.15.0;
merely using a range that could admit a later compatible version shall
not satisfy this requirement.

### RELEASE-22

The published `@sublang/playbook` package shall declare
`@sublang/spex` as a regular runtime dependency with a caret SemVer
range, so the GEARS definition files cited by the shipped `slc/*`
specs ([RELEASE-16](#release-16)) —
`@sublang/spex/scaffold/specs/meta.md` (English) and
`@sublang/spex/scaffold/i18n/zh/specs/meta.md` (Chinese) — resolve
from the installed module tree of every production install.
The declared range's floor shall be at least `@sublang/spex` 0.3.0,
the first release whose scaffold ships both localizations.

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
The package shall additionally expose `@sublang/playbook/xstate-runtime` with
JavaScript and declaration artifacts for the shared XState snapshot,
quiescence, strict JSON, error-normalization, and nested-call bridge helpers
used by linked runtimes, and for the generic linked-runtime factory
`createXStatePlaybookRuntime` with its strategy defaults
([DR-019](../decisions/019-shared-linked-runtime-factory.md)) that
interprets a linked FSM under the `slc/link.md` contract.
This engine subpath shall depend one-way on the
type-only runtime contract and shall import no generated FSM or host adapter.
The `PlaybookSession`, player-resume, and trace shapes introduced by
[DR-010](../decisions/010-playbook-session-tracing-and-resume.md) are
such a breaking public-contract change.
The six-port contract's `CaptainResult`, `CaptainCallOptions`,
`PlaybookPorts.callCaptain`, and `captain.call.*` trace types introduced by
[DR-012](../decisions/012-default-captain-playbook.md) are part of the same
breaking 1.0 contract boundary.

### RELEASE-16

The published package shall ship the authored compiler-phase specs
`slc/link.md`, `slc/gears2fsm.md`, `slc/text2gears.md`, and
`slc/optimize.md` as package
files and expose them through a public, semver-stable `exports['./slc/*']`
mapping (`'./slc/*': './slc/*'`).
A consumer shall be able to locate a spec by resolving
`@sublang/playbook/slc/<name>.md` via `import.meta.resolve` and reading
the resolved file from disk.
Removing or renaming a published `slc/*` path shall be released under
[RELEASE-1](#release-1) SemVer.

### RELEASE-20

The published package shall expose the generic `playbook` executable
through `package.json` `bin` and each bundled playbook's registry
module — CODE and DISCUSS — through public
`exports['./code/registry']` and `exports['./discuss/registry']`
subpaths, all backed by files listed in `files`, as public,
semver-stable surfaces.
The package shall also ship `reference/sdlc/captain.md` and the default
Captain's GEARS, FSM, and linked-runtime TypeScript, JavaScript, and declaration
artifacts, and shall expose the compiled runtime through the public semver-stable
`exports['./captain/playbook']` subpath.
The package shall also ship the authored CODE and DISCUSS playbook sources
`reference/sdlc/code.md` and `reference/sdlc/discuss.md` as package files
beside their compiled artifacts, so a host can display or recompile the
bundled playbooks from source.
The internal Captain shall have no `exports['./captain/registry']` subpath
because it is not an enabled registry entry.
Removing or renaming the `playbook` bin or a
`@sublang/playbook/<id>/registry` or `@sublang/playbook/captain/playbook`
export shall be released under
[RELEASE-1](#release-1) SemVer.
The removal of the `playbook-code` bin, the
`@sublang/playbook/code/tmux-play` export, and the bundled legacy CODE
tmux-play configs are breaking public-surface changes under
[RELEASE-1](#release-1) and shall be recorded in the `Removed` section
of `CHANGELOG.md` per [RELEASE-4](#release-4) and
[RELEASE-5](#release-5).

## Pre-release Checklist

### RELEASE-24

Before tagging a release, the developer/agent shall run
`pnpm test:acceptance` locally. This live acceptance suite shall pack and
install the candidate package once and create isolated fresh git repositories.
It shall launch the installed `playbook` executable through real attached
tmux-play sessions and complete both `/code` and `/discuss` using the locally
authenticated real Claude and Codex adapters.
It shall also run the installed executable's non-interactive
`playbook run` path over a small fixture playbook that makes one real Claude
player call and one real Codex-Captain judge call, using `--json` and no
tmux-play session.

The suite shall fail unless `/code` implements and commits its fixture
requirement with a clean worktree, and `/discuss` adds and commits its fixture
spec item without implementing it, also with a clean worktree.
The non-interactive case shall fail unless it returns a terminal JSON envelope
with the expected verified player and judge results, leaves the fixture
repository and `HEAD` unchanged and clean, and creates no tmux session.
Missing local authentication or required executables shall be a clear failure,
not a skip.
Because these checks spend real model calls and require local credentials and
tmux, they shall remain excluded from `pnpm test` and GitHub CI and shall run
only as a local pre-release verification.
The suite shall not retry model calls automatically. One explicit rerun is
permitted only after the developer diagnoses a transient provider or network
failure; a lifecycle, tmux, package, or repository assertion failure blocks
the release until corrected.

### RELEASE-10

Before tagging a release, the developer/agent shall verify:

- [ ] All tests pass (`pnpm test` from the repo root).
- [ ] The local real-agent acceptance suite passes, covering both attached
      tmux workflows and non-interactive `playbook run`
      (`pnpm test:acceptance`; [RELEASE-24](#release-24)).
- [ ] If the release changes the interactive CLI presentation or layout, or
      changes the declared or locked `@sublang/cligent` version, the
      conditional manual tmux UX smoke passes
      ([RELEASE-26](../test/release.md#release-26)).
- [ ] The compiled `.js` / `.d.ts` siblings are in sync with their
      `.ts` sources (the CI drift check from
      [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)).
- [ ] `CHANGELOG.md` is updated with the new version and date.
- [ ] `package.json` `version` is
      bumped and `private` is unset (or `false`).
- [ ] All changes are committed and pushed to `main`.

## References

[1]: https://semver.org/spec/v2.0.0.html 'Semantic Versioning 2.0.0'
[2]: https://keepachangelog.com/en/1.1.0/ 'Keep a Changelog 1.1.0'
