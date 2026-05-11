<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-004: Link CODE FSM to PlaybookRuntime

## Goal

Compile `reference/sdlc/code.playbook/code.fsm.ts` (the CODE playbook
FSM) into a `PlaybookRuntime` module per [slc/link.md](../../slc/link.md):
a host-agnostic runner that drives the actor, classifies Boss input,
calls players, adjudicates output, and surfaces transitions through the
small `PlaybookPorts` contract.

No host code lives in this repo. tmux-play (and any future presentation
layer) loads the runtime through a generic adapter that implements
`PlaybookPorts` — that adapter is a cross-repo coordination point
(typically `@sublang/cligent/captains/playbook` for tmux-play), not a
deliverable here.

## Inputs (linker invocation)

The link compiler this IR realizes shall be invoked with:

- **FSM artifact**: `reference/sdlc/code.playbook/code.fsm.ts` (importing
  `codingMachine`, `CaptainInput`, `CaptainOutput`, `CodingInput`,
  `CodingEvent` from it).
- **Player binding** (forwarded verbatim from the host's config through
  `PlaybookRuntimeOptions`):

  ```yaml
  playerBinding:
    Coder:    coder      # opaque playerId string the host's adapter routes
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

The CODE source declares three players: `Coder`, `Reviewer`, and the
alias `Committer = Coder | Reviewer`
([code.gears.md](../../reference/sdlc/code.playbook/code.gears.md)).

Per [link.md §Player binding](../../slc/link.md#player-binding) the
linker shall resolve `Committer` per source item using the populated
`<playerName>Player` field on `CaptainInput`:

| Source item | `CaptainInput` fields populated | Resolved player → playerId |
| --- | --- | --- |
| CODE-15 | `coderPlayer` | Coder → `coder` |
| CODE-16 | `reviewerPlayer` | Reviewer → `reviewer` |
| CODE-17 | both, `coderPlayer` listed first | Coder → `coder` |

CODE-1..CODE-14 already have non-composite players and bind trivially:
Coder → `coder`, Reviewer → `reviewer`. The runtime never speaks any
host role id; `coder` and `reviewer` are opaque strings the host
adapter routes to its own primitives.

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
| anything else | LLM-classifier fallback via `callJudge` |

The LLM-classifier prompt for CODE is fixed text the linker emits once;
it names the four event types, the placeholder set for each payload
field, and demands JSON. No mention of FSM internals beyond the event
union.

`BOSS_INTERRUPT` is reached only through the explicit `/interrupt`
slash command (or the LLM classifier choosing it). It is *not* how the
host's outer abort reaches the FSM — see §Quiescence and abort.

## Captain adjudication for CODE

Per [link.md §Captain adjudication](../../slc/link.md#captain-adjudication)
the runtime invokes one adjudicator per source item via `callJudge`.
The CODE FSM's `result` maps are already self-describing (gears2fsm
round-2 review made them so) — the judge prompt for each invocation is
the literal `result` map of *that* invocation, taken from
`CaptainInput.result` XState hands the call.

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
>   unstaged/untracked edits spanning both `@specs/{user,dev,test}/`
>   and other files.
> - `challengesRaised` — Coder challenged one or more review items.
>   Output shall include `challenges: <numbered rebuttals, one per
>   challenged item>`.
> - `accepted` — Coder accepted the review outcome without further
>   edits.

The runtime does not paraphrase or shorten the result descriptions —
the contract the FSM ships is the contract the LLM judge sees. States
where adjudication can be deterministic without the judge (none in
CODE — every result key requires semantic interpretation) would use
the marker-parse strategy instead; the CODE runtime uses LLM-judge
throughout.

## Session lifecycle

Per [link.md §Session lifecycle](../../slc/link.md#session-lifecycle):

- **`init(ports)`**: construct the actor with `input` derived from
  `options.playerBinding` (host adapter forwards model/player
  identifiers it knows about):

  ```ts
  createActor(
    codingMachine.provide({ actors: { captain: captainBridge(ports) } }),
    {
      input: {
        coderPlayer:    options.coderPlayer,
        reviewerPlayer: options.reviewerPlayer,
      },
    },
  );
  ```

  Subscribe to actor snapshots and call `ports.emitStatus(...)` /
  `ports.emitTelemetry(...)` on every transition. Start the actor —
  initial state is `ready`.

- **`handleBossInput({ text, signal })`**:
  1. Classify `text` (slash → event; else LLM-classifier via
     `callJudge`).
  2. If the actor is in a `final` state, dispose and reconstruct
     (final states cannot accept new events). The CODE FSM's `done`
     is the only final state.
  3. `actor.send(event)`.
  4. **Drive to quiescence**: each time the actor invokes its
     `captain` actor, await the invoke's input, build a player
     prompt, call `ports.callPlayer(playerId, prompt, signal)`,
     adjudicate, and resolve the invoke. Repeat until the actor's
     snapshot value is `ready`, `failed`, or a final state. Honor
     `signal` between resolves.

- **`dispose()`**: stop the actor and drain pending port emissions.

## Player prompt composition

Each FSM state hands the runtime a `CaptainInput` whose `prompt` is the
source-item prompt verbatim (placeholders intact per gears2fsm). The
runtime substitutes placeholder tokens from the structured fields on
the same input:

| Token in `prompt` | Substituted from |
| --- | --- |
| `<#>` | `input.irNumber` |
| `<coder-llm>` | `input.coderPlayer` |
| `<reviewer-llm>` | `input.reviewerPlayer` |

