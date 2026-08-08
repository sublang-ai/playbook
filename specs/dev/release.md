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
`@sublang/cligent` as a regular runtime dependency, not as an
optional or peer dependency, so that a global install nests it
inside `@sublang/playbook`'s own module tree.

The package shall declare no agent SDK among `dependencies`,
`optionalDependencies`, `peerDependencies`, or `peerDependenciesMeta`
([DR-026](../decisions/026-optional-adapter-sdks.md),
[DR-027](../decisions/027-runtime-compatibility-from-cligent.md)).
cligent is the only package that imports the SDKs, and its own
optional-peer declaration is the single range npm checks; a second
identical copy here adds no acceptance and one more declaration to
drift — the mirror froze at cligent's old floor the first time
cligent's moved — while a non-identical copy either rejects versions
the loader accepts or admits versions it would warn on.
Both SDKs shall additionally be `devDependencies`, so this
repository's own test, CI, and local acceptance runs exercise real
adapters.

An installed adapter SDK therefore resolves from
`@sublang/cligent`'s installed location whenever it sits on the
directory-ancestor walk from that location — as a top-level
install root does, and as a package hoisted flat in a project
`node_modules` does. An SDK nested inside a *sibling* install
root's own subtree does not, which is why the documented global
install shall name each wanted SDK alongside the package
([DR-026 §3](../decisions/026-optional-adapter-sdks.md#3-a-supplied-sdk-must-be-a-top-level-install-root)):

```sh
npm install -g @sublang/playbook @anthropic-ai/claude-agent-sdk @openai/codex-sdk
```

A user configuring a single vendor shall be able to install that
vendor's SDK alone and pay only that stack's footprint.
The documented ephemeral form shall likewise name each wanted SDK as a
sibling package of the same invocation —
`npx -y -p @sublang/playbook -p <sdk> playbook` — because npm's exec
tree is reached by no install command at all: a global SDK install is
not on that tree's directory-ancestor walk.
The absence of a wanted SDK shall never surface as a mid-turn
adapter failure; it is gated ahead of any agent call by
[PBCLI-39](playbook-cli.md#pbcli-39).

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
used by linked runtimes, for the generic linked-runtime factory
`createXStatePlaybookRuntime` with its strategy defaults
([DR-019](../decisions/019-shared-linked-runtime-factory.md)) that
interprets a linked FSM under the `slc/link.md` contract, and for the
engine's compatibility self-report `RUNTIME_ABI` and
`SUPPORTED_ARTIFACT_SCHEMAS` checked at factory construction
([DR-022](../decisions/022-runtime-compatibility-contract.md),
[PBRT-50](playbook-runtime.md#pbrt-50)), and for the direct-Captain
adjudication prompt builder `defaultBuildCaptainJudgePrompt` that states the
judge reply contract shared with compiled Captain artifacts
([DR-025](../decisions/025-resilient-captain-control-adjudication.md),
[CAPPLAY-18](captain-playbook.md#capplay-18)).
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
The package shall also ship the `docs/` guides the README delegates to, so
an installed copy resolves its own links to the version it shipped with
rather than to whatever the repository currently documents.
The internal Captain shall have no `exports['./captain/registry']` subpath
because it is not an enabled registry entry.
Removing or renaming the `playbook` bin or a
`@sublang/playbook/<id>/registry` or `@sublang/playbook/captain/playbook`
export shall be released under
[RELEASE-1](#release-1) SemVer.
The semver-stable unit of such a subpath is the module's declared public
API: the subpath entry itself and every top-level named and default
export of the JavaScript and declaration files it resolves to.
Those are two sets and not one. A declaration file's exports include the
forms the JavaScript has no counterpart for — exported interfaces, type
aliases, and `export type { … }` re-export lists — and those are the
whole public API of a type-only subpath such as `./runtime`, as well as
the types a consumer must implement to use a value export at all, the
port type of a runtime's own options among them.
Removing or renaming any export of either set is a breaking change under
[RELEASE-1](#release-1), whether or not an item, guide, or README names
that export — a `.d.ts` `export declare` is itself the declaration
SemVer 2.0.0 speaks of, `export interface` and `export type` are the
same declaration in the same file, and a consumer who imported the name
compiled and ran against it. Members reached only through an `_internal` export
are not part of that unit: the leading underscore declares them subject
to change, and they may be added, changed, or removed in any release.
The current unreleased Captain rewrite removes the public
`composeCaptainPrompt` and `composePlayerPrompt` named exports.
That removal stands, so the next release shall be 5.0.0; the package
version and changelog section shall change at tag preparation under
[RELEASE-2](#release-2) and [RELEASE-4](#release-4), not before.
The removal of the `playbook-code` bin, the
`@sublang/playbook/code/tmux-play` export, and the bundled legacy CODE
tmux-play configs are breaking public-surface changes under
[RELEASE-1](#release-1) and shall be recorded in the `Removed` section
of `CHANGELOG.md` per [RELEASE-4](#release-4) and
[RELEASE-5](#release-5).

## Pre-release Checklist

### RELEASE-28

Before tagging a release, the developer/agent shall run the local
`pnpm smoke:release` gate. It shall spend no model call, read no
credential, and create no tmux session, so it is reproducible on any
maintainer machine; it shall require network access to the npm registry,
because two of its steps install from it.

The gate shall work inside one isolated temporary root, shall stop at the
first failing step rather than continue against a candidate already known
bad, and shall preserve that root when it fails. It shall fail unless every
step below holds of the packed candidate:

1. **Pack.** `npm pack` produces the tarball `npm publish` would upload
   ([RELEASE-7](#release-7)).
2. **Lean global shape.** Installing that tarball *alone* into a throwaway
   npm prefix nests `@sublang/cligent` inside the installed
   `@sublang/playbook` tree, leaves no `@anthropic-ai` or `@openai`
   directory anywhere in the installed closure, and reports every adapter
   **unavailable** when probed from `@sublang/cligent`'s own installed
   location ([RELEASE-12](#release-12),
   [RELEASE-13](../test/release.md#release-13)).
3. **Opted-in global shape.** Installing that tarball plus each adapter SDK
   named as its own top-level install root reports every adapter
   **available** when probed from that same location
   ([DR-026 §3](../decisions/026-optional-adapter-sdks.md#3-a-supplied-sdk-must-be-a-top-level-install-root)).
4. **Installed CLI.** The installed `playbook` executable prints its usage
   and resolved config path for `--help`, and for `--list` names both the
   `code` and the `discuss` entry of a config enabling the two bundled
   registries ([RELEASE-20](#release-20)).
5. **Hermetic provisioning.** The deterministic variant of the
   [DR-024 §7](../decisions/024-runtime-engine-provisioning.md#7-the-acceptance-gate-moves-here)
   case: a bare fixture repository with no `package.json`, lockfile, or
   `node_modules` at any level, holding a thin artifact that imports
   `xstate` and `@sublang/playbook/xstate-runtime` and whose single working
   state is a [DR-016](../decisions/016-script-actors-and-optimize-pass.md)
   script actor, so the run needs no agent and no key. Neither engine
   import resolves from the fixture before the run; the run prints one
   provisioning line, creates exactly the two engine links and both resolve
   into the isolated prefix, and returns its terminal JSON envelope; a
   second run provisions nothing further; the fixture repository stays
   clean.
6. **Captain artifact integrity.** The installed
   `@sublang/playbook/captain/playbook` subpath imports and constructs a
   runtime carrying the full contract surface, and every packed
   `reference/sdlc/captain.playbook/` artifact — the compiled
   `captain.gears.md` among them — is byte-identical to the repository's
   own.
7. **Compiled-artifact fidelity.** That byte-equality extends to every
   packed file the manifest is not, and the committed artifact-conformance
   suites (`pnpm vitest run reference/sdlc/captain.playbook`) pass with the
   GEARS ↔ FSM conformance, declared-transition coverage, and pinned
   topology suites each named among those that ran, so a suite renamed,
   moved, or deleted fails the gate instead of quietly shrinking it.
8. **Nested cligent floor.** The nested installed `@sublang/cligent`
   satisfies the caret range the packed manifest declares
   ([RELEASE-14](#release-14)), and carries the two surfaces the Playbook
   Captain shell's durable conversation depends on:
   `CaptainContext.emitReply` and `CaptainRunResult.resumeToken`
   ([DR-029](../decisions/029-session-scoped-conversational-captain.md)).
   Each shall be proven as a member of its own named interface, reached
   through the same public specifier the shell imports
   (`@sublang/cligent/tmux-play`) resolved from that nested copy, and usable
   at the type the shell uses it at — an awaited `emitReply(text)` and a
   string-valued `resumeToken`. The occurrence of either name elsewhere in
   the installed declarations shall not discharge this step: each also occurs
   away from the interface it must be proven on — on unrelated declarations,
   and inside doc comments — so a check that searches the shipped text cannot
   fail for the regression this step exists to catch, and a check that reads
   one declaration file by path cannot see the `exports` entry the shell
   resolves through.
   A candidate whose declared range admits only published cligent releases
   without both surfaces shall fail here rather than at a Boss turn.

Step 7 shall claim no more than it proves. The SLC pipeline is agentic, so
this gate shall not attempt to re-derive the compiled artifacts and shall
not treat their reproduction as a release condition; the conformance chain
it reruns is rooted at the compiled `captain.gears.md`, not at the
maintained `reference/sdlc/captain.md`, so it establishes GEARS ↔ FSM ↔
runtime fidelity only, and the byte-equality of step 6 is what carries that
verdict from the repository tree onto the tarball. Agreement between the
maintained source and the compiled GEARS is established by the text2gears
pass alone and is asserted nowhere here. That byte-equality is a transfer
argument and not a drift check either: `npm pack` copies the working tree,
so agreement between the committed sources and their built siblings stays
the CI sibling check of [RELEASE-10](#release-10).

Because the gate spends no model call and needs no local agent
authentication, it shall not be a substitute for
[RELEASE-24](#release-24), and shall run before it
([RELEASE-10](#release-10)) — a candidate that fails a packaging,
install-shape, provisioning, or artifact check is not worth the live
suite's real model calls.

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
It shall additionally run the hermetic global-only case
([DR-024 §7](../decisions/024-runtime-engine-provisioning.md#7-the-acceptance-gate-moves-here)):
install the packed candidate globally into an isolated npm prefix and
drive a compiled thin fixture artifact — one importing `xstate` and
`@sublang/playbook/xstate-runtime` — from a fresh repository with no
project-local packages anywhere, asserting automatic engine
provisioning triggers, the run reaches its terminal JSON outcome, and a
repeated run provisions nothing further.
Documentation shall drop the project-local install and `npx`
consumption story only after this case passes.

It shall additionally drive one conversational session against a real
Claude Captain through an attached tmux-play session
([DR-029](../decisions/029-session-scoped-conversational-captain.md)).
Every machine outcome in that session shall come from a deterministic
[DR-016](../decisions/016-script-actors-and-optimize-pass.md) script-actor
fixture playbook whose failure is engineered by an absent flag file, never
from a rigged agent, so the only live variable is the Captain's own
judgment. The session shall carry, in one shell session on one durable
conversation: a natural chat turn that engages nothing; an engagement
driven to a deterministic failure whose reply names the failed step and
claims no completion; the verbatim `Retry and continue the iteration`
recovery, which shall reach the finished marker after the flag file is
placed; a natural status question that moves no state; a second
deterministic failure, and then a switch requested in ordinary prose —
no slash command — against that still-active engagement, which shall
dismiss it and start the named target in that order; and a dismissal.
It shall fail unless the literal `Saved you 0` appears nowhere in the
whole session, no turn-failure marker appears beyond the two engineered
script failures, and the fixture repository is left clean.

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

Before tagging a release, the developer/agent shall verify, in this order:

- [ ] All tests pass (`pnpm test` from the repo root).
- [ ] The local model-free release smoke passes (`pnpm smoke:release`;
      [RELEASE-28](#release-28)).
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
