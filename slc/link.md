<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# FSM-to-Captain Linking

Third phase of a playbook (a state-machine agent orchestrating other agents).
Binds the object artifact produced by [gears2fsm](gears2fsm.md) to a concrete
**host** — the environment that owns the Boss readline, the player runtime,
and the lifecycle that ultimately runs the agent.

- Source: an XState v5 machine artifact (`.fsm.ts`) produced by gears2fsm.
- Target: a **linked Captain**, host-bound, ready to plug into the host's
  Captain extension point.

Gears2fsm forbids the FSM from binding a runner; link is where the binding
happens. The link compiler shall not modify the FSM artifact and shall not
re-derive Captain prompts, result keys, or guard semantics — those are fixed
by the FSM.

## Formats

| Role | Format | Extension |
| --- | --- | --- |
| source | fsm | .ts |
| target | captain | host-defined |

The target extension follows the host's runtime (e.g., `.ts` for a cligent-
style TypeScript host, `.py` for a Python host). The link compiler picks the
emitter that matches the host.

## Host abstraction

A **host** defines four surfaces a linked Captain must satisfy:

- **Lifecycle hook**: how the host constructs the Captain instance, calls an
  optional `init`, and disposes it. The Captain shall own session-scoped
  state (the XState actor) here, not at module load.
- **Boss turn entry**: how Boss prompts arrive. Typically a single method
  per turn (e.g., `handleBossTurn(turn, context)`), with the host serializing
  turns. The linker shall not assume per-character streaming on input.
- **Player invocation**: how the Captain reaches each player. The host
  exposes named handles and one or more call primitives (e.g.,
  `context.callRole(roleId, prompt)`). The Captain never constructs adapters
  directly.
- **Status/telemetry**: how the Captain reports human-readable progress and
  machine-readable events back to observers. Status is for the Boss-facing
  pane; telemetry is for opt-in observers (visualizer, metrics).

The host shall declare its Captain contract in the spec it owns; the link
compiler imports the contract types from there. The linker shall not
redefine them.

## Linker inputs

The link compiler shall accept four inputs:

- The FSM artifact (path to a `.fsm.ts`).
- The host's Captain contract module (specifier; the linker imports types
  from it and emits a factory that satisfies it).
