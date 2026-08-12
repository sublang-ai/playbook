<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# GEARS-to-Finite-State-Machine Transformation

Second phase of a playbook (a state-machine agent orchestrating other agents).
Transforms normative GEARS spec items into an XState v5 finite state machine.

- Source: GEARS spec items produced by the first phase.
- Target: an XState v5 machine object artifact [[1]].

Target is an object artifact only: it defines the machine, actor contracts, and typed inputs, but shall not bind a runner or supply concrete runtime implementations.

## Formats

| Role   | Format | Extension |
| ------ | ------ | --------- |
| source | gears  | .md       |
| target | fsm    | .ts       |

## Setup

The artifact shall use XState v5's `setup(...)` then `.createMachine(...)` [[10]].
The artifact shall restrict itself to erasable TypeScript syntax — type annotations that strip cleanly, no constructor parameter properties, `enum`s, or namespaces — so a host running under type stripping loads it directly.
It shall also pass the repository's strict `noUnusedLocals` and
`noUnusedParameters` checks. Helper signatures and XState callbacks shall omit
values they do not read; for example, a fresh-context helper that uses only
`bossIntent` shall not also accept an unused `context`, and an assign callback
that reads only `event` shall destructure only `event`.
The `types` block shall declare only `context`, `events`, machine `input`, and
machine `output`. XState v5's `SetupTypes` has no `actors` property; emitting
`types: { actors: ... }` is invalid and prevents registered action and actor
names from type-checking.
Declare a distinct typed actor contract in `setup(...)`'s top-level `actors`
map for every actor kind the GEARS artifact uses, using typed actor logic such
as `fromPromise<Output, Input>(...)` [[11]]:

- `captain` for direct work performed by Captain;
- `player` for work Captain delegates to a named role;
- `playbook` for a nested playbook call; and
- `script` for a deterministic shell script an
  [optimizer-introduced script item](text2gears.md#script-behaviors-optimizer-introduced)
  runs without any agent.

Do not declare, register, export, or import an actor kind the GEARS artifact
does not use. A playbook with direct Captain work and nested calls but no
delegated player therefore has `captain` and `playbook` contracts only.

XState may expose output from heterogeneous invoked actors as `unknown` in
shared guards and actions. Generated helpers shall accept an unknown event and
narrow its `output` or `error` structurally to the declared actor contract
before reading fields; they shall not rely on unchecked `event.output`
inference. Helpers that construct transition arrays shall preserve guard,
action, and target literals with `as const`, `satisfies`, or typed action/guard
functions rather than widening registered names to plain `string`.

The artifact shall not import a runner or bake in concrete actor
implementations. Each actor placeholder shall fail explicitly (for example,
throw `'captain actor must be provided by the runner'`).
Where the Source artifact begins with an SPDX comment block, the generated
artifact shall preserve its license and copyright text before the imports
using valid TypeScript line comments. It shall never copy Markdown HTML
comment delimiters into a TypeScript target.

`CaptainInput` shall be a typed object with at least:

- `stateId`: the stable id of the invoking working leaf;
- `sourceItem`: the GEARS item ID this state realizes;
- `prompt`: the source item's full final prompt, verbatim;
- `result`: a record whose keys are the valid guard names this invocation may
  return.

`PlayerInput` shall be a typed object with at least:

- `stateId`: the stable id of the invoking working leaf;
- `role`: the canonical lowercase local id derived from the [role](text2gears.md#roles) Captain is to delegate;
- `sourceItem`: the GEARS item ID this state realizes;
- `prompt`: the source item's full final prompt, verbatim;
- `result`: a record whose keys are the valid guard names this invocation may return.

`ScriptInput` shall be a typed object with at least:

- `stateId`: the stable id of the invoking working leaf;
- `sourceItem`: the GEARS item ID this state realizes;
- `command`: the script item's blockquote text, verbatim after Markdown
  unescaping;
- `result`: a record whose keys are the item's two declared guard names, first
  the zero-exit guard, then the nonzero-exit guard.

`ScriptOutput` shall be a discriminated union with one literal `guard` member
per declared result key and a required `exitStatus: number` property.
The script contract carries no prose output: downstream prompts shall not
depend on text a script produces.

`CaptainOutput` and `PlayerOutput` shall each be a discriminated union with one
literal `guard` member per authored result key and every payload field required
by that result as a required property. A catch-all `guard: string` interface
with optional look-alike fields is not a discriminated contract and is
malformed.
The artifact shall export the machine input plus every Captain, player, and
playbook actor input/output type that the linker must provide. The linked
module imports those exact types; it shall not redeclare near-duplicates that
can drift in optional fields, dynamic-call metadata, question ids, or child
result shapes.
Any recursive JSON value type in the artifact shall exactly preserve the
shared boundary's readonly variance:

```typescript
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

Nested-playbook output, completed-result evidence, plans, context, and machine
output shall use that readonly type rather than a mutable array/record
near-duplicate. The linker shall not cast or copy around a variance mismatch.

Every runtime-value placeholder established by Source in a direct-Captain or
delegated-player prompt shall be backed by a typed actor-input field populated
from typed machine context, so the linker can substitute it with the exact
runtime value. Angle-bracketed metavariables quoted inside domain instructions
(for example the literal `<model>` in a commit-message format) remain ordinary
prompt text and are not runtime-value placeholders. For the generic Captain
forms, wire `<boss-intent>` from `bossIntent`,
`<enabled-playbooks>` from `enabledPlaybooks`, `<remaining-plan>` from
`remainingPlan`, and `<completed-call-results>` from
`completedCallResults`. Other placeholders shall retain the semantic typed
field established by Source (for example `<#>` from `irNumber`). Leaving a
placeholder literal, replacing it with an empty default because its field was
omitted, or making the linker recover it from untyped context is malformed.
The sole blockquote placeholder of a dynamic nested-playbook item is instead
the child `textContext` field specified in §Nested playbook calls.

The generic Captain's `enabledPlaybooks` field shall be an immutable array of
exact entries `{ id: string, command: string, intent: string }`, not an array
of ids or an open record. Its dynamic-call guard checks `entry.id`, while the
linked runtime validates, snapshots, and deterministically renders all three
fields.

Guard names shall be specified and interpreted **per state**, not as a global union.
A global union encourages name reuse with divergent semantics and couples unrelated states.
Shared helpers may accept `string`, but each state's `invoke.input.result` is the authoritative local contract.
For an acting GEARS item, the compiler shall derive that contract only from
the ordered bullets under the item's out-of-blockquote `Results:` label.
Every declared guard name shall match `[A-Za-z_$][A-Za-z0-9_$]*`.
It shall preserve every guard name, order, and description verbatim, reject a
missing, duplicate, blank, or malformed declaration, and shall not infer a
result contract from acting-prompt prose or transition implementation.

An acting item that declares no `Results:` label has exactly one outcome
(text2gears emits result contracts only for behaviors with more than one
outcome, or whose output a later item consumes).
The compiler shall give such a state the **default single-outcome contract**:
one result `done` with the fixed description
`The acting agent completed the behavior.`, plus the universal
`needsBossReply` below.
A single-outcome item may instead carry exactly one authored `Results:`
bullet when a later prompt consumes its output; the compiler derives the
one-guard contract from that bullet as usual.
The `done` transition is self-driving per §Transitions: it targets the next
workflow obligation, or a `final` state when the item is the last one.
The default never applies to an item carrying a `Results:` label, and it does
not license inferring any richer contract from prose.
The item's blockquote alone becomes `invoke.input.prompt`; the `Results:`
label and bullets shall never enter that prompt.
A `>` that remains at the start of a prompt line after removing the outer GEARS blockquote marker is literal quoted-context content and shall remain in `invoke.input.prompt` unchanged.
Each result description shall name every additional output field its accepting
guard requires, using the exact case-sensitive property names. For example, a
delegation or continuing-call description whose guard reads the planned child
call shall say that output includes `remainingPlan`, `nextPlaybookId`, and
`nextPlaybookInput`; a direct or final response shall name `response`; and an
authored question shall name `question`. A vague description such as
"selected the next call" is malformed when its guard also requires structured
fields. Deterministic verification synthesizes valid actor output from this
local result contract and shall not infer hidden guard payloads from guard
source text.

For the default generic Captain decide-call-observe pattern, the local guard
discriminants are a stable compiler contract, not names the compiler may
invent:

- initial routing uses `question` with required `question` and `delegation`
  with required `remainingPlan`, `nextPlaybookId`, and
  `nextPlaybookInput`; it has no direct or terminal result;
- post-child reassessment uses `final` with required `response`,
  `followUpQuestion` with required `question`, and `continuing` with required
  `remainingPlan`, `nextPlaybookId`, and `nextPlaybookInput`.

Both direct-Captain states additionally receive the universal
`needsBossReply` result. Their guards and actions shall use those exact
case-sensitive names so the compiled adjudication contract remains stable.

For a controller playbook — one whose Source declares DR-029's session-scoped
controller policy: a session Captain that runs for the whole host session,
receives every Boss turn, and operates the working playbooks from outside the
engagement stack (DR-029) — the compiler shall apply the additive
controller decision-state class below. The class joins the stable compiler
contract beside the decide-call-observe vocabulary above; that vocabulary and
the universal `needsBossReply` rule stay untouched for the artifacts that
consume them.
The controller machine shall be a session loop, not a finite errand: a
quiescent conversational hub (tag `playbook.parked`) receives each Boss turn;
the controller decision state decides it over the closed action set; a
`respond` selection settles its turn in the decision call itself, its
validated `text` being the turn's captain speech; an acting selection's host
settlement becomes the outcome report grounding one closing-reply call; and
the machine returns to the hub for the next turn. Returning to the hub after
a settled turn completes the session loop's turn; it is not the idle-hub
routing that [Transitions](#transitions) reserves for recovery.
Because the hub receives every Boss turn, a controller state carries no
Boss-reply suspension: the compiler shall not add `needsBossReply` to a
controller machine's `invoke.input.result` maps — a clarifying question to
Boss is a `respond` selection.
The machine shall declare no terminal result output and shall keep exactly
one reachable `type: 'final'` shutdown state entered only by the host's
teardown event. The completion rule of
[Errors and termination](#errors-and-termination) applies unamended: its
output clause binds only where Source declares a terminal result, which a
controller Source does not.
The controller decision state's direct-Captain result contract discriminates
the closed action set of DR-029. Its guard discriminants are a stable
compiler contract, not names the compiler may invent — `respond`, `start`,
`switch`, `dismiss`, `deliver`, and `runtime` — with each guard's required
payload fields:

- `respond` requires `text`;
- `start` and `switch` each require `playbookId` and `input`;
- `runtime` requires `actionId`;
- `dismiss` and `deliver` require none — a `deliver` result in particular
  carries no text payload: the host is authoritative for the delivered text,
  so the contract declares no field for it.

The decision state's guards and actions shall use those exact case-sensitive
names so the compiled controller contract remains stable.

## States

Each state shall declare:

- a stable `id` (for `#id` targeting and Boss interrupts);
- an intuitive state key (the property name under `states: { ... }`);
- a one-line `description` (for inspector tools and documentation);
- JSON-safe `meta: { playbook: { stateId, description, role? } }` repeating
  its stable id and description so linked runtimes can discover active public
  identities through `snapshot.getMeta()` without private XState nodes. A
  delegated-role state shall also carry the canonical lowercase source role id in
  `meta.playbook.role`; every other state shall omit `role`;
- if it invokes the direct `captain` actor: `invoke.input` carrying
  `sourceItem`, `prompt`, and `result` (per [Setup](#setup));
- if it invokes the delegated `player` actor: `invoke.input` additionally
  carrying the same source-derived `role` as `meta.playbook.role`;
- if it invokes the `script` actor: `invoke.input` carrying `stateId`,
  `sourceItem`, `command`, and `result` (per [Setup](#setup)) — no `prompt`
  and no `role`.

The source item ID shall live in `invoke.input.sourceItem`, not in a comment — this keeps the GEARS-to-state mapping machine-readable.
A delegated state's `invoke.input.role` shall match the canonical lowercase id of its source item's named role.
A direct Captain state shall not invent a `Captain` role binding.

Every invoking working leaf — sequential or parallel, whatever its actor
kind — shall carry the tag `playbook.busy`: the shared quiescence helper
derives busyness strictly from active-state tags, so an untagged working leaf
reads as quiescent while its call is still in flight.

The machine's initial state shall be a quiescent idle hub (no `invoke`) — typically `ready` — that accepts the Boss entry events and carries the `playbook.parked` tag because it can return control to Boss.
Captain- and player-invoking work begins only on a Boss-originated event, so
constructing and starting the machine performs no agent call.

Each direct Captain or delegated player actor returns a discriminated result
with `guard` set to one of `input.result`'s keys [[4]].
Guards [[5]] on `onDone` transitions inspect `event.output.guard` to route.

Delegated-player example:

```typescript
invoke: {
    src: 'player',
    input: ({ context }): PlayerInput => ({
        stateId: '<stable-state-id>',
        role: 'reviewer',
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

For an item in which Captain acts directly, the corresponding invocation uses
`src: 'captain'` and a `CaptainInput` with the same static mapping fields but no
`role` field.

## Mapping

Each Source spec item shall map to exactly one state in Target.
A state's `invoke.input.sourceItem` shall be that item's ID, and `invoke.input.prompt` shall carry the item's prompt verbatim.

An item written as direct Captain work shall map to exactly one `captain` invocation.
An item that prompts or relays to a named role shall map to exactly one `player` invocation.
A nested-call item shall map to exactly one `playbook` invocation.
A script item (`Captain shall run:`) shall map to
exactly one `script` invocation whose `input.command` carries the blockquote
verbatim and whose `result` preserves the item's two guards in declared order.
The compiler shall not infer one actor kind from a
runtime player name or encode Captain as a player.
A script state is not agent-invoking: the compiler shall not add
`needsBossReply` to a script state's result map and shall not register it with
`resumableStates(ids)`.
A script state's success guard shall target the next workflow step and its
failure guard shall route to `failed` unless the source items define a
different recovery.

Per text2gears [composition](text2gears.md#composition), each spec item already carries the full final prompt for one state behavior, with no duplicate lines.
The FSM compiler shall not concatenate prompts across items, re-compose them, or silently dedupe.
A spec item that still contains duplicate prompt lines is malformed; the compiler shall reject or flag it rather than silently propagate the duplication into `invoke.input.prompt`.

## Parallel groups

Items carrying the same `Parallel group: <id>` metadata shall compile into one
compound state with `type: 'parallel'` and one region per item [[12]].
Each member shall be a delegated-player item; a direct-Captain or nested-call
member is malformed because those actor kinds share one Captain control lane or one
pending-child slot. Each region shall contain a delegated-player working leaf
and a local final state; the working leaf retains the item's stable state id,
`sourceItem`, role, prompt, and result contract.
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
Treat a fixed parallel parent as one jumpable unit. Generate a stable id and
root `BOSS_INTERRUPT` target for the parallel parent, not for any working leaf
inside its regions. Branch working ids remain valid internal resume targets for
their branch-local `BOSS_REPLY`; they shall not appear in the interrupt target
union or classifier catalog. This prevents a nominal one-branch jump from
implicitly entering or restarting the parallel parent's other regions.
An invoke error shall exit to the root failure state, allowing XState to stop
the sibling invocations automatically.

## Nested playbook calls

An item whose behavior is a literal or dynamic
`Captain shall call playbook ...:` shall compile to a state that invokes a
typed `playbook` actor, not the `captain` or `player` actor.
The setup types shall declare `PlaybookInput` with stable `stateId`, target
`playbookId`, composed `text`, and optional `sourceItem`. The playbook actor's
successful output is the child's JSON-safe machine output itself (or
`undefined`), not a second wrapper carrying a synthetic status or `output`
field. `invoke.onDone` shall therefore record `event.output` as the successful
child output. Aborted and error call results reject the actor and reach
`invoke.onError`.
The artifact shall supply a failing placeholder for `playbook`, just as it does
for `captain` and `player`; the linked runtime provides the actor
implementation.

A literal call shall retain the existing representation: `playbookId` is the
literal target and `text` is the composed GEARS blockquote.

A dynamic call written
``Captain shall call playbook selected by `<target-field>`:`` shall declare the
named target field and the blockquote's text field as typed string fields in
FSM context. The dynamic `PlaybookInput` variant shall require string-valued
`playbookIdContext` and `textContext` metadata fields. Its `invoke.input` shall
read the runtime values from those exact context fields and shall also carry
the following static metadata:

```typescript
{
  stateId: '<stable-state-id>',
  sourceItem: '<ITEM-A>',
  playbookId: context.nextPlaybookId,
  text: context.nextPlaybookInput,
  playbookIdContext: 'nextPlaybookId',
  textContext: 'nextPlaybookInput',
}
```

`playbookIdContext` and `textContext` name context fields; they never contain
runtime target or text values. The compiler shall emit them as explicit string
literals so conformance tools can verify context wiring without evaluating or
parsing the `invoke.input` function's source. The evaluated `playbookId` and
`text` shall each be strings and shall come from the context field named by its
corresponding metadata property. Literal calls need not carry these dynamic
metadata properties and retain their existing behavior.

The call state shall carry tag `playbook.suspended` and shall route
`invoke.onDone` from child output and `invoke.onError` from child failure.
The child call shall remain state-scoped: leaving the call state stops the
invoked actor and aborts the host call through XState's invocation signal
[[2]].
The FSM shall not allocate runtime call ids, construct child sessions, retain
runtime promises, or route Boss text to the child.

When Source explicitly continues one downstream behavior after a child
success, abort, or failure, both `invoke.onDone` and `invoke.onError` shall
record the corresponding JSON-safe child result and target that downstream
behavior. The generic `failed` state is the default only when Source declares
no recovery or reassessment path for a rejected child.
That recovering `onError` shall be an ordered transition array. Its first arm
shall use a typed structural guard that accepts only an `Error` carrying a
validated public child `result` with `status: 'aborted' | 'error'`; only that
arm appends sanitized child evidence and continues. A fallback arm shall retain
the control error normalized as JSON-safe `{ name, message, stack? }` in
`lastError` and route to `failed` without appending a completed child result;
the linked runtime alone retains the original error in its out-of-machine
latch. Non-abort port rejection, malformed port data, JSON, identity, bridge,
and other control-plane errors are not authored child outcomes even though
XState delivers both kinds through `invoke.onError`.
Where the rejected error structurally carries the runtime's normalized child
result, the error action shall inspect whether its status was `aborted` or
`error`; it shall not collapse both into an invented success/failure enum. The
FSM may inspect that public structural data without importing the runner or
constructing runtime call identities.
For a workflow that reassesses child results, use a typed JSON-safe record such
as `{ playbookId, status: 'ok', output }` on `onDone` and
`{ playbookId, status: 'aborted' | 'error', error }` on `onError`. Because the
runtime rejection is an `Error` with a public `result` property, normalization
shall inspect `result.status` and `result.error` before applying a generic
`Error` normalizer. It shall persist only the current context target id, the
status, and a compact `{ name, message }` error; it shall never persist the
whole runtime result, child session id, child state, call identity, or stack.
An abort without an error gets a compact generic abort description. The current
target id remains available in typed context until the sanitized record has
been created. On success, persist only `event.output`, which is the actual child
machine output returned by the bridge, not a runtime call-result envelope.
When that optional output is absent, omit the `output` property from the
completed-result record rather than storing `undefined`.
The outer trusted error is an actual `Error` instance and therefore is not a
plain JSON object. The structural guard shall inspect its public `.result`
property directly, then validate only that nested result before sanitizing it;
it shall not require the outer error itself to pass a plain-object/JSON guard.
Validation of that nested public result includes its status-specific required
members and target identity: `playbookId` shall equal the current selected
target, an `error` result shall carry a normalized error, and every optional
member that is present shall have the public contract's declared shape. A
look-alike such as `{ status: 'error' }` is malformed control data, not an
authored child failure, and shall take the fallback `failed` arm without
appending evidence. The guard shall not fabricate missing identity or error
members merely because the status string happens to be recognized.
The public result's declared optional `childSessionId` and `state` members are
valid when their shapes satisfy the shared contract; validate and then discard
them when building compact Captain evidence. They are not undeclared extras.
Likewise, the public normalized error may carry its declared optional string
`stack`; validate it and omit it from the compact `{ name, message }` evidence
rather than rejecting an otherwise valid authored child result.
Apply the public union exactly: an `aborted` or `error` result shall reject an
`output` member; `childSessionId`, when present, shall be non-empty; `error`
shall contain only non-empty `name`, string `message`, and optional string
`stack`; and `state`, when present, shall validate every declared
`PlaybookState` member and reject unknown or missing members. Treating an
arbitrary JSON-safe object as a valid `state`, or checking only that these
members have broad string/object types, is not complete public-result
validation.
In other words, the guard validates the complete public result it received,
while the action retains only the current selected playbook id, status, and
compact error. Do not implement evidence minimization by accepting only the
three keys that survive that projection.

Before entering a dynamic call, the machine shall reject an empty target and
empty input text, any target equal to `selfPlaybookId`, and any target that
Source requires to belong to an input catalog but that catalog does not
contain. Rejection shall occur before invoking the `playbook` actor; the host
remains responsible for its independent registry validation.
Where Source forbids repeating an equivalent completed or failed call without
new information, the machine shall also keep a private deterministic history
of target-and-input signatures and reject a continuation whose target and
complete input exactly match a prior call. Encode each signature as the
collision-free `JSON.stringify([playbookId, text])` tuple of exact JavaScript
strings, not delimiter concatenation, and append it before invocation so
success, abort, and authored failure all count. That history shall not be
included in a Captain or player prompt; a revised input containing new
information is a different call. The exact machine check is a safety floor;
the acting Captain remains responsible for Source's broader semantic
equivalence policy.
That validation belongs on the guarded transition into the call state. The
call state's `invoke.input` mapper shall be a pure read of the already-validated
typed context fields; it shall not call an assertion helper or throw while
XState resolves actor input. This keeps state restoration, inspection, and
scripted coverage from crashing outside the invocation's `onError` boundary.
For the default Captain decide-call-observe loop, the delegation and
continuing `onDone` arms shall transition directly into the invoking call
state. Each arm's single guard validates its applicable actor-output and
context constraints: both validate JSON shape, catalog membership,
self-target, and duplicate history, while strict plan shrink applies only to
`continuing`. Its actions store the selected target/input and append the
signature before state entry. Do not interpose an eventless preparation or
validation state between the Captain actor and the call state: it obscures the
authored Captain entry edge from deterministic coverage and adds no XState
safety beyond the guarded direct transition.

## Context and prompts

Context fields used to drive guards or compose prompts shall be **typed and named**.
The compiler shall not branch on untyped properties of `lastResult`; persistent routing decisions belong in typed context fields. (`lastResult` is for inspection only.)
Where Source declares a finite ordered plan, represent it as a typed readonly
JSON-safe array and validate that shape on the actor-output transition; an
unconstrained `JsonValue` does not establish that a plan is ordered or finite.
Where a decide-call-observe loop carries the calls after the selected next call
as `remainingPlan`, its continuing-call guard shall additionally require the
new plan to be strictly shorter than the current plan. The Captain may revise
or remove remaining entries as evidence arrives, but it cannot grow or retain
the same-length plan indefinitely; the initial finite array therefore bounds
the number of sequential child calls without an arbitrary runtime call limit.

Prompts shall pass only the **specific extracted fields** the player needs.
The compiler shall not dump `JSON.stringify(lastResult)` or any opaque blob: it leaks internal `guard` strings, wastes tokens, and confuses the LLM.

Player bindings and prompt identities shall enter only through `PlaybookSession.roleBindings` at runtime call, prompt, and trace boundaries.
The artifact shall not bake them into machine input, options, or context; model names and other host settings shall remain host policy rather than persisted FSM state.
Host-owned configuration such as an enabled-playbook catalog shall remain
immutable machine input/context for the session. Boss events and actor outputs
shall not carry, replace, append to, or otherwise overwrite that catalog.
Every machine with a dynamic call shall receive its own registered or authored
playbook id as immutable machine input/context named `selfPlaybookId`, and its
dynamic-call guard shall reject that target. The leaf-level `stateId` name is
reserved for actor invocation identity and shall not be reused for a playbook
id.
JSON-safe context and output records shall omit absent optional members instead
of creating own properties whose value is `undefined`.
JSON validation shall accept only null, booleans, finite numbers, strings,
arrays, and plain own enumerable data-property objects. It shall reject cycles,
non-plain instances (`Error`, `Date`, `Map`, and class instances), accessors,
symbol keys, sparse/undefined values, `NaN`, and infinities rather than silently
changing them during serialization.
An accepted array shall have prototype exactly `Array.prototype`, no holes,
symbols, accessors, or extra own string properties, and enumerable own data
descriptors for every canonical index; its standard non-enumerable `length`
descriptor is the sole exception. That data descriptor shall be
non-configurable and carry the exact array length, but its `writable` flag may
be either `true` on an ordinary array or `false` after the shared runtime
recursively freezes a validated boundary value. `Reflect.ownKeys(array)` shall
contain exactly `length + 1` keys: the `length` property and every canonical
index from `0` through `length - 1`. A digit string whose numeric value is not
less than `length` is an extra property, not an array index. An accepted record
shall have prototype exactly `Object.prototype` or `null`, and every key returned by
`Reflect.ownKeys` shall be a string whose own descriptor is enumerable and a
data descriptor. Cycle detection shall track only the active recursion path
and remove a container on unwind, so a shared acyclic array or record is valid
while an actual back-edge is rejected.

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

[Boss](text2gears.md#roles) input enters the machine through three surfaces: pre-emptive interrupts on active states, typed entry events on idle or recoverable states, and Boss replies to delegated-role questions that suspended the FSM in a dedicated wait state.

### Boss interrupts

Boss may interrupt any active state that can itself receive a Boss turn. Every
jumpable state shall have a stable `id` [[9]]. A final state is not jumpable.
A `playbook.suspended` call state with an outstanding child is also not a Boss
interrupt target: the host routes Boss input to the active child leaf and
resumes the parent only from the matching child result.
The runtime sends `{ type: 'BOSS_INTERRUPT', targetId: '<id>' }`; the root machine handles it with one guarded transition per jumpable state targeting `#<id>` with `reenter: true` [[7]][[8]][[9]], so invoked actors restart cleanly.
The compiler shall emit a `bossInterrupts(ids)` helper rather than hand-writing one transition per state.
Each generated arm shall guard both the selected `targetId` and every typed
context precondition required to enter that target safely. It shall not jump
into a working or reassessment state with missing intent, prior result, plan,
or other required context and shall not invent defaults merely to make an
interrupt target executable.
Control-action discovery probes these guards with optional textual fields
omitted. Before applying a string operation such as `trim()`, a generated
guard shall narrow the field to a string; a missing required textual field
shall make the guard return false, never throw, so the control view remains
total and omits an action whose payload the runtime cannot source.
XState automatically stops the current state's invoked actor on transition [[2]].
Where the default Captain's routing state accepts a fresh intent while another
state or Boss-reply wait is active, its `BOSS_INTERRUPT` event shall carry a
required non-empty `bossIntent`. The guarded routing arm shall copy that value,
clear the prior plan, child evidence, exact-call history, selected call,
response, error, and consumed question/reply context, then reenter routing.
It shall not restart the old intent or retain a stale pending question.
For this default Captain, `routing` is the sole `BOSS_INTERRUPT` target; a
fresh directive always returns to routing and shall not jump directly into
reassessment or the Boss-reply wait. The typed event union and classifier
contract shall require exactly `targetId: 'routing'` plus the fresh
`bossIntent`.

### Boss entry events vs. BOSS_INTERRUPT

`BOSS_INTERRUPT` jumps into an **active** machine, pre-empting whichever state is running.
**Boss entry events** start or resume from idle or recoverable states when Boss-supplied parameters can't be inferred from machine state alone.
Entry events shall be typed alongside `BOSS_INTERRUPT` and populate context via a dedicated action.
An entry event's copy action shall not clear per-run parameters the event omits: an absent optional field falls back to the existing (input-seeded) context value.
The two surfaces shall not be collapsed. `BOSS_INTERRUPT` always carries its
target id and may additionally carry typed Boss-supplied fields such as an
intent or IR number only where Source requires the pre-empted target to consume
them; a parameterless entry event may collapse to interrupt-style routing only
when state-jump and context-update semantics are identical.
Entry events shall not be root-level transitions from every active state unless the workflow supports pre-emption; they belong on idle and recoverable states (e.g., `failed`).

### Boss-reply suspension

When a captain- or player-invoking state needs a Boss decision the acting agent
cannot supply alone, the machine shall suspend that task in a quiescent wait
state and resume the same task with the Q+A in the next prompt.
This is a third Boss surface alongside `BOSS_INTERRUPT` and Boss entry events.

Every captain- and player-invoking state supports this path, with one
exception the compiler shall apply, not infer: the states of a controller
machine ([Setup](#setup), controller decision-state class) carry no
Boss-reply suspension, because its hub already receives every Boss turn and a
clarifying question to Boss is a `respond` selection over the closed action
set. The rule below is therefore universal over workflow states and silent
about that class; in particular, adding `needsBossReply` to the controller
decision state would add a seventh outcome to a closed six-action contract
whose guard discriminants [Setup](#setup) fixes, and is nonconformant.
There is no source-level opt-in annotation and no `needsBossReply` result metadata in GEARS output.
The FSM compiler shall preserve the GEARS blockquote as the state's domain `prompt` body and shall not inject any Boss-question instruction into `invoke.input.prompt`.
This preservation includes every literal leading `>` carried inside the outer GEARS blockquote for quoted runtime context.

For every captain- and player-invoking state outside a controller machine,
the compiler shall add
`needsBossReply` to the state's `invoke.input.result` map.
The description shall be the standard adjudicator-facing text:

```text
The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.
```

The standard annotated backtick form names the exact `question` property; the
linker's required-field extractor shall interpret only the identifier before
the colon as the JSON field name.
The linked runtime composes player prompts per [link.md "Player prompt composition"](link.md#player-prompt-composition), without adding a player-visible Boss-question instruction.

The question record shall be
`{ questionId, resumeStateId, sourceItem, asker, question }`, where `asker` is exactly `{ kind: 'captain' }` or `{ kind: 'role', roleId }`.
`questionId` and `resumeStateId` shall both equal the stable working-leaf
`stateId`.
`questionId`, `resumeStateId`, and `sourceItem` shall come from the suspended working leaf's stable invocation metadata.
A delegated `PlayerInput` shall produce the role asker with its canonical local role id, while a direct-Captain state shall produce the Captain asker without inventing a role.
Only
`question` shall come from adjudicated actor output.

A machine with at most one active Captain or player task may use the scalar
form:

- An `awaitBossReply` state with stable `id: 'awaitBossReply'`, tag
  `playbook.parked`, and description
  `Waiting for Boss to answer the acting agent's question.`.
- A `BOSS_REPLY` event carrying `{ answer: string; questionId?: string }`.
- Context fields `pendingBossQuestion?: PendingBossQuestion` and
  `bossReply?: string`.
- `resumableStates(ids)`, `setPendingBossQuestion`, and
  `clearBossReplyContext` helpers with the existing single-question behavior.

A machine with parallel delegated-player tasks shall use the keyed form:

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
The wait state or branch-wait leaf itself shall not be an interrupt target:
re-entering it after the interrupt clears its pending question would create an
unresumable parked state. Its recorded working leaf remains the sole
`BOSS_REPLY` resume destination.

A captain- or player-invoking state's `invoke.input` function shall carry the
pending question and reply selected for that working leaf as singular
`pendingBossQuestion` and `bossReply` fields, regardless of the scalar or keyed
context representation, so prompt composition has one stable contract.
When both fields are present, the linked runtime shall compose the continuation preamble and labelled Q&A blocks per [link.md "Player prompt composition"](link.md#player-prompt-composition).
The FSM artifact shall not bake the continuation preamble into the GEARS-derived `prompt` body.

The following malformed states shall route to `failed` per [Errors and termination](#errors-and-termination):

- Captain or player output has `guard: 'needsBossReply'` but no `question`
  field.
- Captain or player output declares `needsBossReply` from a state without a
  registered scalar or branch-local resume route.
- `BOSS_REPLY` fired with empty or whitespace-only `answer`.
- A keyed `BOSS_REPLY` names no pending question.

## Errors and termination

Every `invoke` shall declare an `onError` handler with a fallback routing to a
dedicated `failed` state and capturing the error in `context.lastError` for
inspection. A nested playbook invoke may place its validated authored-child
recovery arm before that fallback as described in §Nested playbook calls.
`failed` is not `final`: it shall carry tag `playbook.parked`, retain enough
typed context for Boss recovery, and accept the workflow's recovery entry or
interrupt surface. The parked tag distinguishes a recoverable failure from a
busy state so the host retains the session instead of treating the outcome as
an unhandled runtime error.

Every machine shall declare at least one `type: 'final'` state (typically `done`) reachable on completion.
A never-terminating machine is a defect: the runner has no completion signal.

Where Source declares a JSON-safe terminal result, the setup types shall
declare that output and the root machine shall derive it from typed context
through XState's machine `output` function. A final-state transition alone does
not satisfy a declared output contract.
Fields that Source requires in every terminal output shall be required in the
TypeScript output type. In particular, a declared `{ response }` result shall
compile as `{ response: string }`, not `{ response?: string }`; reaching the
final state without a non-empty response shall be guarded out before the
machine output is constructed.

## References

[1]: https://stately.ai/docs/xstate 'XState Official Documentation'
[2]: https://stately.ai/docs/invoke 'Invoke — invoking actors from states'
[3]: https://stately.ai/docs/input 'Input — passing data to invoked actors'
[4]: https://stately.ai/docs/output 'Output — receiving actor results via onDone'
[5]: https://stately.ai/docs/guards 'Guards — synchronous transition conditions'
[6]: https://stately.ai/docs/context 'Context — persistent state and assign'
[7]: https://stately.ai/docs/transitions 'Transitions — reenter, root-level routing'
[8]: https://stately.ai/docs/parent-states 'Parent states — root-level event handling'
[9]: https://stately.ai/docs/finite-states 'Finite states — state IDs'
[10]: https://stately.ai/docs/setup 'Setup — typed machine setup'
[11]: https://stately.ai/docs/actors 'Actors — typed actor contracts'
[12]: https://stately.ai/docs/parallel-states 'Parallel states — concurrent regions and onDone joins'
