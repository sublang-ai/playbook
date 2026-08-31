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

### Normal test gate

#### release-31

When the normal repository test gate runs through `pnpm test`, its effective pnpm lifecycle shall execute the project-local `spex lint` command to successful completion before starting Vitest.

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
The declared range's floor shall be at least `@sublang/cligent` 0.23.0 and shall preserve `[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*` player ids while player and Captain call options carry atomic complete per-call model, effort, instruction, and permissions with explicit concrete-value versus provider-default tuning ([[playbook-cli-4](playbook-cli.md#playbook-cli-4)], [[playbook-captain-10](playbook-captain.md#playbook-captain-10)], [[playbook-captain-31](playbook-captain.md#playbook-captain-31)]).
That floor shall preserve adjacent complete `text` messages as distinct newline-separated messages in player `finalText` when a successful terminal `done` event supplies no result.
That floor shall also expose the typed complete-settings rejection used to preserve a prior continuation without a fresh fallback.
The declared floor shall accept an empty configured player roster, resolve it to an empty startup-visible set and Boss-only one-column layout, and initialize the runtime Captain with an empty player manifest while accepting empty visibility, so an all-roleless Playbook catalog remains roleless ([[playbook-cli-9](playbook-cli.md#playbook-cli-9)], [[playbook-cli-10](playbook-cli.md#playbook-cli-10)]).
The declared floor shall expose both the stock tmux-play child-launch surface used by the raw and diagnostic forms of [[playbook-cli-1](playbook-cli.md#playbook-cli-1)] and the public runtime values `launchManagedTmuxPlay` and `runManagedTmuxPlaySession` with their exact `LaunchManagedTmuxPlayOptions` to `Promise<PreparedManagedTmuxPlayLaunch>` and `ManagedTmuxPlaySessionOptions` to `Promise<void>` call signatures, providing the managed prepared-launch, gated-input, terminal-record, buffered-reply, activation-abort, synchronous native-client hand-off, cancellation, and failure-atomic shutdown surfaces used by [[playbook-cli-49](playbook-cli.md#playbook-cli-49)].
The managed launch context and direct session options shall each expose a required exact boolean work-directory cleanup authority that the caller can carry unchanged across its private child boundary, so a marker can corroborate launcher ownership but can never grant cleanup authority by itself ([[playbook-cli-49](playbook-cli.md#playbook-cli-49)]).
The Playbook candidate shall not release until the npm registry serves the pinned cligent version, its registry artifact matches the prepared candidate's exact integrity, and an override-free `pnpm install --frozen-lockfile` proves the installed public contract; a local pack or link alone shall not satisfy this ordering gate.

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
Since the DR-032 release and the complete-message transport repair, the pin shall be at least 0.23.0 and shall expose the segmented-id grammar, empty-roster host shape, atomic complete per-call settings, typed settings rejection, reliable attached-client resizing, and result-less terminal fallback above.

#### release-22

The published `@sublang/playbook` package shall declare
`@sublang/spex` as a regular runtime dependency with a caret SemVer
range, so the GEARS definition files cited by the shipped `slc/*`
specs ([[release-16](#release-16)]) —
`@sublang/spex/scaffold/specs/meta.md` (English) and
`@sublang/spex/scaffold/i18n/zh/specs/meta.md` (Chinese) — resolve
from the installed module tree of every production install.
The declared range's floor shall be at least `@sublang/spex` 3.0.0,
whose refreshed record and citation law this repository adopts while retaining the canonical package-only spec layout validated since 2.1.1.

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
Its closed `PlaybookRunResult` declaration shall include the exact state-only `{ outcome: 'unresolved-effect', state: PlaybookState }` arm of [[playbook-runtime-79](playbook-runtime.md#playbook-runtime-79)] and shall expose no bounded effect evidence on that runtime-owned result.
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
The public XState engine shall keep `RUNTIME_ABI` at `1`, export the frozen `SUPPORTED_ARTIFACT_SCHEMAS` value `[3]`, and export only the schema-3 authority, repository-disposition, governed-outcome, authority-specification, construction-input, factory-option, and specification declaration types governed by [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)].
The public Playbook Captain declaration surface shall expose only the schema-3 registry-entry shape and its live host-construction-capability type under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)].
The packed CODE, REVIEW, DECIDE, and session-Captain TypeScript artifacts and committed JavaScript siblings shall declare or enforce artifact schema `3` under [[playbook-1](playbook.md#playbook-1)] and [[captain-playbook-8](captain-playbook.md#captain-playbook-8)]; the three workflow registries and their declaration siblings shall expose that exact schema, each runtime declaration shall retain its schema-3 construction surface where public, and no sibling shall expose a legacy schema-2 variant.
That Captain declaration surface shall additionally expose `PlaybookCaptainUnresolvedEffect`, the pure `assertPlaybookCaptainUnresolvedEffects` validator, and `PlaybookCaptainSettlement` with a required read-only `unresolvedEffects` list of that exact bounded entry type under [[playbook-captain-58](playbook-captain.md#playbook-captain-58)], while the runtime declaration shall keep `PlaybookRunResult` free of the list.
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
Every Markdown file the tarball ships shall be link-closed over the packed file list: each relative link target and each link-reference-definition destination in a packed `.md` shall resolve to a packed file or a directory containing packed files, and a fragment on a packed Markdown target shall name an anchor that file renders.
A packed Markdown file citing repository-only content shall cite it by absolute repository URL referencing the repository's main line — a deliberate living pointer, since the version-locality guarantee above governs packed content, while a reader needing the shipped-version text of a repository-only document reads the repository at the shipped release tag. Such a pointer shall use GitHub's `blob/main` form only for an existing file and its `tree/main` form only for an existing directory; the path kind is part of the resolved destination, not an interchangeable URL style.
A packed SLC definition's relative citation into `specs/` is exempt from the closure as a repository citation under the specs tree's own citation law, which requires the relative form.
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

#### release-33

The published package shall expose `@sublang/playbook/session-store` as a
public, semver-stable subpath export backed by committed `.d.ts` and
`.js` artifacts listed in `files` and mapped under
`exports['./session-store']` (`types` and `default`), as the one shared
home for playbook sessions that an external host reads and writes
([DR-042](../decisions/042-shared-session-store-and-replay-stream.md)).
That module shall expose only the narrow store facade — the default
sessions directory, the store opener, the records-stream version
constant, session listing and reading, lease-free stream reading, lease
acquisition, and the lease's append, stream read, status, and release
([[playbook-cli-73](playbook-cli.md#playbook-cli-73)]) — while the store
module behind it, its validators, staging, retirement, and turn-lifecycle
operations shall remain unexported.
A breaking change to that subpath's exported names or shapes, and any
change to the frozen replay-stream file contract it reads and writes
([[playbook-cli-74](playbook-cli.md#playbook-cli-74)]), shall be released
under [[release-1](#release-1)] SemVer, because a dependent host pins its
floor to the release that ships them.

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
5. **Hermetic shared-Captain and player-ledger run.** A bare fixture repository with no `package.json`, lockfile, or `node_modules` at any level shall hold one configured thin registry importing `xstate` and `@sublang/playbook/xstate-runtime` whose work is a [DR-016](../decisions/016-script-actors-and-optimize-pass.md) script actor and one explicit-role registry whose two sequential roles share one segmented player id while a third role binds an equal-configured distinct segmented id ([[playbook-captain-26](playbook-captain.md#playbook-captain-26)], [[playbook-cli-4](playbook-cli.md#playbook-cli-4)]).
   Neither engine import shall resolve from the fixture before launch.
   A subprocess driver beside the globally installed candidate shall invoke the packed launcher's existing dependency-injection seam with a deterministic adapter, the shared config, and a `/command` Boss turn supplied on stdin, without replacing the compiled Captain or constructing tmux.
   The first process shall print one provisioning line, create exactly the two engine links resolving into the isolated prefix, and return exactly one `{sessionId, reply}` JSON object only after persisting the complete Captain session.
   A second process shall continue that same public session id from stdin with the stored Captain continuation and frozen working directory, shall not replay the completed fixture lifecycle, and shall provision nothing further.
   A third process shall run the explicit-role registry with the shared roles ordered first-to-second, and a fourth process shall select the same id under compatible current Captain, player, and role tuning and run those roles second-to-first.
   The four-process trace and complete schema-6 record shall prove one shared token chain across both role orders, one independent token chain for the equal-configured distinct player id, an empty retained-generation map after clean completion ([[playbook-cli-51](playbook-cli.md#playbook-cli-51)]), retained structural identity and working directory, current model and effort application to prior tokens, and explicit provider-default selections ([[playbook-cli-23](playbook-cli.md#playbook-cli-23)]).
   A third configured thin registry, whose script actor fails until a flag file outside the repository exists, shall park its engagement in the recoverable failure state in one process; after the flag is created, a further process holding only that record shall be offered the retry in its own decision digest, shall select it by the exact advertised id, and shall apply it once and finish the engagement ([[playbook-runtime-52](playbook-runtime.md#playbook-runtime-52)], [DR-034](../decisions/034-durable-failure-retry-continuity.md)).
   The fixture repository shall stay clean.
6. **Packed effect-reconciliation matrix.** A fresh Git repository shall configure one schema-3 governed-player fixture through the packed launcher, shared Captain, CLI host, and nested installed Cligent dependency under [DR-040](../decisions/040-outcome-authority-effect-reconciliation.md).
   One process shall create exactly one clean descendant commit while its Codex-shaped player emits separate commentary and misleading `Commit:` text messages followed by successful terminal `done` with no result; an exact hidden semantic candidate and the durable receipt's commit OID shall settle the accepted outcome without deriving repository authority from that prose ([[playbook-runtime-77](playbook-runtime.md#playbook-runtime-77)]).
   A second process shall create one further clean descendant commit but return two malformed hidden-judge replies, thereby spending the single correction budget and parking one bounded unresolved-effect entry with the exact baseline HEAD, after HEAD, and proven commit OID ([[playbook-captain-58](playbook-captain.md#playbook-captain-58)]).
   Two successor processes selecting the exact advertised reconciliation and abandonment controls shall start no player or judge and make no repository change; reconciliation shall preserve the parked evidence, while abandonment shall preserve the same final settlement evidence, leave the root absent from retained generations, and return the session to chat ([[playbook-runtime-79](playbook-runtime.md#playbook-runtime-79)], [[playbook-captain-56](playbook-captain.md#playbook-captain-56)], [[playbook-captain-58](playbook-captain.md#playbook-captain-58)]).
7. **Compiled runtime integrity.** The installed Captain, CODE, REVIEW, and DECIDE playbook subpaths import and construct runtimes carrying the declared contract surface; Captain, CODE, and REVIEW expose retained-snapshot adoption while bespoke DECIDE omits it ([[playbook-runtime-61](playbook-runtime.md#playbook-runtime-61)]).
8. **Compiled-artifact fidelity.** Every packed file other than the manifest is byte-identical to the repository's own, and the committed Captain, CODE, REVIEW, and DECIDE artifact-conformance suites pass with their source/GEARS/FSM, transition, prompt, and topology checks named among those that ran.
9. **Nested cligent floor.** The nested installed `@sublang/cligent` shall satisfy the caret range the packed manifest declares and expose the complete enumerated release-floor capability set through `@sublang/cligent/tmux-play` resolved from that nested copy ([[release-14](#release-14)]).
   The guard shall prove the runtime presence and exact call signatures of `launchManagedTmuxPlay` and `runManagedTmuxPlaySession`, plus the exact usable type and optionality of `CaptainContext.emitReply`, `CaptainRunResult.resumeToken`, `Captain.prepareDispose`, the player and Captain call-option parameters, each continuation and complete-setting option, every complete setting and tuning selection, the typed settings rejection and predicate, the required work-directory cleanup-authority member on both managed launch context and direct session options, both managed attach activation members, and the prepared attach parameter.
   It shall additionally pass a segmented player id such as `dev.coder` through the real public config loader unchanged.
   It shall pass an empty roster through that loader into the empty startup-visible Boss-only layout and initialize the real public runtime core with an empty Captain player manifest and accepted empty visibility.
   Through that installed runtime, a deterministic Codex-shaped adapter shall emit one complete commentary `text` message, one complete final-response `text` message, and a successful terminal `done` event with no result, and the player result shall preserve exactly one newline between the two messages and exactly one final-response line.
   Every interface-member proof shall resolve the owning public type rather than search declarations by spelling, because an unrelated member or documentation reference can retain the same spelling after the required interface loses or narrows it.
   A candidate whose declared range admits only published cligent releases without any one of these capabilities shall fail here rather than at a Boss turn or attachment.
10. **Packed session-store consumer.** An external package declaring only `@sublang/playbook` shall install the candidate tarball into a throwaway prefix and type-check against the packed `@sublang/playbook/session-store` declaration, then through that facade alone open a store on a temporary directory, list and read a session record the installed CLI wrote, acquire and release its lease, and append and read back replay-stream entries ([[release-33](#release-33)], [[playbook-cli-73](playbook-cli.md#playbook-cli-73)]).
   The read-back shall satisfy the frozen envelope, sequence, and readable-prefix contract and carry no resume token, and a record below the current schema shall be rejected rather than migrated, so the external consumer is proven to apply the CLI's own validation ([[playbook-cli-74](playbook-cli.md#playbook-cli-74)], [[playbook-cli-75](playbook-cli.md#playbook-cli-75)]).

Step 8 shall claim no more than it proves. The SLC pipeline is agentic, so
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
The REVIEW case shall create the public session headlessly from stdin, retire that writer, and select the same public id through a second managed interactive process whose natural status question proves that the durable Captain and player conversations survive the front-end hand-off without repeating REVIEW or its repository effects ([[playbook-cli-23](playbook-cli.md#playbook-cli-23)], [[playbook-cli-49](playbook-cli.md#playbook-cli-49)]).
The CODE case shall complete its nested REVIEW call and shall report the ordered start, child-call, child-return, and finish lifecycle exactly once.
It shall retain one installed interactive `/decide` case through a real attached tmux-play session so the live gate observes panes for DECIDE's explicitly bound players under [[playbook-captain-22](playbook-captain.md#playbook-captain-22)] and Boss/Captain focus while DECIDE completes nested REVIEW through the same player ids explicitly shared by both role maps under [[playbook-captain-29](playbook-captain.md#playbook-captain-29)].
After the attached DECIDE turn settles and its pane child retires the lease, a headless process shall select that exact public id under compatible current tuning and prove that the Captain conversation, retained player tokens, explicit role bindings, frozen working directory, and completed repository effect survive without lifecycle replay, replacement player conversations, or a new tmux session ([[playbook-cli-22](playbook-cli.md#playbook-cli-22)], [[playbook-cli-23](playbook-cli.md#playbook-cli-23)], [[playbook-cli-49](playbook-cli.md#playbook-cli-49)]).
It shall additionally run the hermetic global-only case ([DR-024](../decisions/024-runtime-engine-provisioning.md) §7): install the packed candidate globally into an isolated npm prefix, enable a compiled thin fixture registry importing `xstate` and `@sublang/playbook/xstate-runtime` in the shared config of a fresh repository with no project-local packages anywhere, and invoke its slash command through the installed headless Captain.
The fixture shall mechanically reject a worker result that does not equal the repository token before it can enter its final state; the case shall assert automatic engine provisioning triggers exactly once, both runs return only `{sessionId, reply}`, each reply grounds the fixture's published terminal meaning that the exact token was returned and the request completed, and a repeated fresh run provisions nothing further.
Across the successful REVIEW, CODE, DECIDE, and hermetic cases, the installed candidate shall persist canonical Captain record schema `6`, complete shell and internal-Captain runtime snapshot schema `4`, schema-3 catalog entries, an authoritative effect ledger exactly mirrored by the shell snapshot, an empty `unresolvedEffects` list, and complete receipts covering REVIEW `unchanged` plus `one-descendant-commit`, CODE `one-descendant-commit`, DECIDE `unchanged` plus `one-descendant-commit`, and hermetic `unchanged` as applicable ([[playbook-runtime-67](playbook-runtime.md#playbook-runtime-67)], [[playbook-runtime-69](playbook-runtime.md#playbook-runtime-69)], [[playbook-captain-41](playbook-captain.md#playbook-captain-41)], [[playbook-captain-58](playbook-captain.md#playbook-captain-58)]).
The same-id REVIEW and DECIDE status continuations shall preserve the complete effect ledger byte-for-byte while starting no governed repository boundary ([[playbook-cli-23](playbook-cli.md#playbook-cli-23)], [[playbook-runtime-69](playbook-runtime.md#playbook-runtime-69)]).
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
The REVIEW case shall fail unless the headless process returns the public id and one Captain reply, the selected interactive process reports that same id and one new Captain reply, the first reaches approval, the continuation repeats no lifecycle or repository effect, the fixture repository remains clean, and the interactive pane child releases its lease after shutdown.
The DECIDE case shall fail unless the attached and selected headless processes report the same public id, the compatible reopening tuning is retained for the existing Captain and player continuations without changing their role bindings or tokens' ownership, the continuation repeats no lifecycle or repository effect, and no tmux session remains after the hand-off.
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
- [ ] The local real-agent acceptance suite passes, covering REVIEW headless-to-interactive continuation, headless CODE with nested REVIEW, DECIDE interactive-to-headless continuation, and the remaining hermetic and conversational cases (`pnpm test:acceptance`; [[release-24](#release-24)]).
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
`CaptainContext.callCaptain`, atomic `AgentCallSettings` on both call-option types, explicit `TuningSelection`, and the public typed settings-rejection error and predicate required by [[release-14](#release-14)].

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
3.0.0, the root importer in `pnpm-lock.yaml` records the same
specifier and resolves a version no lower than 3.0.0, and both `@sublang/spex/scaffold/specs/meta.md` and
`@sublang/spex/scaffold/i18n/zh/specs/meta.md` resolve from the repo
root to non-empty files (verifying [[release-22](#release-22)]).

### Normal Test Gate Coverage

#### release-32

The test suite shall fail unless the effective `pnpm test` lifecycle, in `pretest`, `test`, and `posttest` order, places a fail-fast `spex lint` command before its first Vitest command (verifying [[release-31](#release-31)]).

### Public Surface Coverage

#### release-17


The test suite shall fail unless each of
`@sublang/playbook/slc/link.md`, `@sublang/playbook/slc/gears2fsm.md`,
`@sublang/playbook/slc/text2gears.md`, and
`@sublang/playbook/slc/optimize.md` resolves via
`import.meta.resolve` to an existing file whose contents are readable (verifying [[release-16](#release-16)]).

#### release-18


The test suite shall fail unless `npm pack --dry-run` lists the `@sublang/playbook/runtime`, `@sublang/playbook/xstate-runtime`, and `@sublang/playbook/session-store` `.js` and `.d.ts` artifacts — including the `xstate-playbook-runtime` factory siblings backing the engine subpath and the internal `accepted-outcome` `.ts`, `.js`, and `.d.ts` siblings — and all four `slc/*.md` files among the packed contents, plus the authored Captain, CODE, REVIEW, and DECIDE sources, every `docs/*.md` guide the README links to, each workflow's GEARS, FSM, and linked-runtime `.ts`, `.js`, and `.d.ts` artifacts, and the CODE, REVIEW, and DECIDE registry `.ts`, `.js`, and `.d.ts` artifacts under `reference/sdlc/<id>.playbook/`.
Generated verification support shall remain canonical repository content but need not be packed (verifying [[release-15](#release-15)], [[release-16](#release-16)], [[release-20](#release-20)], and [[release-33](#release-33)]).
The suite shall further fail unless every packed Markdown file is link-closed over the packed file list: each relative target and reference-definition destination resolves to a packed file or a directory containing packed files, and a fragment on a packed Markdown target names an anchor that file renders (verifying [[release-20](#release-20)]).
The closure's two escape hatches shall themselves be verified against the repository tree: a packed SLC definition's exempt relative citation into `specs/` shall name an existing repository file whose fragment, when present, that file renders, and every living-pointer URL in a packed Markdown file shall name this repository's `main` branch, use `blob/main` for an existing file or `tree/main` for an existing directory, and — on a Markdown file target — name an anchor that file renders (verifying [[release-20](#release-20)]).

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
The public-surface suite shall import the XState engine and fail unless its runtime ABI is `1`, its supported schema set is the frozen exact value `[3]`, and the engine and Captain declaration surfaces expose only their schema-3 specification, factory, and registry-entry shapes with no schema-2 variant (verifying [[release-15](#release-15)]).
The packed-artifact suite shall fail unless the authored TypeScript and committed JavaScript CODE, REVIEW, and session-Captain artifacts declare schema `3`, bespoke DECIDE enforces schema `3` at its host-authority boundary, each workflow registry's TypeScript, JavaScript, and declaration siblings expose schema `3`, the CODE and REVIEW runtime declarations retain the schema-3 factory discriminator, the DECIDE declaration retains its required schema-3 host-construction input, the session-Captain declaration retains its options-only wrapper without a legacy variant, and every sibling agrees with the shipped engine (verifying [[release-15](#release-15)]).
The public-surface suite shall fail unless the declaration behind `exports['./runtime']` exposes `unresolved-effect` as exactly one state-only `PlaybookRunResult` arm with no state description, output, pending call, error, effect ledger, receipt, semantic candidate, or unresolved-effects projection (verifying [[release-15](#release-15)]).
The public-surface suite shall fail unless the declaration behind `exports['./playbook-captain']` exports the exact bounded unresolved-effect entry interface and pure validator, requires `PlaybookCaptainSettlement.unresolvedEffects` as a read-only list of that interface, omits repository paths, projections, ledger and internal identities, prose, semantic evidence, and budgets from the entry, and adds no such list to `PlaybookRunResult` (verifying [[release-15](#release-15)]).
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
- the first process provisions the fixture exactly once into the isolated prefix and returns only `{sessionId, reply}` after durable hand-off, a second process continues the same id from stdin with the stored Captain continuation and frozen working directory without replay or provisioning, and two further processes run one explicit-role fixture against that same id before and after compatible current retuning;
- a deliberately failing fixture parks its engagement in the recoverable failure state in one process, and a second process — holding nothing but that record — is offered the retry in its own decision digest, selects it by the exact advertised id, applies it once, and finishes the engagement, so a recovery that the hosting process could once keep only in memory is proven to cross a process boundary;
- a packed schema-3 governed-player fixture creates exactly one clean descendant commit in both its resolved and semantically unresolved rows while result-less Codex commentary and misleading `Commit:` prose remain opaque; the resolved row accepts only the hidden candidate plus receipt OID, the unresolved row parks after its one durable correction spend, and successor reconciliation and abandonment processes start no player or judge, change no repository state, and preserve the exact bounded evidence through final root disposal (verifying [[release-28](#release-28)]);
- the explicit-role fixture binds two sequential roles to one segmented player id and a third role to an equal-configured distinct segmented id, orders the shared roles first-to-second before retuning and second-to-first afterward, and fails unless the shared roles advance one token chain in both directions while the distinct id advances only its own chain (verifying [[release-28](#release-28)]);
- the retuned process applies the current Captain, player, and role model and effort values to the retained tokens, including explicit provider-default resets, while the stored structural projection, working directory, settled effects, public id, and repository remain unchanged (verifying [[release-28](#release-28)]);
- the installed Captain, CODE, REVIEW, and DECIDE playbook subpaths construct, Captain, CODE, and REVIEW expose retained-snapshot adoption while bespoke DECIDE omits it ([[release-28](#release-28)]), every packed file other than the manifest is byte-identical to the repository's own, the deterministic source-preservation check passes, and each compiled artifact's conformance suites pass with their declared coverage named among those that ran; and
- the nested installed `@sublang/cligent` satisfies the packed manifest's caret range; is reached through `@sublang/cligent/tmux-play` resolved from that nested copy; exposes the managed launch and direct-session runtime values and signatures plus the enumerated Captain lifecycle, context call, continuation, complete-setting, typed-rejection, managed work-directory cleanup-authority, attachment activation, and synchronous native-hand-off release-floor members at the exact optionality and callable type Playbook relies on; accepts and preserves a segmented player id such as `dev.coder` through its real config loader; resolves an empty roster to the Boss-only layout and initializes its public runtime core with an empty Captain player manifest; and carries full model and effort tuning selections that distinguish every concrete shell value from an explicit provider-default reset (verifying [[release-14](#release-14)]); and
- one deterministic Codex-shaped call through that nested installed runtime preserves complete commentary and final-response `text` messages as exactly two lines when terminal `done` supplies no result (verifying [[release-14](#release-14)] and [[release-28](#release-28)]); and
- an external package declaring only `@sublang/playbook` type-checks against the packed session-store declaration and, through that facade alone, opens a store, lists and reads a CLI-written session record, acquires and releases its lease, and appends and reads back stream entries that satisfy the frozen envelope, sequence, and readable-prefix contract, carry no resume token, and reject a below-schema record rather than migrate it (verifying [[release-33](#release-33)] and [[release-28](#release-28)]).

The last clause is a standing guard, not a formality: Playbook relies on every enumerated lifecycle, conversation, settings, and attachment capability, a global install resolves cligent from that nested copy alone, and a candidate whose declared range admits only releases without one of them would install and then fail during initialization, a Boss turn, or managed attachment.

Because that clause is the whole of the gate's protection against an incompatible dependency, the normal `pnpm test` suite shall fail unless every check backing it is itself falsifiable: for each required interface member, a fixture `@sublang/cligent` that declares the owning interface without that member shall make the check fail and name that exact member, while declaration enumeration over the same mutated fixture still finds every required spelling, so a guard that drifts back to matching names rather than resolving owning members fails these rows.
A fixture loader retaining the unsegmented player-id grammar, a config loader or runtime core rejecting an empty player roster, a call option missing or narrowing any continuation or complete-setting member, a tuning type unable to express the full shell value domain or either explicit selection, an optional member made required, an absent managed runtime value or missing or narrowed managed function declaration, a missing, optional, or narrowed managed cleanup-authority boolean, a synchronous lifecycle or native-hand-off member where Playbook requires an asynchronous or synchronous shape respectively, a managed attach that omits either activation option, or a package that stops exporting the public specifier shall likewise fail with the exact unsupported capability named.
One row shall run the complete checks against the repository's own installed cligent, so the declared floor is proven compatible without a pack or an install.

Nothing here shall be asserted by recompiling a playbook.
The SLC pipeline is agentic and its output is not reproducible byte-for-byte from the maintained source, so the gate shall instead run the deterministic source-preservation contract and the committed artifact suites before transferring their result to the packed candidate by byte equality.

Because it spends no model call and needs no authentication, this gate
shall be runnable by any maintainer with registry access, and shall not be
selected by the normal `pnpm test` configuration or by GitHub CI.

### Live pre-release acceptance

#### release-25


The opt-in local `pnpm test:acceptance` suite shall pack and install the candidate package once, then exercise five independent fresh git repositories through the installed npm `playbook` command shim.
The first case shall pipe `/review <request>` to installed `playbook run --json` over a prepared commit using the shared config and real Captain, Coder, and Reviewer agents.
After that headless process retires its lease, it shall launch a managed interactive process selected by the returned public session id, verify its one matching operational id line, ask one natural status question through the attached Boss pane, and fail unless the reply preserves the private Captain marker, REVIEW's approval and repository effects occur exactly once, the public id and stored working directory remain unchanged, the selected child retires its lease on shutdown, and the worktree stays clean (verifying [[release-24](#release-24)]).
The second case shall invoke installed `playbook run --json "/code <task>"` with real Claude and Codex agents and shall fail unless the start, nested REVIEW call, nested REVIEW return, and finish lifecycle markers appear once in order on stderr, only the requested implementation changes, the approved result is present in `HEAD`, the worktree is clean, and no tmux process is created.
The third, independent `/decide` case shall begin attached to tmux-play and shall fail unless its start, nested REVIEW call/return, and finish markers appear, only the requested spec-design files change, the design is committed without implementation, and the worktree is clean.
The DECIDE case shall also fail unless the nested REVIEW leaf exposes exactly the Coder and Reviewer players explicitly shared with DECIDE, creates no replacement conversation for either player id, and keeps the Boss/Captain pane focused.
After the interactive pane child shuts down, the case shall reopen that exact public id through installed `playbook run --session <id> --json` with a compatible current-tuning overlay and a natural status question, and shall fail unless the exact `{sessionId, reply}` result preserves the prior Captain and player continuations, records the current Captain, player, and role model and effort selections including provider-default selections, repeats no lifecycle or repository effect, creates no tmux session, and leaves the worktree clean (verifying [[release-24](#release-24)]).
The fourth, hermetic global-only case shall install the packed candidate into an isolated npm global prefix with inherited npm prefix configuration neutralized, place a configured compiled thin fixture registry importing `xstate` and `@sublang/playbook/xstate-runtime` and making one real Claude player call under a real Codex Captain in a fresh git repository containing no `package.json`, lockfile, or `node_modules` at any level, and invoke the prefix's `playbook run --json` command by absolute path with `/hermetic <task>`.
It shall fail unless neither engine import resolves from the fixture before launch; the first process prints one provisioning line and creates exactly the `node_modules/xstate` and `node_modules/@sublang/playbook` links resolving into the isolated prefix; the fixture mechanically proves the player result equals the repository token before final completion; both processes return exact `{sessionId, reply}` objects whose replies ground the published terminal meaning that the exact token was returned and the request completed; a repeated fresh run creates nothing further and prints no provisioning line; and `@sublang/cligent` resolves from beneath the prefix's `@sublang/playbook` rather than from any machine-global copy (verifying [[release-24](#release-24)]).
The first four cases shall fail unless their successful durable records carry the exact record, snapshot, catalog, ledger-mirror, empty-unresolved-list, and per-workflow receipt-classification matrix of [[release-24](#release-24)], and the same-id REVIEW and DECIDE status continuations leave that ledger unchanged.

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

The acceptance suite shall require local adapter authentication, tmux 3.3 or newer, glow,
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
