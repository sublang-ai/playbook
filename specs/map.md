<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Spec Map

Quick-reference index for locating spec files.
Spec items are the source of truth.
Code can be inconsistent with specs during development.

## Layout

```text
decisions/  Decision records (DRs)
iterations/ Iteration records (IRs)
user/       User-visible behavior item files
dev/        Implementation requirements item files
test/       Acceptance testing item files
map.md      This index
meta.md     The spec of specs
```

## Decisions

| ID | File | Summary |
| --- | --- | --- |
| DR-000 | [000-spec-structure-format.md](decisions/000-spec-structure-format.md) | Spec structure, format, and naming conventions |
| DR-001 | [001-state-machine-tooling.md](decisions/001-state-machine-tooling.md) | XState + Stately Sketch for state machine modeling, visualization, and simulation |
| DR-002 | [002-in-page-xstate-visualizer.md](decisions/002-in-page-xstate-visualizer.md) | XState visualizer architecture (Diagram / Telemetry / Binding; `SketchTelemetry` protocol) — superseded by DR-003 |
| DR-003 | [003-sketch-controlled-shell.md](decisions/003-sketch-controlled-shell.md) | Stately Sketch as a controlled visual shell driven by `actor.system.inspect` and a postMessage protocol |
| DR-004 | [004-link-code-fsm-to-playbook-runtime.md](decisions/004-link-code-fsm-to-playbook-runtime.md) | CODE linker/runtime bindings: player binding (Committer alias config-driven per Addendum A2), free-text Boss-event classification with no in-playbook slash commands, adjudication, lifecycle, abort, telemetry, and direct CODE adapter wiring superseded by DR-008 shell target per Addendum A3; runtime contract types sourced from the shared `@sublang/playbook/runtime` module per Addendum A4 |
| DR-005 | [005-boss-reply-suspension-path.md](decisions/005-boss-reply-suspension-path.md) | Third Boss surface for `gears2fsm`: `awaitBossReply` quiescent state + `BOSS_REPLY` event + universal `needsBossReply` guard for Captain- and player-invoking states, so player questions suspend and resume the same state with the answer in context |
| DR-006 | [006-code-config-composition.md](decisions/006-code-config-composition.md) | CODE config via `captain.options.code` (namespaced, registry-validated) and `playbook-code` as a composer that overlays CODE invariants onto an optional base tmux-play config and targets the DR-008 shell adapter; base-inheritable host fields are `theme`, `layout`, `notifications`, and the captain-judge fields (§2.4); object-launcher deferred — superseded by DR-009 |
| DR-007 | [007-hidden-judge-captain-pane.md](decisions/007-hidden-judge-captain-pane.md) | No raw judge JSON on the Captain pane: route every CODE judge call through cligent's hidden `callCaptain({ visibility: 'hidden' })`, surface a suspended player's full question as captain speech then a rider-less marker (transitional augmentation + gated PBRT-32 test retired at the cligent 0.11.0 pin refresh) |
| DR-008 | [008-playbook-captain-shell.md](decisions/008-playbook-captain-shell.md) | Built-in Playbook Captain host over registered sub-runtimes: command selection, one Captain session, telemetry-mirrored lifecycle, park/resume, and adapter responsibilities; its hand-authored chat/selection/router policy is superseded by DR-012 |
| DR-009 | [009-generic-playbook-cli-and-registry.md](decisions/009-generic-playbook-cli-and-registry.md) | Generic `playbook` CLI and multi-playbook registry enablement (its `profiles` model superseded by DR-021): explicit `from` modules, compiled-Captain catalog intents, reserved `captain` id/command, namespaced players, external-playbook pane visibility, summary policy, and one active root engagement |
| DR-010 | [010-playbook-session-tracing-and-resume.md](decisions/010-playbook-session-tracing-and-resume.md) | Immutable per-runtime playbook session UUIDs, boundary-complete ordered traces, and explicit per-player fresh/resume selection from authoritative adapter tokens |
| DR-011 | [011-composable-playbook-execution.md](decisions/011-composable-playbook-execution.md) | XState parallel-region joins, structured runtime state, function-style nested playbook calls, a live Captain session stack, and causally linked trace schema v2 |
| DR-012 | [012-default-captain-playbook.md](decisions/012-default-captain-playbook.md) | Compiled default Captain policy, first-class Captain calls, dynamic sequential child plans, and deterministic host-owned stack routing; its lazy internal root, intra-turn multi-child plans, and hidden lifecycle classifier superseded by DR-029's session controller |
| DR-013 | [013-routing-only-captain-control.md](decisions/013-routing-only-captain-control.md) | Routing-only Captain policy with exact Boss input, isolated control calls, out-of-prompt machine contracts, and exact visible-response ownership; Addendum A1 degrades tool isolation to prompt level for adapters without provider enforcement; its two-outcome router menu and fresh isolated Captain-root calls superseded by DR-029's closed action set and durable conversation, the A1 tool posture retained |
| DR-014 | [014-durable-one-shot-run-sessions.md](decisions/014-durable-one-shot-run-sessions.md) | Durable one-shot run sessions: optional parked-session `exportSnapshot`/`restore` on linked runtimes, an XDG session store, and `playbook run resume` |
| DR-015 | [015-per-run-agent-tuning.md](decisions/015-per-run-agent-tuning.md) | Per-run agent tuning: `<adapter>[:<model>][@<effort>]` in the `playbook run` agent spec and repeatable `--with <path>` top-level config overlays for the interactive launch |
| DR-016 | [016-script-actors-and-optimize-pass.md](decisions/016-script-actors-and-optimize-pass.md) | Script actors and the GEARS optimize pass: optimizer-introduced `Captain shall run:` items, the runtime-internal `script` actor with mechanical exit-status guards and `playbook.script` telemetry, and the format-preserving `slc/optimize.md` definition |
| DR-017 | [017-run-defaults-config.md](decisions/017-run-defaults-config.md) | Config-driven `playbook run` defaults: a top-level `run` block (`captain`, per-role `players`, `player` catch-all) in the user config with flag-over-config precedence, ignored unrequired roles, fail-closed malformed handling, and untouched resume |
| DR-018 | [018-gears-grammar-provenance-from-spex.md](decisions/018-gears-grammar-provenance-from-spex.md) | GEARS grammar authority moves to the installed `@sublang/spex` scaffold definitions (English and Chinese, with the canonical URLs), with a unified Source-language rule, fixed-English machine syntax, and `@sublang/spex` in the runtime dependency closure |
| DR-019 | [019-shared-linked-runtime-factory.md](decisions/019-shared-linked-runtime-factory.md) | The generic FSM-interpreter machinery ships once as the shared `createXStatePlaybookRuntime(machine, spec)` factory on `@sublang/playbook/xstate-runtime`; `slc/link.md` emits thin modules, CODE is ported as the equivalence proof, and fat artifacts stay compatible |
| DR-020 | [020-spec-layout-agnostic-code-prompts.md](decisions/020-spec-layout-agnostic-code-prompts.md) | CODE prompts and review routing classify by "spec item files" (defined for both the packages and legacy specs layouts) instead of hardcoding `specs/{user,dev,test}`; judge descriptions stay self-contained, player prompts defer placement to `meta.md` |
| DR-021 | [021-inline-agent-settings.md](decisions/021-inline-agent-settings.md) | Remove the top-level `profiles` map and the agent-block `profile` key: every captain and player carries its own adapter/model/effort/permissions inline, with a migration diagnostic for profiles-bearing configs |
| DR-022 | [022-runtime-compatibility-contract.md](decisions/022-runtime-compatibility-contract.md) | Versioned artifact/engine compatibility: the engine's `RUNTIME_ABI` / `SUPPORTED_ARTIFACT_SCHEMAS` self-report, the optional link-time `spec.compat` declaration checked fail-fast at factory construction against the loaded engine, and legacy declaration-free artifacts staying loadable |
| DR-023 | [023-data-only-machine-ir.md](decisions/023-data-only-machine-ir.md) | Playbook 4 direction: data-only machine IR materialized by the host's own playbook and xstate (resolution-hook bridge rejected), gated on a closed IR vocabulary over all executable machine semantics and a passing global-only acceptance test; no longer gates the install docs per DR-024 |
| DR-024 | [024-runtime-engine-provisioning.md](decisions/024-runtime-engine-provisioning.md) | Run-time engine provisioning in `playbook run`: probe-first resolution from the artifact, two direct symlinks to the host's own `xstate` and `@sublang/playbook` on failure, `--no-provision`, declared-manifest refusal and dangling-link diagnostics, and the re-scoped hermetic global-only acceptance gate |
| DR-025 | [025-resilient-captain-control-adjudication.md](decisions/025-resilient-captain-control-adjudication.md) | Resilient Captain control adjudication: the exported explicit `{ guard, … }` judge reply contract reused by the compiled default Captain, one corrective re-ask on a malformed control reply, and shell disposal of a failed internal Captain root with Boss-appropriate failure text; its internal-root disposal superseded by DR-029's conversation reseed |
| DR-026 | [026-optional-adapter-sdks.md](decisions/026-optional-adapter-sdks.md) | Adapter SDKs become optional peer dependencies matching cligent's: libraries declare and the deliberately-installed root supplies, a supplied SDK must be a top-level install root to resolve from nested cligent, missing SDKs fail at an `isAvailable()` preflight rather than mid-turn, and the release smoke asserts both the lean and opted-in install shapes |
| DR-027 | [027-runtime-compatibility-from-cligent.md](decisions/027-runtime-compatibility-from-cligent.md) | Delegate all agent-runtime version knowledge to cligent: the gate derives runtimes, floors, and pinned repairs from cligent's shipped descriptor and renders its structured verdict, unsupported is reported distinctly from absent, `gemini`'s exemption ends, and no agent-SDK peer range is declared here |
| DR-028 | [028-empty-ok-result-re-ask.md](decisions/028-empty-ok-result-re-ask.md) | One corrective re-ask on an empty `ok` player or direct-Captain result before failure-sink routing, with both boundaries unified on the missing-or-empty/whitespace-only predicate |
| DR-029 | [029-session-scoped-conversational-captain.md](decisions/029-session-scoped-conversational-captain.md) | Session-scoped conversational Captain: the default Captain playbook — an always-present controller outside the engagement stack — is rewritten and recompiled to run one durable journal-reseeded conversation driving an observe–act–result loop of validated `respond`/`start`/`switch`/`dismiss`/`deliver`/`runtime` actions over a runtime-owned `describe`/`apply` control capability, replacing the per-turn throwaway control calls and the lifecycle classifier, with turn summaries kept but outcome-grounded and gated to turns with counted activity |

