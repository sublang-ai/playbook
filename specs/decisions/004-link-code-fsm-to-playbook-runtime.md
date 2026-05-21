<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-004: CODE Playbook — Linker Bindings and Host Adapter

## Status

Accepted.
Pins the CODE-specific bindings that [slc/link.md](../../slc/link.md) leaves open.

## Context

[slc/link.md](../../slc/link.md) is host- and FSM-agnostic.
The CODE playbook needs concrete choices for player binding, Boss-event mapping, adjudication, session lifecycle, prompt composition, captain-actor bridge, abort behavior, telemetry, and the tmux-play host adapter (the only host this repo ships).
This DR pins those choices so any implementation iteration builds against a stable contract without re-deciding.

The host adapter ships in this repo, not in cligent.
cligent stays a lower-layer primitive (tmux launcher, Captain contract, role cligents, observer dispatch) with no awareness of playbooks, XState, or `PlaybookRuntime`; this repo imports cligent as a dependency and supplies the small adapter that satisfies cligent's `Captain` interface.

## Decision

### 1. Linker inputs

| Input | Value |
| --- | --- |
| FSM artifact | `code.fsm.ts` (imports `codingMachine`, `CaptainInput`, `CaptainOutput`, `CodingInput`, `CodingEvent`) |
| Player binding | Link-time, baked: `Coder → coder`, `Reviewer → reviewer`; composite `Committer = Coder \| Reviewer` resolved per source item (see §2) |
| Boss-event mapping | Slash-prefix with LLM-classifier fallback (see §3) |
| Adjudication strategy | LLM-judge for every state; marker-parse off |

All four are recorded verbatim in the emitted file's top-of-file header per [link.md §Output](../../slc/link.md#output).

`PlaybookRuntimeOptions` carries only per-run identity strings (`coderPlayer`, `reviewerPlayer`) substituted into `<coder-llm>` / `<reviewer-llm>` placeholders.
Player binding is *not* a runtime option; future per-run remapping would be a separate DR/IR.

### 2. Player binding for CODE

CODE declares `Coder`, `Reviewer`, and the alias `Committer = Coder | Reviewer` ([code.gears.md](../../reference/sdlc/code.playbook/code.gears.md)).
Non-composite states bind trivially (Coder → `coder`, Reviewer → `reviewer`).
Composite states resolve `Committer` per source item via the populated `<playerName>Player` field on `CaptainInput`:

| Source item | Populated field | Resolved | playerId |
| --- | --- | --- | --- |
| CODE-15 | `coderPlayer` | Coder | `coder` |
| CODE-16 | `reviewerPlayer` | Reviewer | `reviewer` |
| CODE-17 | both, `coderPlayer` first | Coder | `coder` |

The runtime never speaks any host role id; `coder` / `reviewer` are opaque strings the host adapter routes to its primitives.

### 3. Boss-event mapping for CODE

CODE's `events` union:

```ts
| { type: 'START_CODING'; intent: string }
| { type: 'CONTINUE_IR'; irNumber: string }
| { type: 'SUMMARIZE_IR'; irNumber: string }
| { type: 'BOSS_INTERRUPT'; targetId: JumpableStateId; intent?; irNumber? }
```

Slash forms:

| Boss line | Event |
| --- | --- |
| `/start <text>` | `{ type: 'START_CODING', intent: '<text>' }` |
| `/continue <#>` | `{ type: 'CONTINUE_IR', irNumber: '<#>' }` |
| `/summarize <#>` | `{ type: 'SUMMARIZE_IR', irNumber: '<#>' }` |
| `/interrupt <stateId> [args…]` | `{ type: 'BOSS_INTERRUPT', targetId, … }` |
| anything else | LLM-classifier via `callJudge` |

The LLM-classifier prompt is fixed text the linker emits once: names the four event types, the placeholder set for each payload field, demands JSON, no FSM internals beyond the event union.

`BOSS_INTERRUPT` is reached only through explicit `/interrupt` (or the LLM-classifier picking it).
It is not the abort surface — see §8.

### 4. Captain adjudication

