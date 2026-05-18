<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-005: Boss-reply suspension path for player questions

## Status

Proposed

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
shape that arises when a Player has a clarifying question for Boss:

> Player asks Captain → Captain surfaces the question to Boss →
> Boss answers Captain → Captain resumes the *same* Player turn
> with the answer in context.

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
PBRT-3) has no state-context awareness — it always either matches
a slash prefix or routes free text to the LLM judge, which has no
reliable signal to distinguish *"SQLite"* as a fresh `/start
SQLite` versus a reply to *"which database should we use?"*.

This DR specifies a third Boss surface — **mid-state suspension
and resume** — that lives in `slc/gears2fsm.md` so every playbook
benefits, not just CODE.

## Decision

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
  `/interrupt <stateId>` can abandon a pending question.
- The standard root-level Boss entry events the machine declares
  (e.g., `START_CODING`, `CONTINUE_IR`, `SUMMARIZE_IR` in CODE),
  so an explicit slash command from Boss while waiting starts a
  fresh turn and discards the pending question.

The compiler shall emit a `resumableStates(ids)` helper analogous
to `bossInterrupts(ids)`, so the `BOSS_REPLY` arm array is
generated from a registered list rather than hand-written
per-state.

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
  resumeStateId: string;     // the suspended state's id
  sourceItem: string;        // the GEARS item ID the player was running
  player: string;            // the player who asked
  question: string;          // verbatim question text from the player
};
bossReply?: string;          // verbatim Boss answer, set on BOSS_REPLY
```

`pendingBossQuestion` is set when a state routes via
`needsBossReply` (see §4); `bossReply` is set when `BOSS_REPLY`
fires. Both shall be cleared by an `assign` action on any
non-`needsBossReply` outcome of the resumed state (see §5).

### 4. New opt-in guard: `needsBossReply`

Captain-invoking states **opt in** by including in their
`invoke.input.result` map:

```typescript
needsBossReply:
  "Player needs a Boss decision or clarification. Output shall
   include `question: <verbatim question text>`."
```

Opt-in is per-state, declared in the gears item, and mirrored in
the FSM's result map per
[gears2fsm.md "Setup"](../../slc/gears2fsm.md#setup).

When a state declares `needsBossReply`:

- The compiler shall emit an `onDone` arm guarded on
  `guardIs('needsBossReply')` targeting `#awaitBossReply`, with
  `actions` that assign `pendingBossQuestion` from the captain
  output (carrying `event.output.question` and the state's known
  `sourceItem` / `player` / `id`).
- The state shall not also declare `needsBossInput` for the same
  semantic intent. `needsBossInput → #ready` remains valid for the
  distinct "I'm stuck, please redirect" intent where there is no
  specific question to resume against (see §10).
- The state shall be registered with the `resumableStates(ids)`
  helper so the matching arm appears in `awaitBossReply.on.BOSS_REPLY`.

Captain output shall include a `question: string` field whenever
`guard === 'needsBossReply'`. Output that declares the guard but
omits the field is malformed; the runtime shall route to the
machine's `failed` state with a clear error (see §8).

### 5. Resume mechanics: input function discipline

A resumable state's `invoke.input` function shall, when
`context.pendingBossQuestion` and `context.bossReply` are both
present, include them in the composed `prompt` as labelled blocks
under the existing
[DR-004 §6](./004-link-code-fsm-to-playbook-runtime.md) grammar:

```
Boss question:
<context.pendingBossQuestion.question>

Boss reply:
<context.bossReply>

<the state's normal prompt body>
```

The composer shall position the question + reply blocks **before**
the state's other structured blocks (`intent`, `reviews`,
`challenges`, `taskDescription`), so the player reads the
conversation context first and treats the rest as the standing
work.

Each captain-invoking state's transitions shall declare
`actions: clearPendingBossQuestion` on every non-`needsBossReply`
outcome — committed, hasFindings, noFindings, accepted, etc. The
helper shall `assign({ pendingBossQuestion: undefined, bossReply:
undefined })`. Forgetting this clear shall be considered a defect:
stale question/reply blocks injected into later prompts would
confuse the player.

A resumed state that returns `needsBossReply` *again* (the player
asks a follow-up) overwrites `pendingBossQuestion` and re-enters
`#awaitBossReply` — recursive Q&A is supported by construction
and is a feature, not a defect.

### 6. Runtime classifier: state-context-aware Boss input

[`specs/dev/playbook-runtime.md`](../dev/playbook-runtime.md)
PBRT-3 (Boss-event classifier) shall add a state-context branch
before the LLM-judge fallback:

> Where the actor snapshot's current state matches
> `'awaitBossReply'`, Boss text that does *not* begin with a
> recognized slash command shall be emitted as
> `{ type: 'BOSS_REPLY', answer: <verbatim text> }`. Slash
> commands shall retain their normal meaning so Boss can still
> `/interrupt`, `/start`, `/continue`, or `/summarize` to abandon
> the pending question.

This is the *only* path that synthesizes `BOSS_REPLY`. Outside
`awaitBossReply`, plain text falls through to the LLM judge as
today. This deterministic disambiguation avoids asking the
classifier to infer whether `"SQLite"` is a fresh task or a reply.

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
| Tool state continuity          | Lost across pause            | Preserved |
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

### 10. `needsBossInput` is not deprecated

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