## Iterations

| ID | File | Goal |
| --- | --- | --- |
| IR-000 | [000-spdx-headers.md](iterations/000-spdx-headers.md) | Add SPDX headers to applicable files |
| IR-003 | [003-sketch-controlled-shell.md](iterations/003-sketch-controlled-shell.md) | Cutover to Sketch-as-controlled-shell: fork patches, parent-side adapter, retire DR-002 renderer |
| IR-004 | [004-link-code-fsm-to-playbook-runtime.md](iterations/004-link-code-fsm-to-playbook-runtime.md) | Compile CODE FSM into `code.playbook.ts` per `slc/link.md` and DR-004; ship the in-repo tmux-play adapter `code.tmux-play.ts` |
| IR-005 | [005-code-playbook-conformance-tests.md](iterations/005-code-playbook-conformance-tests.md) | Conformance tests pinning `code.fsm.ts` to `code.gears.md` (every CODE-N, every edge, every prompt) — replaces the dropped manual acceptance runbook |
| IR-006 | [006-boss-reply-suspension-path.md](iterations/006-boss-reply-suspension-path.md) | Implemented DR-005 end to end: `awaitBossReply` / `BOSS_REPLY` / `needsBossReply` suspension-resume path across specs, CODE gears/FSM/runtime, status/telemetry, and conformance/prompt/runtime tests |
| IR-008 | [008-universal-boss-reply.md](iterations/008-universal-boss-reply.md) | Make Boss-reply suspension universal across every captain-invoking state, withdrawing IR-007's source annotation and moving `needsBossReply` wiring from GEARS metadata into `gears2fsm` |
| IR-009 | [009-free-text-boss-input.md](iterations/009-free-text-boss-input.md) | Make every Boss turn free text classified by the judge, retiring in-playbook slash commands and reserving `/command` for playbook selection |
| IR-010 | [010-drop-boss-question-instruction.md](iterations/010-drop-boss-question-instruction.md) | Drop the injected Boss-question instruction from composed player prompts while retaining Boss-reply suspension |
| IR-011 | [011-playbook-code-onboarding.md](iterations/011-playbook-code-onboarding.md) | Seed a user-level `playbook-code.config.yaml` on first run, gate launch on a light per-adapter readiness check, and recover from missing auth by printing the shim's own `--help` |
| IR-012 | [012-hidden-judge-captain-pane.md](iterations/012-hidden-judge-captain-pane.md) | Implemented DR-007: every CODE judge call runs hidden via `callCaptain({ visibility: 'hidden' })`; `awaitBossReply` entry shows the full question as captain speech then a rider-less marker; temporary cligent augmentation + gated integration test |
| IR-013 | [013-player-alias-default-lineup.md](iterations/013-player-alias-default-lineup.md) | Add config-level player-alias support (Committer→Reviewer) and refresh the seeded CODE overlay: 4:6:6 column weights, 174×49 window, Captain Sonnet 4.6 / Coder GPT-5.5 xhigh / Reviewer Opus 4.8 xhigh |
| IR-014 | [014-playbook-captain-shell.md](iterations/014-playbook-captain-shell.md) | Implement DR-008: built-in Playbook Captain shell with CODE registered, `/code` selection, hidden routing, park/resume semantics, telemetry mirroring, and the `./code/tmux-play` compatibility shim |
| IR-015 | [015-slc-runtime-package-surface.md](iterations/015-slc-runtime-package-surface.md) | Publish the SLC-facing surface: authored type-only `@sublang/playbook/runtime` (`PlayerResult`, `PlaybookPorts`, `PlaybookRuntime`, `PlaybookRuntimeFactory`) as the single source CODE re-exports, `slc/**` shipped via a `./slc/*` export, and `/runtime` + `slc/*` marked public semver-stable surfaces |
| IR-016 | [016-generic-playbook-cli-and-registry.md](iterations/016-generic-playbook-cli-and-registry.md) | Decompose DR-009: generic `playbook` CLI, multi-playbook registry loaded via explicit `from` modules, profile-based settings, namespaced `<id>-<role>` players, active-playbook tmux-play visibility, registry-owned park states and summary policy, and retirement of `playbook-code` / `./code/tmux-play` / `captain.options.code` / PBCODE |
| IR-017 | [017-playbook-session-trace-resume.md](iterations/017-playbook-session-trace-resume.md) | Give every runtime session an immutable UUID and ordered full boundary trace, with explicit player-session isolation and continuation through adapter resume tokens |
| IR-018 | [018-composable-playbook-execution.md](iterations/018-composable-playbook-execution.md) | Run independent player tasks concurrently and let live playbooks call, suspend for, and resume from nested enabled playbooks |
| IR-019 | [019-default-captain-playbook.md](iterations/019-default-captain-playbook.md) | Compile and host the original generic Captain routing and sequential nested-call policy, with initial direct handling superseded by IR-020 |
| IR-020 | [020-routing-only-captain-control.md](iterations/020-routing-only-captain-control.md) | Prevent Captain self-execution through exact input provenance, tool-free fresh calls, clarify-or-delegate routing, and meaningful terminal prose |
| IR-021 | [021-durable-one-shot-run-sessions.md](iterations/021-durable-one-shot-run-sessions.md) | Implement DR-014: parked-session snapshot export/restore, the one-shot session store, `playbook run resume`, and their acceptance tests |
| IR-022 | [022-per-run-agent-tuning.md](iterations/022-per-run-agent-tuning.md) | Implement DR-015: effort in the `playbook run` agent grammar and `--with` config overlays, with acceptance tests |
| IR-023 | [023-script-actors-and-optimize-pass.md](iterations/023-script-actors-and-optimize-pass.md) | Codify DR-016 in the maintained definitions: script behaviors in `text2gears.md`, the `script` actor in `gears2fsm.md`, script execution in `link.md`, and the new `optimize.md` pass shipped via `./slc/*` |
| IR-024 | [024-run-defaults-config.md](iterations/024-run-defaults-config.md) | Implement DR-017: `run` block defaults for `playbook run` with per-role precedence, the `player` catch-all, fail-closed validation, resume immunity, and acceptance tests |
| IR-025 | [025-gears-grammar-provenance.md](iterations/025-gears-grammar-provenance.md) | Implement DR-018: cite the GEARS grammar from the installed `@sublang/spex` package, codify the unified language rule, and pin the dependency and its resolution |
| IR-026 | [026-shared-linked-runtime-factory.md](iterations/026-shared-linked-runtime-factory.md) | Implement DR-019: the shared linked-runtime factory with generic strategy defaults and unit tests, the thin CODE artifact under its unchanged suites, the rewritten `slc/link.md` §Output, and the 1.3.0 bump |
| IR-028 | [028-codex-captain-control-calls.md](iterations/028-codex-captain-control-calls.md) | Implement DR-013 A1: omit the empty tool allowlist for captain adapters without provider-enforced tool restriction so a Codex captain runs, keeping Claude's enforced isolation |
| IR-029 | [029-inline-agent-settings.md](iterations/029-inline-agent-settings.md) | Implement DR-021: drop profile resolution from the launcher, inline the seeded template, reject profiles-bearing configs, and update the PBCLI items and tests |
| IR-027 | [027-linked-runtime-boundary-fixes.md](iterations/027-linked-runtime-boundary-fixes.md) | Route host-reported direct-Captain result failures to the FSM failure state, derive the `bossIntent` interrupt field, name the runtime-owned `bossEvents` exclusions in `slc/link.md`, validate `bossEvents` under an overridden classifier, and retire PBRT-46's unit-only clause |
| IR-030 | [030-runtime-compatibility-metadata.md](iterations/030-runtime-compatibility-metadata.md) | Implement DR-022: the engine compatibility self-report, the `spec.compat` construction check with unit and run-path tests, the `slc/link.md` link-time `compat` emission, and the 3.1.0 release preparation |
| IR-031 | [031-runtime-engine-provisioning.md](iterations/031-runtime-engine-provisioning.md) | Implement DR-024: probe-first engine provisioning in `playbook run` with `--no-provision`, guard-order diagnostics, injected host roots, PBCLI-38 integration tests, and the fourth hermetic global-only acceptance case |
| IR-032 | [032-conversational-first-turn-resilience.md](iterations/032-conversational-first-turn-resilience.md) | Implement DR-025: `defaultBuildCaptainJudgePrompt` exported and reused by the compiled Captain, the corrective adjudication re-ask, internal-root failure disposal in the shell, and their integration tests |
| IR-033 | [033-optional-adapter-sdks.md](iterations/033-optional-adapter-sdks.md) | Implement DR-026: move both adapter SDKs to optional peers plus devDependencies, add the launcher and `run` SDK preflight with named install remedies, and re-aim the release smoke at the lean and opted-in global install shapes |
| IR-034 | [034-runtime-compatibility-from-cligent.md](iterations/034-runtime-compatibility-from-cligent.md) | Implement DR-027: descriptor-derived gate with per-runtime verdicts and pinned repairs, drop the peer-range mirror, and end `gemini`'s exemption |
| IR-035 | [035-empty-ok-result-re-ask.md](iterations/035-empty-ok-result-re-ask.md) | Implement DR-028: one corrective re-ask on an empty `ok` player or direct-Captain result under the unified empty predicate, with per-call trace pairs, PBRT-38 resume selection, and the PBRT-51 integration tests |
| IR-036 | [036-session-scoped-conversational-captain.md](iterations/036-session-scoped-conversational-captain.md) | Implement DR-029: the engine `describe`/`apply` control surface, rewritten CAPTAIN/CAPPLAY specs, the recompiled controller Captain, the durable-conversation shell rework, the cligent floor bump, and the three-tier acceptance plan — hermetic A-28/A-29 task gates, the fifth live conversational scenario, and the `pnpm smoke:release` release gate |

