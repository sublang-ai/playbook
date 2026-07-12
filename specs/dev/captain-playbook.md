<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPPLAY: Default Captain playbook

## Intent

This spec defines the source, compiled runtime, host integration, and compiler contracts for the default generic Captain playbook.
Essential project-specific references are the `reference/sdlc/captain.md` source, `slc` compiler definitions, and Playbook Captain shell.

### CAPPLAY-6

Where the package ships the default Captain playbook, the maintained source shall be `reference/sdlc/captain.md` and `slc playbook` shall compile it into `reference/sdlc/captain.playbook/` GEARS, XState FSM, linked runtime, and verification artifacts; the FSM shall implement a finite `ready` to decision to dynamic child call to reassessment loop, require every continuation to make `remainingPlan` strictly shorter, and return a JSON-safe `{ response }` terminal output; the repository shall retain the complete generated verification bundle, while the published npm subset and public runtime export shall follow [RELEASE-20](release.md#release-20).
The initial `ready` hub shall carry `playbook.parked`, and a consumed routing
or reassessment answer shall clear its pending question and reply before the
machine enters a child-call or terminal state.

### CAPPLAY-7

Where the default Captain runtime is constructed, the shell shall supply an immutable catalog containing only each enabled callable playbook's stable id, effective command, and intent, excluding the internal Captain and all module, option, player, token, session, call, and stack data; when the FSM selects a dynamic target, it shall validate the id against that catalog and the shell shall independently validate it against the enabled registry before opening a child.

### CAPPLAY-8

Where a compiled GEARS behavior has Captain act directly, the FSM shall invoke a first-class `captain` actor and the linked runtime shall call `PlaybookPorts.callCaptain` visibly; where Captain delegates behavior to a named player, the FSM shall invoke a distinct `player` actor and the runtime shall call `callPlayer`; the host shall serialize all direct Captain and judge work, including visible Captain and hidden `callJudge` calls, through one abort-aware concurrency-one queue and shall trace Captain calls with paired `captain.call.started` and `captain.call.finished` events.

### CAPPLAY-9

Where the shell is idle, when it receives ordinary Boss text, it shall lazily construct the internal `captain` root and submit the text; while a runtime stack exists, after handling the registered command forms specified by [CAPTAIN-7](playbook-captain.md#captain-7), it shall route original ordinary Boss text according to the active leaf and shall not let a new root selection replace that stack; an engaged lifecycle-only classifier may dismiss the leaf only for an explicit stop or dismissal request, shall receive no registry, ledger, frame, session, or call identity, and shall fail open to unchanged delivery on rejection, throw, non-`ok` status, absent text, malformed JSON, or an unknown decision; the internal root shall require no generated player or command, make no visibility request, and emit no `/captain` lifecycle status.
The shell shall suppress every human `emitStatus` call made by the hidden
internal Captain runtime while continuing to forward its structured telemetry;
internal state ids and context belong only on that telemetry channel.

### CAPPLAY-10

Where the compiler emits a dynamic nested call, its invocation shall carry runtime `playbookId` and text from typed context plus explicit static metadata naming those context fields; SLC verification shall compare the metadata with the GEARS dynamic-call declaration, verify the context wiring, and exercise scripted child success and failure without evaluating implementation source text.
The FSM shall reduce each child return to reassessment evidence containing only
the selected playbook id, `ok` / `aborted` / `error` status, actual JSON-safe
child output, or a compact `{ name, message }` error. It shall not retain a
child session id, call id, child state, stack, or opaque runtime result in the
Captain-visible completed-results context.
