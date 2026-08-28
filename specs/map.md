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
| [DR-019](decisions/019-shared-linked-runtime-factory.md) | 019-shared-linked-runtime-factory.md | The generic flat single-region FSM interpreter ships once as `createXStatePlaybookRuntime(machine, spec)` on `@sublang/playbook/xstate-runtime`; emitted metadata retains local roles while concrete player binding stays host-owned |
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
| [DR-036](decisions/036-coherent-abort-settlement.md) | 036-coherent-abort-settlement.md | One abort-settlement model: exact-identity cancellation classified at each latch, machine-state settlement precedence with terminal ahead of a coincident abort, delivery refused on a pre-aborted boundary, and invocation-owned resources held to settlement |
| [DR-037](decisions/037-terminal-result-meaning.md) | 037-terminal-result-meaning.md | A terminal run result carries the reached final state's authored Boss-facing meaning independently of optional runtime control capabilities |
| [DR-038](decisions/038-universal-run-resumption.md) | 038-universal-run-resumption.md | Resumption as a capability-gated machine property — retained pre-terminal generations with their nested stacks, cross-session adoption under an exact structural envelope, ledger-authoritative players, and a Captain resume selection |

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
