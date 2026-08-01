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
Routing and reassessment answers shall resume their originating Captain leaf
through the universal Boss-reply continuation; text2gears shall not model an
answer as a separate GEARS item or working state.
The machine shall record each selected child's stable target id and exact
complete input before invocation, using a collision-free serialized tuple, and
shall reject that exact pair on a later continuation whether the prior child
succeeded, aborted, or failed. That deterministic history is private prompt
state and does not replace Captain's broader semantic no-repeat instruction.

### CAPPLAY-7

Where the default Captain runtime is constructed, the shell shall supply an immutable catalog containing only each enabled callable playbook's stable id, effective command, and intent, excluding the internal Captain and all module, option, player, token, session, call, and stack data; when the FSM selects a dynamic target, it shall validate the id against that catalog and the shell shall independently validate it against the enabled registry before opening a child.

### CAPPLAY-8

Where a compiled GEARS behavior has Captain decide routing or reassess results, the FSM shall invoke a first-class `captain` actor and the linked runtime shall call `PlaybookPorts.callCaptain` visibly with a fresh-session request and an explicit empty tool allowlist; where Captain delegates behavior to a named player, the FSM shall invoke a distinct `player` actor and the runtime shall call `callPlayer`; the host shall serialize all Captain and judge work, including visible Captain and hidden `callJudge` calls, through one abort-aware concurrency-one queue, apply the same fresh tool-free isolation to the default Captain's hidden adjudication, fail closed when the adapter cannot enforce it, and trace Captain calls with paired `captain.call.started` and `captain.call.finished` events.

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

### CAPPLAY-16

Where SLC compiles the default Captain source, explicit result contracts shall be source metadata outside acting-agent blockquotes and the verifier shall compare them with every generated invocation result map; the initial routing state shall declare only question and delegation outcomes plus universal Boss-reply suspension, ready-state entry shall carry the exact Boss text without classification, and any classifier used after parking shall select only an event kind while the runtime attaches the original text.
Visible Captain prompts shall contain only the supplied evidence and human
decision instructions, with no guard names, result property names, control
JSON request, workspace-investigation request, or private chain-of-thought
request. For a question or final outcome, the linked runtime shall preserve
the corresponding visible Captain call's exact final text as `question` or
`response`; hidden adjudication may select the guard and structural plan
fields but shall not replace that human prose.

### CAPPLAY-18

Where the compiled default Captain adjudicates a visible routing or
reassessment reply, the linked runtime shall compose the hidden
`captain-output-adjudication` prompt through the engine's exported
`defaultBuildCaptainJudgePrompt`, which states the explicit
`{ guard, …structuralPayloadFields }` JSON reply contract over the state's
declared result keys and instructs the judge to omit `question` and
`response`.
When an adjudication reply fails structural validation — no recoverable JSON
object, a missing or undeclared `guard`, an undeclared field, or a missing or
malformed required structural field — the runtime shall issue exactly one corrective
judge call that appends the rejection reason and the restated reply shape to
the same prompt, and shall adjudicate the second reply; a second malformed
reply shall latch the control error, park the machine in its recoverable
`failed` state, and reject the boundary call, and a rejected or aborted judge
transport call shall not trigger the corrective re-ask.
Each judge call, initial or corrective, shall trace its own paired
`judge.call.started` and `judge.call.finished` boundaries.
