<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-005: Boss-reply suspension path for player questions

## Status

Accepted

## Context

[`slc/gears2fsm.md`](../../slc/gears2fsm.md) defines two Boss-control surfaces:

- **`BOSS_INTERRUPT`** — pre-empts the active state. Per [gears2fsm.md "Boss interrupts"](../../slc/gears2fsm.md#boss-interrupts) the runtime re-enters the target with `reenter: true`, which XState documents as *stopping the currently invoked actor* [[1]] — any in-flight player conversation is killed.
- **Boss entry events** — typed payload-carrying events scoped to *idle or recoverable* states per [gears2fsm.md "Boss entry events vs. BOSS_INTERRUPT"](../../slc/gears2fsm.md#boss-entry-events-vs-boss_interrupt); they start or resume from idle, not a paused mid-state.

Neither surface fits the three-actor message-passing shape that arises when a player turn surfaces a clarifying question for Boss:

> Player produces prose containing a question → Captain's
> adjudicator classifies that prose as `needsBossReply` and
> extracts the question → runtime routes the FSM to a quiescent
> wait state and surfaces the question to Boss → Boss answers →
> runtime fires `BOSS_REPLY` → the *same FSM state* re-enters
> with the question + reply embedded in the next player prompt
> (a fresh player turn — not necessarily the same cligent
> conversation or tool session; see §7).

Before this DR, the reference CODE FSM ([`code.fsm.ts`](../../reference/sdlc/code.playbook/code.fsm.ts)) partially recognized this through `needsBossInput` guards routing to `#ready`; after the universal migration, only `commitCoderInitial` and `commitJoint` retain `needsBossInput` for the broader rescoping intent described in §11.
That fallback is lossy on three counts when the player has a specific question:

1. The question is not preserved — Boss sees the FSM at the idle hub with no record of what was asked.
2. The pending continuation (which state, IR task, player, sourceItem) is dropped — Boss must reconstruct it from transcript scrollback.
3. Boss has no protocol to *answer* — ordinary Boss input is interpreted as a fresh directive, and no surface means "this is the reply to your question."

The runtime's Boss-event classifier ([PBRT-7](../dev/playbook-runtime.md#pbrt-7)) needs current-state context: the judge cannot tell whether *"SQLite"* is a fresh directive or a reply to *"which database?"* unless it knows the actor is waiting for a Boss answer.

This DR adds a third surface — **mid-state suspension and resume** — in `slc/gears2fsm.md`, so every playbook benefits, not just CODE.

## Decision

### Authority and message flow

Three actors collaborate on the suspension path; their responsibilities shall not bleed into one another:

| Actor | Produces | Does NOT |
|-------|----------|----------|
| **Player** (claude / codex / etc.) | Free-form prose, which may contain a question Boss must answer | Choose FSM guards; emit FSM events; name a resume state; know that an FSM exists |
| **Captain adjudicator** (the LLM the runtime drives through `callJudge`) | Picks one `guard` from the state's `result` map; extracts every payload field the chosen guard's description marks as required (e.g., `question` for `needsBossReply`) into `CaptainOutput` | Drive the FSM transition; mutate context; see Boss input |
| **Runtime** | Invokes the Captain adjudicator per [PBRT-10](../dev/playbook-runtime.md#pbrt-10); on its return, sets `pendingBossQuestion` from invocation metadata + adjudicated `CaptainOutput.question` (per §3); fires `BOSS_REPLY` per §6; emits status per §10.2 | *Independently* infer guards or resume metadata from player prose outside the adjudicator's `CaptainOutput`; populate `pendingBossQuestion` from undocumented sources; re-classify Boss text outside §6's precedence |

PBRT-10 already vests the *act* of adjudication in the runtime — it calls `callJudge` and parses the reply.
The rule above is narrower: once the adjudicator returns a `CaptainOutput`, the runtime shall not second-guess it — not pluck a guard the adjudicator "missed," not derive `sourceItem` or `player` from player text.
Those fields are authoritative only as invocation metadata.

A player saying "I have a question: which database?" never emits `BOSS_REPLY` or names `awaitBossReply` — those are runtime constructs invisible to the player; it only produces prose.
The adjudicator decides whether that prose matches the state's `needsBossReply` description and, if so, extracts the question into `CaptainOutput.question`.
The runtime then composes `pendingBossQuestion` from a fixed mix:

| Field | Source |
|-------|--------|
| `resumeStateId` | The suspended state's `id` (FSM metadata) |
| `sourceItem` | The suspended state's `CaptainInput.sourceItem` |
| `player` | The suspended state's `CaptainInput.player` |
| `question` | The adjudicated `CaptainOutput.question` |

The runtime shall never read `resumeStateId`, `sourceItem`, or `player` from player prose, even if the prose offers them.
This separation matters because: (a) players cannot know FSM state ids; (b) embedding FSM semantics in prose makes the playbook brittle to prompt-cache drift and adversarial output; (c) the adjudicated `CaptainOutput` is the only surface tests can pin against.

### 1. New quiescent state: `awaitBossReply`

`gears2fsm.md` shall require every machine with at least one captain-invoking state to declare an `awaitBossReply` state with:

- A stable `id` of `'awaitBossReply'`.
- A `description` of `'Waiting for Boss to answer a player question.'`.
- One `BOSS_REPLY` arm per captain-invoking state, each guarded on `context.pendingBossQuestion?.resumeStateId === '<state-id>'`, targeting `'#<state-id>'` with `reenter: true`, and assigning the reply into context (§3).
- The standard `BOSS_INTERRUPT` handler from `bossInterrupts(ids)` per [gears2fsm.md "Boss interrupts"](../../slc/gears2fsm.md#boss-interrupts), with `actions: clearBossReplyContext` (§5) so a Boss interrupt abandons the pending question.
- The machine's root-level Boss entry events (e.g., `START_CODING`, `CONTINUE_IR`, `SUMMARIZE_IR`), re-declared on `awaitBossReply` with `actions: clearBossReplyContext` so a fresh directive while waiting starts a fresh turn and discards the pending question and any stale reply.

The compiler shall emit a `resumableStates(ids)` helper analogous to `bossInterrupts(ids)`, generating the `BOSS_REPLY` arm array from the registered list of all captain-invoking states.

`awaitBossReply` is a quiescent state for the runtime drive loop; see §10 for the PBRT-11 / PBRT-14 / PBRT-3 / DR-004 §8 amendments.

### 2. New typed event: `BOSS_REPLY`

`gears2fsm.md`'s typed events block shall include:

```typescript
| { type: 'BOSS_REPLY'; answer: string }
```

`BOSS_REPLY` is handled *only* on `awaitBossReply`; fired elsewhere it falls through unhandled.
The runtime shall never synthesize one outside the `awaitBossReply` context (§6).

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

Field provenance is normative: the first three come from the suspended state's invocation metadata, only `question` from adjudicated player output (see *Authority and message flow*).

`pendingBossQuestion` is set when a state routes via `needsBossReply` (§4); `bossReply` is set when `BOSS_REPLY` fires.
Both shall be cleared by an `assign` on any non-`needsBossReply` outcome of the resumed state (§5).

### 4. Universal `needsBossReply`

Every captain-invoking state shall support Boss-reply suspension.
There is no source-level opt-in annotation and no `needsBossReply` metadata in GEARS output; `text2gears` emits only the domain prompt body and any domain result metadata.

`gears2fsm` shall add `needsBossReply` to every captain-invoking state's `invoke.input.result` map with the standard adjudicator-facing description defined in [gears2fsm.md "Boss-reply suspension"](../../slc/gears2fsm.md#boss-reply-suspension).

The literal ``Output shall include `question:`` substring is load-bearing: `code.playbook.ts`'s `extractRequiredFields` regex parses it to make `question` a required reply field, which triggers §8's missing-`question` failure mode.
Removing the marker would silently weaken that guarantee.

Past the marker, the description tells the adjudicator when to pick the guard and what field to extract.
The player never sees this description and never chooses the guard directly (see *Authority and message flow*).
The linked runtime shall not add a player-visible Boss-question instruction to the composed player prompt.
A player question that naturally appears in the player's prose is still detected by the adjudicator through the `needsBossReply` description.

The old source-annotation mechanism is superseded: a `Result guard: needsBossReply` line in GEARS output is stale compiler metadata.
The FSM result map is the first artifact that carries the universal `needsBossReply` guard per [gears2fsm.md "Setup"](../../slc/gears2fsm.md#setup).

For every captain-invoking state:

- The compiler shall emit an `onDone` arm guarded on `guardIs('needsBossReply')`, targeting `#awaitBossReply`, with `actions: setPendingBossQuestion` — which assigns `pendingBossQuestion` from the captain output and the state's known `sourceItem` / `player` / `id`, **and clears `bossReply`** so a follow-up question cannot inherit the prior answer (§5).
- The state may also declare `needsBossInput` for the distinct "I'm stuck, please redirect" intent with no specific question to resume against (§11).
- The state shall be registered with `resumableStates(ids)` so its arm appears in `awaitBossReply.on.BOSS_REPLY`.

Captain output shall include a `question: string` whenever `guard === 'needsBossReply'`.
Output that declares the guard but omits the field is malformed; the runtime routes to `failed` with a clear error (§8).

### 5. Resume mechanics: prompt-composer discipline

A captain-invoking state's `invoke.input`, when `context.pendingBossQuestion` and `context.bossReply` are both present, shall expose those fields to the linked runtime.
The runtime prompt composer shall render the continuation preamble and Q&A labelled blocks per [link.md "Player prompt composition"](../../slc/link.md#player-prompt-composition).
That section owns the exact runtime text and ordering.
The GEARS-derived `invoke.input.prompt` remains the domain prompt body; the continuation preamble is not stored in that body.

The compiler shall emit two assigner helpers, used everywhere pending-question / reply context is touched:

- **`setPendingBossQuestion`** — `assign({ pendingBossQuestion: <new>, bossReply: undefined })`. Used on every `needsBossReply` arm; clearing `bossReply` stops a follow-up question carrying the prior answer into its prompt.
- **`clearBossReplyContext`** — `assign({ pendingBossQuestion: undefined, bossReply: undefined })`. Used everywhere a pending question must be dropped.

Each captain-invoking state shall declare `actions: clearBossReplyContext` on every non-`needsBossReply` outcome.
Every transition *out of* `awaitBossReply` shall also clear, on both abandon paths — `BOSS_INTERRUPT` and every re-declared root-level Boss entry event (§1).
The sole exception is the `BOSS_REPLY` resume, which preserves `pendingBossQuestion` for the resumed state's `invoke.input` and clears both fields when that state later completes via a non-`needsBossReply` outcome.
Forgetting a clear is a defect: stale Q/A blocks would leak into later or unrelated prompts.

A resumed state that returns `needsBossReply` again (a follow-up question) re-enters `#awaitBossReply` via `setPendingBossQuestion`, which writes the new question and clears the prior answer.
Recursive Q&A is supported by construction.

### 6. Runtime classifier: state-context-aware Boss input

[PBRT-7](../dev/playbook-runtime.md#pbrt-7) shall make Boss-event classification state-context-aware.
The runtime shall not use slash-prefix parsing.
For every non-empty Boss turn it shall call `callJudge` with the current FSM state and the valid Boss events for that state.
When the actor is in `'awaitBossReply'`, the prompt shall include the pending question and allow `BOSS_REPLY` only in that state.

| Input shape | Classification | Rationale |
|-------------|---------------|-----------|
| Judge returns `BOSS_REPLY` with a non-empty `answer` while actor is in `awaitBossReply` | `{ type: 'BOSS_REPLY', answer }` | Boss answered the pending question |
| Judge returns a root-level Boss entry event or `BOSS_INTERRUPT` while actor is in `awaitBossReply` | Emit that event (transitions out of `awaitBossReply` per §1; `clearBossReplyContext` runs) | Boss explicitly abandons the pending question with a fresh directive |
| Judge returns no action or an invalid event/payload | One `emitStatus` call, no event (per PBRT-7) | A malformed classifier response must not silently move the FSM |
| Empty or whitespace-only text | No event, judge/player call, status, or FSM action; trace telemetry only (per PBRT-7) | Preserves PBRT-7; an empty BOSS_REPLY is malformed per §8 |

Outside `awaitBossReply`, `BOSS_REPLY` is not a valid classification result.
The in-state context lets the judge decide whether `"SQLite"` is a fresh directive or a reply.

### 7. Transcript embedding with player-session resume

The runtime shall **embed** the question and reply as labelled blocks in the next prompt (§5).
Per [DR-010](010-playbook-session-tracing-and-resume.md), it shall also use the player session's latest authoritative resume token when the adapter supplies one.

Trade-off matrix:

|                                | Embedded transcript | SDK session resume |
|--------------------------------|------------------------------|--------------------|
| Captain bridge change          | Explicit prompt blocks | Explicit resume selection |
| Token cost per resume          | Re-sends Q+A as text | Server-side cache may be preserved |
| Tool state continuity          | Explicit context survives without backend support | Preserved when the adapter returns a token |
| Prompt-cache effectiveness     | Q+A is new input | Prior conversation remains available |
| Determinism across adapters    | Same shape for every adapter | Best effort per adapter |

The two mechanisms are complementary.
The transcript is mandatory deterministic input and an adapter-independent fallback; SDK resume preserves the player's conversation and tool context where supported.

### 8. Failure modes

The following malformed states shall route to `failed` (per [gears2fsm.md "Errors and termination"](../../slc/gears2fsm.md#errors-and-termination)) with the error in `context.lastError`:

| Condition | Error message |
|-----------|---------------|
| Captain output has `guard: 'needsBossReply'` but no `question` field | `"needsBossReply outcome missing 'question' field"` |
| Captain output declares `needsBossReply` from a state not registered with `resumableStates(ids)` | `"state <id> declared needsBossReply but is not registered as resumable"` |
| `BOSS_REPLY` fired with empty/whitespace-only `answer` | `"BOSS_REPLY received empty answer"` |

There is no `awaitBossReply` timeout — Boss is human, long pauses are normal.
Cancellation is via a fresh Boss directive or interrupt, not a timer.

### 9. CODE FSM migration

The implementing IR shall add `needsBossReply` to every CODE captain-invoking state and register every such state with `resumableStates(ids)`.
The existing `needsBossInput → #ready` paths shall be retained where they represent a distinct "no specific question; Boss should redirect or rescope" outcome.

In particular, the CODE Committer states shall carry both guards:

- `needsBossReply` for a specific question Boss can answer before the same state resumes.
- `needsBossInput` for a broader rescoping request that should abandon the current state and return to the idle hub.

### 10. Runtime contract amendments

This DR amends the items below to accommodate the new quiescent state and its Boss-facing visibility; the amendments land with the implementing IR.

#### 10.1 Amend PBRT-11 (Drive to quiescence)

[PBRT-11](../dev/playbook-runtime.md#pbrt-11) lists quiescent states as the idle, failure, and terminal states.
It shall also include any Boss-reply suspension state (`awaitBossReply`): `handleBossInput` shall return when the actor reaches the idle, failure, terminal, **or `awaitBossReply`** state, after draining port emissions.

Without this, `handleBossInput` never returns from `awaitBossReply`, the runtime never yields to Boss, and the reply can never reach the FSM — a deadlock that defeats the DR.

#### 10.2 Amend PBRT-14 (status / telemetry stream) and PBRT-3

[PBRT-14](../dev/playbook-runtime.md#pbrt-14) and the user-facing [PBRT-3](../user/playbook-runtime.md#pbrt-3) glyph vocabulary shall be amended so that, on entry to `awaitBossReply`, the runtime emits a distinct status frame carrying `pendingBossQuestion`'s `question`, `player`, `sourceItem`, and the resume target id.
Without it, Boss sees the FSM go silent with no signal that input is expected.

The implementing IR selects the glyph and frame layout; this DR does not pin those bytes.
The IR shall also have the telemetry topic carry the same fields, so non-tmux-play hosts can render their own prompt.

#### 10.3 Amend DR-004 §8 (CODE quiescent values)

[DR-004 §8](./004-link-code-fsm-to-playbook-runtime.md#8-quiescence-and-abort) pins CODE quiescent values to `'ready'`, `'failed'`, `'done'`; the list shall gain `'awaitBossReply'` once the CODE FSM declares the state (§9).
`code.playbook.ts`'s quiescent-state constant shall be updated in the same IR commit — drift from the spec list would re-introduce the 10.1 deadlock.

### 11. `needsBossInput` is not deprecated

`needsBossInput → #ready` remains valid for a distinct intent: the player cannot proceed and has no specific question — Boss please give a fresh turn.
This is a real outcome (e.g. the workflow is wedged and needs a rescope), qualitatively different from a clarifying question.

The universal `needsBossReply` guard handles the specific-question case for every captain-invoking state.
Authored GEARS may still declare `needsBossInput` when no specific question exists and Boss should rescope or redirect.

## Consequences

- **gears2fsm grows a third Boss surface.** `BOSS_INTERRUPT` and Boss entry events keep their semantics; mid-state suspension is now a first-class pattern for every captain-invoking state.
- **CODE becomes conversational.** Players in any captain-invoking state can ask Boss questions without losing context — no more manual fresh-turn reconstruction after a question.
- **The classifier becomes state-aware.** Boss input is disambiguated by current FSM state, not just event-union heuristics; the judge receives the pending-question context when it matters.
- **Test surface grows.** Conformance must cover every `needsBossReply` arm and its `BOSS_REPLY` resume arm, plus question-lands, resume-Q+A, context-survives, fresh-directive pre-emption, and clear-on-success.
- **cligent and the SDKs are untouched.** Transcript embedding makes the DR implementable with no cligent coordination.
- **CODE author discipline shifts slightly.** Adding a captain-invoking state means giving it the universal `needsBossReply` arm, registering it resumable, and giving downstream transitions `clearBossReplyContext`; [`code.fsm.coverage.test.ts`](../../reference/sdlc/code.playbook/code.fsm.coverage.test.ts) fails closed on omissions.

## References

[1]: https://stately.ai/docs/transitions#external-transitions "XState — external transitions and `reenter`"
