<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Spec Map

Quick-reference index for locating spec files.
Spec items are the source of truth.
Code can be inconsistent with specs during development.

## Authoring and reviewing specs

Know the rules in [`meta.md`](meta.md) before authoring, modifying, or reviewing a DR, IR, or item.

## Layout

```text
decisions/    Decision records (DRs)
intents/      Intent records (IRs)
packages/     Spec packages (one file per package)
map.md        This index
meta.md       The spec of specs
```

## Decisions

| ID | File | Summary |
| --- | --- | --- |
| [DR-000](decisions/000-spec-structure-format.md) | 000-spec-structure-format.md | Spec structure, format, and naming conventions |
| [DR-001](decisions/001-state-machine-tooling.md) | 001-state-machine-tooling.md | XState + Stately Sketch for state machine modeling, visualization, and simulation; DR-033 narrows the scope — drawing running machines belongs to the host application |
| [DR-002](decisions/002-in-page-xstate-visualizer.md) | 002-in-page-xstate-visualizer.md | XState visualizer architecture (Diagram / Telemetry / Binding; `SketchTelemetry` protocol) — superseded by DR-003 |
| [DR-003](decisions/003-sketch-controlled-shell.md) | 003-sketch-controlled-shell.md | Superseded by DR-033: Stately Sketch as a controlled shell — the cutover never landed |
| [DR-004](decisions/004-link-code-fsm-to-playbook-runtime.md) | 004-link-code-fsm-to-playbook-runtime.md | Current CODE linker bindings: one Coder role, deterministic exact-text entry, shared single-region runtime, nested REVIEW after every CODE commit, and generic registry/shell integration |
| [DR-005](decisions/005-boss-reply-suspension-path.md) | 005-boss-reply-suspension-path.md | Quiescent scalar or branch-local Boss-question suspension, identified `BOSS_REPLY` reentry with explicit Q+A context, abandonment cleanup, and optional backend continuation |
| [DR-006](decisions/006-code-config-composition.md) | 006-code-config-composition.md | CODE config via `captain.options.code` (namespaced, registry-validated) and `playbook-code` as a composer that overlays CODE invariants onto an optional base tmux-play config and targets the DR-008 shell adapter; base-inheritable host fields are `theme`, `layout`, `notifications`, and the captain-judge fields (§2.4); object-launcher deferred — superseded by DR-009 |
| [DR-007](decisions/007-hidden-judge-captain-pane.md) | 007-hidden-judge-captain-pane.md | Generic shell ownership of hidden judge control calls, runtime-owned Boss-facing status, and full player-question presentation without raw judge JSON |
| [DR-008](decisions/008-playbook-captain-shell.md) | 008-playbook-captain-shell.md | Built-in Playbook Captain host over registered sub-runtimes: command selection, one Captain session, telemetry-mirrored lifecycle, park/resume, and adapter responsibilities; its hand-authored chat/selection/router policy is superseded by DR-012 |
| [DR-009](decisions/009-generic-playbook-cli-and-registry.md) | 009-generic-playbook-cli-and-registry.md | Generic `playbook` CLI and registry manifests, explicit modules, top-level session players, explicit role bindings and visibility, frame-owned summaries, and current CODE/REVIEW/DECIDE starter enablement |
| [DR-010](decisions/010-playbook-session-tracing-and-resume.md) | 010-playbook-session-tracing-and-resume.md | Immutable per-runtime playbook session UUIDs, boundary-complete ordered trace schema v3 with distinct role/player identity, and explicit fresh/resume selection from authoritative adapter tokens |
| [DR-011](decisions/011-composable-playbook-execution.md) | 011-composable-playbook-execution.md | DECIDE's independent parallel proposal join, structured runtime state, function-style nested playbook calls, a host-owned engagement stack, and causally linked traces; DR-029 places the session Captain outside that stack |
| [DR-012](decisions/012-default-captain-playbook.md) | 012-default-captain-playbook.md | Compiled default Captain policy, first-class Captain calls, dynamic sequential child plans, and deterministic host-owned stack routing; its lazy internal root, intra-turn multi-child plans, and hidden lifecycle classifier superseded by DR-029's session controller |
| [DR-013](decisions/013-routing-only-captain-control.md) | 013-routing-only-captain-control.md | Routing-only Captain policy with exact Boss input, isolated control calls, out-of-prompt machine contracts, and exact visible-response ownership; Addendum A1 degrades tool isolation to prompt level for adapters without provider enforcement; its two-outcome router menu and fresh isolated Captain-root calls superseded by DR-029's closed action set and durable conversation, the A1 tool posture retained |
| [DR-014](decisions/014-durable-one-shot-run-sessions.md) | 014-durable-one-shot-run-sessions.md | Durable one-shot runtime sessions and `playbook run resume` — superseded by DR-031's complete Captain-session continuation |
| [DR-015](decisions/015-per-run-agent-tuning.md) | 015-per-run-agent-tuning.md | Repeatable `--with <path>` top-level config overlays for new or ordinarily reopened Captain sessions; uncertain retry retains exact attempted settings |
| [DR-016](decisions/016-script-actors-and-optimize-pass.md) | 016-script-actors-and-optimize-pass.md | Script actors and the GEARS optimize pass: optimizer-introduced `Captain shall run:` items, the runtime-internal `script` actor with mechanical exit-status guards and `playbook.script` telemetry, and the format-preserving `slc/optimize.md` definition |
| [DR-017](decisions/017-run-defaults-config.md) | 017-run-defaults-config.md | A separate top-level `run` defaults block — superseded by DR-031's shared interactive and headless configuration |
| [DR-018](decisions/018-gears-grammar-provenance-from-spex.md) | 018-gears-grammar-provenance-from-spex.md | GEARS grammar authority moves to the installed `@sublang/spex` scaffold definitions (English and Chinese, with the canonical URLs), with a unified Source-language rule, fixed-English machine syntax, and `@sublang/spex` in the runtime dependency closure |
| [DR-019](decisions/019-shared-linked-runtime-factory.md) | 019-shared-linked-runtime-factory.md | The generic single-region FSM interpreter ships once as `createXStatePlaybookRuntime(machine, spec)` on `@sublang/playbook/xstate-runtime`; emitted metadata retains local roles while concrete player binding stays host-owned |
| [DR-020](decisions/020-spec-layout-agnostic-code-prompts.md) | 020-spec-layout-agnostic-code-prompts.md | CODE and REVIEW prompts defer spec placement to `map.md` and `meta.md`; new IRs use the current `intents/` path and intent-record vocabulary |
| [DR-021](decisions/021-inline-agent-settings.md) | 021-inline-agent-settings.md | Remove profiles: Captain and top-level session players carry inline agent settings, while playbook role bindings may override model and effort |
| [DR-022](decisions/022-runtime-compatibility-contract.md) | 022-runtime-compatibility-contract.md | Versioned artifact/engine compatibility through `RUNTIME_ABI`, `SUPPORTED_ARTIFACT_SCHEMAS`, factory `spec.compat`, and registry `artifactSchema`; DR-032 rejects declaration-free/schema-1 player metadata in favor of schema-2 local roles |
| [DR-023](decisions/023-data-only-machine-ir.md) | 023-data-only-machine-ir.md | Playbook 4 direction: data-only machine IR materialized by the host's own playbook and xstate (resolution-hook bridge rejected), gated on a closed IR vocabulary over all executable machine semantics and a passing global-only acceptance test; no longer gates the install docs per DR-024 |
| [DR-024](decisions/024-runtime-engine-provisioning.md) | 024-runtime-engine-provisioning.md | Shared launch-time engine provisioning for configured filesystem playbooks: probe-first resolution from the artifact, two direct symlinks to the host's own `xstate` and `@sublang/playbook` on failure, `--no-provision` in both front ends, declared-manifest refusal and dangling-link diagnostics, and the re-scoped hermetic global-only acceptance gate |
| [DR-025](decisions/025-resilient-captain-control-adjudication.md) | 025-resilient-captain-control-adjudication.md | Resilient Captain control adjudication: the exported explicit `{ guard, … }` judge reply contract reused by the compiled default Captain, one corrective re-ask on a malformed control reply, and shell disposal of a failed internal Captain root with Boss-appropriate failure text; its internal-root disposal superseded by DR-029's conversation reseed |
| [DR-026](decisions/026-optional-adapter-sdks.md) | 026-optional-adapter-sdks.md | Adapter SDKs become optional peer dependencies matching cligent's: libraries declare and the deliberately-installed root supplies, a supplied SDK must be a top-level install root to resolve from nested cligent, missing SDKs fail at an `isAvailable()` preflight rather than mid-turn, and the release smoke asserts both the lean and opted-in install shapes |
| [DR-027](decisions/027-runtime-compatibility-from-cligent.md) | 027-runtime-compatibility-from-cligent.md | Delegate all agent-runtime version knowledge to cligent: the gate derives runtimes, floors, and pinned repairs from cligent's shipped descriptor and renders its structured verdict, unsupported is reported distinctly from absent, `gemini`'s exemption ends, and no agent-SDK peer range is declared here |
| [DR-028](decisions/028-empty-ok-result-re-ask.md) | 028-empty-ok-result-re-ask.md | One corrective re-ask on an empty `ok` player or direct-Captain result before failure-sink routing, with both boundaries unified on the missing-or-empty/whitespace-only predicate |
| [DR-029](decisions/029-session-scoped-conversational-captain.md) | 029-session-scoped-conversational-captain.md | The compiled Captain becomes a session-long conversational controller outside the working stack: one recoverable conversation, at most one validated action per turn, one result-and-reply path for success/rejection/failure/partial completion, faithful multi-turn handoff, and factual nonzero summaries |
| [DR-030](decisions/030-shared-mapped-player-continuity.md) | 030-shared-mapped-player-continuity.md | Same-name nested-role inheritance and root-engagement continuation — superseded by DR-032 |
| [DR-031](decisions/031-shared-captain-session-front-ends.md) | 031-shared-captain-session-front-ends.md | Interactive and headless front ends host the same compiled Captain session, config, nested stack, presentation contract, and durable continuation |
| [DR-032](decisions/032-explicit-roles-session-players.md) | 032-explicit-roles-session-players.md | Playbook-local roles bind explicitly to Captain-session players; compatible current model and effort selections may change across durable continuation |
| [DR-033](decisions/033-sketch-view-retirement.md) | 033-sketch-view-retirement.md | Sketch view retirement: the host app draws running machines; the runtime keeps emitting the trace they ride on |
| [DR-034](decisions/034-durable-failure-retry-continuity.md) | 034-durable-failure-retry-continuity.md | A parked failure state sources its retry from the persisted machine snapshot, so it recovers identically live and after continuation |
| [DR-035](decisions/035-truthful-terminal-meaning.md) | 035-truthful-terminal-meaning.md | A final state's description is the workflow's published terminal meaning, so distinct terminal outcomes reach distinct final states |