## Packages

### CAPTAIN

| Group | File | Summary |
| --- | --- | --- |
| user | [playbook-captain.md](user/playbook-captain.md) | Playbook Captain host Boss surface: the deterministic command table (start/deliver/switch/reply), the session Captain deciding every non-command turn, nested call/return, active-leaf visibility, external lifecycle status with dual switch facts, parking, dismissal, continuity-preserving failure recovery, and gated outcome-grounded turn summaries |
| dev | [playbook-captain.md](dev/playbook-captain.md) | Playbook Captain host behavior: registry loading, the session Captain started at `init` with journal and pinned durable conversation, validated action settlement over the controller port (start/switch/dismiss/deliver/`apply()` runtime actions), digest-carrying hidden decision envelopes with validated `emitReply` captain speech, shared queue, causal UUID stack, external-leaf visibility, trace pass-through, gated grounded summaries, telemetry, LIFO lifecycle, and journal-seeded conversation reseed |
| test | [playbook-captain.md](test/playbook-captain.md) | Integration tests for the command parse table, the closed decision set with one corrective re-ask, durable-call posture and token rotation, registry/reserved-name validation, bridges and hidden-judge envelopes, visibility/status privacy, causal nesting, gated grounded summaries, parking, dismissal, switch, LIFO disposal, journal-seeded reseed, and the observe–act–result, validated-action, continuity, and injection/prose-validation rows |