Per [link.md §Captain adjudication](../../slc/link.md#captain-adjudication) the runtime invokes one adjudicator per source item via `callJudge`.
CODE's `result` maps are self-describing (gears2fsm round-2 review made them so), so each invocation's judge prompt is the literal `result` map XState hands the call via `CaptainInput.result`.

Example (CODE-2 / `respondToReview`):

> The player just produced this output, replying to a review of the
> latest commit:
>
> ```
> <player output verbatim>
> ```
>
> Pick exactly one outcome by `guard` and return JSON
> `{ guard, …payloadFields }`.
> Required payload fields are named in the outcome description.
>
> - `changesMadeSpecs` — Coder accepted items and produced unstaged/untracked
>   edits in `@specs/{user,dev,test}/` only.
> - `changesMadeCode` — Coder accepted items and produced unstaged/untracked
>   edits outside `@specs/{user,dev,test}/` only.
> - `changesMadeMixed` — both.
> - `challengesRaised` — Coder challenged one or more items; output includes
>   `challenges: <numbered rebuttals>`.
> - `accepted` — Coder accepted without further edits.

The runtime does not paraphrase or shorten result descriptions; every CODE state uses LLM-judge.

### 5. Session lifecycle

Per [link.md §Session lifecycle](../../slc/link.md#session-lifecycle):

- **`init(ports)`** — construct the actor with `input` derived from
  `options.coderPlayer` / `options.reviewerPlayer`; subscribe to
  snapshots; start.
  Initial state: `ready`.

  ```ts
  createActor(
    codingMachine.provide({ actors: { captain: captainBridge(ports) } }),
    { input: { coderPlayer: options.coderPlayer, reviewerPlayer: options.reviewerPlayer } },
  );
  ```

- **`handleBossInput({ text, signal })`**:
  1. Classify `text` (slash → event; else LLM-classifier).
  2. If the actor is in a final state (`done`), dispose and reconstruct.
  3. `actor.send(event)`.
  4. Drive to quiescence (set in §8): invoke `captain` → build prompt →
     `callPlayer` → adjudicate → resolve.
     Honor `signal` between resolves.
- **`dispose()`** — stop the actor and drain pending port emissions.

### 6. Player prompt composition

Each FSM state hands the runtime a `CaptainInput` whose `prompt` is the source-item prompt verbatim (placeholders intact per gears2fsm).
The runtime substitutes:

| Token | From |
| --- | --- |
| `<#>` | `input.irNumber` |
| `<coder-llm>` | `input.coderPlayer` |
| `<reviewer-llm>` | `input.reviewerPlayer` |

Substitution is literal string replace with no escaping.
Boss intent, review items, rebuttals, and task descriptions are prepended as labelled blocks when set:

```
Boss intent:
<input.intent>

Review items:
<input.reviews>

[etc.]

<input.prompt with placeholders substituted>
```

The FSM's prompt body is never modified or re-flowed.

### 7. Captain-actor bridge

For each FSM invocation, the runtime's `captain` actor:

1. Reads `input: CaptainInput`.
2. Resolves `playerId` from `input.player` via the binding table
   (composite tiebreak per §2).
3. Builds the player prompt per §6.
4. Awaits `ports.callPlayer(playerId, prompt, signal)`; the host adapter
   cancels its own primitive on `signal`.
5. On `result.status === 'ok'`, adjudicates `result.finalText` via §4.
   On `'error'` / `'aborted'`, throws — `fromPromise` rejects, XState
   routes through `onError: captainError → #failed`, the drive-loop sees
   the quiescent `failed` snapshot and returns.
   `failed` is the single fail-stop sink for both Captain errors and
   player failures; no `BOSS_INTERRUPT` special case.
6. Returns the adjudicator JSON; XState routes via `onDone` and the FSM
   advances.

`callJudge` is the runtime's adjudication / classification primitive — never used for player turns.
Hosts typically wire it to the host's Captain LLM (cligent: `context.callCaptain`).

### 8. Quiescence and abort

- **Quiescent values** for CODE: `'ready'`, `'failed'`, `'done'`.
  `handleBossInput` returns when the snapshot matches.
- **`signal` abort** uses the natural-rejection strategy from
  [link.md §Abort](../../slc/link.md#abort): host adapter cancels
  in-flight `callPlayer` / `callJudge`; port resolves with
  `PlayerResult { status: 'aborted' }` (or rejects); step 5 throws;
  XState routes via `onError → #failed`; drive-loop exits.
- **No synthetic `BOSS_INTERRUPT` on signal** — the FSM's
  `bossInterrupts` helper has `reenter: true`, so a synthetic interrupt
  to the active state would respawn the player call.
- **`BOSS_INTERRUPT` is reserved for explicit Boss redirects** (the
  gears2fsm contract — *"jumps into an active machine, pre-empting
  whichever state is running"*).
  The classifier slash form `/interrupt <stateId> [args]` is the
  supported path.
- **Re-entry from `failed`** — the runtime accepts another Boss turn
  from `failed` per the FSM's `readyEvents`.
  Whether the host allows it is the host's decision (tmux-play's SIGINT
  is terminal per TMUX-026 [[3]]).

### 9. Status and telemetry

Per [link.md §Status and telemetry](../../slc/link.md#status-and-telemetry):

- One `emitStatus` per transition into a Boss-relevant state.
  For CODE: `ready`, every review state, every commit state, `failed`,
  `done`.
  Status lines are short (`State → reviewBossCommitSpecs`).
  The actor's `lastError` is surfaced via `emitStatus` on entry to
  `failed`.
- One `emitTelemetry({ topic: 'playbook.fsm.state', payload: { from, to, event } })`
  per transition.
  The visualizer (`views/sketch`) listens for these.

Player prompts and adjudicator JSON ride the host's record channels (cligent's `captain_*` / `role_*`); the runtime shall not duplicate them as telemetry.

### 10. Emitted module — `code.playbook.ts`

The link compiler emits exactly one file at `code.playbook.ts` with a top-of-file header recording the linker invocation:

```text
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Generated by slc/link.md (FSM-to-Runtime linker).
// Source FSM:    ./code.fsm.ts
// Player bind:   Coder→coder, Reviewer→reviewer,
//                Committer→{coder per CODE-15/17, reviewer per CODE-16}
// Boss event:    slash-prefix (LLM-classifier fallback)
// Adjudication:  LLM-judge per state
```

Contract surface:

- Imports `./code.fsm.js` (`codingMachine`, `CaptainInput`,
  `CaptainOutput`, `CodingInput`, `CodingEvent`) and `xstate`
  (`createActor`, `fromPromise`).
- Exports `CodePlaybookOptions extends CodingInput` (carries
  `coderPlayer` / `reviewerPlayer` and any future per-run knobs).
- Exports `PlaybookPorts` and `PlaybookRuntime` per
  [slc/link.md](../../slc/link.md).
- Default-exports
  `createPlaybookRuntime(options: CodePlaybookOptions): PlaybookRuntime`.
- Holds no host-specific types and makes no host primitive calls; speaks
  only `PlaybookPorts`.

Internal capabilities (names illustrative): player-prompt composer, Boss-event classifier, LLM judge, player-id resolver, captain bridge.

### 11. Host adapter — tmux-play

Adapter file `code.tmux-play.ts`:

- Imports `./code.playbook.js` and types from
  `@sublang/cligent/tmux-play` (`Captain`, `BossTurn`, `CaptainContext`,
  `CaptainSession`, `RoleRunResult`).
- Default-exports a Captain factory `(options: unknown) => Captain` per
  TMUX-014 [[2]].
- In `init(session)` constructs the runtime with `options` forwarded
  from `captain.options` and builds `PlaybookPorts`.
- Forwards `handleBossTurn(turn, context) →
  runtime.handleBossInput({ text: turn.prompt, signal: context.signal })`.
- In `dispose()` calls `runtime.dispose()`.

Port wiring (the entire mapping):

| `PlaybookPorts` | cligent primitive |
| --- | --- |
| `callPlayer(playerId, prompt, signal)` | `context.callRole(playerId, prompt)` — pass through; `signal` lives on `context`. Build `PlayerResult` from `RoleRunResult` (`{ status, finalText, error }`) per TMUX-033 [[4]] |
| `callJudge(prompt, signal)` | `context.callCaptain(prompt)` → return `finalText`; throw on `status !== 'ok'` |
| `emitStatus(message, data?)` | `session.emitStatus(message, data)` |
| `emitTelemetry({ topic, payload })` | `session.emitTelemetry({ topic, payload })` |

The adapter is ~40 lines once helpers factor out and is playbook-specific only via the `./code.playbook.js` import.

**Role-id constraint.**
Because the player binding is baked at link time (§1), the user's `tmux-play.config.yaml` `roles[]` shall declare role IDs that match the baked `playerId` strings (`coder`, `reviewer`).
The adapter does not remap.

**Build / ESM constraint.**
cligent's session imports `captain.from` via native `import()`, and native ESM rejects `.ts` without a loader hook, so the adapter must exist as compiled `.js` at the path `captain.from` references.
The package satisfies this with:

- A TypeScript → ESM `.js` build emitting `code.playbook.js` and
  `code.tmux-play.js` next to the `.ts` sources.
- `package.json` declaring `"type": "module"`.
- `.ts` sources using NodeNext-style `import './code.fsm.js'`
  specifiers that resolve to the compiled sibling.

Example config (dev form, sibling path per TMUX-013 [[1]]):

```yaml
captain:
  from: ./code.tmux-play.js
  adapter: claude
  model: claude-opus-4-7
  options:
    coderPlayer: claude            # substitutes <coder-llm>
    reviewerPlayer: codex          # substitutes <reviewer-llm>
roles:
  - id: coder                      # matches baked playerId
    adapter: claude
  - id: reviewer
    adapter: codex
```

After release as `@sublang/playbook`, `captain.from` swaps to the package specifier (e.g. `'@sublang/playbook/code/tmux-play'`, final form confirmed at publish time).
Roles, options, and the rest of the config are unchanged.

## Consequences

- The runtime is host-agnostic; future hosts (web, Electron, CI) get
  their own ~30-line adapter against `PlaybookPorts`.
- Player binding is baked at link time; per-run remapping would be a
  separate DR/IR.
- The adapter's `./code.playbook.js` direct-import is the only
  host-specific seam in the runtime emission flow.
  A future second playbook either copies the adapter file with the
  import swapped or, if duplication earns it, graduates to a shared
  generic adapter under `slc/` that reads a `bridge` path from
  `captain.options`.
- cligent stays unaware of playbooks, XState, and `PlaybookRuntime`.
  Bugs blocking integration are filed and fixed in cligent's repo per
  the maintainer agreement, not patched around from this repo.

### Out of scope

- Building a second host (web/Electron/CI runner).
- Generalizing `code.tmux-play.ts` into a shared `slc/` adapter — not
  needed until a second playbook ships from this repo.
- Patching cligent or tmux-play from this repo.
- Re-deriving FSM behavior, prompts, guard keys, or result semantics —
  those live in `code.gears.md` and `code.fsm.ts`.
- Visualizer rendering (IR-003).
- Persisting FSM context across runtime sessions.

## Addenda

### A1. §8 quiescent values extended for Boss-reply suspension (per DR-005)

[DR-005](./005-boss-reply-suspension-path.md) introduces an
`awaitBossReply` quiescent state for the CODE FSM. §8's
quiescent-values list (`'ready'`, `'failed'`, `'done'`) is
extended to `'ready' | 'failed' | 'done' | 'awaitBossReply'`,
matching [PBRT-11](../dev/playbook-runtime.md#pbrt-11)'s
amended drive-loop check. The matching constant in
`code.playbook.ts` shall be kept in sync — drift between the
spec list and the implementation constant would re-introduce a
drive-loop deadlock on `awaitBossReply`.

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-013 "TMUX-013 — `captain.from` path resolution"
[2]: https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-014 "TMUX-014 — Captain factory contract"
[3]: https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-026 "TMUX-026 — SIGINT terminal teardown"
[4]: https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-033 "TMUX-033 — `RoleRunResult` shape"