Substitution is a literal string replace with no escaping. Boss intent,
review items, rebuttals, and task descriptions are prepended as
labelled blocks ahead of the verbatim prompt when the corresponding
field is set:

```
Boss intent:
<input.intent>

Review items:
<input.reviews>

[etc.]

<input.prompt with placeholders substituted>
```

This block-prepend is the runtime's convention; the FSM's prompt body
is never modified or re-flowed.

## Captain-actor bridge

For each FSM invocation, the runtime's `captain` actor:

1. Reads `input: CaptainInput`.
2. Resolves the `playerId` string from `input.player` via the player
   binding table (with the composite-player tiebreak rules above).
3. Builds the player prompt per §Player prompt composition.
4. Awaits `ports.callPlayer(playerId, playerPrompt, signal)`. The host
   adapter is responsible for cancelling its own primitive on
   `signal`; the port returns `PlayerResult` regardless of cancellation
   outcome.
5. Inspects `result.status`. On `'ok'`, adjudicates `result.finalText`
   via the per-state judge (§Captain adjudication). On `'error'` or
   `'aborted'`, throws — the `fromPromise` Captain actor rejects,
   XState routes the rejection through the state's `onError:
   captainError` → `#failed`, and the drive-loop sees the quiescent
   `failed` snapshot and returns. The FSM's `failed` is the single
   fail-stop sink for both Captain-actor errors and host-level player
   failures; no special-case `BOSS_INTERRUPT` is needed.
6. Returns the adjudicator's JSON as the actor's output. XState routes
   it through the state's `onDone` and the FSM advances.

`callJudge` is the runtime's adjudication / classification primitive —
never used for player turns. Host adapters typically wire it to the
host's Captain LLM (cligent: `context.callCaptain`).

## Quiescence and abort

- **Quiescent** values for the CODE FSM are `'ready'`, `'failed'`, and
  the final `'done'`. `handleBossInput` returns when the snapshot value
  matches one of these.