### CAPPLAY

| Group | File | Summary |
| --- | --- | --- |
| user | [captain-playbook.md](user/captain-playbook.md) | Default Captain controller behavior: natural session-long chat over one remembered conversation, per-turn decisions on the closed respond/start/switch/dismiss/deliver/runtime set, conversational multi-turn planning, faithful engaged delivery, and grounded closing replies with privacy rules |
| dev | [captain-playbook.md](dev/captain-playbook.md) | Captain source and session-loop machine (parked hub, shutdown-only final state), canonical compiled/verification bundle, controller-port consumption with settlement evidence, sanitized catalog and digest contract, durable hidden captain calls, the compiled decision/result prompt-contract pins, and the decision-call corrective re-ask |
| test | [captain-playbook.md](test/captain-playbook.md) | Compilation and shell integration tests for the session-loop machine, closed action set, settlement-evidence privacy, durable single-flight calls and trace completeness, status suppression, exact-text/no-investigation posture, decision-call re-ask coverage, and the six compiled prompt-contract pins |

### GIT

| Group | File | Summary |
| --- | --- | --- |
| dev | [git.md](dev/git.md) | Commit message format and AI co-authorship trailers |

### LIC

| Group | File | Summary |
| --- | --- | --- |
| dev | [licensing.md](dev/licensing.md) | SPDX header requirements and file-scope rules |
| test | [licensing.md](test/licensing.md) | Copyright and license header presence checks |

