<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-004: Link CODE FSM to tmux-play Captain

## Goal

Wire `reference/sdlc/code.playbook/code.fsm.ts` (the compiled CODE
playbook) into [cligent](https://github.com/sublang-ai/cligent)'s tmux-play
Captain extension so the playbook actually runs end-to-end. A Boss types in
the left tmux pane; the FSM advances; player conversations stream in the
right panes. No new FSM behavior; this IR is purely the third compiler
phase (linking).

Land the general link contract first ([slc/link.md](../../slc/link.md)),
then specialize it for the CODE FSM + tmux-play host, then ship the linked
Captain module plus the smallest possible example config and run script.

## Inputs (linker invocation)

The link compiler this IR realizes shall be invoked with:

- **FSM artifact**: `reference/sdlc/code.playbook/code.fsm.ts` (importing
  `codingMachine`, `CaptainInput`, `CaptainOutput`, `CodingInput`,
  `CodingEvent` from it).
- **Host contract**: `@sublang/cligent/tmux-play` — types `Captain`,
  `BossTurn`, `CaptainSession`, `CaptainContext`, `RoleHandle`,
  `RoleRunResult`, `CaptainRunResult` ([DR-004](https://github.com/sublang-ai/cligent/blob/main/specs/decisions/004-tmux-play-captain-architecture.md)).
- **Player binding** (sourced from the linker's option payload, which
  flows in through `tmux-play`'s `captain.options`):

  ```yaml
  playerBinding:
    Coder:    coder      # host role id (must exist in roles[])
    Reviewer: reviewer
    # Composite players resolved per slc/link.md:
    #   Committer = Coder | Reviewer  →  resolved per source item
  ```

- **Boss-event mapping**: slash-prefix default, LLM-classifier fallback.
- **Adjudication strategy**: LLM-judge for every state, marker-parse
  off by default.

These four inputs are recorded verbatim in the emitted file's top-of-file
header per [link.md §Output](../../slc/link.md#output).

## Player binding for CODE

The CODE source declares three players: `Coder`, `Reviewer`, and the alias
`Committer = Coder | Reviewer` ([code.gears.md](../../reference/sdlc/code.playbook/code.gears.md)).

Per [link.md §Player binding](../../slc/link.md#player-binding) the linker
shall resolve `Committer` per source item using the populated
`<playerName>Player` field on `CaptainInput`:

| Source item | `CaptainInput` fields populated | Resolved player → role id |
| --- | --- | --- |
| CODE-15 | `coderPlayer` | Coder → `coder` |
| CODE-16 | `reviewerPlayer` | Reviewer → `reviewer` |
| CODE-17 | both, `coderPlayer` listed first | Coder → `coder` |

CODE-1..CODE-14 already have non-composite players and bind trivially:
Coder → `coder`, Reviewer → `reviewer`.

## Boss-event mapping for CODE

CODE's event union is

```ts
| { type: 'START_CODING'; intent: string }
| { type: 'CONTINUE_IR'; irNumber: string }
| { type: 'SUMMARIZE_IR'; irNumber: string }
| { type: 'BOSS_INTERRUPT'; targetId: JumpableStateId; intent?; irNumber? }
```

The linker emits one classifier per event. Slash forms:

| Boss line | Event |
| --- | --- |
| `/start <text>` | `{ type: 'START_CODING', intent: '<text>' }` |
| `/continue <#>` | `{ type: 'CONTINUE_IR', irNumber: '<#>' }` |
| `/summarize <#>` | `{ type: 'SUMMARIZE_IR', irNumber: '<#>' }` |
| `/interrupt <stateId> [args…]` | `{ type: 'BOSS_INTERRUPT', targetId: '<stateId>', … }` |
| anything else | LLM-classifier fallback |

The LLM-classifier prompt for CODE is fixed text the linker emits once; it
names the four event types, the placeholder set for each payload field,
and demands JSON. No mention of FSM internals beyond the event union.

`BOSS_INTERRUPT` is reached only through the explicit `/interrupt`
slash command (or the LLM classifier choosing it). It is *not* how
SIGINT-style aborts reach the FSM — those go through the natural
`onError → #failed` path documented in §Quiescence and abort.

## Captain adjudication for CODE

Per [link.md §Captain adjudication](../../slc/link.md#captain-adjudication)
the linker emits one adjudicator per source item. The CODE FSM's
`result` maps are already self-describing (gears2fsm round-2 review made
them so) — the linker's judge prompt for each state is the literal
`result` map of that state.

Example (CODE-2 / `respondToReview`):

> The player just produced this output, replying to a review of the
> latest commit:
>
> ```
> <player output verbatim>
> ```
>
> Pick exactly one of the following outcomes by `guard` and return JSON
> `{ guard, …payloadFields }`. Required payload fields are named in the
> outcome description.
>
> - `changesMadeSpecs` — Coder accepted items and produced
>   unstaged/untracked edits in `@specs/{user,dev,test}/` only.
> - `changesMadeCode` — Coder accepted items and produced
>   unstaged/untracked edits outside `@specs/{user,dev,test}/` only.
> - `changesMadeMixed` — Coder accepted items and produced
>   unstaged/untracked edits spanning both `@specs/{user,dev,test}/` and
>   other files.
> - `challengesRaised` — Coder challenged one or more review items.
>   Output shall include `challenges: <numbered rebuttals, one per
>   challenged item>`.
> - `accepted` — Coder accepted the review outcome without further
>   edits.

The judge is invoked via cligent's `context.callCaptain(judgePrompt)`. The
linker does not paraphrase or shorten the result descriptions, so the
contract the FSM ships is the contract the LLM judge sees.

States where adjudication can be deterministic without the judge (none in
CODE — every result key requires semantic interpretation) would use the
marker-parse strategy instead; the CODE linker uses LLM-judge throughout.

## Session lifecycle

Per [link.md §Session lifecycle](../../slc/link.md#session-lifecycle):

- **`init(session)`**: construct the actor with input

  ```ts
  createActor(codingMachine, {
    input: {
      coderPlayer:    session.roles.find(r => r.id === 'coder')?.model,
      reviewerPlayer: session.roles.find(r => r.id === 'reviewer')?.model,
    },
  })
  ```

  Subscribe to actor snapshots and call `session.emitStatus(...)` /
  `session.emitTelemetry(...)` on every transition.
  Start the actor — initial state is `ready`.
- **`handleBossTurn(turn, context)`**:
  1. Classify `turn.prompt` (slash → event; else LLM-classifier).
  2. If the actor is in a `final` state, dispose and reconstruct (final
     states cannot accept new events). The CODE FSM's `done` is the
     only final state.
  3. `actor.send(event)`.
  4. **Drive to quiescence**: each time the actor invokes its
     `captain` actor, await the invoke's input, build a player prompt,
     call the host primitive, adjudicate, and resolve the invoke. Repeat
     until the actor's snapshot value is `ready`, `failed`, or a final
     state. Honor `context.signal` between resolves.
- **`dispose()`**: stop the actor.

The linker swaps the FSM's `captain` placeholder via XState's
`.provide({ actors: { captain: ... } })`. The provided actor is the bridge:
it receives `CaptainInput`, calls a host primitive, adjudicates, and
returns `CaptainOutput`.

## Player prompt composition

Each FSM state hands the linker a `CaptainInput` whose `prompt` is the
source-item prompt verbatim (placeholders intact per gears2fsm). The linker
substitutes placeholder tokens from the structured fields on the same
input:

| Token in `prompt` | Substituted from |
| --- | --- |
| `<#>` | `input.irNumber` |
| `<coder-llm>` | `input.coderPlayer` |
| `<reviewer-llm>` | `input.reviewerPlayer` |

Substitution is a literal string replace with no escaping; the linker
emits one prompt-prep helper that handles all three tokens. Boss intent,
review items, rebuttals, and task descriptions are likewise prepended as
labelled blocks ahead of the verbatim prompt when the corresponding field
is set:

```
Boss intent:
<input.intent>

Review items:
<input.reviews>

[etc.]

<input.prompt with placeholders substituted>
```

This block-prepend is the linker's convention; the FSM's prompt body is
never modified or re-flowed.

## Captain-actor bridge

For each FSM invocation, the linked Captain actor:

1. Reads `input: CaptainInput`.
2. Resolves the host role id from `input.player` via the player binding
   table (with the composite-player tiebreak rules above).
3. Builds the player prompt per §Player prompt composition.
4. Awaits `context.callRole(roleId, playerPrompt)`. Honors
   `context.signal`. `callRole` failures already surface as
   `role_finished { status: 'error' }` records emitted by the cligent
   runtime per [TMUX-025](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-025);
   the linker neither re-emits them as `runtime_error` (that record is
   reserved for control-plane failures per the same spec item) nor
   swallows them. Step 5 below routes the bad status into the FSM's
   `onError` so the runtime's own `role_finished` record stays the
   single source of truth for the failure.
5. Adjudicates the role's `finalText` via the per-state judge
   (§Captain adjudication). On `RunStatus === 'error'` or
   `'aborted'`, the bridge throws — the `fromPromise` actor rejects,
   XState routes the rejection through the state's `onError:
   captainError` → `#failed`, and the linker's drive-loop sees the
   quiescent `failed` snapshot and returns. The FSM's `failed` is
   the single fail-stop sink for both Captain-actor errors and
   host-level role failures; no special-case `BOSS_INTERRUPT` is
   needed.
6. Returns the adjudicator's JSON as the actor's output. XState routes it
   through the state's `onDone` and the FSM advances.

`context.callCaptain(prompt)` is reserved for the LLM-judge / LLM-
classifier. The FSM-driven player calls all use `callRole`.

## Quiescence and abort

- **Quiescent** values for the CODE FSM are `'ready'`, `'failed'`, and
  the final `'done'`. `handleBossTurn` returns when the snapshot value
  matches one of these.
- **`context.signal` abort**: the linker shall *not* synthesize a
  `BOSS_INTERRUPT` on signal — the FSM's `bossInterrupts` helper uses
  `reenter: true`, so a synthetic interrupt would stop and immediately
  re-enter the same state, spawning a fresh player call.
  Instead, the linker relies on the natural rejection path: cligent
  propagates `context.signal` into the in-flight `callRole` /
  `callCaptain`, the call rejects with an abort error, the
  `fromPromise` Captain actor surfaces that as a rejection, and
  XState routes it through the state's `onError: captainError` →
  `#failed`. `failed` is quiescent, so the drive-loop exits and
  `handleBossTurn` returns. The active player call is already
  cancelled by the same signal propagation; no further action is
  needed from the linker.
- **`BOSS_INTERRUPT` remains available for explicit Boss-driven
  redirects** (the gears2fsm contract — "jumps into an active
  machine, pre-empting whichever state is running"). The classifier's
  slash form `/interrupt <stateId> [args]` is the supported path; it
  is not how SIGINT-style aborts are expressed.
- **Re-entry from `failed`**: Boss may send another `START_CODING` /
  `CONTINUE_IR` / `SUMMARIZE_IR` from `failed`; the FSM accepts them
  via `readyEvents`. The actor's `lastError` is surfaced via
  `emitStatus` on the transition into `failed` so Boss sees the
  diagnostic.

## Status and telemetry

Per [link.md §Status and telemetry](../../slc/link.md#status-and-telemetry):

- One `session.emitStatus(...)` per transition into a Boss-relevant state.
  For CODE: `ready`, every review state, every commit state, `failed`,
  `done`. Status lines are short (`State → reviewBossCommitSpecs`).
- One `session.emitTelemetry({ topic: 'playbook.fsm.state', payload: {
  from, to, event } })` per transition, regardless of relevance — the
  visualizer (`views/sketch`) listens for these.

Player prompts and adjudicator JSON ride the cligent `role_*` /
`captain_*` records that the runtime emits automatically; the linker does
not duplicate them as telemetry.

## Simulated compiler output

The link compiler this IR realizes emits exactly one file. Below is the
shape it would emit for the inputs above. No code is written yet — the
shape is what the IR ships.

**`reference/sdlc/code.playbook/code.captain.ts`** — top-of-file header
records the linker invocation:

```text
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Generated by slc/link.md (FSM-to-Captain linker).
// Source FSM:        ./code.fsm.ts  (compiled from code.gears.md)
// Host contract:     @sublang/cligent/tmux-play  (cligent DR-004)
// Player binding:    Coder→coder, Reviewer→reviewer,
//                    Committer→{coder per CODE-15/17, reviewer per CODE-16}
// Boss event:        slash-prefix (LLM-classifier fallback)
// Adjudication:      LLM-judge per state
```

**Module shape** (described, not implemented):

- `import { codingMachine, CaptainInput, CaptainOutput, CodingInput,
  CodingEvent } from './code.fsm.js';` — the FSM's actual public
  surface. `JumpableStateId`, the per-state `result` maps, and every
  other internal type stay local to the FSM; the linker has no need
  for them as static imports (see §Captain adjudication for how each
  invocation's `result` reaches the judge).
- `import { createActor, fromPromise } from 'xstate';`
- `import type { Captain, BossTurn, CaptainContext, CaptainSession,
  RoleHandle } from '@sublang/cligent/tmux-play';`
- `export interface CodeCaptainOptions { playerBinding?: { Coder?:
  string; Reviewer?: string }; … }` — the opaque `options` blob that
  `tmux-play.config.yaml` forwards verbatim.
- `export default function createCodeCaptain(options: unknown): Captain
  { … }` — the host factory.
- Internal helpers, one per emitted strategy:
  - `composePlayerPrompt(input: CaptainInput): string`
  - `classifyBossPrompt(prompt: string, context): Promise<CodingEvent>`
  - `judgeResult(input: CaptainInput, output: string, context):
    Promise<CaptainOutput>` — derives the judge prompt from the
    `input.result` map XState hands the invocation. No pre-computed
    per-state table is needed: the FSM ships the contract through each
    `CaptainInput`, the linker reads it there.
  - `resolveRoleId(input: CaptainInput, binding): string` — implements
    the composite-player tiebreak.
- The `captain` actor placeholder is replaced with
  `fromPromise<CaptainOutput, CaptainInput>(async ({ input }) => { … })`
  wired through the helpers; XState's `.provide({ actors: { captain }
  })` swap happens inside `init`.

The file holds no CODE-specific prose. All player prompts, guard keys,
and result descriptions live in `code.fsm.ts` and reach the linker
through `CaptainInput` at each invocation; the linker never mirrors
them.

## Deliverables

- [ ] **`slc/link.md`** — the general third-phase spec. *(Lands first;
  pre-existing in this IR's branch.)*
- [ ] **`reference/sdlc/code.playbook/code.captain.ts`** — the linked
  Captain module (per §Simulated compiler output). Not in this IR — see
  §Tasks below for the commit ordering.
- [ ] **`reference/sdlc/code.playbook/code.captain.test.ts`** —
  unit tests with stubbed `CaptainContext` / `CaptainSession`. Asserts
  the boss-event classifier, role-id resolution, judge JSON parsing, and
  the quiescence drive loop.
- [ ] **`reference/sdlc/code.playbook/tmux-play.config.yaml`** — example
  config that points `captain.from` at `code.captain.ts` and declares
  two roles (`coder`, `reviewer`). Mirrors the example block in
  [link.md §Output](../../slc/link.md#output).
- [ ] **`reference/sdlc/code.playbook/README.md`** — quickstart: install
  cligent, pnpm-link or `npm install` the playbook, run `tmux-play
  --config ./tmux-play.config.yaml`, what to type first, how to read the
  pane layout.
- [ ] **`specs/map.md`** — add IR-004 row.

## Tasks

Each task is a commit. Order keeps `main` building at every commit.

1. **Land `slc/link.md`** in its own commit. It is independent of any
   host implementation and can be reviewed without the rest of the IR.
2. **Land this IR** (`specs/iterations/004-link-code-fsm-to-tmux-play.md`)
   referencing `slc/link.md`. Update `specs/map.md` in the same commit.
3. **Pin the cligent dependency**. Decide submodule vs published
   tarball vs `pnpm link --global`; record the choice as a one-line note
   in this IR's Goal section. Either choice keeps the rest of the IR
   buildable. (Mirror IR-003's task 1 in style.)
4. **Scaffold the linked file** — create `code.captain.ts` with the
   top-of-file header from §Simulated compiler output, the imports, the
   factory export, and TODO stubs for the four helpers. No runtime
   logic yet; the file should typecheck against `@sublang/cligent/
   tmux-play` and `./code.fsm.js`.
5. **Implement the player-prompt composer** (`composePlayerPrompt`). One
   commit with the implementation + a unit test that round-trips every
   placeholder token (`<#>`, `<coder-llm>`, `<reviewer-llm>`) and every
   labelled block (`intent`, `reviews`, `challenges`, `taskDescription`).
6. **Implement the role-id resolver** (`resolveRoleId`). Cover
   CODE-15/16/17 alias resolution in the test.
7. **Implement the LLM judge** (`judgeResult`). One commit per strategy
   would also work; for CODE there is only LLM-judge, so one commit.
   Each invocation's judge prompt is built from the `result` map on
   that invocation's `CaptainInput` — XState already hands the linker
   the per-state contract through `input.result`, so no pre-computed
   table and no FSM refactor are needed. Test against a fake
   `callCaptain` that returns a fixed JSON; assert the prompt body
   contains every key listed in `input.result` with its description
   verbatim.
8. **Implement the Boss-event classifier** (`classifyBossPrompt`). Slash
   forms first; LLM-classifier fallback second. Test the slash table and
   one LLM-fallback path with a fake `callCaptain`.
9. **Wire the Captain-actor bridge** (`fromPromise` glue plus
   `.provide({ actors: { captain: … } })`) inside `createCodeCaptain`.
   Add a test that drives an actor through one fake turn end-to-end with
   stubbed `callRole`/`callCaptain` returning canned responses.
10. **Drive-to-quiescence loop + abort**. Implement `handleBossTurn`
    proper, including the `final`-state dispose/reconstruct path. On
    `context.signal` abort the linker takes no FSM action — it relies
    on the natural rejection → `onError` → `#failed` path (see
    §Quiescence and abort). Test three scenarios: clean run to
    `ready`; signal-abort mid-`callRole` lands at `failed` with the
    abort error in `lastError`; explicit `/interrupt <stateId>` slash
    redirects to that state via `BOSS_INTERRUPT`.
11. **Status/telemetry hookup** (`session.emitStatus` /
    `session.emitTelemetry`). Subscribe to actor snapshots, emit on every
    transition. Test with a fake session that records emissions.
12. **Example config + README**. Add `tmux-play.config.yaml` and
    `README.md`. Manual acceptance: run `tmux-play --config …`, type
    `/start add a hello world`, watch the FSM walk to `commitCoderInitial`
    and a `coder` pane stream the reply.
13. **Spec deltas**. Update `specs/map.md` to mark IR-004 deliverables
    complete; if anything diverged from this IR's design, record the
    delta in a one-paragraph addendum at the bottom of this file.

## Acceptance criteria

- A user with cligent installed can run `tmux-play --config
  reference/sdlc/code.playbook/tmux-play.config.yaml` and see the
  standard tmux-play layout: Captain pane left, `coder` and `reviewer`
  panes right.
- Typing `/start <intent>` in the Captain pane drives the FSM through
  at least `planAndImplement → commitCoderInitial → reviewBossCommit*`
  with each player's reply streaming to the matching role pane.
- Typing free-form text (no slash) routes through the LLM-classifier
  fallback and lands on the same flow when the text obviously matches
  `START_CODING`.
- `Ctrl-C` (SIGINT) is terminal in tmux-play per [TMUX-026](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-026):
  the runtime aborts the active turn, runs shutdown, kills the tmux
  session, and removes launcher-owned work dirs. Internally during
  the unwind, cligent's `context.signal` cancels the in-flight
  `callRole`, which *resolves* with `RoleRunResult { status:
  'aborted' }` per [TMUX-033](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-033) —
  it does not reject. The linker's bridge inspects `result.status`
  and throws (per §Captain-actor bridge step 5); that throw rejects
  the `fromPromise` Captain actor, XState routes the rejection
  through `onError` to `#failed`, and the drive-loop drains the turn
  cleanly. The user sees tmux exit, not a `failed` snapshot — there
  is no follow-up turn in the same session. In-session redirection
  (without ending the session) is reached only via the explicit
  `/interrupt` slash, not Ctrl-C.
- Typing `/interrupt <stateId>` redirects the FSM to that jumpable
  state via `BOSS_INTERRUPT` (with `reenter: true`). This is the
  explicit Boss-driven redirect path; it is distinct from SIGINT and
  is not how aborts are expressed.
- The FSM's `done` state cleanly disposes the actor; the next Boss turn
  starts fresh from `ready`.
- The sketch visualizer (`views/sketch`) attached as an opt-in
  observer renders the same `playbook.fsm.state` transitions emitted by
  the linked Captain. *(Demonstration is in IR-003's scope; this IR
  contributes the telemetry source.)*
- Test suite passes; `code.captain.ts` has no FSM-specific prose other
  than what it derives from importing `code.fsm.ts` at runtime.
- All `reference/sdlc/code.playbook/**` source files carry SPDX headers
  per [LIC-1](../dev/licensing.md#lic-1) and
  [LIC-2](../dev/licensing.md#lic-2). *(Update path if the playbook
  repo's licensing spec lives elsewhere.)*

## Out of scope

- Building a second host (web/Electron Captain). The link spec supports
  it; this IR ships only the cligent/tmux-play binding.
- Re-deriving any FSM behavior, prompts, guard keys, or result
  semantics. Those live in `code.gears.md` and `code.fsm.ts`.
- Visualizer rendering. The visualizer is IR-003's deliverable; this IR
  only emits the telemetry it consumes.
- Persisting FSM context across `tmux-play` sessions.
