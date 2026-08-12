<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# release: Release Workflow

## Intent

This project-local package specifies and verifies versioning, changelog, packaging, public surfaces, and release gates for `@sublang/playbook`.

## External Behavior

### Versioning

#### release-1

The project shall follow Semantic Versioning 2.0.0 [[1]]:
`MAJOR.MINOR.PATCH` where MAJOR indicates breaking changes, MINOR
indicates new features, and PATCH indicates bug fixes.

#### release-2

The `version` in `package.json` shall
match the git tag (without the `v` prefix). The release workflow
shall verify this match before publishing.

### Changelog

#### release-3

All notable changes shall be documented in `CHANGELOG.md` at the
repository root, following the Keep a Changelog format [[2]].

#### release-4

Before creating a release tag, the developer/agent shall:

1. Review all commits since the last release (`git log <last-tag>..HEAD`).
2. Ensure all notable changes are documented in `[Unreleased]`.
3. Select the next version under [[release-1](#release-1)] from those changes.
4. Add that version section to `CHANGELOG.md` with the release date.
5. Move items from `[Unreleased]` to the new version section.
6. Update the comparison links at the bottom of the file.

#### release-5

Changelog entries shall be grouped under these headings (in
order): `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
`Security`.

### Development dependency override

#### release-11

A local-development link of `@sublang/cligent` to a local
checkout shall be applied only by copying the tracked
`pnpm-workspace.yaml.example` to `pnpm-workspace.yaml`, which
overrides the registry version pinned in `pnpm-lock.yaml`.

That override is local-only: `pnpm-workspace.yaml` shall stay
git-ignored and the `pnpm-lock.yaml` mutation it induces shall
not be committed, so the override is absent from the published
package and from every production and CI install — the release
workflow drops it before install ([[release-7](#release-7)]).

### Release Process

#### release-6

Releases shall be triggered by pushing a git tag matching the
pattern `vMAJOR.MINOR.PATCH` (e.g., `v0.1.0`).

#### release-7

The release workflow on GitHub shall:

1. Verify the tag version matches the `version` field in
   `package.json`.
2. Drop the dev-only `pnpm-workspace.yaml` override before install
   so the build sees the registry-pinned `@sublang/cligent` rather
   than the contributor-machine local link (see
   [[release-11](#release-11)]).
3. Install with `pnpm install --frozen-lockfile`, run `pnpm build`, verify
   that the build changed no committed `.js` or `.d.ts` shipping artifact,
   and then run `pnpm test`.
4. Extract release notes for the tag version from the root
   `CHANGELOG.md` into a file (not a shell variable), so backticks
   and `$()` in the notes can't be interpreted as commands when the
   release is created.
5. Publish to npm with provenance attestation.
6. Create a GitHub Release with the extracted notes attached.

#### release-8

The npm package shall be published with the `--provenance` flag
for supply-chain attestation. Authentication shall use npm OIDC
trusted publishing — static npm tokens shall not be used.

#### release-9

The scoped `@sublang/playbook` package shall be published with
`--access public` to ensure public availability.

### Install closure

#### release-12

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
([DR-026](../decisions/026-optional-adapter-sdks.md) §3):

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
[[playbook-cli-39](playbook-cli.md#playbook-cli-39)].

#### release-14

Where the published `@sublang/playbook` `package.json` declares
`@sublang/cligent` per [[release-12](#release-12)], the declared
version specifier shall be a caret SemVer range, not a moving
registry dist-tag such as `latest`.
The declared range shall admit cligent's tmux-play dynamic
visible-player surface used by the Playbook Captain shell, first
available in `@sublang/cligent` 0.13.0, and shall admit the explicit
`CallPlayerOptions.resume` surface required by
[[playbook-captain-26](playbook-captain.md#playbook-captain-26)], the pre-close
`Captain.prepareDispose()` lifecycle used by
[[playbook-captain-16](playbook-captain.md#playbook-captain-16)], and the isolated
`CallCaptainOptions.resume` and `CallCaptainOptions.allowedTools`
surface required by [[playbook-captain-31](playbook-captain.md#playbook-captain-31)].

The repo-local `pnpm-lock.yaml` root importer shall use the same
specifier and continue to pin a specific resolved cligent version,
so the CI install in [[release-7](#release-7)] and contributor
`pnpm install --frozen-lockfile` runs stay reproducible until a
developer deliberately refreshes the pin within the declared range.
That pinned version shall itself expose explicit player resume,
the pre-close Captain lifecycle, and isolated fresh, tool-restricted
Captain calls, first released together in `@sublang/cligent` 0.15.0;
merely using a range that could admit a later compatible version shall
not satisfy this requirement.

#### release-22

The published `@sublang/playbook` package shall declare
`@sublang/spex` as a regular runtime dependency with a caret SemVer
range, so the GEARS definition files cited by the shipped `slc/*`
specs ([[release-16](#release-16)]) —
`@sublang/spex/scaffold/specs/meta.md` (English) and
`@sublang/spex/scaffold/i18n/zh/specs/meta.md` (Chinese) — resolve
from the installed module tree of every production install.
The declared range's floor shall be at least `@sublang/spex` 2.1.1,
the first release whose CLI validates the canonical package-only spec layout used by this repository.

### Public surfaces

#### release-15

The published package shall expose `@sublang/playbook/runtime` as a
public, semver-stable subpath export backed by committed `.d.ts` and
`.js` artifacts listed in `files` and mapped under
`exports['./runtime']` (`types` and `default`).
That module shall carry only the runtime contract types
([[playbook-runtime-34](playbook-runtime.md#playbook-runtime-34)]) — no runtime engine and no
linker. A breaking change to its exported type names or shapes shall
be released under [[release-1](#release-1)] SemVer.
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
[[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)]), and for the direct-Captain
adjudication prompt builder `defaultBuildCaptainJudgePrompt` that states the
judge reply contract shared with compiled Captain artifacts
([DR-025](../decisions/025-resilient-captain-control-adjudication.md),
[[captain-playbook-18](captain-playbook.md#captain-playbook-18)]).
This engine subpath shall depend one-way on the
type-only runtime contract and shall import no generated FSM or host adapter.
The `PlaybookSession`, player-resume, and trace shapes introduced by
[DR-010](../decisions/010-playbook-session-tracing-and-resume.md) are
such a breaking public-contract change.
The six-port contract's `CaptainResult`, `CaptainCallOptions`,
`PlaybookPorts.callCaptain`, and `captain.call.*` trace types introduced by
[DR-012](../decisions/012-default-captain-playbook.md) are part of the same
breaking 1.0 contract boundary.

#### release-16

The published package shall ship the authored compiler-phase specs
`slc/link.md`, `slc/gears2fsm.md`, `slc/text2gears.md`, and
`slc/optimize.md` as package
files and expose them through a public, semver-stable `exports['./slc/*']`
mapping (`'./slc/*': './slc/*'`).
A consumer shall be able to locate a spec by resolving
`@sublang/playbook/slc/<name>.md` via `import.meta.resolve` and reading
the resolved file from disk.
Removing or renaming a published `slc/*` path shall be released under
[[release-1](#release-1)] SemVer.

#### release-20

The published package shall expose the generic `playbook` executable through `package.json` `bin` and the CODE, REVIEW, and DECIDE playbook and registry modules through public `exports['./<id>/playbook']` and `exports['./<id>/registry']` subpaths, all backed by files listed in `files`, as public semver-stable surfaces.
The package shall also ship `reference/sdlc/captain.md` and the default
Captain's GEARS, FSM, and linked-runtime TypeScript, JavaScript, and declaration
artifacts, and shall expose the compiled runtime through the public semver-stable
`exports['./captain/playbook']` subpath.
The package shall also ship the authored CODE, REVIEW, and DECIDE sources `reference/sdlc/code.md`, `reference/sdlc/review.md`, and `reference/sdlc/decide.md` beside their compiled artifacts, so a host can display or recompile the bundled playbooks from source.
The package shall also ship the `docs/` guides the README delegates to, so
an installed copy resolves its own links to the version it shipped with
rather than to whatever the repository currently documents.
The internal Captain shall have no `exports['./captain/registry']` subpath
because it is not an enabled registry entry.
Removing or renaming the `playbook` bin or a
`@sublang/playbook/<id>/registry` or `@sublang/playbook/captain/playbook`
export shall be released under
[[release-1](#release-1)] SemVer.
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
[[release-1](#release-1)], whether or not an item, guide, or README names
that export — a `.d.ts` `export declare` is itself the declaration
SemVer 2.0.0 speaks of, `export interface` and `export type` are the
same declaration in the same file, and a consumer who imported the name
compiled and ran against it. Members reached only through an `_internal` export
are not part of that unit: the leading underscore declares them subject
to change, and they may be added, changed, or removed in any release.
Narrowing an existing public declaration so input that previously
typechecked no longer does — including adding a required property to an
options type — is likewise a breaking change under [[release-1](#release-1)].
The current unreleased replacement of DISCUSS and its public subpaths with REVIEW and DECIDE is a breaking public-surface change and shall be released in the same next major version under [[release-1](#release-1)].

### Pre-release Checklist

#### release-28

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
   ([[release-7](#release-7)]).
2. **Lean global shape.** Installing that tarball *alone* into a throwaway
   npm prefix nests `@sublang/cligent` inside the installed
   `@sublang/playbook` tree, leaves no `@anthropic-ai` or `@openai`
   directory anywhere in the installed closure, and reports every adapter
   **unavailable** when probed from `@sublang/cligent`'s own installed
   location ([[release-12](#release-12)],
   [[release-13](release.md#release-13)]).
3. **Opted-in global shape.** Installing that tarball plus each adapter SDK
   named as its own top-level install root reports every adapter
   **available** when probed from that same location
   ([DR-026](../decisions/026-optional-adapter-sdks.md) §3).
4. **Installed CLI.** The installed `playbook` executable prints its top-level and `run` usage, resolved config path, continuation and uncertain-recovery grammar, and for `--list` names the `code`, `review`, and `decide` entries of a config enabling the bundled registries ([[release-20](#release-20)]).
5. **Hermetic shared-Captain run.** A bare fixture repository with no `package.json`, lockfile, or `node_modules` at any level shall hold a configured thin registry importing `xstate` and `@sublang/playbook/xstate-runtime` whose work is a [DR-016](../decisions/016-script-actors-and-optimize-pass.md) script actor.
   Neither engine import shall resolve from the fixture before launch.
   A subprocess driver beside the globally installed candidate shall invoke the packed launcher's existing dependency-injection seam with a deterministic adapter, the shared config, and a `/command` Boss turn supplied on stdin, without replacing the compiled Captain or constructing tmux.
   The first process shall print one provisioning line, create exactly the two engine links resolving into the isolated prefix, and return exactly one `{sessionId, reply}` JSON object only after persisting the complete Captain session.
   A second process shall continue that same public session id from stdin with the stored Captain continuation and frozen working directory, shall not replay the completed fixture lifecycle, and shall provision nothing further.
   The fixture repository shall stay clean.
6. **Compiled runtime integrity.** The installed Captain, CODE, REVIEW, and DECIDE playbook subpaths import and construct runtimes carrying the declared contract surface.
7. **Compiled-artifact fidelity.** Every packed file other than the manifest is byte-identical to the repository's own, and the committed Captain, CODE, REVIEW, and DECIDE artifact-conformance suites pass with their source/GEARS/FSM, transition, prompt, and topology checks named among those that ran.
8. **Nested cligent floor.** The nested installed `@sublang/cligent`
   satisfies the caret range the packed manifest declares
   ([[release-14](#release-14)]), and carries the two surfaces the Playbook
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
not treat byte-for-byte reproduction as a release condition.
The deterministic source contract check shall establish only that each GEARS artifact preserves the maintained source fragments its parser recognizes as instruction blocks or explicit quoted relays, including their order and literal quote markers.
It shall not infer prose-only relay contracts, prove a result-field ownership declaration that is absent from GEARS, or establish semantic authorship for a bare quoted placeholder.
The linked ownership check shall establish agreement between GEARS-declared verbatim fields and the runtime's declared verbatim fields, while the artifact suites establish GEARS ↔ FSM ↔ runtime fidelity.
The byte-equality check is a transfer
argument and not a drift check either: `npm pack` copies the working tree,
so agreement between the committed sources and their built siblings stays
the CI sibling check of [[release-10](#release-10)].

Because the gate spends no model call and needs no local agent
authentication, it shall not be a substitute for
[[release-24](#release-24)], and shall run before it
([[release-10](#release-10)]) — a candidate that fails a packaging,
install-shape, provisioning, or artifact check is not worth the live
suite's real model calls.

#### release-24

Before tagging a release, the developer/agent shall run
`pnpm test:acceptance` locally. This live acceptance suite shall pack and
install the candidate package once and create isolated fresh git repositories.
It shall run the installed executable's headless shared-Captain path with real Claude and Codex adapters for bundled REVIEW and CODE, using stdin as well as argument input, exact `{sessionId, reply}` JSON output, and no tmux-play session.
The REVIEW case shall continue the same public session in a second process from stdin and shall prove that continuation reuses the durable Captain conversation without repeating REVIEW or its repository effects.
The CODE case shall complete its nested REVIEW call and shall report the ordered start, child-call, child-return, and finish lifecycle exactly once.
It shall retain one installed interactive `/decide` case through a real attached tmux-play session so the live gate still observes inherited same-role player panes and Boss/Captain focus while DECIDE completes nested REVIEW.
It shall additionally run the hermetic global-only case ([DR-024](../decisions/024-runtime-engine-provisioning.md) §7): install the packed candidate globally into an isolated npm prefix, enable a compiled thin fixture registry importing `xstate` and `@sublang/playbook/xstate-runtime` in the shared config of a fresh repository with no project-local packages anywhere, and invoke its slash command through the installed headless Captain.
The fixture shall mechanically reject a worker result that does not equal the repository token before it can enter its final state; the case shall assert automatic engine provisioning triggers exactly once, both runs return only `{sessionId, reply}`, each reply grounds the fixture's published terminal meaning that the exact token was returned and the request completed, and a repeated fresh run provisions nothing further.
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

The suite shall fail unless headless `/code` implements and commits its fixture requirement, reaches nested REVIEW approval, and leaves a clean worktree, and unless interactive `/decide` commits and reaches nested REVIEW approval for its fixture design without implementing that design, also with a clean worktree.
The headless REVIEW case shall fail unless both processes return the same public session id with one Captain reply each, the first reaches approval, the continuation repeats no lifecycle or repository effect, the fixture repository remains clean, and neither process creates a tmux session.
Missing local authentication or required executables shall be a clear failure,
not a skip.
Because these checks spend real model calls and require local credentials and
tmux, they shall remain excluded from `pnpm test` and GitHub CI and shall run
only as a local pre-release verification.
The suite shall not retry model calls automatically. One explicit rerun is
permitted only after the developer diagnoses a transient provider or network
failure; a lifecycle, tmux, package, or repository assertion failure blocks
the release until corrected.

#### release-10

Before tagging a release, the developer/agent shall verify, in this order:

- [ ] All tests pass (`pnpm test` from the repo root).
- [ ] The local model-free release smoke passes (`pnpm smoke:release`;
      [[release-28](#release-28)]).
- [ ] The local real-agent acceptance suite passes, covering headless REVIEW with process-crossing continuation, headless CODE with nested REVIEW, and attached DECIDE (`pnpm test:acceptance`; [[release-24](#release-24)]).
- [ ] If the release changes the interactive CLI presentation or layout, or
      changes the declared or locked `@sublang/cligent` version, the
      conditional manual tmux UX smoke passes
      ([[release-26](release.md#release-26)]).
- [ ] The compiled `.js` / `.d.ts` siblings are in sync with their
      `.ts` sources (the CI drift check from
      [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)).
- [ ] `CHANGELOG.md` is updated with the new version and date.
- [ ] `package.json` `version` is
      bumped and `private` is unset (or `false`).
- [ ] All changes are committed and pushed to `main`.

## Verification

### Install Closure Coverage

#### release-13


The smoke test shall install the publishable tarball (`npm pack`)
globally into a throwaway prefix in both documented shapes and
shall probe each adapter from `@sublang/cligent`'s installed
location — the module scope the adapter will itself import from at
run time — rather than from the prefix root or a project-local
install, either of which passes even when the SDK is unreachable
to cligent (verifying [[release-12](#release-12)]).

The smoke test shall fail unless, with **the tarball alone**:

- `@sublang/cligent` is nested inside the installed
  `@sublang/playbook` module tree;
- no `@anthropic-ai` or `@openai` directory exists anywhere in the
  installed closure; and
- every adapter reports **unavailable** when probed.

The smoke test shall further fail unless, with **the tarball plus
each adapter SDK named as its own top-level install root**, every
adapter reports **available** when probed from that same location.

The smoke test shall additionally cover **the ephemeral exec tree**
(`npm exec` / `npx`), probing from `@sublang/cligent`'s location
inside that tree — where npm hoists it flat rather than nesting it:

- with the tarball as the only package, every adapter shall report
  **unavailable**, because no install command reaches an exec tree;
- with the tarball plus each adapter SDK named as sibling packages
  of one exec invocation, every adapter shall report **available**;
- with the tarball plus only one SDK, the installed executable's own
  gate shall block and print a re-run naming **every** lineup SDK —
  the supplied one included — and no placeholder argument, because
  each distinct package set materializes a distinct tree and a
  missing-only re-run alternates between partial trees forever.

The lean shape pins the footprint contract; the opted-in shape
pins the resolution contract behind the documented install command;
the exec shapes pin the documented `npx` form.
A shape that hoists the SDK flat — an in-repository or
project-local install — satisfies both probes regardless and shall
not be substituted for any case.

#### release-19

The test suite shall fail unless `package.json` declares
`@sublang/cligent` with a caret SemVer range and — unless the
[[release-11](release.md#release-11)] local-development
override is active, which rewrites both the recorded specifier and
the resolution in the working copy — the root importer in
`pnpm-lock.yaml` records the same specifier and a concrete resolved
cligent version whose public tmux-play contract declares both the
pre-close `Captain.prepareDispose()` lifecycle and
`CallPlayerOptions.resume` selection accepted by
`CaptainContext.callPlayer`, plus `CallCaptainOptions.resume` and
`CallCaptainOptions.allowedTools` accepted by
`CaptainContext.callCaptain`.

The committed lockfile is never exempt, whatever the working copy
holds. Both sides of every comparison below shall be this package's own
committed state — the committed lockfile against the committed
manifest, never against the working copy, which is a pair no install
ever consumes and which lets an uncommitted edit mask a broken commit.
Where that committed pair is readable, the test suite shall fail
unless all of the following hold of it:

- its `overrides` block records every override the committed manifest
  declares and no others, at the declared value, or — for a `$`
  reference the resolver expands before writing — at any value;
- its `settings` block equals the values the verified frozen install
  runs against, and it carries no further configuration-derived
  top-level key unless the committed manifest declares the `pnpm`
  configuration that produced it;
- no declared override names a local path (`link:`, `file:`, or
  `portal:`), release-11 sanctioning only the git-ignored override
  file;
- the root importer's entries are exactly the manifest's declared
  dependencies, each recording the manifest's specifier — except where
  a declared override rewrites it, that being the resolver's own rule
  — and none resolving to a local path unless the manifest itself
  declares that dependency as one;
- every dependency the manifest declares as a local path names one
  that travels with the package: an archive beneath the package root,
  never a linked directory and never a path climbing out of it;
- `@sublang/cligent` satisfies [[release-14](release.md#release-14)]
  in the committed pair itself — a caret range in the committed
  manifest and a concrete resolved version in the committed importer —
  with no local-development exemption, that exemption belonging to a
  working copy mid-development and release-11 forbidding the state it
  exempts from ever reaching a commit;
- every committed resolution falls inside the caret range its own
  manifest entry declares, release-14 having the pin refreshed within
  that range, and an overridden dependency excepted as the override's
  to decide. Range membership follows SemVer, under which a prerelease
  falls inside a range only where that range carries a prerelease on
  the same version — so a stable caret admits none.

The last three clauses are what internal agreement alone cannot supply,
and they are the ones no install failure will report. A manifest and a
lockfile that both name a sibling checkout agree with each other
perfectly: the frozen install then *succeeds*, printing the linked
package at version `0.0.0` and leaving a dangling symlink behind, and
the packed tarball carries `link:` into the published manifest, where
it fails every consumer with `EUNSUPPORTEDPROTOCOL`. A resolution
outside its declared range is likewise no disagreement pnpm reports —
it trusts the recorded resolution, installs the forbidden version, and
exits `0`, leaving the surface the range was raised to require simply
absent. The damage lands past every gate that reports one.

Nothing here may be asserted by path or by spelling. The override path
is contributor-adjustable, so an assertion naming
`pnpm-workspace.yaml.example`'s default would pass a deeper or
absolute checkout that breaks the clean install identically, and a
specifier a contributor's `exclude-links-from-lockfile` erased from the
importer would leave no path to name at all. Equality against tracked
configuration is what stays faithful: it rejects local state whatever
its shape, and admits a legitimately declared override or vendored
local dependency, which is tracked rather than local. The resolution
is checked apart from the specifier because a lockfile may name the
declared range and still resolve it locally — a shape that installs a
dangling symlink with no error at all.

This enforces release-11's rule that the override's lockfile mutation
is never committed, since every production and CI install consumes the
committed lockfile frozen, after dropping the override. Most clauses
above correspond to a way that install aborts: a config snapshot with
no tracked backing — `overrides` or `settings` alike — raises
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`, and an importer disagreeing with
the manifest raises `ERR_PNPM_OUTDATED_LOCKFILE`. The two clauses
named above as exceptions abort nothing, which is precisely why they
are stated here rather than left to the install.

#### release-27


The test suite shall fail unless, for each adapter SDK wired by the
bundled production config, `package.json` lists it under
`devDependencies` and under none of `dependencies`,
`optionalDependencies`, `peerDependencies`, or `peerDependenciesMeta`.
Absence, not identity: cligent's own optional-peer declaration is the
single range npm checks, so a restated range here is a second copy
that can only drift — the earlier identity requirement froze at
cligent's old floor the first time cligent's moved — and its absence
is what keeps a cligent floor move from forcing a release of this
package ([DR-027](../decisions/027-runtime-compatibility-from-cligent.md)) (verifying [[release-12](#release-12)]).

#### release-23


The test suite shall fail unless `package.json` declares
`@sublang/spex` with a caret SemVer range whose floor is at least
2.1.1, the root importer in `pnpm-lock.yaml` records the same
specifier, and both `@sublang/spex/scaffold/specs/meta.md` and
`@sublang/spex/scaffold/i18n/zh/specs/meta.md` resolve from the repo
root to non-empty files, and the normal `pnpm test` gate runs `spex lint` before Vitest (verifying [[release-22](#release-22)]).

### Public Surface Coverage

#### release-17


The test suite shall fail unless each of
`@sublang/playbook/slc/link.md`, `@sublang/playbook/slc/gears2fsm.md`,
`@sublang/playbook/slc/text2gears.md`, and
`@sublang/playbook/slc/optimize.md` resolves via
`import.meta.resolve` to an existing file whose contents are readable (verifying [[release-16](#release-16)]).

#### release-18


The test suite shall fail unless `npm pack --dry-run` lists the `@sublang/playbook/runtime` and `@sublang/playbook/xstate-runtime` `.js` and `.d.ts` artifacts — including the `xstate-playbook-runtime` factory siblings backing the engine subpath — and all four `slc/*.md` files among the packed contents, plus the authored Captain, CODE, REVIEW, and DECIDE sources, every `docs/*.md` guide the README links to, each workflow's GEARS, FSM, and linked-runtime `.ts`, `.js`, and `.d.ts` artifacts, and the CODE, REVIEW, and DECIDE registry `.ts`, `.js`, and `.d.ts` artifacts under `reference/sdlc/<id>.playbook/`.
Generated verification support shall remain canonical repository content but need not be packed (verifying [[release-15](#release-15)], [[release-16](#release-16)], and [[release-20](#release-20)]).

#### release-21


The test suite shall fail unless `package.json` declares a `playbook`
bin and no `playbook-code` bin, declares
`exports['./runtime']` and `exports['./xstate-runtime']`, declares
the playbook and registry subpaths for CODE, REVIEW, and DECIDE,
declares `exports['./captain/playbook']`, declares neither
`exports['./captain/registry']` nor `exports['./code/tmux-play']`, and
`npm pack --dry-run` lists the `playbook` launcher entry and the
three workflow registry `.js` and `.d.ts` artifacts
among the packed contents.
The test suite shall additionally pin the semver-stable unit of each
public subpath rather than only the subpath entry: it shall fail unless
the top-level named and default exports of the JavaScript and
declaration files behind every public subpath are exactly the recorded
sets, so removing or renaming one goes red at the gate and is decided as
a [[release-1](release.md#release-1)] release event before the tag
rather than adjudicated after it.
Which subpaths those are shall be derived from `package.json`'s
`exports` map minus a recorded exclusion carrying its reason, and the
suite shall fail unless the recorded sets cover exactly that derivation.
An enumeration written here is the same defect one level up: it named
four subpaths while `exports['./xstate-runtime']` — public and
semver-stable by [[release-15](release.md#release-15)] — was
unpinned along with `exports['./code/playbook']`,
`exports['./playbook-captain']`, and other compiled-workflow subpaths,
and a fifth name added here would have left the sixth to the next
reviewer. Deriving it turns a subpath added to the manifest red until it
is recorded. `exports['./slc/*']` is the recorded exclusion: a wildcard
directory mapping to authored specs, not a module with an export set.
The JavaScript and declaration sets shall be recorded separately, since
one recorded set cannot describe both: a declaration file exports types
the JavaScript module has no key for, so a single set forces the
declaration check to see only value declarations and leaves every
exported interface, type alias, and type re-export unpinned — including
the entirety of a type-only subpath
([[release-20](release.md#release-20)]).
The declaration check shall be proven falsifiable in each of the forms
it must catch: the suite shall fail unless removing an exported
interface, an exported type alias, a name from an `export type { … }`
re-export list, and an exported declared value each changes the recorded
declaration set, so a check that silently stops seeing one of them turns
those rows red.
A wildcard re-export in a pinned declaration file shall leave nothing
unpinned, in the `export *` form and in the `export type *` form alike —
the latter being the one that matters in a declaration file, and the one
a rejection written for the former neither rejects nor enumerates, so a
type wildcard added an unbounded type surface with every row green. Where
the wildcard names a relative target inside the package the suite shall
resolve it and enumerate the re-exported names into that subpath's
recorded set, so growing one cannot enlarge a public surface silently;
where it names anything else the suite shall fail, that being the case no
enumeration can resolve. Both dispositions shall be proven for both
forms.
Members reached only through an `_internal` export shall not be pinned (verifying [[release-20](#release-20)]).

### Local release smoke

#### release-29

The local `pnpm smoke:release` entry point shall exist and shall run every
[[release-28](release.md#release-28)] step against one freshly packed
candidate, in one isolated temporary root, with no model call, no
credential, and no tmux session, while preserving the package and hermetic
execution contracts in [[release-12](#release-12)] and [[release-24](#release-24)].

It shall fail — preserving the temporary root and naming the failing step —
unless all of the following hold:

- the two global install shapes probe every adapter from
  `@sublang/cligent`'s own installed location, **unavailable** for the
  tarball alone and **available** with each SDK named as its own top-level
  install root, and the lean closure carries no `@anthropic-ai` or
  `@openai` directory at any depth;
- the installed executable answers top-level and `run` help with the fresh, continuation, and uncertain-recovery grammar, and `--list` names the CODE, REVIEW, and DECIDE registries;
- the hermetic fixture resolves neither engine import before launch, and a subprocess driver using the packed launcher's injected deterministic adapter drives its configured slash command through the compiled Captain with no tmux;
- the first process provisions the fixture exactly once into the isolated prefix and returns only `{sessionId, reply}` after durable hand-off, while a second process continues the same id from stdin with the stored Captain continuation and frozen working directory, repeats no fixture lifecycle, provisions nothing, and leaves the repository clean;
- the installed Captain, CODE, REVIEW, and DECIDE playbook subpaths construct, every packed file other than the manifest is byte-identical to the repository's own, the deterministic source-preservation check passes, and each compiled artifact's conformance suites pass with their declared coverage named among those that ran; and
- the nested installed `@sublang/cligent` satisfies the packed manifest's
  caret range and ships both `CaptainContext.emitReply` and
  `CaptainRunResult.resumeToken`, each proven as a member of its own named
  interface, reached through `@sublang/cligent/tmux-play` resolved from that
  nested copy, and usable at the type the shell uses it at.

The last clause is a standing guard, not a formality: the shell's durable
conversation calls both surfaces, a global install resolves cligent from
that nested copy alone, and a candidate whose declared range admits only
releases without them would install and then fail at the first Boss turn.

Because that clause is the whole of the gate's protection against an
incompatible dependency, the normal `pnpm test` suite shall fail unless the
check backing it is itself falsifiable: for each of the two members, a
fixture `@sublang/cligent` that declares the member's own interface without
it shall make the check fail and name that member, while a scan for the two
member names over that same fixture's declarations finds both — so a check
that ever drifts back to matching names rather than resolving members fails
these rows. The same rows shall cover a member kept under a shape the shell
cannot call and a package that stops exporting the specifier, and one row
shall run the check against the repository's own installed cligent, so the
declared floor is proven compatible without a pack or an install.

Nothing here shall be asserted by recompiling a playbook.
The SLC pipeline is agentic and its output is not reproducible byte-for-byte from the maintained source, so the gate shall instead run the deterministic source-preservation contract and the committed artifact suites before transferring their result to the packed candidate by byte equality.

Because it spends no model call and needs no authentication, this gate
shall be runnable by any maintainer with registry access, and shall not be
selected by the normal `pnpm test` configuration or by GitHub CI.

### Live pre-release acceptance

#### release-25


The opt-in local `pnpm test:acceptance` suite shall pack and install the candidate package once, then exercise five independent fresh git repositories through the installed npm `playbook` command shim.
The first case shall pipe `/review <request>` to installed `playbook run --json` over a prepared commit using the shared config and real Captain, Coder, and Reviewer agents.
It shall launch a second installed process selected by the first process's public session id, pipe one natural status question to that continuation, and fail unless both outputs are exact `{sessionId, reply}` objects carrying the same id, REVIEW's approval and repository effects occur exactly once, neither process creates tmux, and the worktree stays clean.
The second case shall invoke installed `playbook run --json "/code <task>"` with real Claude and Codex agents and shall fail unless the start, nested REVIEW call, nested REVIEW return, and finish lifecycle markers appear once in order on stderr, only the requested implementation changes, the approved result is present in `HEAD`, the worktree is clean, and no tmux process is created.
The third, independent `/decide` case shall remain attached to tmux-play and shall fail unless its start, nested REVIEW call/return, and finish markers appear, only the requested spec-design files change, the design is committed without implementation, and the worktree is clean.
The DECIDE case shall also fail unless the nested REVIEW leaf exposes DECIDE's inherited Coder and Reviewer with no replacement same-role session and with the Boss/Captain pane focused.
The fourth, hermetic global-only case shall install the packed candidate into an isolated npm global prefix with inherited npm prefix configuration neutralized, place a configured compiled thin fixture registry importing `xstate` and `@sublang/playbook/xstate-runtime` and making one real Claude player call under a real Codex Captain in a fresh git repository containing no `package.json`, lockfile, or `node_modules` at any level, and invoke the prefix's `playbook run --json` command by absolute path with `/hermetic <task>`.
It shall fail unless neither engine import resolves from the fixture before launch; the first process prints one provisioning line and creates exactly the `node_modules/xstate` and `node_modules/@sublang/playbook` links resolving into the isolated prefix; the fixture mechanically proves the player result equals the repository token before final completion; both processes return exact `{sessionId, reply}` objects whose replies ground the published terminal meaning that the exact token was returned and the request completed; a repeated fresh run creates nothing further and prints no provisioning line; and `@sublang/cligent` resolves from beneath the prefix's `@sublang/playbook` rather than from any machine-global copy (verifying [[release-24](#release-24)]).

The fifth, conversational case
([DR-029](../decisions/029-session-scoped-conversational-captain.md)) shall
drive one attached tmux-play session with a real Claude Captain and a
bundled deterministic fixture playbook whose middle step is a
[DR-016](../decisions/016-script-actors-and-optimize-pass.md) script actor
succeeding only when a flag file exists — the engineered failure, so no
agent is rigged and the Captain's judgment is the only live variable.
It shall fail unless, in one shell session and in this order:

- a natural-language chat turn is answered as Captain prose while no
  engagement starts;
- engaging the fixture with the flag file absent reaches the fixture's
  failure, and that turn's reply names the failed step while claiming no
  completion;
- after the flag file is created, the verbatim Boss turn
  `Retry and continue the iteration` drives that same engagement to its
  finished marker, with no second engagement started in its place;
- a natural status question is answered with no further lifecycle marker,
  leaving the engagement where it stood;
- after the flag file is removed and the fixture is engaged to its failure
  a second time, a switch requested in ordinary prose — carrying no slash
  command — emits the fixture's stopped marker and then the target
  playbook's started marker, in that order; and
- a dismissal requested in ordinary prose ends the engagement.

It shall further fail unless, across the whole session, the literal
`Saved you 0` never appears on the Boss surface, no turn-failure marker
appears beyond the two engineered script failures, and the fixture
repository is left clean with no ignored or untracked artifacts. The
deterministic `/decide <task>` command mapping is not this case's subject
and stays in the hermetic tier; what this case exercises is the
model-decided switch against a still-active engagement.

The acceptance suite shall require local adapter authentication, tmux, glow,
Expect, git, and npm. It shall not be selected by the normal `pnpm test`
configuration or by GitHub CI.
It shall stop after the first failed scenario rather than spend more model
calls, preserve the failed scenario artifacts, and report a bounded
terminal-control-stripped diagnostic snapshot outside the fixture repository.

### Conditional manual tmux UX smoke

#### release-26

When a release changes the interactive CLI presentation or layout, or changes
the declared or locked `@sublang/cligent` version, a developer shall manually
launch the packed candidate's installed `playbook` command in a fresh
repository and verify:

- pane content, titles, colors, borders, and proportions are readable at the
  normal terminal size;
- narrowing, widening, and vertically resizing the terminal preserve usable
  wrapping and do not collapse or overlap the Boss pane;
- keyboard entry, pane switching, scrolling, selection, and copy behave
  naturally with both keyboard and mouse; and
- Ctrl-C exits cleanly, restores the parent terminal, and leaves no tmux-play
  session behind.

This human presentation check is conditional under [[release-10](#release-10)] and does not replace
[[release-25](#release-25)]; the real-model functional workflows shall not be
repeated manually — interactively or through `playbook run` — merely to
duplicate the automatic gate.

### Hosted release workflow

#### release-30

Where a release candidate carries a versioned changelog and package manifest, when the hosted release-workflow verification runs, it shall fail unless:

- the workflow triggers only for `vMAJOR.MINOR.PATCH` tags and rejects a tag that does not equal the manifest version [[release-2](#release-2)] and [[release-6](#release-6)];
- the changelog follows Keep a Changelog, contains the tagged version's dated notes, and uses the required heading order [[release-3](#release-3)], [[release-4](#release-4)], and [[release-5](#release-5)];
- the workflow performs the ordered frozen install, build, compiled-sibling check, test, release-note extraction, publish, and GitHub Release steps [[release-7](#release-7)]; and
- publishing uses OIDC trusted publishing with provenance and public access, with no static npm token [[release-8](#release-8)] and [[release-9](#release-9)].

## References

[1]: https://semver.org/spec/v2.0.0.html 'Semantic Versioning 2.0.0'
[2]: https://keepachangelog.com/en/1.1.0/ 'Keep a Changelog 1.1.0'