### PBCLI

| Group | File | Summary |
| --- | --- | --- |
| user | [playbook-cli.md](user/playbook-cli.md) | Generic `playbook` command: top-level `playbooks` config model with inline per-agent settings (no `config:` wrapper, no top-level `players`), starter-config seeding that enables CODE via explicit `from`, `--config` raw pass-through, `--list`, `--help`, launcher-owned adapter readiness gate, exit/signal behavior, launch under the Playbook Captain shell on tmux-play, the non-interactive `run <from> [task]` one-shot with parked-session `run resume <session-id>`/`--last` continuation, per-run `<adapter>[:<model>][@<effort>]` bindings with config-supplied defaults from the user config's `run` block, repeatable `--with <path>` top-level config overlays, automatic engine provisioning for filesystem registry modules with `--no-provision`, and the adapter SDK preflight that names each missing SDK's install command |
| dev | [playbook-cli.md](dev/playbook-cli.md) | Generic `playbook` launcher: tmux-play resolution, config normalization, namespaced roster generation, pre-launch manifest checks including reserved `captain` id/command/role rejection, launcher-owned initial visibility, seeded protected-auto lineup, adapter readiness, the headless `run` host over cligent `Cligent` with its exit-code map, XDG parked-session store, and resume flow, plus `--with` overlay merging, adapter-scoped effort validation, run-defaults loading from the resolved user config, probe-first symlink engine provisioning from the host's own tree, and the `isAvailable()`-based adapter SDK probe shared by the gate and the run path |
| test | [playbook-cli.md](test/playbook-cli.md) | Integration tests for seeding, composition, namespaced visibility, reserved `captain` id/command/role rejection, readiness, the `--list`/`--help`/`--config`/exit-code surface, the `run` subcommand over an injected agent runner including the park/resume lifecycle over an injected session store, per-run tuning (effort grammar, `--with` overlays, config-driven run defaults over an injected user-config path), the incompatible linked-artifact diagnostic, engine provisioning over synthetic modules and injected host roots, and the adapter SDK preflight over an injected probe |

