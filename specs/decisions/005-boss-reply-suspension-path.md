<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-005: Boss-reply suspension path for player questions

## Status

Accepted

## Context

[`slc/gears2fsm.md`](../../slc/gears2fsm.md) defines two Boss-control surfaces:

- **`BOSS_INTERRUPT`** — pre-empts the active state; per
  [gears2fsm.md "Boss interrupts"](../../slc/gears2fsm.md#boss-interrupts)
  the runtime re-enters the target with `reenter: true`, which XState
  documents as *stopping the currently invoked actor* [[1]]. Any
  conversation a player has in flight is killed.
- **Boss entry events** — typed events carrying payload, scoped to
  *idle or recoverable* states per
  [gears2fsm.md "Boss entry events vs. BOSS_INTERRUPT"](../../slc/gears2fsm.md#boss-entry-events-vs-boss_interrupt).
  These start or resume *from idle*, not from a paused mid-state.

Neither surface supports the natural three-actor message-passing
shape that arises when a player turn surfaces a clarifying
question for Boss:

> Player produces prose containing a question → Captain's
> adjudicator classifies that prose as `needsBossReply` and
> extracts the question → runtime routes the FSM to a quiescent
> wait state and surfaces the question to Boss → Boss answers →
> runtime fires `BOSS_REPLY` → the *same FSM state* re-enters
> with the question + reply embedded in the next player prompt
> (which is a fresh player turn — not necessarily the same
> underlying cligent conversation or tool session; see §7).

The reference CODE FSM
([`code.fsm.ts`](../../code.fsm.ts))
already partially recognizes this pattern: five captain-invoking
states (`planAndImplement`, `continueIr`, `summarizeSpecs`,
`commitCoderInitial`, `commitJoint`) declare a
`needsBossInput: 'Progress requires additional Boss input.'` guard
that routes to `#ready`. This is lossy on three counts:

1. The question itself is not preserved — Boss sees the FSM at the
   idle hub with no record of what was asked.
2. The pending continuation (which state, which IR task, which
   player, which sourceItem) is dropped — Boss must reconstruct
   it by reading transcript scrollback.
3. Boss has no protocol to *answer*: the only Boss surfaces are
   `/start`, `/continue`, `/summarize`, `/interrupt`, none of which
   express "this text is the reply to the question you just asked."

The runtime's Boss-event classifier (per
[`specs/dev/playbook-runtime.md`](../dev/playbook-runtime.md)
PBRT-7) has no state-context awareness — it always either matches
a slash prefix or routes free text to the LLM judge, which has no
reliable signal to distinguish *"SQLite"* as a fresh `/start
SQLite` versus a reply to *"which database should we use?"*.

This DR specifies a third Boss surface — **mid-state suspension
and resume** — that lives in `slc/gears2fsm.md` so every playbook
benefits, not just CODE.

## Decision

### Authority and message flow

Three actors collaborate on the Boss-reply suspension path; their
responsibilities shall not bleed into one another:

| Actor | Produces | Does NOT |
|-------|----------|----------|
| **Player** (claude / codex / etc.) | Free-form prose, which may contain a question Boss must answer | Choose FSM guards; emit FSM events; name a resume state; know that an FSM exists |
| **Captain adjudicator** (the LLM the runtime drives through `callJudge`) | Picks one `guard` from the state's `result` map; extracts every payload field the chosen guard's description marks as required (e.g., `question` for `needsBossReply`) into `CaptainOutput` | Drive the FSM transition; mutate context; see Boss input |
| **Runtime** | Invokes the Captain adjudicator per [PBRT-10](../dev/playbook-runtime.md#pbrt-10); on its return, sets `pendingBossQuestion` from invocation metadata + adjudicated `CaptainOutput.question` (per §3); fires `BOSS_REPLY` per §6; emits status per §10.2 | *Independently* infer guards or resume metadata from player prose outside the adjudicator's `CaptainOutput`; populate `pendingBossQuestion` fields from anywhere other than the documented sources; re-classify Boss text outside §6's precedence |

PBRT-10 already vests the *act* of adjudication in the runtime
(it is the runtime that calls `callJudge` and parses the JSON
reply). The rule above is narrower: once the adjudicator has
returned a `CaptainOutput`, the runtime shall not second-guess
it — not pluck a guard from the prose because the adjudicator
"missed one," not derive `sourceItem` or `player` from anything
in the player's text. Those fields are authoritative only as
invocation metadata.

A player saying "I have a question: which database should we
use?" never emits `BOSS_REPLY` or names `awaitBossReply` — those
are runtime-level constructs invisible to the player. It only
produces prose. The Captain adjudicator decides whether that
prose matches the state's `needsBossReply` guard description
and, if so, extracts the question verbatim into
`CaptainOutput.question`. The runtime then composes
`pendingBossQuestion` from a fixed mix:

| Field | Source |
|-------|--------|
| `resumeStateId` | The suspended state's `id` (FSM metadata) |
| `sourceItem` | The suspended state's `CaptainInput.sourceItem` |
| `player` | The suspended state's `CaptainInput.player` |
| `question` | The adjudicated `CaptainOutput.question` |

The runtime shall never read `resumeStateId`, `sourceItem`, or
`player` from the player's prose, even if the prose offers
those fields — they are authoritative only as invocation
metadata. This separation matters because: (a) players have no
way to know FSM state ids; (b) embedding FSM semantics in
player prose makes the playbook brittle to prompt-cache drift
and adversarial output; (c) the adjudicated `CaptainOutput` is
the only surface tests can pin against.

### 1. New quiescent state: `awaitBossReply`

`gears2fsm.md` shall require every machine that contains at least
one resumable captain-invoking state to declare an
`awaitBossReply` state with:

- A stable `id` of `'awaitBossReply'` (for `#awaitBossReply`
  targeting and consistency across compiled FSMs).
- A `description` of `'Waiting for Boss to answer a player
  question.'`.
- One transition arm per *resumable* captain-invoking state on the
  `BOSS_REPLY` event, each guarded on
  `context.pendingBossQuestion?.resumeStateId === '<state-id>'`,
  targeting `'#<state-id>'` with `reenter: true`, and assigning
  the reply payload into context (see §3).
- The standard `BOSS_INTERRUPT` handler emitted by
  `bossInterrupts(ids)` per
  [gears2fsm.md:128](../../slc/gears2fsm.md#boss-interrupts), so
  `/interrupt <stateId>` can abandon a pending question.  The
  transition shall add `actions: clearBossReplyContext` (see §5)
  to drop the abandoned question and any stale reply before the
  interrupt target enters.
- The standard root-level Boss entry events the machine declares
  (e.g., `START_CODING`, `CONTINUE_IR`, `SUMMARIZE_IR` in CODE),
  declared as transitions on `awaitBossReply` itself with
  `actions: clearBossReplyContext` so an explicit slash command
  from Boss while waiting starts a fresh turn and discards both
  the pending question and any stale prior reply.

The compiler shall emit a `resumableStates(ids)` helper analogous
to `bossInterrupts(ids)`, so the `BOSS_REPLY` arm array is
generated from a registered list rather than hand-written
per-state.

`awaitBossReply` is a quiescent state for runtime drive-loop
purposes; see §10 for the amendments to PBRT-11, PBRT-14/3, and
DR-004 §8 that make this concrete.

### 2. New typed event: `BOSS_REPLY`

`gears2fsm.md`'s typed events block shall include:

```typescript
| { type: 'BOSS_REPLY'; answer: string }
```

`BOSS_REPLY` is handled *only* on `awaitBossReply`. A `BOSS_REPLY`
fired on any other state shall fall through unhandled (XState's
default) — the runtime shall never synthesize one outside the
`awaitBossReply` context (see §6).

### 3. New context fields

```typescript
pendingBossQuestion?: {
  resumeStateId: string;     // from suspended state's `id`
  sourceItem: string;        // from `CaptainInput.sourceItem`
  player: string;            // from `CaptainInput.player`
  question: string;          // from adjudicated `CaptainOutput.question`
};
bossReply?: string;          // from `BOSS_REPLY` event's `answer` field
```

Field provenance is normative: the first three are taken from
the suspended state's invocation metadata; only `question` is
taken from the adjudicated player output. See *Authority and
message flow* above for the rationale.

`pendingBossQuestion` is set when a state routes via
`needsBossReply` (see §4); `bossReply` is set when `BOSS_REPLY`
fires. Both shall be cleared by an `assign` action on any
non-`needsBossReply` outcome of the resumed state (see §5).

### 4. New opt-in guard: `needsBossReply`

Captain-invoking states **opt in** by including in their
`invoke.input.result` map a description targeted at the
[PBRT-10 adjudicator](../dev/playbook-runtime.md#pbrt-10):

```typescript
needsBossReply:
  "The player's prose surfaces a clarifying question for Boss " +
  "that the player cannot answer alone. " +
  "Output shall include `question: <verbatim question text " +
  "from the player's prose>`."
```

The literal ``Output shall include `question:`` substring is
load-bearing — `code.playbook.ts`'s `extractRequiredFields`
regex parses it to make `question` a required JSON field in the
adjudicator's reply, which is what triggers §8's
missing-`question` failure mode when an LLM judge picks the
guard without supplying the payload. Removing the marker would
silently weaken the failure-mode guarantee.

Past the marker, the description tells the adjudicator (a) when
to pick this guard from the player's prose, and (b) what payload
field to extract. The player never sees this description and
never chooses this guard directly — see *Authority and message
flow* above.

Opt-in is per-state, declared in the gears item, and mirrored in
the FSM's result map per
[gears2fsm.md "Setup"](../../slc/gears2fsm.md#setup).

When a state declares `needsBossReply`:

- The compiler shall emit an `onDone` arm guarded on
  `guardIs('needsBossReply')` targeting `#awaitBossReply`, with
  `actions: setPendingBossQuestion` that assigns
  `pendingBossQuestion` from the captain output (carrying
  `event.output.question` and the state's known `sourceItem` /
  `player` / `id`) **and clears `bossReply`** so a follow-up
  question cannot inherit the prior answer (see §5).
- The state shall not also declare `needsBossInput` for the same
  semantic intent. `needsBossInput → #ready` remains valid for the
  distinct "I'm stuck, please redirect" intent where there is no
  specific question to resume against (see §11).
- The state shall be registered with the `resumableStates(ids)`
  helper so the matching arm appears in `awaitBossReply.on.BOSS_REPLY`.

Captain output shall include a `question: string` field whenever
`guard === 'needsBossReply'`. Output that declares the guard but
omits the field is malformed; the runtime shall route to the
machine's `failed` state with a clear error (see §8).

### 5. Resume mechanics: input function discipline

A resumable state's `invoke.input` function shall, when
`context.pendingBossQuestion` and `context.bossReply` are both
present, prepend a continuation preamble and the Q+A labelled
blocks to the composed `prompt` under the existing
[DR-004 §6](./004-link-code-fsm-to-playbook-runtime.md) grammar:

```
You previously paused this task to ask Boss a question; Boss
has now replied. Continue the same task using the reply below.

Boss question:
<context.pendingBossQuestion.question>

Boss reply:
<context.bossReply>

<the state's normal prompt body>
```

The line break inside the preamble in the fenced example is for
document readability only; runtime output may render the preamble
as one continuous line.

The preamble names Captain's continuation role explicitly so the
player does not have to infer it from the labelled blocks alone.
It also keeps FSM mechanics out of the prose: the player is told
*what to do* ("continue the same task") and *why* ("you asked
Boss; here's the reply"), without ever naming `awaitBossReply`,
`BOSS_REPLY`, or the FSM at all.

The composer shall position the question + reply blocks **before**
the state's other structured blocks (`intent`, `reviews`,
`challenges`, `taskDescription`), so the player reads the
conversation context first and treats the rest as the standing
work.

The compiler shall emit two assigner helpers used everywhere
pending question / reply context is touched:

- **`setPendingBossQuestion`** —
  `assign({ pendingBossQuestion: <new>, bossReply: undefined })`.
  Used on every `needsBossReply` arm. Overwriting
  `pendingBossQuestion` without clearing `bossReply` would let a
  follow-up question carry the *prior* answer into its prompt.
- **`clearBossReplyContext`** —
  `assign({ pendingBossQuestion: undefined, bossReply: undefined })`.
  Used everywhere a pending question must be dropped.

Each captain-invoking state's transitions shall declare
`actions: clearBossReplyContext` on every non-`needsBossReply`
outcome — committed, hasFindings, noFindings, accepted, etc.
Every transition *out of* `awaitBossReply` shall also use
`clearBossReplyContext` on its abandon paths: BOSS_INTERRUPT and
every root-level Boss entry event re-declared on
`awaitBossReply` (see §1). The only transition that may leave
`awaitBossReply` *without* clearing is the `BOSS_REPLY` resume,
which deliberately preserves `pendingBossQuestion` so the resumed
state's `invoke.input` can read it (and which clears both fields
when the resumed state itself completes via a non-`needsBossReply`
outcome). Forgetting these clears shall be considered a defect:
stale question/reply blocks injected into later prompts would
confuse the player or leak abandoned conversation into unrelated
turns.

A resumed state that returns `needsBossReply` *again* (the player
asks a follow-up) re-enters `#awaitBossReply` via
`setPendingBossQuestion`, which both writes the new question and
clears the prior answer. Recursive Q&A is supported by
construction and is a feature, not a defect.

### 6. Runtime classifier: state-context-aware Boss input

[`specs/dev/playbook-runtime.md`](../dev/playbook-runtime.md)
PBRT-7 (Boss-event classifier) shall be amended with a
state-context branch that runs **before** the LLM-judge fallback,
applied only when the actor snapshot's current state is
`'awaitBossReply'`. The branch shall classify in this strict
precedence (each rule consumes the input; later rules do not run):

| Input shape | Classification | Rationale |
|-------------|---------------|-----------|
| Recognized slash (`/start`, `/continue`, `/summarize`, `/interrupt <id>`) | Emit the slash's normal event (transition out of `awaitBossReply` per §1; `clearBossReplyContext` runs) | Boss explicitly abandons the pending question |
| Unrecognized slash (e.g. `/foo`) or `/interrupt` without a target | One `emitStatus` call, no event (per PBRT-7) | Preserves PBRT-7's existing contract; does not silently re-classify a typo as a reply |
| Empty or whitespace-only text | No event, no port call (per PBRT-7) | Preserves PBRT-7; an empty BOSS_REPLY is malformed per §8 |
| All other text | `{ type: 'BOSS_REPLY', answer: <verbatim text> }` | The only path that synthesizes BOSS_REPLY |

Outside `awaitBossReply`, classification falls through to the
existing PBRT-7 behavior unchanged (slash forms first, then LLM
judge for non-slash text). The deterministic in-state branch
avoids asking the LLM judge to infer whether `"SQLite"` is a
fresh task or a reply.

### 7. Transcript embedding over SDK session resume

The runtime shall **embed** the question and Boss reply as
labelled blocks in the next player prompt (per §5). The runtime
shall **not** use the underlying adapter SDK's session-resume
mechanism (e.g., cligent's `options.resume`) to continue the
player's prior conversation in place.

Trade-off matrix:

|                                | Embedded transcript (chosen) | SDK session resume |
|--------------------------------|------------------------------|--------------------|
| Captain bridge change          | None                         | Adapter API extension |
| Token cost per resume          | Re-sends Q+A as text         | Server-side cache preserved |
| Tool state continuity          | Lost between successive player turns | Preserved across the wait |
| Prompt-cache effectiveness     | New transcript invalidates   | Preserved |
| Determinism across adapters    | Same shape for claude/codex/etc. | Per-adapter quirks |

The transcript approach trades cache efficiency for adapter
uniformity. Coding workflows compose each turn from explicit
structured blocks anyway, so the loss of tool-state continuity is
not a practical regression. Future DRs may revisit this if a
playbook's turns become long enough that re-prompting cost
matters.

### 8. Failure modes

The following malformed states shall route to the machine's
`failed` state (per
[gears2fsm.md "Errors and termination"](../../slc/gears2fsm.md#errors-and-termination))
with the listed error captured in `context.lastError`:

| Condition | Error message |
|-----------|---------------|
| Captain output has `guard: 'needsBossReply'` but no `question` field | `"needsBossReply outcome missing 'question' field"` |
| Captain output declares `needsBossReply` from a state not registered with `resumableStates(ids)` | `"state <id> declared needsBossReply but is not registered as resumable"` |
| `BOSS_REPLY` fired with empty/whitespace-only `answer` | `"BOSS_REPLY received empty answer"` |

There is no `awaitBossReply` timeout. Boss is a human; long pauses
are normal. Cancellation is via slash command (`/interrupt`,
`/start`, etc.), not a timer.

### 9. CODE FSM migration

The five existing `needsBossInput → #ready` paths shall be
audited per-state to determine which retain that semantic (no
specific question; Boss should redirect) versus which convert to
`needsBossReply → #awaitBossReply` (a specific question Boss
should answer). The audit is part of the IR that implements this
DR; the audit's outcome shall be:

| State | Likely classification (subject to gears review) |
|-------|------------------------------------------------|
| `planAndImplement` | `needsBossReply` — player typically has a specific scope question |
| `continueIr` | `needsBossReply` — player typically asks about ambiguous tasks |
| `summarizeSpecs` | `needsBossReply` — player typically asks about scope of spec extraction |
| `commitCoderInitial` | Audit — may genuinely be `needsBossInput` if "I can't form a clean commit, please rescope" |
| `commitJoint` | Audit — same as `commitCoderInitial` |

Extending `needsBossReply` to *other* captain-invoking states
(reviewers, committers) shall be done only by deliberate
per-state gears authoring. Default is opt-out. Reviewer states
in particular shall not opt in by default: the Reviewer-as-judge
contract per CODE-2 etc. requires the reviewer to *commit to
findings or no-findings based on what is in front of them*, not
pause mid-review.

### 10. Runtime contract amendments

This DR amends the following existing items to accommodate the
new quiescent state and its Boss-facing visibility. The
amendments shall land alongside the FSM/runtime IR that
implements this DR.

#### 10.1 Amend PBRT-11 (Drive to quiescence)

[PBRT-11](../dev/playbook-runtime.md#pbrt-11) currently lists
quiescent states as *"the idle state, the failure state, or the
terminal state"*. It shall be amended to also include any state
declared as a Boss-reply suspension state per this DR (i.e.,
`awaitBossReply`). Concretely: `handleBossInput` shall return
when the actor reaches any of the idle state, the failure state,
the terminal state, **or `awaitBossReply`**, after draining
pending port emissions.

Without this amendment, `handleBossInput` would not return from
`awaitBossReply` and the runtime would never yield control back
to Boss, so the reply Boss is meant to type could never reach
the FSM — a deadlock that defeats the entire DR.

#### 10.2 Amend PBRT-14 (status / telemetry stream) and PBRT-3

[PBRT-14](../dev/playbook-runtime.md#pbrt-14) and the user-facing
[PBRT-3](../user/playbook-runtime.md#pbrt-3) four-glyph
vocabulary shall be amended so that on entry to `awaitBossReply`,
the runtime emits a distinct status frame including
`pendingBossQuestion.question`,
`pendingBossQuestion.player`, and `pendingBossQuestion.sourceItem`
(and the resume target's state id). Without this, Boss sees the
FSM go silent with no signal that input is expected, let alone
which question to answer.

The IR implementing this DR shall select the glyph and frame
layout; this DR does not pin those bytes. The IR shall also
ensure the corresponding telemetry topic carries the same
structured fields, so non-tmux-play hosts can render their own
prompt.

#### 10.3 Amend DR-004 §8 (CODE quiescent values)

[DR-004 §8 "Quiescence and abort"](./004-link-code-fsm-to-playbook-runtime.md#8-quiescence-and-abort)
pins CODE quiescent values to `'ready'`, `'failed'`, `'done'`.
The list shall be extended to include `'awaitBossReply'` once the
CODE FSM declares the state per §9. The matching constant in the
CODE runtime (`code.playbook.ts`'s quiescent-state set) shall be
updated in the same IR commit so PBRT-11's drive-loop and the
CODE-specific list stay aligned — drift between them would
re-introduce the deadlock 10.1 prevents.

### 11. `needsBossInput` is not deprecated

`needsBossInput → #ready` remains a valid pattern for the
distinct intent: *the player cannot proceed and there is no
specific question — Boss please give a fresh turn.* This is a
genuine outcome (e.g., the workflow is fundamentally wedged and a
rescope is needed) and is qualitatively different from a
clarifying question.

Future gears items shall name the guard according to intent:

- `needsBossReply` if a specific question can be surfaced.
- `needsBossInput` if no specific question exists; Boss should
  rescope or redirect.

## Consequences

- **gears2fsm grows a third Boss surface.** The two existing
  surfaces (`BOSS_INTERRUPT`, Boss entry events) keep their
  current semantics. Mid-state suspension is now a first-class
  pattern, available to any playbook whose gears items opt in.
- **CODE playbook becomes conversational.** Players in five
  existing states can ask Boss questions without losing context;
  the workflow resumes naturally on reply. Workflow throughput
  improves: no more manual `/continue <#>` reconstruction after a
  question.
- **Runtime classifier becomes state-aware.** Boss input is
  disambiguated by current FSM state, not just by slash prefix or
  LLM heuristic. The LLM judge sees only genuinely ambiguous
  inputs.
- **Test surface grows.** Conformance tests must verify every
  declared `needsBossReply` arm and its matching `BOSS_REPLY`
  resume arm in `awaitBossReply` (per
  [PLAYBOOK-1..6](../dev/playbook.md)). New test items shall
  cover: question lands at `awaitBossReply`; resume includes the
  Q+A blocks; context survives across suspension; slash command
  preempts; clear-on-success runs.
- **Cligent and SDKs are not changed.** The transcript-embedding
  decision means this DR is implementable without coordination
  with the cligent project.
- **CODE author discipline shifts slightly.** Gears authors who
  add `needsBossReply` to a state must also register it as
  resumable and audit downstream transitions for the
  `clearPendingBossQuestion` action. The IR will provide the
  checklist; the
  [`code.fsm.coverage.test.ts`](../../code.fsm.coverage.test.ts)
  family will fail closed on omissions.

## References

[1]: https://stately.ai/docs/transitions#external-transitions "XState — external transitions and `reenter`"
