<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-014: Playbook Captain shell

## Status

Done

## Intent

Implement [DR-008](../decisions/008-playbook-captain-shell.md) in reviewable slices.
The end state is a built-in Playbook Captain shell as the tmux-play Captain, with CODE registered as the first sub-runtime, `/code` as the explicit playbook-selection command, hidden routing and hidden CODE judge calls in one Captain session, telemetry-mirrored sub-runtime state, park/resume semantics, and a `./code/tmux-play` compatibility shim that delegates to the shell.

## Deliverables

- [x] IR-014 doc and its `map.md` row.
- [x] Runtime/user/test specs amended for DR-008: playbook-runtime-1/2 scoped to engaged CODE turns; playbook-runtime-15/16/30 amended for the shell target, registry construction, and CODE registry option validation; playbook-runtime-29 and PBCODE-16 amended so composed `captain.from` points at the shell adapter; playbook-runtime-12's direct-runtime/no-change disposition recorded; shell engagement/status behavior specified in a CAPTAIN package; stale DR-004/DR-006 direct-adapter wording reconciled.
- [x] Upstream cligent shared-session contract verified or amended before the shell relies on one Captain session across visible chat, hidden routing, and sub-runtime judge calls.
- [x] Playbook Captain shell adapter implemented with a registered CODE entry, bounded control ledger, visible chat envelope, hidden router envelope, hidden sub-runtime judge calls, and pass-through status/telemetry.
- [x] Shell routing implemented for registered commands, hidden router decisions, same-playbook command continuation, different-playbook rejection while engaged, and dismiss.
- [x] Shell park/resume/final-disposal behavior implemented from mirrored `playbook.fsm.state` telemetry.
- [x] CODE tmux-play compatibility shim delegates to the same shell with CODE registered.
- [x] `playbook-code` composer, package exports, example configs, generated `.js`/`.d.ts` siblings, and README updated for the shell adapter path while preserving explicit `./code/tmux-play` users.
- [x] Tests cover shell routing, hidden control calls, shared-session call surfaces, telemetry mirroring, park/resume/dismiss/final disposal, CODE option validation through the registry, compatibility shim behavior, and composer output.
- [x] Close-out re-verifies `map.md` and records any DR-008 divergence.

## Tasks

Each task is one commit.
Order keeps `main` building and reviewable by landing specs before behavior, extracting reusable CODE registration before switching the public launch path, and moving the composer only after the shell can carry the existing CODE tests.

1. **Land IR-014 + map.md row.** _[done]_
   Add this doc and its `map.md` row.
   No runtime behavior change.
2. **Spec amendments.** _[done]_
   Amend playbook-runtime-1/2/15/16/29/30, PBCODE-16, and the matching test specs for DR-008.
   Record playbook-runtime-12's no-change disposition: direct runtime use may still restart terminal CODE actors, while the shell disposes final sub-runtime engagements instead.
   Add the CAPTAIN user/dev/test package for shell chat, routing, engagement status, telemetry topic separation, and park/resume/dispose behavior.
   Reconcile DR-004/DR-006 direct-adapter wording with the DR-008 shell target.
   Prose only; no code.
3. **Extract CODE registration.** _[done]_
   Factor CODE option validation and runtime construction into a registry entry that the existing direct adapter can use without changing behavior.
   Keep `code.tmux-play.ts` as the active adapter for this task and keep existing adapter tests green.
   Implementation note: `code.registry.ts` now owns CODE metadata, option validation, and runtime construction, and the existing direct adapter delegates to it while remaining the active adapter.
4. **Add the shell adapter for explicit CODE commands.** _[done]_
   Verify upstream cligent specs pin one continuous Captain session across visible chat and delegated hidden calls, or amend upstream before relying on that contract.
   Implement the Playbook Captain shell factory with CODE registered, `/code <text>` dispatch, bare `/code` engagement chat, same-playbook command continuation, and pass-through CODE ports.
   Add focused shell tests for explicit command routing and hidden CODE judge calls.
   Upstream verification note: `@sublang/cligent@0.11.0` ships docs that define custom Captains retaining `CaptainSession` and using `context.callCaptain`, docs that define `Cligent` resume-token continuity across runs, and a tmux-play runtime that routes every `context.callCaptain` call through one `captainCligent` instance while applying per-call visibility.
   `playbook-captain.ts` now implements the CODE-registered shell factory for explicit `/code` routing, and `playbook-captain.test.ts` covers init validation, lazy engagement, bare `/code` visible chat, same-runtime continuation, and hidden sub-runtime judge calls.
