<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# GEARS-to-Finite-State-Machine Transformation

Second phase of a playbook (a state-machine agent orchestrating other agents).
Transforms normative GEARS spec items into an XState v5 finite state machine.

- Source: GEARS spec items produced by the first phase.
- Target: an XState v5 machine object artifact [[1]].

Target is an object artifact only: it defines the machine, actor contracts, and typed inputs, but shall not bind a runner or supply concrete runtime implementations.

## Formats

| Role | Format | Extension |
| --- | --- | --- |
| source | gears | .md |
| target | fsm | .ts |

## Setup

The artifact shall use XState v5's `setup(...)` then `.createMachine(...)` [[10]].
The artifact shall restrict itself to erasable TypeScript syntax — type annotations that strip cleanly, no constructor parameter properties, `enum`s, or namespaces — so a host running under type stripping loads it directly.
The `types` block shall declare `context`, `events`, machine `input`, and a typed `Captain` actor contract [[11]].
The artifact shall not import a runner or bake in a concrete Captain implementation; any actor placeholder shall fail explicitly (e.g., throw `'captain actor must be provided by the runner'`).

`CaptainInput` shall be a typed object with at least:

- `stateId`: the stable id of the invoking working leaf;
- `player`: the [player](text2gears.md#players) Captain is to invoke;
- `sourceItem`: the GEARS item ID this state realizes;
- `prompt`: the source item's full final prompt, verbatim;
- `result`: a record whose keys are the valid guard names this invocation may return.

`CaptainOutput` shall be a discriminated object with `guard: string` and any extracted fields downstream states need.

Guard names shall be specified and interpreted **per state**, not as a global union.
A global union encourages name reuse with divergent semantics and couples unrelated states.
Shared helpers may accept `string`, but each state's `invoke.input.result` is the authoritative local contract.

## States

Each state shall declare:

- a stable `id` (for `#id` targeting and Boss interrupts);
- an intuitive state key (the property name under `states: { ... }`);
- a one-line `description` (for inspector tools and documentation);
- JSON-safe `meta: { playbook: { stateId, description } }` repeating its
  stable id and description so linked runtimes can discover active public
  identities through `snapshot.getMeta()` without private XState nodes;
- if it invokes Captain: `invoke.input` carrying `player`, `sourceItem`, `prompt`, `result` (per [Setup](#setup)).

The source item ID shall live in `invoke.input.sourceItem`, not in a comment — this keeps the GEARS-to-state mapping machine-readable.
A state's `invoke.input.player` shall match its source item's player.

The machine's initial state shall be a quiescent idle hub (no `invoke`) — typically `ready` — that accepts the Boss entry events.
Captain-invoking work begins only on a Boss-originated event, so constructing and starting the machine performs no player call.

Captain returns a discriminated result with `guard` set to one of `input.result`'s keys [[4]].
Guards [[5]] on `onDone` transitions inspect `event.output.guard` to route.

Example:

```typescript
invoke: {
    src: 'captain',
    input: ({ context }): CaptainInput => ({
        stateId: '<stable-state-id>',
        player: 'Reviewer',
        sourceItem: '<ITEM-A>',
        prompt: [
            'Flag any issues or improvements (numbered; no duplication).',
            "Think thoroughly — don't just approve or reject.",
        ].join('\n'),
        result: {
            hasFindings: 'Reviewer raised issues or suggestions.',
            noFindings: 'Reviewer has no findings.',
        },
    }),
    onDone: [...],
    onError: { target: 'failed', actions: 'rememberCaptainError' },
}
```

## Mapping

Each Source spec item shall map to exactly one state in Target.
A state's `invoke.input.sourceItem` shall be that item's ID, and `invoke.input.prompt` shall carry the item's prompt verbatim.

Per text2gears [composition](text2gears.md#composition), each spec item already carries the full final prompt for one state behavior, with no duplicate lines.
The FSM compiler shall not concatenate prompts across items, re-compose them, or silently dedupe.
A spec item that still contains duplicate prompt lines is malformed; the compiler shall reject or flag it rather than silently propagate the duplication into `invoke.input.prompt`.

## Parallel groups

Items carrying the same `Parallel group: <id>` metadata shall compile into one
compound state with `type: 'parallel'` and one region per item [[12]].
Each region shall contain a Captain-invoking working leaf and a local final
state; the working leaf retains the item's stable state id, `sourceItem`,
player, prompt, and result contract.
The parallel parent shall use `onDone` as the join, which XState takes only
after every region reaches final.

Each branch shall assign only its own staged result.
The join shall promote all staged results atomically before later work begins,
so branch completion order cannot change downstream inputs.
Transitions between sibling regions are forbidden.

Working leaves shall carry tag `playbook.busy`.
A branch that supports Boss-reply suspension shall use a local waiting leaf
tagged `playbook.parked` rather than exit the parallel parent; `BOSS_REPLY`
shall identify and reenter only the waiting branch.
If several branch questions are pending, the event shall carry a stable
question id and the classifier shall not guess among them.
A fresh entry event or root interrupt may exit the complete parallel parent and
shall clear its staged results and branch questions.
An invoke error shall exit to the root failure state, allowing XState to stop
the sibling invocations automatically.

## Nested playbook calls

An item whose behavior is `Captain shall call playbook <playbook-id>:` shall
compile to a state that invokes a typed `playbook` actor, not the `captain`
actor.
The setup types shall declare `PlaybookInput` with stable `stateId`, target
`playbookId`, and composed `text`, plus a JSON-safe `PlaybookOutput` received
from the child.
The artifact shall supply a failing placeholder for `playbook`, just as it does
for `captain`; the linked runtime provides the actor implementation.

The call state shall carry tag `playbook.suspended` and shall route
`invoke.onDone` from child output and `invoke.onError` from child failure.
The child call shall remain state-scoped: leaving the call state stops the
invoked actor and aborts the host call through XState's invocation signal
[[2]].
The FSM shall not allocate runtime call ids, construct child sessions, retain
runtime promises, or route Boss text to the child.

## Context and prompts

Context fields used to drive guards or compose prompts shall be **typed and named**.
The compiler shall not branch on untyped properties of `lastResult`; persistent routing decisions belong in typed context fields. (`lastResult` is for inspection only.)

Prompts shall pass only the **specific extracted fields** the player needs.
The compiler shall not dump `JSON.stringify(lastResult)` or any opaque blob: it leaks internal `guard` strings, wastes tokens, and confuses the LLM.

Player bindings and per-run parameters shall flow in via the machine's `input` and be copied into context at start-up.
The artifact shall not bake in player bindings, model names, or per-run values.

## Transitions

A transition fires on an event — typically `onDone` (actor completed) [[4]].
When multiple are possible, a synchronous guard [[5]] picks the path.
Transitions shall persist relevant typed fields from `event.output` to context via `assign` [[6]] so downstream prompts can read them.
Transitions shall be self-driving when source items define the next obligation.
Routing to an idle hub is for recovery, unrecoverable Boss input, or one-shot entry events — not the happy path.

### Auto-advance on approval

A review/approval state's success outcome shall **target the next workflow step**, not idle back to a hub.
Returning to Boss on success is a defect: it forces manual stepping.

### Don't re-validate what already passed

A state following an approval shall not enter a fresh approval of the same content — that adds latency and risks ping-pong loops.
A state may route through approval once when its input came from an unreviewed branch (e.g., re-do without an intervening review).

### One feedback cycle across phases

When the source has a feedback cycle, all phases that need feedback shall reuse it, not duplicate it per phase.
Phases may set typed routing fields so terminal outcomes return to the originating branch.

## Boss control

[Boss](text2gears.md#players) input enters the machine through three surfaces: pre-emptive interrupts on active states, typed entry events on idle or recoverable states, and Boss replies to player questions that suspended the FSM in a dedicated wait state.

### Boss interrupts

Boss may interrupt any active state at any time. Every jumpable state shall have a stable `id` [[9]].
The runtime sends `{ type: 'BOSS_INTERRUPT', targetId: '<id>' }`; the root machine handles it with one guarded transition per jumpable state targeting `#<id>` with `reenter: true` [[7]][[8]][[9]], so invoked actors restart cleanly.
The compiler shall emit a `bossInterrupts(ids)` helper rather than hand-writing one transition per state.
XState automatically stops the current state's invoked actor on transition [[2]].

### Boss entry events vs. BOSS_INTERRUPT

`BOSS_INTERRUPT` jumps into an **active** machine, pre-empting whichever state is running.
**Boss entry events** start or resume from idle or recoverable states when Boss-supplied parameters can't be inferred from machine state alone.
Entry events shall be typed alongside `BOSS_INTERRUPT` and populate context via a dedicated action.
An entry event's copy action shall not clear per-run parameters the event omits: an absent optional field falls back to the existing (input-seeded) context value.
The two surfaces shall not be collapsed: `BOSS_INTERRUPT` cannot carry payload, and a parameterless entry event may collapse to interrupt-style routing only when state-jump semantics are identical.
Entry events shall not be root-level transitions from every active state unless the workflow supports pre-emption; they belong on idle and recoverable states (e.g., `failed`).

### Boss-reply suspension

When a captain-invoking state needs a Boss decision the player cannot supply alone, the machine shall suspend that task in a quiescent wait state and resume the same task with the Q+A in the next prompt.
This is a third Boss surface alongside `BOSS_INTERRUPT` and Boss entry events.

Every captain-invoking state supports this path.
There is no source-level opt-in annotation and no `needsBossReply` result metadata in GEARS output.
The FSM compiler shall preserve the GEARS blockquote as the state's domain `prompt` body and shall not inject any Boss-question instruction into `invoke.input.prompt`.

For every captain-invoking state, the compiler shall add `needsBossReply` to the state's `invoke.input.result` map.
The description shall be the standard adjudicator-facing text:

```text
The player's prose surfaces a clarifying question for Boss that the player cannot answer alone. Output shall include `question: <verbatim question text from the player's prose>`.
```

It shall include the load-bearing substring ``Output shall include `question:`` so the runtime's adjudicator requires `question` in the JSON reply.
The linked runtime composes player prompts per [link.md "Player prompt composition"](link.md#player-prompt-composition), without adding a player-visible Boss-question instruction.

The question record shall be
`{ questionId, resumeStateId, sourceItem, player, question }`.
`questionId` and `resumeStateId` shall both equal the stable working-leaf
`stateId`.
`questionId`, `resumeStateId`, `sourceItem`, and `player` shall come from
the suspended working leaf's stable invocation metadata; only `question` shall
come from adjudicated player output.

A machine with at most one active Captain task may use the scalar form:

- An `awaitBossReply` state with stable `id: 'awaitBossReply'`, tag
  `playbook.parked`, and description
  `Waiting for Boss to answer a player question.`.
- A `BOSS_REPLY` event carrying `{ answer: string; questionId?: string }`.
- Context fields `pendingBossQuestion?: PendingBossQuestion` and
  `bossReply?: string`.
- `resumableStates(ids)`, `setPendingBossQuestion`, and
  `clearBossReplyContext` helpers with the existing single-question behavior.

A machine with parallel Captain tasks shall use the keyed form:

- One local waiting leaf per branch, tagged `playbook.parked`.
- A `BOSS_REPLY` event carrying `{ questionId: string; answer: string }`.
- Context fields
  `pendingBossQuestions: Partial<Record<ResumableStateId, PendingBossQuestion>>`
  and `bossReplies: Partial<Record<ResumableStateId, string>>`.
- Helpers that set, answer, and clear only the named branch record; exiting the
  complete parallel group for a fresh directive or interrupt clears every
  record owned by that group.

Where exactly one question is pending, a linked runtime may accept a classifier
reply that omits `questionId` and fill that sole id.
Where several questions are pending, the classifier prompt and event shall
require `questionId` and shall reject an omitted or unknown id without moving
the FSM.

The scalar `awaitBossReply` state and every local branch wait are quiescent for
the runtime drive boundary.
They shall allow a fresh root entry event or interrupt to abandon the relevant
pending question data before starting new work.

A captain-invoking state's `invoke.input` function shall carry the pending
question and reply selected for that working leaf as singular
`pendingBossQuestion` and `bossReply` fields, regardless of the scalar or keyed
context representation, so prompt composition has one stable contract.
When both fields are present, the linked runtime shall compose the continuation preamble and labelled Q&A blocks per [link.md "Player prompt composition"](link.md#player-prompt-composition).
The FSM artifact shall not bake the continuation preamble into the GEARS-derived `prompt` body.

The following malformed states shall route to `failed` per [Errors and termination](#errors-and-termination):

- Captain output has `guard: 'needsBossReply'` but no `question` field.
- Captain output declares `needsBossReply` from a state without a registered
  scalar or branch-local resume route.
- `BOSS_REPLY` fired with empty or whitespace-only `answer`.
- A keyed `BOSS_REPLY` names no pending question.

## Errors and termination

Every `invoke` shall declare an `onError` handler routing to a dedicated `failed` state, with the error captured in `context.lastError` for inspection.
`failed` is not `final`: Boss may interrupt out of it to recover.

Every machine shall declare at least one `type: 'final'` state (typically `done`) reachable on completion.
A never-terminating machine is a defect: the runner has no completion signal.

## References

[1]: https://stately.ai/docs/xstate "XState Official Documentation"
[2]: https://stately.ai/docs/invoke "Invoke — invoking actors from states"
[3]: https://stately.ai/docs/input "Input — passing data to invoked actors"
[4]: https://stately.ai/docs/output "Output — receiving actor results via onDone"
[5]: https://stately.ai/docs/guards "Guards — synchronous transition conditions"
[6]: https://stately.ai/docs/context "Context — persistent state and assign"
[7]: https://stately.ai/docs/transitions "Transitions — reenter, root-level routing"
[8]: https://stately.ai/docs/parent-states "Parent states — root-level event handling"
[9]: https://stately.ai/docs/finite-states "Finite states — state IDs"
[10]: https://stately.ai/docs/setup "Setup — typed machine setup"
[11]: https://stately.ai/docs/actors "Actors — typed actor contracts"
[12]: https://stately.ai/docs/parallel-states "Parallel states — concurrent regions and onDone joins"