### PBRT

| Group | File | Summary |
| --- | --- | --- |
| user | [playbook-runtime.md](user/playbook-runtime.md) | CODE Boss surface after a turn reaches CODE: free-text classification, `awaitBossReply` reply-vs-directive behavior, Captain-pane progress, and tmux-play host configuration through `@sublang/playbook/playbook-captain` with host-owned fields such as notifications, namespaced `code-coder`/`code-reviewer` binding, plus CODE options under `captain.options.playbooks.code.options` and the Committer alias |
| dev | [playbook-runtime.md](dev/playbook-runtime.md) | Linked runtime behavior: six host-agnostic ports including direct Captain, causal sessions, Captain/player/judge/nested traces, continuation, the single empty-result corrective re-ask at the player and direct-Captain boundaries, constrained DISCUSS review-scope adjudication, XState parallel joins and structured state, nested call/resume, abort, telemetry, the optional parked-session snapshot capability, the optional `describe`/`apply` control surface with runtime-advertised retry/jump actions, keyed at-most-once receipts, and paired apply traces, the engine compatibility self-report with the `spec.compat` construction check, and the public contract |
| test | [playbook-runtime.md](test/playbook-runtime.md) | Integration tests for six-port identity, Captain/player/judge traces and abort, continuation, empty-result re-ask recovery at both boundaries incl. re-ask prompt/resume fidelity, constrained DISCUSS review-scope adjudication, parallel DISCUSS and branch waits, structured state, nested call/resume, parked-session snapshot round trips, control-surface views, action derivation, and receipt idempotency, lifecycle, and registry wiring |