- A **player binding** that maps GEARS players (declared in the
  [text2gears](text2gears.md#players) source) to host player identifiers.
- An **adjudication strategy** and a **Boss-event mapping** (both selected
  by name; the strategies themselves are host-agnostic, defined below).

The first three are required; the fourth has documented defaults so a
linker run with only the first three still produces a working Captain.

## Player binding

Each GEARS state names exactly one player (`invoke.input.player`). The
linker shall map every named player to a host identifier.

For composite players declared with aliases (e.g., `Committer = Coder |
Reviewer`), the linker shall resolve the alias **per source item** by
inspecting the `CaptainInput` fields populated at that state: if one of
`<playerName>Player` is the only such field present, bind to that player;
if multiple are present, prefer the first-listed alternative in the alias
declaration order; if none are present, fall back to the alias's first
alternative. The resolution shall be deterministic and recorded in the
emitted artifact so future maintainers can audit it without re-running the
linker.

The linker shall not invent player identifiers and shall not silently
collapse aliases at the FSM level — composite players keep their
`player: 'Committer'` value on `CaptainInput`; resolution decides the host
call site only.

## Boss-event mapping

The FSM's `events` union enumerates every Boss-originated event
(`START_CODING`, `CONTINUE_IR`, `SUMMARIZE_IR`, `BOSS_INTERRUPT`, and any
others a particular FSM adds). The host typically delivers Boss input as a
free-form string. The linker shall classify each Boss turn into exactly one
of the FSM's events plus its payload.

Two default classifier strategies, in selection order:

- **Slash-prefix** (default): the Boss types a leading slash command
  (`/start <prompt>`, `/continue <irNumber>`, …). The linker generates one
  parser per event from the `events` union; payload extraction is
  positional and explicit. Unknown commands surface as a status line, not
  as a silently-dropped turn.
- **LLM-classifier** (fallback): when no slash matches, the linker invokes
  the host's Captain LLM (e.g., `context.callCaptain`) with a fixed
  classification prompt that demands a JSON `{ event, payload }` answer
  against the FSM's typed event union. The Captain LLM is the host's own
  language model; the FSM never sees the classifier prompt.

Both strategies shall be host-agnostic in their generated form — the
specific LLM call is the host's primitive, not the strategy's. Hosts that
deliver structured Boss turns may skip classification entirely.

`BOSS_INTERRUPT` (or whatever name the FSM uses for explicit Boss-driven
state jumps) shall route from the host's *redirect* channel when the host
provides one — a dedicated control key, a slash command, or a separate
input lane — and shall not require Boss to retype a slash through the
classifier. `BOSS_INTERRUPT` is *not* an abort surface: aborts go through
the host's abort signal and the strategies in §Session lifecycle. Hosts
where the abort signal is terminal (e.g., SIGINT runs shutdown, not
mid-turn cancellation) shall not route abort to `BOSS_INTERRUPT`.

## Captain adjudication

After a player call returns free-form text, the linker shall coerce that
text into one of the **per-state** `invoke.input.result` keys, along with
any payload fields the state's `result` description names as required (per
gears2fsm's contract that result descriptions oblige outputs).

The linker shall emit one adjudicator per source item, scoped to that
state's `result` map. Two default adjudication strategies, in selection
order:

- **LLM-judge** (default): construct a fresh prompt for the host's Captain
  LLM that names the source item's player, includes the player's verbatim
  output, lists the `result` keys with their descriptions, and demands a
  JSON `{ guard, …payloadFields }` answer keyed to exactly one of the
  declared guards. The judge prompt shall not interpret the player's
  output, paraphrase it, or alter the FSM's `result` text — it carries the
  description verbatim.
- **Marker-parse** (alternative, host-agnostic): a deterministic parser
  that scans the player output for a terminal control line such as
  `FSM-RESULT: { "guard": "...", ... }`. Useful when player adapters can
  be steered to emit structured trailers and the operator wants to avoid
  the extra LLM call.

A linker may select different strategies per state if its config so
specifies; the default is **LLM-judge for every state**.

The adjudicator shall fail loudly on:

- A guard the state does not declare,
- A missing payload field the state's `result` description requires,
- An empty / malformed response.

On failure the linker shall propagate the failure as a control-plane
error in the host's terms — e.g., throw out of the host's Boss-turn
entry so the host surfaces it on its control-plane channel (cligent
catches such throws and emits `runtime_error` per its TMUX-025) — not
silently re-prompt the player. Adjudicator failures are linker bugs or
operator misconfigurations; the host's role-result channels
(`role_finished` and equivalents) are reserved for failures the player
itself produced.

## Session lifecycle

The linked Captain shall:

- In the host's lifecycle hook (`init`), construct the XState actor with
  the FSM's `input` shape derived from session-scoped data the host
  supplies (player bindings, identities, instance defaults). The actor is
  session-scoped, not turn-scoped.
- Start the actor in `init` and subscribe to its snapshots so each state
  transition can be surfaced as status/telemetry before the next event
  fires.
- Per Boss turn, classify the prompt, send the FSM event, then **drive the
  actor to quiescence**: keep awaiting Captain-actor invocations until the
  machine reaches a state that takes a Boss event (typically `ready` or
  `failed`) or a `final` state. Within that drive loop the linker calls
  the host's player primitives, awaits each player response, adjudicates
  it, and resolves the FSM's Captain actor with the resulting
  `CaptainOutput`.
- When the actor reaches a `final` state during a Boss turn, the linker
  shall dispose the actor and lazily reconstruct it on the next Boss
  turn — `final` is terminal and cannot accept new events.
- Honor the host's abort signal at every player call and at every poll
  between transitions. On abort, the linker shall drive the actor to a
  quiescent state before returning from the turn. Three strategies are
  permitted; the linker selects per FSM:
  - **Natural rejection** — the linker's Captain actor (e.g.,
    `fromPromise`) ends the invocation by rejecting, and the FSM
    routes the rejection through `onError` to a quiescent sink. The
    cancelled host primitive may *itself* reject (some hosts), or it
    may resolve with a structured failure/abort status that the
    bridge inspects and converts into a Captain-actor rejection
    (cligent's `RoleRunResult { status: 'aborted' | 'error' }` is the
    canonical example). Either shape is permitted — the contract is
    on the Captain-actor boundary, not on the host primitive's
    promise behavior. Preferred when every Captain-invoking state's
    `onError` lands somewhere quiescent — the FSM's own error wiring
    is the abort path.
  - **Synthetic pre-emption to a quiescent target** — send the FSM's
    pre-emption event (e.g., `BOSS_INTERRUPT { targetId: <state> }`)
    with a target that is itself quiescent (typically `ready` or
    `failed`). The linker shall not pick the active state as the
    target: `gears2fsm.md` prescribes `reenter: true` for
    `bossInterrupts`, so re-entering the active state restarts its
    `invoke` and spawns a fresh player call.
  - **Programmatic stop** — `actor.stop()` and report the turn as
    aborted via the host's status channel. Reserved for FSMs with
    neither `onError` wiring nor a pre-emption event.
- In `dispose`, stop the actor and drain any pending host emissions.

The actor's `lastError` field shall be surfaced via the host's status
channel when the machine enters its `failed` state, so Boss sees the
diagnostic without inspecting telemetry.

## Status and telemetry

The linker shall emit, at minimum:

- One **status** line per Boss-visible transition (entering a state whose
  semantics matter to Boss — e.g., the FSM enters `respondToReview`). The
  default is to emit on every transition and let the host filter; hosts
  may bind a stricter rule.
- One **telemetry** event per state transition under a namespaced topic
  (recommended `playbook.fsm.state`), with payload `{ from, to, event }`.
  Observers (visualizer, metrics) consume telemetry; the runtime never
  interprets the topic.

Captain prompts and player responses already flow through the host's
record set (cligent's `captain_*` / `role_*`); the linker shall not
duplicate them into telemetry.

## Output

The link compiler emits **one** source file, host-formatted, that:

- Imports the FSM artifact by relative path and the host's Captain contract
  by specifier.
- Default-exports the factory shape the host requires (e.g.,
  `(options: unknown) => Captain` for cligent/tmux-play).
- Holds no FSM business logic. Player prompts, guard keys, and result
  descriptions live in the FSM; the linked file contains only the bridge
  — player binding, Boss-event classifier, per-state adjudicator wiring,
  lifecycle plumbing.
- Records the linker inputs (FSM path, host contract specifier, player
  binding, strategies) in a top-of-file header comment so the file is
  reproducible from the same inputs.

The linker is free to add a second emitted artifact (e.g., a bundling
manifest or a host configuration template) when the host requires it; that
second artifact is host-specific and is documented in the host-bound IR
rather than here.

## Out of scope

- Defining player prompts, result keys, or guard semantics — those belong
  in the GEARS source and the FSM artifact.
- Implementing player adapters or LLM transports — those are the host's
  concern.
- Persisting FSM context across sessions, multi-Boss orchestration, or
  visualizer rendering — separate hosts/observers may add them without
  changing this spec.

New behavior in any of these areas requires a separate slc spec.

## References

[1]: [text2gears](text2gears.md) "First phase: text → GEARS spec items."
[2]: [gears2fsm](gears2fsm.md) "Second phase: GEARS items → FSM artifact."
[3]: https://stately.ai/docs/actors "XState actors — `createActor`, snapshots, abort signal handling."