## Intents

| ID | File | Intent |
| --- | --- | --- |
| [IR-000](intents/000-spdx-headers.md) | 000-spdx-headers.md | Add SPDX headers to applicable files |
| [IR-004](intents/004-link-code-fsm-to-playbook-runtime.md) | 004-link-code-fsm-to-playbook-runtime.md | Compile CODE FSM into `code.playbook.ts` per `slc/link.md` and DR-004; ship the in-repo tmux-play adapter `code.tmux-play.ts` |
| [IR-005](intents/005-code-playbook-conformance-tests.md) | 005-code-playbook-conformance-tests.md | Conformance tests pinning `code.fsm.ts` to `code.gears.md` (every CODE-N, every edge, every prompt) — replaces the dropped manual acceptance runbook |
| [IR-006](intents/006-boss-reply-suspension-path.md) | 006-boss-reply-suspension-path.md | Implemented DR-005 end to end: `awaitBossReply` / `BOSS_REPLY` / `needsBossReply` suspension-resume path across specs, CODE gears/FSM/runtime, status/telemetry, and conformance/prompt/runtime tests |
| [IR-008](intents/008-universal-boss-reply.md) | 008-universal-boss-reply.md | Make Boss-reply suspension universal across every captain-invoking state, withdrawing IR-007's source annotation and moving `needsBossReply` wiring from GEARS metadata into `gears2fsm` |
| [IR-009](intents/009-free-text-boss-input.md) | 009-free-text-boss-input.md | Make every Boss turn free text classified by the judge, retiring in-playbook slash commands and reserving `/command` for playbook selection |
| [IR-010](intents/010-drop-boss-question-instruction.md) | 010-drop-boss-question-instruction.md | Drop the injected Boss-question instruction from composed player prompts while retaining Boss-reply suspension |
| [IR-011](intents/011-playbook-code-onboarding.md) | 011-playbook-code-onboarding.md | Seed a user-level `playbook-code.config.yaml` on first run, gate launch on a light per-adapter readiness check, and recover from missing auth by printing the shim's own `--help` |
| [IR-012](intents/012-hidden-judge-captain-pane.md) | 012-hidden-judge-captain-pane.md | Implemented DR-007: every CODE judge call runs hidden via `callCaptain({ visibility: 'hidden' })`; `awaitBossReply` entry shows the full question as captain speech then a rider-less marker; temporary cligent augmentation + gated integration test |
| [IR-013](intents/013-player-alias-default-lineup.md) | 013-player-alias-default-lineup.md | Add config-level player-alias support (Committer→Reviewer) and refresh the seeded CODE overlay: 4:6:6 column weights, 174×49 window, Captain Sonnet 4.6 / Coder GPT-5.5 xhigh / Reviewer Opus 4.8 xhigh |
| [IR-014](intents/014-playbook-captain-shell.md) | 014-playbook-captain-shell.md | Implement DR-008: built-in Playbook Captain shell with CODE registered, `/code` selection, hidden routing, park/resume semantics, telemetry mirroring, and the `./code/tmux-play` compatibility shim |
| [IR-015](intents/015-slc-runtime-package-surface.md) | 015-slc-runtime-package-surface.md | Publish the SLC-facing surface: authored type-only `@sublang/playbook/runtime` (`PlayerResult`, `PlaybookPorts`, `PlaybookRuntime`, `PlaybookRuntimeFactory`) as the single source CODE re-exports, `slc/**` shipped via a `./slc/*` export, and `/runtime` + `slc/*` marked public semver-stable surfaces |
| [IR-016](intents/016-generic-playbook-cli-and-registry.md) | 016-generic-playbook-cli-and-registry.md | Decompose DR-009: generic `playbook` CLI, multi-playbook registry loaded via explicit `from` modules, profile-based settings, namespaced `<id>-<role>` players, active-playbook tmux-play visibility, registry-owned park states and summary policy, and retirement of `playbook-code` / `./code/tmux-play` / `captain.options.code` / PBCODE |
| [IR-017](intents/017-playbook-session-trace-resume.md) | 017-playbook-session-trace-resume.md | Give every runtime session an immutable UUID and ordered full boundary trace, with explicit player-session isolation and continuation through adapter resume tokens |
| [IR-018](intents/018-composable-playbook-execution.md) | 018-composable-playbook-execution.md | Run independent player tasks concurrently and let live playbooks call, suspend for, and resume from nested enabled playbooks |
| [IR-019](intents/019-default-captain-playbook.md) | 019-default-captain-playbook.md | Compile and host the original generic Captain routing and sequential nested-call policy, with initial direct handling superseded by IR-020 |
| [IR-020](intents/020-routing-only-captain-control.md) | 020-routing-only-captain-control.md | Prevent Captain self-execution through exact input provenance, tool-free fresh calls, clarify-or-delegate routing, and meaningful terminal prose |
| [IR-021](intents/021-durable-one-shot-run-sessions.md) | 021-durable-one-shot-run-sessions.md | Implement DR-014: parked-session snapshot export/restore, the one-shot session store, `playbook run resume`, and their acceptance tests |
| [IR-022](intents/022-per-run-agent-tuning.md) | 022-per-run-agent-tuning.md | Implement DR-015: effort in the `playbook run` agent grammar and `--with` config overlays, with acceptance tests |
| [IR-023](intents/023-script-actors-and-optimize-pass.md) | 023-script-actors-and-optimize-pass.md | Codify DR-016 in the maintained definitions: script behaviors in `text2gears.md`, the `script` actor in `gears2fsm.md`, script execution in `link.md`, and the new `optimize.md` pass shipped via `./slc/*` |
| [IR-024](intents/024-run-defaults-config.md) | 024-run-defaults-config.md | Implement DR-017: `run` block defaults for `playbook run` with per-role precedence, the `player` catch-all, fail-closed validation, resume immunity, and acceptance tests |
| [IR-025](intents/025-gears-grammar-provenance.md) | 025-gears-grammar-provenance.md | Implement DR-018: cite the GEARS grammar from the installed `@sublang/spex` package, codify the unified language rule, and pin the dependency and its resolution |
| [IR-026](intents/026-shared-linked-runtime-factory.md) | 026-shared-linked-runtime-factory.md | Implement DR-019: the shared linked-runtime factory with generic strategy defaults and unit tests, the thin CODE artifact under its unchanged suites, the rewritten `slc/link.md` §Output, and the 1.3.0 bump |
| [IR-028](intents/028-codex-captain-control-calls.md) | 028-codex-captain-control-calls.md | Implement DR-013 A1: omit the empty tool allowlist for captain adapters without provider-enforced tool restriction so Codex, Kimi, and OpenCode captains run, keeping Claude and Gemini enforcement |
| [IR-029](intents/029-inline-agent-settings.md) | 029-inline-agent-settings.md | Implement DR-021: drop profile resolution from the launcher, inline the seeded template, reject profiles-bearing configs, and update the playbook-cli items and tests |
| [IR-027](intents/027-linked-runtime-boundary-fixes.md) | 027-linked-runtime-boundary-fixes.md | Route host-reported direct-Captain result failures to the FSM failure state, derive the `bossIntent` interrupt field, name the runtime-owned `bossEvents` exclusions in `slc/link.md`, validate `bossEvents` under an overridden classifier, and retire playbook-runtime-46's unit-only clause |
| [IR-030](intents/030-runtime-compatibility-metadata.md) | 030-runtime-compatibility-metadata.md | Implement DR-022: the engine compatibility self-report, the `spec.compat` construction check with unit and run-path tests, the `slc/link.md` link-time `compat` emission, and the 3.1.0 release preparation |
| [IR-031](intents/031-runtime-engine-provisioning.md) | 031-runtime-engine-provisioning.md | Implement DR-024: probe-first engine provisioning in `playbook run` with `--no-provision`, guard-order diagnostics, injected host roots, playbook-cli-38 integration tests, and the fourth hermetic global-only acceptance case |
| [IR-032](intents/032-conversational-first-turn-resilience.md) | 032-conversational-first-turn-resilience.md | Implement DR-025: `defaultBuildCaptainJudgePrompt` exported and reused by the compiled Captain, the corrective adjudication re-ask, internal-root failure disposal in the shell, and their integration tests |
| [IR-033](intents/033-optional-adapter-sdks.md) | 033-optional-adapter-sdks.md | Implement DR-026: move both adapter SDKs to optional peers plus devDependencies, add the launcher and `run` SDK preflight with named install remedies, and re-aim the release smoke at the lean and opted-in global install shapes |
| [IR-034](intents/034-runtime-compatibility-from-cligent.md) | 034-runtime-compatibility-from-cligent.md | Implement DR-027: descriptor-derived gate with per-runtime verdicts and pinned repairs, drop the peer-range mirror, and end `gemini`'s exemption |
| [IR-035](intents/035-empty-ok-result-re-ask.md) | 035-empty-ok-result-re-ask.md | Implement DR-028: one corrective re-ask on an empty `ok` player or direct-Captain result under the unified empty predicate, with per-call trace pairs, playbook-runtime-38 resume selection, and the playbook-runtime-51 integration tests |
| [IR-036](intents/036-session-scoped-conversational-captain.md) | 036-session-scoped-conversational-captain.md | Implement DR-029 with the runtime control capability, compiled session controller, durable-conversation shell, cligent floor, and release gates; IR-039 completes the unified result path and conversational handoff |
| [IR-037](intents/037-markdown-cross-reference-check.md) | 037-markdown-cross-reference-check.md | Fail the suite on a broken spec cross-reference: the XREF package, a dependency-free link/anchor checker with GitHub's slug rules, and the repointing of two links into a sibling checkout |
| [IR-038](intents/038-conversational-gate-config-coverage.md) | 038-conversational-gate-config-coverage.md | Bring the live gate's conversational config under `pnpm test`: its config and fixture playbook sources moved out of the excluded acceptance suite into `acceptance/live-config.ts` and `acceptance/live-fixtures.ts`, and the amended playbook-cli-32 composing it through the real launcher over the real fixture modules |
| [IR-039](intents/039-unified-captain-results.md) | 039-unified-captain-results.md | Complete DR-029 with one conversational result path, complete recovery history, action-safe recovery, and faithful multi-turn task handoff |
| [IR-040](intents/040-compiled-composed-workflows.md) | 040-compiled-composed-workflows.md | Establish and release-gate a linked CODE, REVIEW, and DECIDE baseline with shared mapped-player continuity, current SLC preservation rules, and package-only specs |
| [IR-041](intents/041-shared-captain-session.md) | 041-shared-captain-session.md | Make `playbook` and `playbook run` two presentations of one configurable, nested, durable compiled Captain session |
| [IR-042](intents/042-explicit-roles-session-players.md) | 042-explicit-roles-session-players.md | Implement explicit local roles, Captain-session players, compatible retuning, and durable continuation through either front end |
| [IR-043](intents/043-truthful-terminal-meaning.md) | 043-truthful-terminal-meaning.md | Implement DR-035: one final state per authored terminal outcome, splitting CODE's overloaded `done` |
| [IR-044](intents/044-durable-failure-retry-continuity.md) | 044-durable-failure-retry-continuity.md | Implement DR-034: the failure-state retry derives from the persisted machine snapshot, so a continued session recovers in place |

## Packages

| File | Summary |
| --- | --- |
| [captain-playbook.md](packages/captain-playbook.md) | Compiled session Captain behavior, controller contract, compilation, and verification |
| [cross-references.md](packages/cross-references.md) | Relative Markdown link and GitHub-anchor resolution plus repository checks |
| [git.md](packages/git.md) | Commit preparation, message format, and AI co-authorship |
| [licensing.md](packages/licensing.md) | SPDX header scope, requirements, and repository checks |
| [playbook.md](packages/playbook.md) | CODE, REVIEW, and DECIDE source, GEARS, FSM, prompt, transition, nesting, and terminal conformance |
| [playbook-captain.md](packages/playbook-captain.md) | Registry, routing, explicit role binding, Captain-session player continuity, engagement stack, and host lifecycle |
| [playbook-cli.md](packages/playbook-cli.md) | Interactive and headless launch, player config, durable session reopening, provisioning, persistence, and checks |
| [playbook-runtime.md](packages/playbook-runtime.md) | Role-local linked runtime ports, execution, composition, tracing, persistence, and control |
| [release.md](packages/release.md) | Versioning, package surfaces, release workflow, smoke, and live acceptance |