### PLAYBOOK

| Group | File | Summary |
| --- | --- | --- |
| dev | [playbook.md](dev/playbook.md) | CODE playbook FSM ↔ GEARS conformance contract (source agreement, transition coverage, prompt composition, Reviewer review-only and spec-checklist prompts) |
| test | [playbook.md](test/playbook.md) | Integration tests pinning the FSM ↔ GEARS conformance contract and Reviewer prompt contracts under `pnpm test` |

### RELEASE

| Group | File | Summary |
| --- | --- | --- |
| dev | [release.md](dev/release.md) | npm/GitHub release workflow, local pre-release real-agent tmux and non-interactive acceptance, install closure with a nested `@sublang/cligent`, optional-peer adapter SDKs, and the `@sublang/spex` GEARS-grammar dependency, and semver-stable runtime, SLC, CLI, CODE/DISCUSS registry, and default `captain/playbook` package surfaces, including packed Captain, CODE, and DISCUSS sources and compiled artifacts with no Captain registry export |
| test | [release.md](test/release.md) | Integration tests for install closure across the lean and opted-in global shapes, optional-peer SDK declaration shape, dependency/lock agreement, SLC and `@sublang/spex` GEARS-definition resolution, packed runtime, Captain, and CODE/DISCUSS source artifacts, CLI/registry/`captain/playbook` exports with retired and internal-only surfaces absent, plus opt-in local real-agent `/code`, `/discuss`, and headless `playbook run` acceptance and conditional manual tmux UX smoke |

### SKETCH

| Group | File | Summary |
| --- | --- | --- |
| user | [sketch.md](user/sketch.md) | XState sketch visualizer: diagram and live-activity behavior |
| dev | [sketch.md](dev/sketch.md) | Architecture, telemetry protocol, and lifecycle contracts |
| test | [sketch.md](test/sketch.md) | Integration tests for diagram, telemetry derivation, and lifecycle |
