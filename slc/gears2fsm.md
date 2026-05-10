<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# GEARS-to-Finite-State-Machine Transformation

This is the second phase in defining a playbook: a state-machine-powered AI agent that coordinates multiple AI agents to carry out a defined procedure.
This phase transforms normative GEARS spec items into an XState v5 finite state machine.

- Source: GEARS spec items produced by the first phase.
- Target: an XState v5 machine object artifact [[1]].

The target is an object artifact only.
It defines the state machine, actor contracts, and typed inputs; it shall not bind a runner or provide concrete runtime implementations.

## Formats

| Role | Format | Extension |
| --- | --- | --- |
| source | gears | .md |
| target | fsm | .ts |

## Setup

The compiled artifact shall use XState v5's `setup(...)` and call `.createMachine(...)` on the setup result [[10]].
The `types` block shall declare `context`, `events`, machine `input`, and a typed `Captain` actor contract [[11]].
Accordingly, the artifact shall not import a project runner or bake in a concrete Captain implementation.
If the artifact emits an actor placeholder, that placeholder shall fail explicitly (e.g., throw `'captain actor must be provided by the runner'`) rather than performing any work.

`CaptainInput` shall be a typed object with at least:

- `role`: the [role](text2gears.md#roles) Captain is to invoke;
- `sourceItems`: the GEARS item IDs composed into this prompt;
- `prompt`: the composed prompt;
- `result`: a record whose keys are the valid guard names this invocation may return.

`CaptainOutput` shall be a discriminated object with `guard: string` and any extracted fields downstream states need.

Guard names shall be specified and interpreted **per state**, not collected into a single global union of every guard the machine ever uses.
A global union encourages name reuse with divergent semantics and silently couples unrelated states.
Shared guard helper functions may accept `string`, but each state's `invoke.input.result` remains the authoritative local result contract.

## States

Each state shall declare:

- a stable `id` (used for `#id` targeting and Boss interrupts);
- an intuitive state key (the property name under `states: { ... }`, what humans read in code);
- a one-line `description` summarizing what the state does (used by inspector tools and as living documentation);
- if it invokes Captain: an `invoke.input` carrying `role`, `sourceItems`, `prompt`, and `result` (per [Setup](#setup)).

Listing source items in `invoke.input.sourceItems` makes the GEARS-to-state mapping machine-readable.
Comments listing source IDs are not sufficient; the IDs shall live in the structured input.

A state's `invoke.input.role` shall match the role named by every composed source item.
If two items name different roles, or require Captain to ask different roles to act, they cannot share a state.

Captain follows the instructions and returns a discriminated result with `guard` set to one of the keys of `input.result` [[4]].
Guards [[5]] on `onDone` transitions inspect `event.output.guard` to choose the next state.

Example:

```typescript
invoke: {
    src: 'captain',
    input: ({ context }): CaptainInput => ({
        role: 'Reviewer',
        sourceItems: ['<ITEM-A>', '<ITEM-B>'],
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

## Composition

A single state in Target may correspond to multiple Source spec items, reversing the [abstraction](text2gears.md#abstraction) from the first phase.
All prompts from those items shall be composed into the state's `invoke.input.prompt`, and all their IDs shall be listed in `sourceItems`.

Items shall be composed into one state only when **role, condition, and downstream outcomes are identical**.
If two items lead to different next states, they shall be split into separate states with explicit IDs rather than gated by ad-hoc context flags.
Differences in subject matter, next workflow step, or required event payload are semantic differences and shall be represented as distinct states or distinct typed context fields, not hidden inside `lastResult`.

## Context and prompts

Context fields used to drive guards or compose prompts shall be **typed and named**.
The compiler shall not branch on untyped properties of `lastResult`.
`lastResult` is useful for inspection, but persistent routing decisions shall be promoted to typed context fields.

Prompts shall pass only the **specific extracted fields** the role needs.
The compiler shall not dump `JSON.stringify(lastResult)` or any opaque blob into prompts: it leaks internal `guard` strings, wastes tokens, and confuses the LLM.

Role bindings (which concrete player or agent fills a role) and any per-run parameters shall be supplied via the machine's `input` argument and copied into context at start-up.
The artifact shall not bake in role bindings, model names, or per-run values.

## Transitions

A transition fires on an event — typically `onDone` (the current state's actor completed) [[4]].
When multiple transitions are possible, a synchronous guard [[5]] inspects event data to choose the path.
Each transition shall persist the relevant typed fields from `event.output` to context via `assign` [[6]], making them available to downstream prompts.
Transitions shall be self-driving whenever the source items define the next procedural obligation.
Routing to an idle hub is appropriate for explicit recovery, an unrecoverable need for Boss input, or ad-hoc one-shot entry events; it is not appropriate for the ordinary happy path of a playbook.

### Auto-advance on approval

A review or approval state's success outcome shall **encode and target the next workflow step**, not idle back to a hub.
A review whose success returns control to the Boss is a defect: it forces the Boss to drive every step manually.

### Don't re-validate what already passed

A state that follows an approval shall not transition into a fresh approval of the same content.
The prior approval already validated it; re-validating only adds latency and risks ping-pong loops.
A state may route through approval once when its input was produced by an unreviewed branch (e.g., a re-do without an intervening review).

### One feedback cycle across phases

When the source has a feedback cycle (e.g., a back-and-forth between two roles to resolve findings), all phases that need feedback shall reuse the same cycle, not duplicate it per phase.
Phases may set typed routing fields so the cycle's terminal outcomes route back to the originating branch.

## Boss control

[Boss](text2gears.md#roles) input enters the machine through two distinct surfaces: pre-emptive interrupts on active states, and typed entry events on idle or recoverable states.

### Boss interrupts

Boss may interrupt any active state at any time.
Every jumpable state shall have a stable `id` [[9]].
The runtime sends `{ type: 'BOSS_INTERRUPT', targetId: '<id>' }`; the root machine handles it with one guarded transition per jumpable state targeting `#<id>` with `reenter: true` [[7]][[8]][[9]] so invoked actors restart cleanly.
The compiler shall emit a `bossInterrupts(ids)` helper that maps a single source-of-truth list of jumpable IDs into the transition array, rather than hand-writing one transition per state.
XState automatically stops the current state's invoked actor on transition [[2]].

### Boss entry events vs. BOSS_INTERRUPT

`BOSS_INTERRUPT` is for jumping into an **active** machine — pre-empting whichever state is running.
**Boss entry events** are for **starting or resuming from an idle or recoverable state** when Boss-supplied parameters cannot be inferred from machine state alone.
Entry events shall be defined as typed events alongside `BOSS_INTERRUPT` and shall populate context via a dedicated action.
The compiler shall not collapse the two surfaces: a `BOSS_INTERRUPT` cannot carry per-event payload semantics, and a parameterless entry event may collapse to interrupt-style target routing only when its state-jump semantics are identical.
Entry events shall not be installed as root-level transitions from every active state unless the workflow intentionally supports pre-emption; normal entry events belong on the idle state and on recoverable states such as `failed`.

## Errors and termination

Every `invoke` shall declare an `onError` handler routing to a dedicated `failed` state, with the error captured in `context.lastError` for inspection.
`failed` is not `final`: Boss may interrupt out of it to recover.

Every machine shall declare at least one `type: 'final'` state (typically `done`) reachable when the procedure is complete.
A machine that never terminates is a defect: the runner has no signal that the procedure is complete.

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
