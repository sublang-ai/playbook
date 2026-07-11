<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# FSM-to-Runtime Linking

Third phase of a playbook (a state-machine agent orchestrating other agents).
Compiles the [gears2fsm](gears2fsm.md) artifact into a **`PlaybookRuntime`**: a host-agnostic runner that:

- Drives the FSM.
- Classifies Boss input into typed events.
- Runs the Captain-actor against the playbook's players.
- Adjudicates player output into FSM guards.
- Surfaces transitions as status/telemetry.

The runtime is invoked through the stable `PlaybookPorts` contract.
Presentation layers (tmux-play, web, CLI, tests) implement the four ports once and inherit every playbook.

- Source: an XState v5 machine artifact (`.fsm.ts`) produced by gears2fsm.
- Target: a `PlaybookRuntime` factory module — TypeScript, host-agnostic.

Hosts are out of scope for this phase.
Each host has a small adapter (~30 lines) that loads a `PlaybookRuntime` module and supplies the host's primitives as `PlaybookPorts`.
The adapter shall speak only `PlaybookPorts` to the runtime and shall not leak host types back into it.

The link compiler shall not modify the FSM artifact and shall not re-derive Captain prompts, result keys, or guard semantics — those are fixed by the FSM.

## Formats

| Role | Format | Extension |
| --- | --- | --- |
| source | fsm | .ts |
| target | playbook | .ts |

## PlaybookRuntime contract

The emitted module shall default-export a factory of the following shape:

```typescript
interface PlaybookRuntime {
  init(session: PlaybookSession): Promise<void>;
  handleBossInput(turn: { text: string; signal: AbortSignal }): Promise<void>;
  dispose(): Promise<void>;
}

interface PlaybookSession {
  sessionId: string;
  playbookId: string;
  ports: PlaybookPorts;
}

type PlaybookRuntimeFactory<Options = unknown> = (
  options: Options,
) => PlaybookRuntime;

export default function createPlaybookRuntime(
  options: PlaybookRuntimeOptions,
): PlaybookRuntime;
```

The default export conforms to `PlaybookRuntimeFactory<PlaybookRuntimeOptions>`, the generic factory type the shared contract module exposes (§Output).

`init` receives the host-owned playbook session identity and ports, constructs the XState actor with FSM `input` derived from `options`, and starts the actor.
The runtime owns the actor for its lifetime; `handleBossInput` runs one turn, and `dispose` stops the actor and drains pending port emissions.
The host shall generate a non-empty, globally unique `sessionId` for each init-to-dispose lifecycle and shall supply the stable registry or authored playbook id as `playbookId`.

`PlaybookRuntimeOptions` is host-agnostic and carries only *per-run* knobs such as identity strings (e.g., model names a playbook substitutes into prompt placeholders) and strategy overrides the linker exposes.
The link compiler emits a typed options interface per playbook based on the FSM's `CodingInput` (or equivalent).

Player binding is a *linker-time* input baked into the emitted runtime by default.
A linker may also expose it via `PlaybookRuntimeOptions` for per-run remapping; the contract requires only that the runtime ship with a deterministic binding it applies at every `callPlayer` site.

## PlaybookPorts contract

```typescript
interface PlaybookPorts {
  callPlayer(
    playerId: string,
    prompt: string,
    signal: AbortSignal,
    options: PlayerCallOptions,
  ):
    Promise<PlayerResult>;
  callJudge(prompt: string, signal: AbortSignal):
    Promise<string>;
  emitStatus(message: string, data?: unknown): Promise<void>;
  emitTelemetry(event: { topic: string; payload: unknown }): Promise<void>;
}

interface PlayerCallOptions {
  resume: string | false;
}

interface PlayerResult {
  status: 'ok' | 'aborted' | 'error';
  resumeToken?: string;
  finalText?: string;
  error?: string;
}
```

`PlayerResult` mirrors the status, resume token, final text, and error fields of cligent's `PlayerRunResult` ([TMUX-033](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-033)).
The runtime treats `status !== 'ok'` as a player failure and routes it through the FSM's error path (§Abort).