- **`signal` abort**: the runtime takes no FSM action on signal — it
  relies on the natural rejection path. The host adapter cancels its
  in-flight `callPlayer` / `callJudge` on signal; the port resolves
  with `PlayerResult { status: 'aborted' }` (or rejects, for hosts
  whose primitives reject natively). Step 5 above converts the bad
  status into a Captain-actor rejection, XState routes through
  `onError` to `#failed`, and the drive-loop exits. This satisfies the
  **natural rejection** strategy in
  [link.md §Abort](../../slc/link.md#abort).
- **No synthetic `BOSS_INTERRUPT` on signal**: the FSM's
  `bossInterrupts` helper uses `reenter: true`; a synthetic interrupt
  targeting the active state would stop and immediately re-enter the
  same state, spawning a fresh player call.
- **`BOSS_INTERRUPT` remains available for explicit Boss-driven
  redirects** (the gears2fsm contract — "jumps into an active
  machine, pre-empting whichever state is running"). The classifier's
  slash form `/interrupt <stateId> [args]` is the supported path.
- **Re-entry from `failed`**: the runtime accepts another Boss turn
  from `failed` — `START_CODING` / `CONTINUE_IR` / `SUMMARIZE_IR` are
  all valid via the FSM's `readyEvents`. Whether the *host* allows a
  follow-up turn is the host's decision (e.g., tmux-play's SIGINT is
  terminal per [TMUX-026](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-026)
  and the user never sees the `failed` snapshot interactively; a web
  host or a CI host may allow programmatic recovery). The runtime's
  internal `failed` transition still happens during unwind so the
  actor lands cleanly.

## Status and telemetry

Per [link.md §Status and telemetry](../../slc/link.md#status-and-telemetry):

- One `ports.emitStatus(...)` per transition into a Boss-relevant state.
  For CODE: `ready`, every review state, every commit state, `failed`,
  `done`. Status lines are short (`State → reviewBossCommitSpecs`). The
  actor's `lastError` is surfaced via `emitStatus` on the transition
  into `failed`.
- One `ports.emitTelemetry({ topic: 'playbook.fsm.state', payload: {
  from, to, event } })` per transition, regardless of relevance — the
  visualizer (`views/sketch`) listens for these.

Player prompts and adjudicator JSON ride the host's own record channels
when the host has them (cligent's `captain_*` / `role_*`); the runtime
shall not duplicate them as telemetry.

## Simulated compiler output

The link compiler this IR realizes emits exactly one file. Below is
the shape it would emit for the inputs above. No code is written yet —
the shape is what the IR ships.

**`reference/sdlc/code.playbook/code.playbook.ts`** — top-of-file header
records the linker invocation:

```text
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Generated by slc/link.md (FSM-to-Runtime linker).
// Source FSM:    ./code.fsm.ts  (compiled from code.gears.md)
// Player bind:   Coder→coder, Reviewer→reviewer,
//                Committer→{coder per CODE-15/17, reviewer per CODE-16}
// Boss event:    slash-prefix (LLM-classifier fallback)
// Adjudication:  LLM-judge per state
```

**Module shape** (described, not implemented):

- `import { codingMachine, CaptainInput, CaptainOutput, CodingInput,
  CodingEvent } from './code.fsm.js';`
- `import { createActor, fromPromise } from 'xstate';`
- `export interface CodePlaybookOptions extends CodingInput { /* … */ }`
  — typed options surface; carries `coderPlayer`/`reviewerPlayer` and
  any future per-run knobs.
- `export interface PlaybookPorts { /* per slc/link.md */ }` — re-
  exported for host adapter authors; the runtime references it
  directly.
- `export interface PlaybookRuntime { /* init / handleBossInput /
  dispose */ }`
- `export default function createPlaybookRuntime(options:
  CodePlaybookOptions): PlaybookRuntime { … }` — the factory.
- Internal helpers (host-agnostic):
  - `composePlayerPrompt(input: CaptainInput): string`
  - `classifyBossInput(text: string, ports: PlaybookPorts, signal):
    Promise<CodingEvent>`
  - `judgeResult(input: CaptainInput, output: string, ports, signal):
    Promise<CaptainOutput>` — derives the judge prompt from
    `input.result`; calls `ports.callJudge`.
  - `resolvePlayerId(input: CaptainInput, binding): string` —
    composite-player tiebreak.
  - `captainBridge(ports)`: returns a
    `fromPromise<CaptainOutput, CaptainInput>` that runs steps 1–6
    above for each invocation.

The file holds no host-specific types and makes no host primitive
calls. The runtime speaks only `PlaybookPorts`.

## Host coordination (informative)

The first host to run this runtime is cligent/tmux-play. The cligent
side ships, in its own repo, a generic adapter at
`@sublang/cligent/captains/playbook` that:

- Accepts a `bridge` path (or specifier) via `captain.options`.
- Imports the module and constructs the runtime with options forwarded
  from `captain.options`.
- Implements `PlaybookPorts` by wrapping its own primitives:
  `callPlayer ← context.callRole`, `callJudge ← context.callCaptain`,
  `emitStatus`/`emitTelemetry` ← `session.emitStatus`/`session.emit
  Telemetry`.
- Forwards `handleBossTurn(turn, context)` to `runtime.handleBossInput
  ({ text: turn.prompt, signal: context.signal })`.

Example tmux-play config a user writes:

```yaml
captain:
  from: '@sublang/cligent/captains/playbook'
  adapter: claude
  model: claude-opus-4-7
  options:
    bridge: ../../reference/sdlc/code.playbook/code.playbook.ts
    coderPlayer: claude
    reviewerPlayer: codex
roles:
  - id: coder
    adapter: claude
  - id: reviewer
    adapter: codex
```

That config is owned by the user, not by this repo. This IR's deliverables
stop at the runtime; the cligent adapter is tracked separately in
cligent's own IRs.

## Deliverables

- [ ] **`slc/link.md`** — the general third-phase spec around
  `PlaybookRuntime` + `PlaybookPorts`. *(Already landed.)*
- [ ] **`reference/sdlc/code.playbook/code.playbook.ts`** — the
  emitted runtime module (per §Simulated compiler output).
- [ ] **`reference/sdlc/code.playbook/code.playbook.test.ts`** —
  unit tests with a hand-rolled fake `PlaybookPorts`. Asserts the
  Boss-event classifier, player-id resolution, judge JSON parsing,
  the quiescence drive loop, and the natural-rejection abort path.
- [ ] **`reference/sdlc/code.playbook/README.md`** — quickstart
  pointing at the runtime module, a fake-ports example for local
  iteration, and a "running under tmux-play" subsection that links
  out to the cligent-side `@sublang/cligent/captains/playbook`
  adapter (or notes "not yet shipped" while that is true).
- [ ] **`specs/map.md`** — update IR-004 row to match the new file
  name and summary.

The tmux-play YAML config and the end-to-end tmux acceptance run are
*not* deliverables here — they depend on the cligent-side adapter
landing. This IR can ship and be useful before then; cligent
coordination follows in its own IR.

## Tasks

Each task is a commit. Order keeps `main` building at every commit.

1. **Land the rewritten `slc/link.md`** and this IR file (with the
   new filename `004-link-code-fsm-to-playbook-runtime.md`). Remove
   the old `004-link-code-fsm-to-tmux-play.md`. Update `specs/map.md`
   in the same commit.
2. **Scaffold the runtime module** — create `code.playbook.ts` with
   the top-of-file header from §Simulated compiler output, the
   imports, the factory export, the `PlaybookPorts`/`PlaybookRuntime`
   types, and TODO stubs for the five helpers. The file shall
   typecheck against `./code.fsm.js` and `xstate` only — no host
   imports.
3. **Implement the player-prompt composer** (`composePlayerPrompt`).
   Unit test round-trips every placeholder token (`<#>`,
   `<coder-llm>`, `<reviewer-llm>`) and every labelled block
   (`intent`, `reviews`, `challenges`, `taskDescription`).
4. **Implement the player-id resolver** (`resolvePlayerId`). Cover
   CODE-15/16/17 alias resolution in the test.
5. **Implement the LLM judge** (`judgeResult`). Each invocation's
   judge prompt is built from `input.result` — XState hands the
   runtime the per-state contract directly. Test against a fake
   `ports.callJudge` that returns a fixed JSON; assert the prompt
   body contains every key listed in `input.result` with its
   description verbatim.
6. **Implement the Boss-event classifier** (`classifyBossInput`).
   Slash forms first; LLM-classifier fallback via `ports.callJudge`
   second. Test the slash table and one LLM-fallback path with a
   fake `callJudge`.
7. **Wire the Captain-actor bridge** (`captainBridge(ports)` +
   `.provide({ actors: { captain: … } })`) inside
   `createPlaybookRuntime`. Test that an actor driven through one
   fake turn end-to-end with stubbed `callPlayer`/`callJudge` ports
   transitions through the expected states.
8. **Drive-to-quiescence loop + abort**. Implement `handleBossInput`
   proper, including the `final`-state dispose/reconstruct path. On
   `signal` abort the runtime takes no FSM action — it relies on
   the natural rejection → `onError` → `#failed` path. Test three
   scenarios: clean run to `ready`; signal-abort mid-`callPlayer`
   lands at `failed` with the abort error in `lastError`; explicit
   `/interrupt <stateId>` slash redirects to that state via
   `BOSS_INTERRUPT`.
9. **Status/telemetry hookup** (`ports.emitStatus` /
   `ports.emitTelemetry`). Subscribe to actor snapshots, emit on
   every transition. Test with a fake `PlaybookPorts` that records
   emissions.
10. **README**. Document the fake-ports example, the public
    `PlaybookRuntime`/`PlaybookPorts` types, and the tmux-play
    integration path (linking out to the cligent-side adapter).
11. **Spec deltas**. Update `specs/map.md` to mark IR-004 deliverables
    complete; if anything diverged from this IR's design, record the
    delta in a one-paragraph addendum at the bottom of this file.

## Acceptance criteria

- `code.playbook.ts` typechecks against `./code.fsm.js` and `xstate`
  with no host-specific imports. The exported `createPlaybookRuntime`
  satisfies the `PlaybookRuntime` interface from
  [slc/link.md](../../slc/link.md).
- Unit tests with a hand-rolled fake `PlaybookPorts` drive the FSM
  through at least:
  - `/start <intent>` → `planAndImplement` → `commitCoderInitial` →
    `reviewBossCommitSpecs` (or whichever scope-variant the test
    pins), with `callPlayer` invoked for Coder then Reviewer in the
    expected order.
  - LLM-classifier fallback: free-form Boss text routes through
    `callJudge` and lands on the same flow when the text obviously
    matches `START_CODING`.
  - Natural-rejection abort: `signal` fires mid-`callPlayer`, the
    fake port resolves with `PlayerResult { status: 'aborted' }`,
    the runtime lands at `failed`, the drive-loop returns, and
    `lastError` is surfaced via `emitStatus`.
  - `/interrupt <stateId>` redirects via `BOSS_INTERRUPT` (with
    `reenter: true`).
  - `done` cleanly disposes the actor; the next Boss turn starts
    fresh from `ready`.
- `code.playbook.ts` has no FSM-specific prose other than what it
  derives from importing `code.fsm.ts` at runtime.
- All `reference/sdlc/code.playbook/**` source files carry SPDX
  headers per the project's licensing spec.
- End-to-end under tmux-play is verified separately, after the
  cligent-side `@sublang/cligent/captains/playbook` adapter ships
  (cligent's own IR). When that lands, a tmux-play config of the
  shape shown in §Host coordination shall run the CODE playbook
  unmodified.

## Out of scope

- The cligent-side `@sublang/cligent/captains/playbook` adapter — its
  own IR in the cligent repo.
- Building a second host (web/Electron/CI runner). The runtime is
  host-agnostic and ready for those; each host writes its own
  ~30-line adapter against `PlaybookPorts`.
- Re-deriving any FSM behavior, prompts, guard keys, or result
  semantics. Those live in `code.gears.md` and `code.fsm.ts`.
- Visualizer rendering. The visualizer is IR-003's deliverable; this
  IR only emits the telemetry it consumes.
- Persisting FSM context across runtime sessions.
