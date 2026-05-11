<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# FSM-to-Runtime Linking

Third phase of a playbook (a state-machine agent orchestrating other agents).
Compiles the object artifact produced by [gears2fsm](gears2fsm.md) into a
**`PlaybookRuntime`** — a host-agnostic runner that drives the FSM, classifies
Boss input into typed events, runs the Captain-actor against the playbook's
players, adjudicates player output into FSM guards, and surfaces transitions
as status/telemetry.

The runtime is invoked through a small, stable `PlaybookPorts` contract.
Presentation layers (tmux-play, web, CLI, tests) implement the four ports
once and inherit every playbook.

- Source: an XState v5 machine artifact (`.fsm.ts`) produced by gears2fsm.
- Target: a `PlaybookRuntime` factory module — TypeScript, host-agnostic.

Hosts are out of scope for this phase. Each host writes one generic adapter
that loads any `PlaybookRuntime` module and supplies its own ports; the
adapter is a host-side concern documented in that host's own repo.

Gears2fsm forbids the FSM artifact from binding a runner; link is where the
runner is bound. The link compiler shall not modify the FSM artifact and
shall not re-derive Captain prompts, result keys, or guard semantics —
those are fixed by the FSM.

## Formats

| Role | Format | Extension |
| --- | --- | --- |
| source | fsm | .ts |
| target | playbook | .ts |

## PlaybookRuntime contract

The emitted module shall default-export a factory of the following shape:

```typescript
interface PlaybookRuntime {
  init(ports: PlaybookPorts): Promise<void>;
  handleBossInput(turn: { text: string; signal: AbortSignal }): Promise<void>;
  dispose(): Promise<void>;
}

export default function createPlaybookRuntime(
  options: PlaybookRuntimeOptions,
): PlaybookRuntime;
```

`init` receives the host's ports, constructs the XState actor with FSM
`input` derived from `options`, and starts the actor. The runtime owns the
actor for the rest of its lifetime; `handleBossInput` runs one turn,
`dispose` stops the actor and drains pending port emissions.

`PlaybookRuntimeOptions` is host-agnostic and carries only data the
playbook needs to bind to its world — player binding, identity strings,
strategy overrides. The link compiler emits a typed options interface per
playbook based on the FSM's `CodingInput` (or equivalent).

## PlaybookPorts contract

```typescript
interface PlaybookPorts {
  callPlayer(playerId: string, prompt: string, signal: AbortSignal):
    Promise<PlayerResult>;
  callJudge(prompt: string, signal: AbortSignal):
    Promise<string>;
  emitStatus(message: string, data?: unknown): Promise<void>;
  emitTelemetry(event: { topic: string; payload: unknown }): Promise<void>;
}

interface PlayerResult {
  status: 'ok' | 'aborted' | 'error';
  finalText?: string;
  error?: string;
}
```

`PlayerResult` mirrors cligent's `RoleRunResult` shape ([TMUX-033](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-033))
so a tmux-play port adapter is direct assignment; other hosts adapt their
own player primitives to the same shape. The runtime treats `status !==
'ok'` as a player failure and routes it through the FSM's error path
(§Abort).

`callJudge` returns free-form text. The runtime parses it according to
the per-state adjudication strategy (§Captain adjudication). One port
serves both classifier and adjudicator — they vary only in prompt; hosts
that want a cheaper classifier model may wrap `callJudge` themselves.

`emitStatus` is human-readable; `emitTelemetry` is structured. Both are
async so hosts can apply backpressure on slow transports. Both shall
return ordered, awaited, never-dropped emissions to whichever channel
the host wires; the runtime emits in order and awaits each before
issuing the next.

The runtime never constructs adapters, never speaks to LLMs directly,
and never touches host-specific types beyond `PlaybookPorts`.

## Linker inputs

The link compiler shall accept:

- The FSM artifact (path to a `.fsm.ts`).
- A **player binding** mapping GEARS players (declared in the
  [text2gears](text2gears.md#players) source) to opaque player-identifier
  strings.
- An **adjudication strategy** (default: LLM-judge per state) and a
  **Boss-event mapping** (default: slash-prefix with LLM-classifier
  fallback). Both strategies are host-agnostic.

The host's identity does not enter compilation. A given linked
`PlaybookRuntime` module runs unchanged under any host that implements
`PlaybookPorts`.

## Player binding

Each GEARS state names exactly one player (`invoke.input.player`). The
linker shall map every named player to a `playerId` string used in
`PlaybookPorts.callPlayer(playerId, …)`. The host adapter then routes
that opaque string to its concrete primitive.

For composite players declared with aliases (e.g., `Committer = Coder |
Reviewer`), the linker shall resolve the alias **per source item** by
inspecting the `CaptainInput` fields populated at that state: if only one
of `<playerName>Player` is present, bind to that player; if multiple are
present, prefer the first-listed alternative in the alias declaration
order; if none are present, fall back to the alias's first alternative.
The resolution shall be deterministic and recorded in the emitted module
so future maintainers can audit it without re-running the linker.

The linker shall not invent player identifiers and shall not silently
collapse aliases at the FSM level — composite players keep their
`player: 'Committer'` value on `CaptainInput`; resolution decides the
`callPlayer` invocation only.

## Boss-event mapping

The FSM's `events` union enumerates every Boss-originated event. The
runtime receives Boss input as a free-form string (`handleBossInput.text`)
and shall classify each turn into exactly one of the FSM's events plus
its payload.

Two default classifier strategies, in selection order:

- **Slash-prefix** (default): the Boss types a leading slash command
  (`/start <prompt>`, `/continue <irNumber>`, …). The linker generates
  one parser per event from the `events` union; payload extraction is
  positional and explicit. Unknown commands surface as `emitStatus`, not
  as a silently-dropped turn.
- **LLM-classifier** (fallback): when no slash matches, the runtime
  invokes `callJudge` with a fixed classification prompt that demands a
  JSON `{ event, payload }` answer against the FSM's typed event union.

Hosts that deliver structured Boss turns (a programmatic API, a CI host
with pre-typed payloads) shall classify before calling `handleBossInput`
and may use a slash form that round-trips their structured payload.

`BOSS_INTERRUPT` (or whatever name the FSM uses for explicit Boss-driven
state jumps) is reached only through the explicit `/interrupt <stateId>`
slash form (or LLM-classifier choosing it). It is *not* an abort surface;
aborts go through the abort signal and the strategies in §Abort. Hosts
where the abort signal is terminal (e.g., SIGINT runs shutdown) shall
not route abort to `BOSS_INTERRUPT`.

## Captain adjudication

After a player call returns, the runtime shall coerce `result.finalText`
into one of the **per-state** `invoke.input.result` keys, along with any
payload fields the state's `result` description names as required.

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

The linker may select different strategies per state if its config so
specifies; the default is **LLM-judge for every state**.

The adjudicator shall fail loudly on:

- A guard the state does not declare,
- A missing payload field the state's `result` description requires,
- An empty / malformed response.

Adjudicator failures are control-plane errors. The runtime shall
propagate them by throwing out of `handleBossInput` after attempting
cleanup; the host adapter surfaces the throw on its control-plane
channel (cligent surfaces such throws as `runtime_error` per
[TMUX-025](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-025)).
The host's player-result channels (`role_finished` and equivalents) are
reserved for failures the player itself produced and are emitted by the
host automatically when `callPlayer` resolves with `status !== 'ok'`.

## Session lifecycle

The `PlaybookRuntime` shall:

- In `init`, construct the XState actor with FSM `input` derived from
  `options`. The actor is session-scoped, not turn-scoped. Subscribe to
  actor snapshots so each transition can be surfaced via `emitStatus`
  and `emitTelemetry` before the next event fires. Start the actor.
- Per `handleBossInput`:
  1. Classify `turn.text` (slash → event; else LLM-classifier).
  2. If the actor is in a `final` state, dispose and reconstruct it —
     `final` is terminal and cannot accept new events.
  3. Send the classified event to the actor.
  4. **Drive to quiescence**: each time the actor invokes its `captain`
     actor, await the invoke's input, build a player prompt, call
     `callPlayer`, adjudicate, and resolve the invoke. Repeat until the
     actor's snapshot value is a state that takes a Boss event
     (typically `ready` or `failed`) or a `final` state.
- In `dispose`, stop the actor and drain pending port emissions.

The actor's `lastError` field shall be surfaced via `emitStatus` when
the machine enters its `failed` state, so Boss sees the diagnostic
without inspecting telemetry.

## Abort

`handleBossInput.signal` is the abort surface. The runtime shall honor
it at every `callPlayer`/`callJudge` and at every poll between
transitions. On abort, the runtime shall drive the actor to a quiescent
state before returning from the turn. Three strategies are permitted;
the linker selects per FSM:

- **Natural rejection** — the runtime's Captain actor (e.g.,
  `fromPromise`) ends the invocation by rejecting, and the FSM routes
  the rejection through `onError` to a quiescent sink. The cancelled
  port call may *itself* reject, or it may resolve with `PlayerResult {
  status: 'aborted' | 'error' }` that the runtime inspects and converts
  into a Captain-actor rejection. Either shape is permitted — the
  contract is on the Captain-actor boundary, not on the port's promise
  behavior. Preferred when every Captain-invoking state's `onError`
  lands somewhere quiescent; the FSM's own error wiring is the abort
  path.
- **Synthetic pre-emption to a quiescent target** — send the FSM's
  pre-emption event (e.g., `BOSS_INTERRUPT { targetId: <state> }`) with
  a target that is itself quiescent (typically `ready` or `failed`).
  The runtime shall not pick the active state as the target:
  `gears2fsm.md` prescribes `reenter: true` for `bossInterrupts`, so
  re-entering the active state restarts its `invoke` and spawns a fresh
  player call.
- **Programmatic stop** — `actor.stop()` and report the turn as aborted
  via `emitStatus`. Reserved for FSMs with neither `onError` wiring nor
  a pre-emption event.

Whether the host's outer abort (e.g., SIGINT) is recoverable or terminal
is the host's concern. The runtime exits `handleBossInput` cleanly in
either case; the host decides whether to call `dispose` afterward.

## Status and telemetry

The runtime shall emit, at minimum:

- One `emitStatus` per Boss-relevant transition (entering a state whose
  semantics matter to Boss — e.g., `respondToReview`, `failed`). The
  default is to emit on every transition and let the host filter; hosts
  may bind a stricter rule.
- One `emitTelemetry` per state transition under a namespaced topic
  (recommended `playbook.fsm.state`), with payload `{ from, to, event }`.
  Observers consume telemetry; the runtime never interprets the topic.

Player prompts and adjudicator JSON ride the host's own record channels
when the host has them (cligent's `captain_*` / `role_*`); the runtime
shall not duplicate them into `emitTelemetry`.

## Output

The link compiler emits **one** TypeScript module that:

- Imports the FSM artifact by relative path.
- Imports XState's actor primitives (`createActor`, `fromPromise`,
  `setup`'s `.provide`).
- Exports `createPlaybookRuntime` and the typed `PlaybookRuntimeOptions`
  interface for that playbook.
- Holds no host-specific types and no host primitive calls. The runtime
  speaks only `PlaybookPorts`.
- Records the linker inputs (FSM path, player binding, strategies) in a
  top-of-file header comment so the file is reproducible from the same
  inputs.

## Host adaptation (informative, not normative)

A host integrates with playbooks by writing one generic adapter that:

1. Accepts a path to a `PlaybookRuntime` module via its own config
   surface.
2. Imports the module and constructs the runtime with
   host-supplied `options` (forwarded verbatim from the host config).
3. Implements `PlaybookPorts` by wrapping the host's own primitives —
   for cligent/tmux-play this is `callPlayer ← context.callRole`,
   `callJudge ← context.callCaptain`, `emitStatus`/`emitTelemetry` ←
   `session.emitStatus`/`session.emitTelemetry`.
4. Calls `runtime.init(ports)` once at session start, forwards each
   Boss turn to `runtime.handleBossInput`, and calls `runtime.dispose()`
   at session end.

The adapter is host-side code, owned by the host's repo. It is the same
~30 lines regardless of which playbook is loaded — a new playbook
requires no host change.

## Out of scope

- Defining player prompts, result keys, or guard semantics — those
  belong in the GEARS source and the FSM artifact.
- Host adapters, host configuration, presentation layouts — each host
  owns these in its own repo.
- Persisting FSM context across sessions, multi-Boss orchestration, or
  visualizer rendering — separate hosts/observers may add them without
  changing this spec.

New behavior in any of these areas requires a separate slc spec.

## References

[1]: [text2gears](text2gears.md) "First phase: text → GEARS spec items."
[2]: [gears2fsm](gears2fsm.md) "Second phase: GEARS items → FSM artifact."
[3]: https://stately.ai/docs/actors "XState actors — `createActor`, snapshots, abort signal handling."