5. **Add hidden router and visible chat.** _[done]_
   Add the hidden router call with closed `chat` / `dispatch` / `sub` / `dismiss` decisions, unregistered-slash fallthrough, near-miss clarification, and the visible chat envelope.
   Add tests that hidden router calls pass `{ visibility: 'hidden' }` and that visible chat does not expose control JSON.
   Implementation note: `playbook-captain.ts` now sends non-command routing through a hidden control envelope, parses closed router decisions, falls back to visible clarification on invalid router output, and keeps visible chat on a separate non-control envelope.
6. **Add park, resume, dismiss, and final disposal.** _[done]_
   Mirror sub-runtime state from `playbook.fsm.state` telemetry, park on idle/failed/awaitBossReply, resume parked CODE turns, reject different-playbook commands while engaged, dismiss active engagements, and dispose on final.
   Add tests for each lifecycle path and for the shell telemetry topic not colliding with `playbook.fsm.state`.
   Implementation note: `playbook-captain.ts` now mirrors sub-runtime FSM telemetry into the shell ledger before pass-through, parks on CODE idle/failed/`awaitBossReply`, emits shell FSM telemetry on `playbook.captain.fsm.state`, disposes final and dismissed engagements with shell status lines, and constructs replacements after disposal.
7. **Switch public launch paths.** _[done]_
   Point `playbook-code` composed configs and the primary package export at the shell adapter.
   Turn `./code/tmux-play` into the compatibility shim that delegates to the shell with CODE registered.
   Update example configs, README, generated siblings, and composer/compatibility tests.
   Implementation note: `playbook-code` now composes `captain.from: @sublang/playbook/playbook-captain`, the package exports that shell subpath while keeping `./code/tmux-play` as a delegating shim, example configs and README name the shell path, and compatibility tests drive CODE through `/code` on the shim.
8. **Close-out.** _[done]_
   Run the relevant test suite, re-verify `specs/map.md`, and record any substantive divergence from DR-008 in this IR.
   Close-out note: `specs/map.md` still reflects DR-008, IR-014, CAPTAIN, PBCODE, and PBRT after the launch-path switch.
   Close-out note: no substantive divergence from DR-008 was found.
   Audit note: host adapter teardown through tmux-play `Captain.dispose()` is intentionally not treated as Boss-facing engagement disposal; cligent closes session emissions before calling Captain teardown, so the shell clears local state and disposes the active sub-runtime without emitting shell status or shell FSM telemetry on that teardown path, while dismiss and final engagement disposal still emit the DR-008/CAPTAIN status and telemetry.

## Verification

- The tmux-play `captain.from` value composed by `playbook-code` targets the Playbook Captain shell adapter, and `./code/tmux-play` still works by delegating to that shell.
- The shell supports `/code`, hidden router dispatch, visible chat, active-sub-runtime continuation, dismiss, and final disposal without teaching the shell CODE's in-playbook event taxonomy.
- Every control-plane Captain call for routing and CODE judge work uses `{ visibility: 'hidden' }`; visible chat uses a separate prompt envelope and never asks for or displays control JSON.
- The shell mirrors CODE state from sub-runtime telemetry, parks on CODE idle/failed/awaitBossReply, disposes on CODE done, and passes sub-runtime status and telemetry through in order.
- Shell FSM telemetry uses a topic distinct from `playbook.fsm.state`.
- CODE options stay under `captain.options.code`, are validated by the CODE registry entry, and reject unknown keys with path-named errors.
- Tests covering the new shell, compatibility shim, composer, and existing CODE runtime behavior pass from the repo root.
