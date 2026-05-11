<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-004: Link CODE FSM to PlaybookRuntime

## Goal

Compile `reference/sdlc/code.playbook/code.fsm.ts` (the CODE playbook
FSM) into a `PlaybookRuntime` module per [slc/link.md](../../slc/link.md):
a host-agnostic runner that drives the actor, classifies Boss input,
calls players, adjudicates output, and surfaces transitions through the
small `PlaybookPorts` contract.

The host adapter for tmux-play ships in this repo (per [slc/link.md
§Host adaptation](../../slc/link.md#host-adaptation-informative-not-normative)'s
project-organization clause). cligent is imported as a lower-layer
dependency and stays unaware of playbook, XState, or `PlaybookRuntime`.
A future presentation layer (web/Electron/CI) gets its own small adapter
file alongside the CODE artifacts — same pattern, different host
primitives.

## Inputs (linker invocation)

The link compiler this IR realizes shall be invoked with:

- **FSM artifact**: `reference/sdlc/code.playbook/code.fsm.ts` (importing
  `codingMachine`, `CaptainInput`, `CaptainOutput`, `CodingInput`,
  `CodingEvent` from it).
- **Player binding** (linker-time input — *baked into the compiled
  runtime*, not a runtime option):

  ```yaml
  playerBinding:
    Coder:    coder      # opaque playerId the runtime passes to callPlayer
    Reviewer: reviewer
    # Composite players resolved per slc/link.md:
    #   Committer = Coder | Reviewer  →  resolved per source item
  ```

  The default rule is *lowercase the GEARS player name*; the binding
  above is the explicit form for clarity. The host (e.g., tmux-play)
  must declare role IDs that match the baked `playerId` strings —
  there is no runtime knob to remap. Future per-run remapping would
  be a separate IR.

- **Boss-event mapping**: slash-prefix default, LLM-classifier fallback.
- **Adjudication strategy**: LLM-judge for every state, marker-parse
  off by default.

These four inputs are recorded verbatim in the emitted file's
top-of-file header per [link.md §Output](../../slc/link.md#output).

`PlaybookRuntimeOptions` carries only *runtime* knobs — the per-run
identity strings (`coderPlayer`, `reviewerPlayer`) used to substitute
`<coder-llm>` / `<reviewer-llm>` placeholders in player prompts, plus
any other future per-run inputs. It does *not* carry the player
binding.

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
  `options.coderPlayer` / `options.reviewerPlayer` (per-run model
  identity strings forwarded by the host adapter from
  `captain.options`; substituted into `<coder-llm>` / `<reviewer-llm>`
  placeholders in player prompts). The player binding itself is baked
  in at link time and does not appear here.

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

## Host adapter (tmux-play)

The host adapter belongs in this repo, not in cligent. cligent stays a
lower-layer primitive — it provides the tmux launcher, the Captain
extension contract, the role cligents, and observer dispatch, with no
awareness of playbooks, XState, or `PlaybookRuntime`. This repo
imports cligent (as a dependency) and supplies the small adapter that
satisfies cligent's `Captain` interface.

The adapter lives at `reference/sdlc/code.playbook/code.tmux-play.ts`
and:

- Imports `./code.playbook.js` (the runtime) and types from
  `@sublang/cligent/tmux-play` (`Captain`, `BossTurn`,
  `CaptainContext`, `CaptainSession`, `RoleRunResult`).
- Default-exports a Captain factory `(options: unknown) => Captain`
  per cligent's [TMUX-014](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-014).
- In `init(session)`, constructs the runtime with `options` forwarded
  from `captain.options` and builds a `PlaybookPorts` object.
- Forwards `handleBossTurn(turn, context)` to
  `runtime.handleBossInput({ text: turn.prompt, signal: context.signal })`.
- In `dispose()`, calls `runtime.dispose()`.

Port wiring (the entire mapping):

| `PlaybookPorts` | cligent primitive |
| --- | --- |
| `callPlayer(playerId, prompt, signal)` | `context.callRole(playerId, prompt)` — pass through; `signal` already lives on `context`. Return `PlayerResult` built from the resulting `RoleRunResult` (`{ status, finalText, error }` map verbatim per [TMUX-033](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-033)). |
| `callJudge(prompt, signal)` | `context.callCaptain(prompt)` → return `finalText`. Throw on `status !== 'ok'`. |
| `emitStatus(message, data?)` | `session.emitStatus(message, data)` — direct forward. |
| `emitTelemetry({ topic, payload })` | `session.emitTelemetry({ topic, payload })` — direct forward. |

The adapter is small (~40 lines once helpers are factored) and is
playbook-specific only in that it direct-imports `./code.playbook.js`.
A future second playbook in this repo would either copy this file with
one import swapped, or — if the duplication earns it — graduate to a
shared generic adapter under `slc/` that reads a `bridge` path from
`captain.options`.

**Role-id requirement on tmux-play config.** Because the player binding
is baked into the runtime at link time (§Inputs), the user's
`tmux-play.config.yaml` `roles[]` shall declare role IDs that match
the baked `playerId` strings. For CODE that is `coder` and `reviewer`.
The adapter does not remap. If a future IR adds runtime-configurable
binding, this constraint relaxes; until then, naming a role
`claude-coder` would simply mean Coder's `callRole('coder', …)` finds
no matching role and the cligent runtime surfaces the failure
naturally.

### Build step (dev) and ESM loading

cligent's session imports `captain.from` via Node's native `import()`.
Native ESM rejects `.ts` without a loader hook, so the adapter must
exist as compiled `.js` at the path `captain.from` references. This IR
ships a build step (TypeScript → ESM `.js`) that emits `code.playbook.js`
and `code.tmux-play.js` next to the `.ts` sources. The package.json
declares `"type": "module"` so Node treats the emitted `.js` as ESM,
matching cligent's own ESM convention; the `.ts` source files use
NodeNext-style `import './code.fsm.js'` specifiers that resolve to the
compiled sibling at runtime. The build is the same pipeline that
produces the published `@sublang/playbook` package, so dev and release
paths converge.

Example `tmux-play.config.yaml` shipped at
`reference/sdlc/code.playbook/tmux-play.config.yaml`. Local
`captain.from` resolves against this file's directory per
[TMUX-013](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-013),
so the sibling form `./code.tmux-play.js` is correct:

```yaml
# Dev (this repo, after `pnpm build`):
captain:
  from: ./code.tmux-play.js        # sibling of this config; built from code.tmux-play.ts
  adapter: claude
  model: claude-opus-4-7
  options:
    coderPlayer: claude            # forwarded to PlaybookRuntimeOptions; substitutes <coder-llm>
    reviewerPlayer: codex          # substitutes <reviewer-llm>
roles:
  - id: coder                      # must match the baked playerId (Coder → 'coder')
    adapter: claude
  - id: reviewer                   # must match the baked playerId (Reviewer → 'reviewer')
    adapter: codex
```

After release as `@sublang/playbook`, the same config swaps
`captain.from` to the package specifier — e.g.,
`'@sublang/playbook/code/tmux-play'` (final specifier confirmed at
publish time) — and the user installs `@sublang/cligent` and
`@sublang/playbook` side-by-side. Roles, options, and the rest of the
config are unchanged.

## Deliverables

- [ ] **`slc/link.md`** — the general third-phase spec around
  `PlaybookRuntime` + `PlaybookPorts`. *(Already landed.)*
- [ ] **`reference/sdlc/code.playbook/code.playbook.ts`** — the
  emitted runtime module (per §Simulated compiler output).
- [ ] **`reference/sdlc/code.playbook/code.playbook.test.ts`** —
  unit tests with a hand-rolled fake `PlaybookPorts`. Asserts the
  Boss-event classifier, player-id resolution, judge JSON parsing,
  the quiescence drive loop, and the natural-rejection abort path.
- [ ] **`reference/sdlc/code.playbook/code.tmux-play.ts`** — the
  tmux-play host adapter (per §Host adapter (tmux-play)). Imports
  `./code.playbook.js` and types from `@sublang/cligent/tmux-play`;
  default-exports a Captain factory that wires `PlaybookPorts` to
  cligent primitives.
- [ ] **`reference/sdlc/code.playbook/code.tmux-play.test.ts`** —
  unit tests with stubbed `CaptainContext` / `CaptainSession` that
  assert port wiring, `RoleRunResult` ↔ `PlayerResult` identity,
  `handleBossTurn → handleBossInput` forwarding, and lifecycle
  ordering.
- [ ] **`reference/sdlc/code.playbook/tmux-play.config.yaml`** — the
  example config shown in §Host adapter (tmux-play), with
  `captain.from: ./code.tmux-play.js` (sibling path; resolves
  correctly under [TMUX-013](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-013)).
- [ ] **Build pipeline** — a `package.json` with `"type": "module"`
  and a `pnpm build` (or `npm run build`) script that emits
  `code.playbook.js` and `code.tmux-play.js` next to the `.ts`
  sources. TypeScript → ESM `.js`; no bundler needed. The same
  pipeline is the publish pipeline for `@sublang/playbook`. Source
  `.ts` and built `.js` both ship in the npm tarball; `.js` is what
  `captain.from` resolves to in either dev or release. NodeNext-style
  `.js` import specifiers in the `.ts` sources resolve to the
  compiled siblings.
- [ ] **`reference/sdlc/code.playbook/README.md`** — quickstart
  pointing at the runtime module, a fake-ports example for local
  iteration, a "running under tmux-play" subsection that links the
  example YAML config, and a "release usage" note showing the
  package-specifier form (`@sublang/playbook/code/tmux-play`).
- [ ] **`package.json`** — declare `@sublang/cligent` as a
  `peerDependency` (or `dependency` while the playbook is unpublished
  and is consumed via local link); set up a `pnpm`/`npm` script to
  link a local cligent checkout for development.
- [ ] **`specs/map.md`** — update IR-004 row to match the new file
  name and summary. *(Already updated to reflect the rename;
  re-verify summary on close-out.)*

## Tasks

Each task is a commit. Order keeps `main` building at every commit.

1. **Land the rewritten `slc/link.md`** and this IR file (with the
   new filename `004-link-code-fsm-to-playbook-runtime.md`). Remove
   the old `004-link-code-fsm-to-tmux-play.md`. Update `specs/map.md`
   in the same commit.
2. **Bootstrap the build pipeline.** Add a minimal `package.json`
   (with `"type": "module"`), `tsconfig.json` (NodeNext module
   resolution), and `pnpm build` script under
   `reference/sdlc/code.playbook/` (or wherever the workspace root
   for this artifact set sits). The script shall emit `.js` next to
   every `.ts` source. Wire `@sublang/cligent` as a peer/devDependency
   per §Deliverables. Verify `pnpm install && pnpm build` is clean
   on a fresh checkout before any source file is added.
3. **Scaffold the runtime module** — create `code.playbook.ts` with
   the top-of-file header from §Simulated compiler output, the
   imports, the factory export, the `PlaybookPorts`/`PlaybookRuntime`
   types, and TODO stubs for the five helpers. The file shall
   typecheck against `./code.fsm.js` and `xstate` only — no host
   imports. Verify `pnpm build` emits `code.playbook.js`.
4. **Implement the player-prompt composer** (`composePlayerPrompt`).
   Unit test round-trips every placeholder token (`<#>`,
   `<coder-llm>`, `<reviewer-llm>`) and every labelled block
   (`intent`, `reviews`, `challenges`, `taskDescription`).
5. **Implement the player-id resolver** (`resolvePlayerId`). Cover
   CODE-15/16/17 alias resolution in the test. The baked binding
   table is the link-time input from §Inputs; resolver returns
   `coder` or `reviewer` per the table.
6. **Implement the LLM judge** (`judgeResult`). Each invocation's
   judge prompt is built from `input.result` — XState hands the
   runtime the per-state contract directly. Test against a fake
   `ports.callJudge` that returns a fixed JSON; assert the prompt
   body contains every key listed in `input.result` with its
   description verbatim.
7. **Implement the Boss-event classifier** (`classifyBossInput`).
   Slash forms first; LLM-classifier fallback via `ports.callJudge`
   second. Test the slash table and one LLM-fallback path with a
   fake `callJudge`.
8. **Wire the Captain-actor bridge** (`captainBridge(ports)` +
   `.provide({ actors: { captain: … } })`) inside
   `createPlaybookRuntime`. Test that an actor driven through one
   fake turn end-to-end with stubbed `callPlayer`/`callJudge` ports
   transitions through the expected states.
9. **Drive-to-quiescence loop + abort**. Implement `handleBossInput`
   proper, including the `final`-state dispose/reconstruct path. On
   `signal` abort the runtime takes no FSM action — it relies on
   the natural rejection → `onError` → `#failed` path. Test three
   scenarios: clean run to `ready`; signal-abort mid-`callPlayer`
   lands at `failed` with the abort error in `lastError`; explicit
   `/interrupt <stateId>` slash redirects to that state via
   `BOSS_INTERRUPT`.
10. **Status/telemetry hookup** (`ports.emitStatus` /
    `ports.emitTelemetry`). Subscribe to actor snapshots, emit on
    every transition. Test with a fake `PlaybookPorts` that records
    emissions.
11. **Author the tmux-play adapter** (`code.tmux-play.ts` per §Host
    adapter (tmux-play)). Default-export the Captain factory; import
    types from `@sublang/cligent/tmux-play` and the runtime from
    `./code.playbook.js`. Unit-test with stubbed `CaptainContext` /
    `CaptainSession`: assert `callRole`/`callCaptain` forwarding,
    `RoleRunResult` ↔ `PlayerResult` identity, `signal` propagation,
    and the `init → handleBossTurn → dispose` lifecycle ordering.
    Verify `pnpm build` emits `code.tmux-play.js`.
12. **Example config** (`tmux-play.config.yaml`). Ship the dev form
    with `captain.from: ./code.tmux-play.js` (sibling path);
    document the release-form swap inline as a YAML comment; declare
    `roles[].id` as `coder` and `reviewer` to match the baked
    `playerId` strings.
13. **README**. Document the fake-ports example, the public
    `PlaybookRuntime`/`PlaybookPorts` types, the tmux-play
    integration path (the example YAML config + how to run
    `pnpm build && tmux-play --config …`), and the "release usage"
    subsection showing the `@sublang/playbook` package-specifier
    form.
14. **End-to-end tmux-play acceptance** (manual, but recorded as a
    `code.tmux-play.acceptance.md` log next to the YAML config).
    Steps: `pnpm install && pnpm build`, optionally `pnpm link
    @sublang/cligent` to point at a local cligent checkout,
    `tmux-play --config
    reference/sdlc/code.playbook/tmux-play.config.yaml`, type
    `/start <intent>`, observe the Captain pane status line walking
    through `planAndImplement → commitCoderInitial → reviewBossCommit*`,
    confirm the coder pane streams a reply, type `/interrupt
    ready`, confirm the FSM jumps to `ready`. Hit Ctrl-C, confirm
    the tmux session tears down cleanly per [TMUX-026](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-026).
    If any cligent or tmux-play bug surfaces during this step, file
    it in cligent's repo per the maintainer agreement and proceed
    once fixed; do not patch around cligent from this repo.
15. **Spec deltas**. Update `specs/map.md` to mark IR-004
    deliverables complete; if anything diverged from this IR's
    design, record the delta in a one-paragraph addendum at the
    bottom of this file.

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
  derives from importing `code.fsm.ts` at runtime, and no host-
  specific imports (it speaks only `PlaybookPorts`).
- `code.tmux-play.ts` is the *only* file in this IR that imports
  from `@sublang/cligent/tmux-play`. Removing that import shall not
  affect `code.playbook.ts` or its tests.
- All `reference/sdlc/code.playbook/**` source files carry SPDX
  headers per the project's licensing spec.
- End-to-end under tmux-play (per Task 14): launching `tmux-play`
  with the bundled YAML config shows the standard 4/6/6 layout
  (Captain | Coder | Reviewer); `/start <intent>` drives the FSM
  through at least `planAndImplement → commitCoderInitial →
  reviewBossCommit*`, with the coder pane streaming a real reply
  from the configured adapter and the Captain pane showing the
  FSM-state status lines; `/interrupt ready` redirects to `ready`;
  Ctrl-C tears the session down cleanly per [TMUX-026](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-026).

## Out of scope

- Building a second host (web/Electron/CI runner). The runtime is
  host-agnostic and ready for those; each host writes its own
  ~30-line adapter against `PlaybookPorts` (mirroring
  `code.tmux-play.ts` for tmux-play).
- Generalizing `code.tmux-play.ts` into a shared adapter under
  `slc/` that reads a `bridge` path from `captain.options`. Not
  needed until a second playbook ships from this repo.
- Patching cligent or tmux-play from this repo. If a cligent or
  tmux-play bug blocks Task 14, file and fix it in the cligent repo
  per the maintainer agreement, then proceed.
- Re-deriving any FSM behavior, prompts, guard keys, or result
  semantics. Those live in `code.gears.md` and `code.fsm.ts`.
- Visualizer rendering. The visualizer is IR-003's deliverable; this
  IR only emits the telemetry it consumes.
- Persisting FSM context across runtime sessions.