Every linked runtime owns a map from resolved player id to its latest non-empty `resumeToken`.
The first call to each player in a playbook session shall pass `{ resume: false }`; later calls shall pass the exact stored token.
After a resolved call, the runtime shall replace the token when the result carries one or clear it when absent before interpreting `status`; a rejected call with no result leaves the prior token unchanged.
The map survives actor reconstruction inside the same runtime and is discarded at `dispose`.

`callJudge` returns free-form text.
The runtime parses it per the state's adjudication strategy (§Captain adjudication).
One port serves both classifier and adjudicator — they vary only in prompt.

`emitStatus` is human-readable; `emitTelemetry` is structured.
Both are async and shall be ordered, awaited, and never-dropped; the runtime awaits each emission before issuing the next.

The runtime never speaks to LLMs directly and never touches host types beyond `PlaybookPorts`.

## Playbook trace

Every linked runtime shall emit a boundary-complete, ordered trace through `emitTelemetry` topic `playbook.trace`.
Each payload shall carry `schemaVersion: 1`, the immutable `sessionId` and `playbookId`, a contiguous one-based `sequence`, a Unix-millisecond `timestamp`, a trace `type`, event `payload`, and the runtime-local `turnId` / paired `callId` where applicable.

```typescript
type PlaybookTraceType =
  | 'session.started'
  | 'boss.input.received'
  | 'judge.call.started'
  | 'judge.call.finished'
  | 'player.call.started'
  | 'player.call.finished'
  | 'fsm.transition'
  | 'status.emitted'
  | 'boss.input.settled'
  | 'session.disposed';

interface PlaybookTraceEvent {
  schemaVersion: 1;
  sessionId: string;
  playbookId: string;
  sequence: number;
  timestamp: number;
  type: PlaybookTraceType;
  turnId?: number;
  callId?: string;
  payload: unknown;
}
```

The trace types are `session.started`, `boss.input.received`, `judge.call.started`, `judge.call.finished`, `player.call.started`, `player.call.finished`, `fsm.transition`, `status.emitted`, `boss.input.settled`, and `session.disposed`.
Call pairs carry exact prompts and replies, normalized failures, player and state identity, explicit resume selection, and returned resume tokens.
FSM trace events carry the same transition, pending-question, and normalized-error fields as state telemetry.
Trace emissions are awaited and sequenced before the boundary operation or human status/state telemetry they describe.

This trace covers everything observable through `PlaybookRuntime`; host-specific adapter streaming remains in the host record stream.
Trace payloads never become Boss-visible status or prompt text.

## Linker inputs

The link compiler shall accept:

- The FSM artifact (path to a `.fsm.ts`).
- A **player binding** mapping GEARS players (declared in the
  [text2gears](text2gears.md#players) source) to opaque player-identifier
  strings.
  Where no binding is supplied, the linker shall apply the default
  binding — each player to its lowercased name (e.g. `Coder` → `coder`)
  — and record the applied binding in the emitted header.
- An **adjudication strategy** (default: LLM-judge per state) and a
  **Boss-event mapping** (default: free-text judge classification).
  Both strategies are host-agnostic.

The host's identity does not enter compilation; the linked module runs unchanged under any host that implements `PlaybookPorts`.

## Player binding

Each GEARS state names exactly one player (`invoke.input.player`).
The linker shall map every named player to a `playerId` string used in `PlaybookPorts.callPlayer(playerId, …)`.
The host adapter routes that opaque string to its concrete primitive.

For composite players declared with aliases (e.g., `Committer = Coder | Reviewer`), the linker shall resolve the alias **per source item**.
Resolution inspects the `CaptainInput` fields populated at that state:

- If only one `<playerName>Player` field is present, bind to that player.
- If multiple are present, prefer the first-listed alternative in the alias declaration order.
- If none are present, fall back to the alias's first alternative.

Resolution shall be deterministic and recorded in the emitted module so future maintainers can audit it without re-running the linker.

The linker shall not invent player identifiers beyond the recorded default binding, and shall not silently collapse aliases at the FSM level — composite players keep their `player: 'Committer'` value on `CaptainInput`; resolution decides only the `callPlayer` invocation.

## Player prompt composition

The runtime shall compose the actual player prompt from the state's `CaptainInput`.
`input.prompt` is the GEARS-derived domain prompt body and shall not be mutated, re-flowed, or treated as a place to store framework control instructions.

The composer may prepend structured labelled blocks from typed `CaptainInput` fields the FSM exposes (for example `Boss intent:`, `Review items:`, `Rebuttals:`, or `Task description:`).
Those blocks are outside the domain prompt body.

The composer shall not inject a player-visible Boss-question instruction.
Boss-question detection is adjudicator-facing: it comes from the state's `needsBossReply` result description, not from extra prompt text.

When `CaptainInput` carries both `pendingBossQuestion` and `bossReply`, the composer shall prepend the continuation preamble and labelled Q&A blocks before ordinary structured blocks and before the domain prompt body:

```text
You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.

Boss question:
<pendingBossQuestion.question>

Boss reply:
<bossReply>
```

The continuation preamble is framework text supplied by the runtime.
It is not part of the GEARS blockquote and shall not appear in `invoke.input.prompt`.

## Boss-event mapping

The FSM's `events` union enumerates every Boss-originated event.
The runtime receives Boss input as a free-form string (`handleBossInput.text`) and shall classify each non-empty turn into one of the FSM's events plus its payload, or no FSM action, by invoking `callJudge`.
Empty or whitespace-only text produces no event, judge call, player
call, status emission, or FSM transition; its received and settled
session-trace events are still emitted.

The classifier prompt shall demand JSON against the FSM's typed event union and any state-specific Boss input contract, including the payload fields required for each event.
Fields the FSM's event union declares optional shall stay optional in the classifier contract and the reply parser; the classifier shall not promote them to required.
When the FSM supports a Boss-reply suspension state, the prompt shall include the current state and the pending Boss question so the judge can distinguish a reply from a fresh directive.

A playbook runtime shall not define slash-prefix commands for states or features inside that playbook.
The `/command` namespace is reserved for host-level or playbook-selection UX before a turn reaches `handleBossInput`.
If a host forwards text beginning with `/` to `handleBossInput`, the runtime treats it as ordinary Boss text and classifies it through `callJudge`.

Hosts that receive structured control input shall resolve host-level concerns before choosing a playbook runtime.
Once they call `handleBossInput`, they shall pass the Boss content as text and shall not pre-classify in-playbook FSM events or rely on slash forms as a runtime protocol.

`BOSS_INTERRUPT` (or the FSM's equivalent explicit-state-jump event) is reached only by the judge choosing it and supplying its required target payload.
It is *not* an abort surface; aborts go through the abort signal and the strategies in §Abort.
Hosts where the abort signal is terminal (e.g., SIGINT runs shutdown) shall not route abort to `BOSS_INTERRUPT`.

## Captain adjudication

After a player call returns, the runtime shall coerce `result.finalText` into one of the **per-state** `invoke.input.result` keys.
It shall also extract any payload fields the state's `result` description names as required.

Two default adjudication strategies, in selection order:

- **LLM-judge** (default): construct a fresh prompt for `callJudge` that
  names the source item's player, includes the player's verbatim output,
  lists the `result` keys with their descriptions, and demands a JSON
  `{ guard, …payloadFields }` answer keyed to exactly one of the
  declared guards. The judge prompt shall not interpret the player's
  output, paraphrase it, or alter the FSM's `result` text — it carries
  the description verbatim.
- **Marker-parse** (alternative): a deterministic parser that scans the
  player output for a terminal control line such as
  `FSM-RESULT: { "guard": "...", ... }`. Useful when player adapters can
  be steered to emit structured trailers and the operator wants to avoid
  the extra LLM call.

The linker may select different strategies per state; the default is **LLM-judge for every state**.

The adjudicator shall fail loudly on:

- A guard the state does not declare,
- A missing payload field the state's `result` description requires,
- An empty / malformed response.

Adjudicator failures are control-plane errors.
The runtime shall propagate them by throwing out of `handleBossInput` after attempting cleanup.
The host adapter surfaces the throw on its control-plane channel (cligent surfaces such throws as `runtime_error` per [TMUX-025](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-025)).
The host's player-result channels (`player_finished` and equivalents) are reserved for failures the player itself produced; the host emits them when `callPlayer` resolves with `status !== 'ok'`.

## Session lifecycle

The `PlaybookRuntime` shall:

- In `init`, bind the immutable `PlaybookSession`, emit
  `session.started`, and construct the XState actor with FSM `input` derived
  from `options`. The actor is session-scoped, not turn-scoped. Subscribe to
  actor snapshots so each transition can be surfaced via `emitStatus`
  and `emitTelemetry` before the next event fires. Start the actor.
- Per `handleBossInput`:
  1. Allocate a runtime-local turn id and trace the exact Boss text.
  2. Classify `turn.text` through the Boss-event mapping.
     If it produces no event, return after draining any port emissions.
  3. If the actor is in a `final` state, dispose and reconstruct it —
     `final` is terminal and cannot accept new events.
  4. Send the classified event to the actor.
  5. **Drive to quiescence**: each time the actor invokes its `captain`
     actor, await the invoke's input, build a player prompt, call
     `callPlayer`, adjudicate, and resolve the invoke. Repeat until the
     actor's snapshot value is a state that takes a Boss event
     (typically `ready` or `failed`) or a `final` state.
- In `dispose`, stop the actor, drain pending port emissions, emit
  `session.disposed` with the final state, and discard player resume tokens.

The actor's `lastError` field shall be surfaced via `emitStatus` when the machine enters its `failed` state.

## Abort

`handleBossInput.signal` is the abort surface.
The runtime shall honor it at every `callPlayer`/`callJudge` and at every poll between transitions.
On abort, the runtime shall drive the actor to a quiescent state before returning from the turn.
Three strategies are permitted; the linker selects per FSM:

- **Natural rejection** — the runtime's Captain actor (e.g.,
  `fromPromise`) ends the invocation by rejecting, and the FSM routes
  the rejection through `onError` to a quiescent sink. The cancelled
  port call may *itself* reject, or it may resolve with
  `PlayerResult { status: 'aborted' | 'error' }` that the runtime
  inspects and converts into a Captain-actor rejection. Either shape
  is permitted — the contract is on the Captain-actor boundary, not on
  the port's promise behavior. Preferred when every Captain-invoking
  state's `onError` lands somewhere quiescent; the FSM's own error
  wiring is the abort path.
- **Synthetic pre-emption to a quiescent target** — send the FSM's
  pre-emption event (e.g., `BOSS_INTERRUPT { targetId: <state> }`) with
  a target that is itself quiescent (typically `ready` or `failed`).
  The runtime shall not pick the active state as the target:
  `gears2fsm.md` prescribes `reenter: true` for `bossInterrupts`, so
  re-entering the active state restarts its `invoke` and spawns a
  fresh player call.
- **Programmatic stop** — `actor.stop()` and report the turn as aborted
  via `emitStatus`. Reserved for FSMs with neither `onError` wiring nor
  a pre-emption event.

Whether the host's outer abort (e.g., SIGINT) is recoverable or terminal is the host's concern.
The runtime exits `handleBossInput` cleanly in either case; the host decides whether to call `dispose` afterward.

## Status and telemetry

The runtime shall emit, at minimum:

- One `emitStatus` per Boss-relevant transition (entering a state whose
  semantics matter to Boss — e.g., `respondToReview`, `failed`). The
  default is to emit on every transition and let the host filter; hosts
  may bind a stricter rule.
- One `emitTelemetry` per state transition under a namespaced topic
  (recommended `playbook.fsm.state`), with payload `{ from, to, event }`.
  Observers consume telemetry; the runtime never interprets the topic.

Player prompts and adjudicator JSON may additionally ride the host's own record channels when the host has them (cligent's `captain_*` / `player_*`).
The `playbook.trace` copies are the host-agnostic runtime-boundary record required by §Playbook trace.

## Output

The link compiler emits **one** TypeScript module that:

- Imports the FSM artifact by relative path, with an extension-bearing
  specifier that resolves to a file sitting beside the module (e.g.
  `./code.fsm.ts`, or `./code.fsm.js` where a compiled module ships), so
  the emitted module loads without a build step.
- Restricts itself to erasable TypeScript syntax — type annotations
  that strip cleanly, no constructor parameter properties, `enum`s, or
  namespaces — so a host running under type stripping loads it
  directly.
- Imports XState's actor primitives (`createActor`, `fromPromise`,
  `setup`'s `.provide`).
- Exports `createPlaybookRuntime` and the typed `PlaybookRuntimeOptions`
  interface for that playbook.
- Exposes, under an `_internal` export, the pure helpers verification
  needs — at least the player-prompt composer (`composePlayerPrompt`) —
  so compilation-correctness tests can exercise composition without a
  host.
- Holds no host-specific types and no host primitive calls. The runtime
  speaks only `PlaybookPorts`.
- Records the linker inputs (FSM path, player binding, strategies) in a
  top-of-file header comment so the file is reproducible from the same
  inputs.
- Sources the contract types (`PlayerResult`, `PlayerCallOptions`,
  `PlaybookPorts`, `PlaybookSession`, `PlaybookTraceEvent`,
  `PlaybookRuntime`, `PlaybookRuntimeFactory`) from a single shared
  type-only module instead of redefining them, and re-exports the names
  its consumers import, so every linked playbook shares one contract
  definition. The shared module imports no FSM or host types, so the
  dependency runs one way — from each linked module to the shared
  contract, never the reverse.

## Host adaptation (informative, not normative)

A host integrates with playbooks via a small adapter that:

1. Accepts a path to a `PlaybookRuntime` module (either as a direct
   import in a playbook-specific adapter, or via the host's config
   surface in a generic adapter).
2. Imports the module and constructs the runtime with options forwarded
   verbatim from the host config.
3. Implements `PlaybookPorts` by wrapping the host's own primitives —
   for cligent/tmux-play this is `callPlayer ← context.callPlayer`,
   `callJudge ← context.callCaptain`, `emitStatus`/`emitTelemetry` ←
   `session.emitStatus`/`session.emitTelemetry`.
4. Generates a unique playbook-session id, calls
   `runtime.init({ sessionId, playbookId, ports })` once at session start, forwards each
   Boss turn to `runtime.handleBossInput`, and calls
   `runtime.dispose()` at session end.

The adapter is ~30 lines regardless of which playbook is loaded.
Its location is a project-organization choice:

- **Playbook repo** — simplest when the playbook author owns the integration; keeps host primitives a lower-layer dependency.
- **Host repo** — when the host author wants to ship an opt-in playbook Captain.
- **Third package** — otherwise.

This spec is silent on the choice; the contract is the same in any location.

## Out of scope

- Defining player prompts, result keys, or guard semantics — those
  belong in the GEARS source and the FSM artifact.
- Host adapter implementations, host configuration, presentation
  layouts — where these live is a per-project decision (see
  §Host adaptation); this spec only constrains the `PlaybookPorts`
  contract they satisfy.
- Persisting FSM context or the trace across sessions, multi-Boss
  orchestration, or visualizer rendering — separate hosts/observers may add
  them without changing this spec. A host may persist the emitted trace, but
  the runtime does not rehydrate a disposed actor from it.

New behavior in any of these areas requires a separate slc spec.

## References

[1]: [text2gears](text2gears.md) "First phase: text → GEARS spec items."
[2]: [gears2fsm](gears2fsm.md) "Second phase: GEARS items → FSM artifact."
[3]: https://stately.ai/docs/actors "XState actors — `createActor`, snapshots, abort signal handling."
