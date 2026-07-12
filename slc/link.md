<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# FSM-to-Runtime Linking

Third phase of a playbook (a state-machine agent orchestrating other agents).
Compiles the [gears2fsm](gears2fsm.md) artifact into a **`PlaybookRuntime`**: a host-agnostic runner that:

- Drives the FSM.
- Classifies Boss input into typed events.
- Runs direct-Captain, delegated-player, and nested-playbook actors.
- Adjudicates Captain and player output into FSM guards.
- Surfaces transitions as status/telemetry.

The runtime is invoked through the stable `PlaybookPorts` contract.
Presentation layers (tmux-play, web, CLI, tests) implement the six ports once
and inherit every playbook.

- Source: an XState v5 machine artifact (`.fsm.ts`) produced by gears2fsm.
- Target: a `PlaybookRuntime` factory module — TypeScript, host-agnostic.

Hosts are out of scope for this phase.
Each host has an adapter that loads a `PlaybookRuntime` module and supplies the host's primitives as `PlaybookPorts`.
The adapter shall speak only `PlaybookPorts` to the runtime and shall not leak host types back into it.

The link compiler shall not modify the FSM artifact and shall not re-derive Captain prompts, result keys, or guard semantics — those are fixed by the FSM.

## Formats

| Role   | Format   | Extension |
| ------ | -------- | --------- |
| source | fsm      | .ts       |
| target | playbook | .ts       |

## PlaybookRuntime contract

The emitted module shall default-export a factory of the following shape:

```typescript
interface PlaybookRuntime {
  init(session: PlaybookSession): Promise<void>;
  handleBossInput(turn: {
    text: string;
    signal: AbortSignal;
  }): Promise<PlaybookRunResult>;
  resumePlaybookCall(input: {
    callId: string;
    result: PlaybookCallResult;
    signal: AbortSignal;
  }): Promise<PlaybookRunResult>;
  dispose(): Promise<void>;
}

interface PlaybookSession {
  sessionId: string;
  playbookId: string;
  rootSessionId: string;
  parentSessionId?: string;
  parentCallId?: string;
  depth: number;
  ports: PlaybookPorts;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

interface NormalizedError {
  name: string;
  message: string;
  stack?: string;
}

type PlaybookStateValue =
  | string
  | { readonly [key: string]: PlaybookStateValue };

interface PlaybookState {
  value: PlaybookStateValue;
  activeStateIds: readonly string[];
  tags: readonly string[];
  status: 'active' | 'done' | 'error' | 'stopped';
  quiescent: boolean;
  stateId?: string;
}

interface PlaybookPendingCall {
  callId: string;
  playbookId: string;
  childSessionId: string;
}

type PlaybookRunResult =
  | { outcome: 'quiescent' | 'no-action'; state: PlaybookState }
  | {
      outcome: 'failed' | 'aborted';
      state: PlaybookState;
      error?: NormalizedError;
    }
  | {
      outcome: 'terminal';
      state: PlaybookState;
      output?: JsonValue;
    }
  | {
      outcome: 'suspended';
      state: PlaybookState;
      pendingCall: PlaybookPendingCall;
    };

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
The runtime shall validate non-empty session, playbook, and root ids, a safe
non-negative integer depth, root identity (`depth === 0` and
`rootSessionId === sessionId` with no parent fields), and child identity
(`depth > 0` with non-empty parent session and call ids). It shall copy those
identity scalars and the port references into its own immutable record rather
than retaining the caller's mutable session object. A child `sessionId` shall
differ from both its `rootSessionId` and `parentSessionId`.

Run outcomes are exact: `no-action` means no FSM event was sent;
`quiescent` means a non-failure parked/idle state; `failed` means the FSM is in
a recoverable failure state; `terminal` means top-level final with optional
JSON output; `aborted` means the turn signal ended work; and `suspended` means
exactly one `pendingCall` is active.
Control-plane exceptions reject the runtime method rather than masquerade as a
recoverable workflow `failed` result.

`PlaybookRuntimeOptions` is host-agnostic and carries only _per-run_ knobs such as identity strings (e.g., model names a playbook substitutes into prompt placeholders) and strategy overrides the linker exposes.
The link compiler emits a typed options interface per playbook based on the FSM's `CodingInput` (or equivalent).

Player binding is a _linker-time_ input baked into the emitted runtime by default.
A linker may also expose it via `PlaybookRuntimeOptions` for per-run remapping; the contract requires only that the runtime ship with a deterministic binding it applies at every `callPlayer` site.

## PlaybookPorts contract

```typescript
interface PlaybookPorts {
  callPlayer(
    playerId: string,
    prompt: string,
    signal: AbortSignal,
    options: PlayerCallOptions,
  ): Promise<PlayerResult>;
  callCaptain(
    prompt: string,
    signal: AbortSignal,
    options: CaptainCallOptions,
  ): Promise<CaptainResult>;
  callJudge(prompt: string, signal: AbortSignal): Promise<string>;
  callPlaybook(
    request: PlaybookCallRequest,
    signal: AbortSignal,
  ): Promise<PlaybookCallStart>;
  emitStatus(message: string, data?: unknown): Promise<void>;
  emitTelemetry(event: { topic: string; payload: unknown }): Promise<void>;
}

interface PlayerCallOptions {
  resume: string | false;
}

interface CaptainCallOptions {
  visibility: 'visible' | 'hidden';
}

interface PlayerResult {
  status: 'ok' | 'aborted' | 'error';
  resumeToken?: string;
  finalText?: string;
  error?: string;
}

interface CaptainResult {
  status: 'ok' | 'aborted' | 'error';
  finalText?: string;
  error?: string;
}

interface PlaybookCallRequest {
  callId: string;
  playbookId: string;
  text: string;
}

type PlaybookCallResult =
  | {
      status: 'ok';
      playbookId: string;
      childSessionId: string;
      state?: PlaybookState;
      output?: JsonValue;
    }
  | {
      status: 'aborted';
      playbookId: string;
      childSessionId?: string;
      state?: PlaybookState;
      error?: NormalizedError;
    }
  | {
      status: 'error';
      playbookId: string;
      childSessionId?: string;
      state?: PlaybookState;
      error: NormalizedError;
    };

type PlaybookCallStart =
  | { state: 'settled'; result: PlaybookCallResult }
  | { state: 'suspended'; childSessionId: string };
```

`PlayerResult` mirrors the status, resume token, final text, and error fields of cligent's `PlayerRunResult` ([TMUX-033](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-033)).
The runtime treats `status !== 'ok'` as a player failure and routes it through the FSM's error path (§Abort).

`callCaptain` runs a direct-Captain FSM actor against the host's Captain
session. The linked runtime shall pass `{ visibility: 'visible' }` for authored
workflow calls. `CaptainResult` carries no resume token or player-continuation
selection: the host owns one Captain session and its continuity. A non-`ok`
result, or an `ok` result without `finalText`, shall reject the actor through
the FSM's error path.

Every linked runtime owns a map from resolved player id to its latest non-empty `resumeToken`.
Before reading a resolved direct-Captain or delegated-player result, the
runtime shall validate, detach, and freeze it through the shared
`validateCaptainResult` or `validatePlayerResult` helper. The accepted object
shape is exact: only the declared status and optional string fields are
allowed, JSON-unsafe members reject, and caller mutation after resolution
cannot change trace evidence or player continuity. Validation happens before
adopting a resume token or reading final text.
The first call to each player in a playbook session shall pass `{ resume: false }`; later calls shall pass the exact stored token.
After a resolved call, the runtime shall replace the token when the result carries one or clear it when absent before interpreting `status`; a rejected call with no result leaves the prior token unchanged.
After awaiting a host Captain or player promise, the runtime shall re-check the
combined invocation/public-boundary signal before validating the result,
adopting a resume token, or emitting a successful finish. A host promise that
ignores cancellation and resolves late shall be paired as aborted and shall
not mutate continuity or masquerade as success.
The map survives actor reconstruction inside the same runtime and is discarded at `dispose`.
The runtime shall keep an in-flight set keyed by resolved player id and reject
a second concurrent call to the same id before crossing the host port. Calls
to distinct resolved player ids may overlap.

`callJudge` returns free-form text.
The runtime parses it per the state's adjudication strategy (§Captain adjudication).
One port serves both classifier and adjudicator — they vary only in prompt.
Concurrent `callJudge` attempts within one linked runtime shall pass through
one abort-aware local FIFO. After the host promise resolves, the runtime shall
require a string reply and re-check the combined signal before tracing or
parsing success, so a non-cooperative late judge cannot outlive cancellation.
The host shall serialize `callCaptain` and `callJudge` together through one
shared abort-aware concurrency-one FIFO because both use the same single-flight
Captain session, even when distinct player ports overlap [[4]]. A direct Captain
call's subsequent adjudication shall enter that same queue only after the
visible call has settled; the linked runtime shall not hold one queue lease
while requesting the other port.
Use one shared `PQueue({ concurrency: 1 })` for the individual host
`callCaptain` and `callJudge` promises. Do not pass an invocation or public
boundary signal as `PQueue.add(..., { signal })`: PQueue may release a running
slot as soon as that signal aborts even though a non-cooperative host promise
is still executing, which permits overlap. Instead check the combined signal
inside the queued task before crossing the host port, await the host promise
without releasing the queue lease, and check the signal again afterward.

`callPlaybook` starts a function-style child call.
The caller runtime supplies its stable call id and the XState invocation's
lifetime signal.
The host drives the child's initial text before resolving the port with either
an immediate settled result or a suspended child session.
Suspension is resumed later through `PlaybookRuntime.resumePlaybookCall`; the
port promise itself shall not remain pending across Boss turns.

`emitStatus` is human-readable; `emitTelemetry` is structured.
Both are async and shall be ordered, awaited, and never-dropped; the runtime awaits each emission before issuing the next.

The runtime never speaks to LLMs directly and never touches host types beyond `PlaybookPorts`.

## Playbook trace

Every linked runtime shall emit a boundary-complete, ordered trace through `emitTelemetry` topic `playbook.trace`.
Each payload shall carry `schemaVersion: 2`, the immutable session identity and
causality, a contiguous one-based `sequence`, a Unix-millisecond `timestamp`, a
trace `type`, event `payload`, and the runtime-local `turnId` / paired `callId`
where applicable.

```typescript
type PlaybookTraceType =
  | 'session.started'
  | 'boss.input.received'
  | 'judge.call.started'
  | 'judge.call.finished'
  | 'player.call.started'
  | 'player.call.finished'
  | 'captain.call.started'
  | 'captain.call.finished'
  | 'playbook.call.started'
  | 'playbook.call.finished'
  | 'fsm.transition'
  | 'status.emitted'
  | 'boss.input.settled'
  | 'session.disposed';

interface PlaybookTraceEvent {
  schemaVersion: 2;
  sessionId: string;
  playbookId: string;
  rootSessionId: string;
  parentSessionId?: string;
  parentCallId?: string;
  depth: number;
  sequence: number;
  timestamp: number;
  type: PlaybookTraceType;
  turnId?: number;
  callId?: string;
  payload: JsonValue;
}
```

The trace types are `session.started`, `boss.input.received`,
`judge.call.started`, `judge.call.finished`, `player.call.started`,
`player.call.finished`, `captain.call.started`, `captain.call.finished`,
`playbook.call.started`,
`playbook.call.finished`, `fsm.transition`, `status.emitted`,
`boss.input.settled`, and `session.disposed`.
Call pairs carry exact prompts and replies, normalized failures, actor and state
identity, and their boundary-specific options.
Judge results use `reply`; player start and finish payloads both carry the
selected `resume`; Captain start and finish payloads both carry
the exact composed prompt, `visibility: 'visible'`, the direct invocation's
`stateId` and `sourceItem`, and no player resume selection or resume token;
judge `purpose` is
`boss-input-classification`, `player-output-adjudication`, or
`captain-output-adjudication`; and every error uses
`{ name, message, stack? }` rather than a raw string or `Error` instance.
The Captain finish payload shall preserve the exact `CaptainResult` status and
final text when present, while carrying any failure in normalized form.
An `ok` result without `finalText` therefore retains status `ok` but also
carries the normalized missing-text failure that makes the actor reject.
The pair obligation also applies when a port promise rejects or throws: the
linked runtime shall emit and drain one normalized finish boundary before it
propagates the failure. No started call boundary may be left without its
matching finished boundary.
If a started-boundary sink records the event and then rejects, the runtime
shall make one best-effort normalized error-finish attempt with the same call
id and then reject the original start error. It shall not retry either event or
let a failure of that finish attempt replace the start error.
When a call boundary carries `callId`, that id shall be unique within the
runtime session. A stable FSM `stateId` is identity metadata in the payload,
not a call id and shall not be reused as one across repeated invocations.
Optional trace and run-result members shall be omitted when absent; the runtime
shall not create own `turnId`, `callId`, parent identity, output, or error
properties with value `undefined` and then rely on JSON serialization to drop
them.
A `boss.input.settled` payload shall project the complete structured run
result: its outcome must be one of the `PlaybookRunResult` discriminants (never
an invented `error` outcome), and it shall include `state`, singular
`stateId`, `pendingCall`, `output`, and normalized `error` whenever the matching
result arm carries them.
One runtime-owned concurrency-one emission queue shall serialize every trace,
human status, and state telemetry call. Sequence allocation and enqueueing
shall occur atomically, and every public method shall drain that queue before
resolving or rejecting. A state transition emission queued on entry shall be
observed before the invoked boundary's `*.started` event, even when a host
delays `emitTelemetry`.
The linked module shall use `PQueue({ concurrency: 1 })` from `p-queue` for
this ordering and drain it with `onIdle()` rather than recreate a promise-queue
implementation in every generated artifact.
FSM trace events carry the same transition, pending-question, and normalized-error fields as state telemetry.
Trace emissions are awaited and sequenced before the boundary operation or human status/state telemetry they describe.
Every event in one session carries the same root/parent/depth identity.
A parent call start precedes its child `session.started`; the child's
`session.disposed` precedes the parent call finish.
Parallel call finishes may occur in either order, so consumers shall use call
ids for pairing and sequence for the observed total order.

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

Each delegated GEARS state names exactly one player
(`player` actor `invoke.input.player`).
The linker shall map every named player to a `playerId` string used in
`PlaybookPorts.callPlayer(playerId, …)`.
The host adapter routes that opaque string to its concrete primitive.
Every direct-Captain and delegated-player invocation shall also carry its
working leaf's explicit
`stateId`; a linked runtime shall use that field for call identity and shall
not infer one leaf from a structured root snapshot.
Direct `captain` actor states bypass player binding and call
`PlaybookPorts.callCaptain`; the linker shall not synthesize a player id named
`captain` for them.

For composite players declared with aliases (e.g., `Committer = Coder | Reviewer`), the linker shall resolve the alias **per source item**.
Resolution inspects the `PlayerInput` fields populated at that state:

- If only one `<playerName>Player` field is present, bind to that player.
- If multiple are present, prefer the first-listed alternative in the alias declaration order.
- If none are present, fall back to the alias's first alternative.

Resolution shall be deterministic and recorded in the emitted module so future maintainers can audit it without re-running the linker.

The linker shall not invent player identifiers beyond the recorded default
binding, and shall not silently collapse aliases at the FSM level — composite
players keep their `player: 'Committer'` value on `PlayerInput`; resolution
decides only the `callPlayer` invocation.

## Player prompt composition

The runtime shall compose the actual player prompt from the state's
`PlayerInput`.
`input.prompt` is the GEARS-derived domain prompt body and shall not be mutated, re-flowed, or treated as a place to store framework control instructions.

The composer may prepend structured labelled blocks from typed `PlayerInput`
fields the FSM exposes (for example `Boss intent:`, `Review items:`,
`Rebuttals:`, or `Task description:`).
Those blocks are outside the domain prompt body.

The composer shall not inject a player-visible Boss-question instruction.
Boss-question detection is adjudicator-facing: it comes from the state's `needsBossReply` result description, not from extra prompt text.

When `PlayerInput` carries both `pendingBossQuestion` and `bossReply`, the
composer shall prepend the continuation preamble and labelled Q&A blocks before
ordinary structured blocks and before the domain prompt body:

```text
You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.

Boss question:
<pendingBossQuestion.question>

Boss reply:
<bossReply>

```

The continuation preamble is framework text supplied by the runtime.
It is not part of the GEARS blockquote and shall not appear in `invoke.input.prompt`.
The composer shall retain the blank line after the Boss reply before the next
structured block or domain prompt, producing exactly two newline characters at
that boundary.
When implementing the prefix as an array joined with `"\n"`, the array needs
two trailing empty strings after `bossReply`; one trailing empty string emits
only one newline and is nonconformant. Equivalently, append `"\n\n"` exactly
once before the following block or domain body.

## Captain prompt composition

The runtime shall compose a direct Captain prompt from the state's
`CaptainInput` under the same prompt-integrity rules: `input.prompt` remains the
verbatim GEARS domain body, while specific typed fields may be supplied as
labelled blocks and substituted for their declared placeholders.
It shall not introduce a player binding or player resume instruction.
String fields substitute verbatim. Arrays and objects such as the sanitized
enabled-playbook catalog, remaining plan, and completed child results shall be
validated as JSON-safe and rendered as deterministic JSON; they shall never be
coerced through default JavaScript string conversion or expose untyped context.
Deterministic rendering shall sort object keys lexicographically at every
depth while preserving array order, so equivalent JSON values produce the same
prompt independent of host property insertion order.
At construction, a structured host-owned catalog shall be validated against its
declared exact entry shape, copied, and frozen recursively so later caller
mutation or extra properties cannot alter a prompt or machine decision.

When a direct Captain task resumes from its own Boss question, the composer
shall prepend the same continuation preamble and labelled Q&A blocks defined in
§Player prompt composition. The runtime shall pass the complete composed prompt
once to `callCaptain` with `{ visibility: 'visible' }`; it shall not expose the
subsequent adjudicator prompt or structured judge reply through that visible
call.

## Boss-event mapping

The FSM's `events` union enumerates every Boss-originated event.
The runtime receives Boss input as a free-form string (`handleBossInput.text`) and shall classify each non-empty turn into one of the FSM's events plus its payload, or no FSM action, by invoking `callJudge`.
Empty or whitespace-only text produces no event, judge call, Captain call,
player call, status emission, or FSM transition; its received and settled
session-trace events are still emitted.

The classifier prompt shall demand JSON against the FSM's typed event union and any state-specific Boss input contract, including the payload fields required for each event.
Fields the FSM's event union declares optional shall stay optional in the classifier contract and the reply parser; the classifier shall not promote them to required.
The runtime shall parse the judge reply tolerantly before validating the
event. It shall recover the intended JSON object from surrounding prose or a
Markdown fence, ignore earlier non-JSON bracketed prose, remove a trailing
comma before a closing brace or bracket, and complete a truncated
unterminated string or unclosed object/array. When several values are
recoverable, it shall choose the first object in document order, preferring a
strict parse at each candidate position before repairing that same candidate.
When no object is recoverable or the recovered event/payload is invalid, the
runtime shall emit exactly one status and send no FSM event; a malformed
classification is recoverable control input, not a public boundary rejection.
Host-owned runtime options, player bindings, and enabled-playbook catalogs are
not Boss-event payload. The classifier schema and parser shall not invite or
accept them, and classified prose shall never overwrite their machine context.
When the FSM supports a Boss-reply suspension state, the prompt shall inspect
the actor snapshot context and include each exact pending Boss question,
question id, and asking player so the judge can distinguish a reply from a
fresh directive. With one pending question, a classified `BOSS_REPLY` that
omits its optional id shall be filled with that sole id. With several pending
questions, the classifier shall require a known id. A reply shall re-enter only
its recorded resume state and preserve the original intent, plan, prior child
results, and Q+A continuation context.
The allowed fresh directives while parked include every applicable root entry
event and `BOSS_INTERRUPT`; accepting one shall abandon and clear the pending
question and reply context before new work begins.

A playbook runtime shall not define slash-prefix commands for states or features inside that playbook.
The `/command` namespace is reserved for host-level or playbook-selection UX before a turn reaches `handleBossInput`.
If a host forwards text beginning with `/` to `handleBossInput`, the runtime treats it as ordinary Boss text and classifies it through `callJudge`.

Hosts that receive structured control input shall resolve host-level concerns before choosing a playbook runtime.
Once they call `handleBossInput`, they shall pass the Boss content as text and shall not pre-classify in-playbook FSM events or rely on slash forms as a runtime protocol.

`BOSS_INTERRUPT` (or the FSM's equivalent explicit-state-jump event) is reached only by the judge choosing it and supplying its required target payload.
It is _not_ an abort surface; aborts go through the abort signal and the strategies in §Abort.
Hosts where the abort signal is terminal (e.g., SIGINT runs shutdown) shall not route abort to `BOSS_INTERRUPT`.

## Captain adjudication

After a direct Captain or delegated player call returns, the runtime shall
coerce `result.finalText` into one of the **per-state**
`invoke.input.result` keys.
It shall also extract any payload fields the state's `result` description names as required.
Required-field extraction shall recognize both an exact backticked property
name such as `` `question` `` and the standard annotated form
`` `question: <verbatim question text>` ``; in either form only `question` is
the JSON property name.
The adjudicator shall use the same document-order tolerant JSON recovery as
the Boss classifier. Unlike invalid classification, a reply from which no
object can be recovered, an undeclared guard, or a missing required field is a
control-plane error and shall throw after the invocation reaches its FSM error
path and ordered emissions drain.

Two default adjudication strategies, in selection order:

- **LLM-judge** (default): construct a fresh prompt for `callJudge` that
  names the source item's actor (and delegated player where applicable),
  includes the actor's verbatim output,
  lists the `result` keys with their descriptions, and demands a JSON
  `{ guard, …payloadFields }` answer keyed to exactly one of the
  declared guards. The judge prompt shall not interpret the player's
  output, paraphrase it, or alter the FSM's `result` text — it carries
  the description verbatim.
- **Marker-parse** (delegated-player alternative): a deterministic parser that
  scans the player output for a terminal control line such as
  `FSM-RESULT: { "guard": "...", ... }`. Useful when player adapters can
  be steered to emit structured trailers and the operator wants to avoid
  the extra LLM call.

The linker may select different strategies per delegated-player state; the
default is **LLM-judge for every state**. Direct-Captain states shall use the
LLM judge so their visible prose remains human-readable and carries no marker
or control JSON. Their adjudicator call uses purpose
`captain-output-adjudication` and remains hidden at the host adapter.

When the adjudicated Captain prose supplies a terminal `response` that the FSM
returns, that already-visible prose is the Boss presentation. The linked
runtime shall not make a second visible Captain call or expose the hidden
structured adjudication merely to present the same response.

The adjudicator shall fail loudly on:

- A guard the state does not declare,
- A missing payload field the state's `result` description requires,
- An empty / malformed response.

Adjudicator failures are control-plane errors.
The runtime shall propagate them by throwing out of `handleBossInput` after attempting cleanup.
The host adapter surfaces the throw on its control-plane channel (cligent surfaces such throws as `runtime_error` per [TMUX-025](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-025)).
The host's player-result channels (`player_finished` and equivalents) are reserved for failures the player itself produced; the host emits them when `callPlayer` resolves with `status !== 'ok'`.
Captain call failures stay on the Captain/control boundary and shall not be
reported as player failures.
Because XState still needs the invoked promise to settle, the linked runtime
shall latch an adjudicator, actor-output JSON-validation, or nested-boundary
control error outside machine context, allow the invocation's `onError` path to
reach quiescence, drain all emissions, and then reject the public runtime
method with that original error. It shall not return such a failure as a
recoverable `{ outcome: 'failed' }` workflow result.
The first latched non-abort control error takes precedence over a coincident
boundary-signal abort. Read and clear the latch only in the public boundary's
`finally` cleanup after XState and emissions have settled, so it cannot leak
into a later Boss turn or be erased before rejection.
When a host port or structured-result validator fails after a call-start
boundary, latch that original error before attempting the required finish
trace. If the finish sink records the event and then rejects, do not emit a
second finish and do not let the sink failure replace the earlier control
error returned by the public boundary; retain the sink failure only as
independent cleanup evidence.

## Nested playbook bridge

Where the FSM declares the typed `playbook` actor from
[gears2fsm](gears2fsm.md#nested-playbook-calls), the linked runtime shall provide
it with the shared `createNestedPlaybookBridge(...).actorLogic`; it shall not
regenerate a second pending-call, identity-validation, or abort-cleanup
substrate inside each linked artifact.
Instantiate the generic bridge with the FSM-exported `PlaybookInput` type so
XState `.provide(...)` receives the exact declared actor input rather than a
structurally similar local type.
Construct one bridge per runtime and wire every integration hook: allocate ids
with `nextCallId`; return the currently active public-boundary signal from
`getBoundarySignal`; bind `resumePlaybookCall.signal` before settling the
deferred actor through `bindResumeSignal`; enqueue the exact start/finish trace
through `emitStarted` / `emitFinished`; drain the global emission queue through
`drain`; latch the original control error through `onControlPlaneError`; and
retain any cleanup/observer failure through `onBackgroundError` for the next
public boundary or disposal rejection. The runtime shall not leave these
optional API hooks unwired merely because their TypeScript properties are
optional for simpler bridge consumers.
On invocation the bridge allocates a runtime-local call id, traces the start,
and calls `PlaybookPorts.callPlaybook` with the composed target/text and the
bridge signal combined from the XState invocation lifetime, the active public
boundary, and the bridge's own disposal controller.

For a literal invocation, target and text retain their existing static/composed
values. For a dynamic invocation, the bridge shall use the evaluated
`PlaybookInput.playbookId` and `PlaybookInput.text` values, require both to be
strings with non-empty target and text, and preserve the exact resolved values in the
request and trace. The linker shall preserve the FSM's static
`playbookIdContext` and `textContext` metadata for conformance; it shall not
parse function source, treat either metadata name as the runtime value, or
freeze a dynamic call to the value observed during artifact inspection.

If the port returns `state: 'settled'`, the bridge validates the result,
emits and drains `playbook.call.finished`, then resolves successful output or
rejects an aborted/error result.
If the port returns `state: 'suspended'`, the bridge records one pending call
and awaits a runtime-owned deferred result.
Only after that pending record exists may the drive boundary treat the call
state's `playbook.suspended` tag as quiescent.
One runtime supports at most one pending child call; a second shall reject.
The bridge shall strictly validate the start discriminant, non-empty suspended
child session id, settled target identity, optional state descriptor,
normalized error, and JSON-safe output. A malformed start, malformed result,
identity mismatch, or non-JSON value is a control-plane error. Once a start
trace exists, every thrown port, validation failure, immediate result,
suspension resume, invocation abort, and disposal path shall emit and drain
exactly one matching finish trace; malformed data shall neither create a
pending identity nor be reassessed as ordinary child evidence.
The bridge shall detach and recursively freeze a validated start/result before
tracing it or delivering it to the FSM, so caller mutation after port
resolution cannot alter identity, evidence, or trace payloads. A non-abort
`callPlaybook` throw/rejection is a control-plane failure: pair its finish,
latch and rethrow the original error, and take the FSM fallback error path. A
rejection caused by the combined abort signal remains an authored `aborted`
child result.
When cancellation wins while the host's opening promise is still pending, the
shared bridge shall retain and drain that exact promise before emitting the
matching finish boundary. It shall ignore an abort-reason rejection from that
opening promise, surface any other late rejection as a control-plane cleanup
failure, and recover a child session identity from a late resolved start when
available. Generated runtimes shall pass the host port directly to the shared
bridge rather than recreate this opening-promise drainage locally.
The pending record shall retain a one-shot invocation-signal listener. If the
call state is stopped, that listener shall settle and clear the deferred call
as an aborted `NestedPlaybookCallError`, drain the matching finish boundary after
host abort cleanup, and make a later nested invocation possible; it shall not
leave a permanently pending record merely because XState stopped observing the
promise actor.

`resumePlaybookCall` shall accept only the matching pending call id, target
playbook id, and child session id; bind its new turn signal for work resumed in
the parent; emit and drain the call-finish trace; settle the bridge deferred;
and use XState `waitFor` to drive the parent to its next
quiescent, suspended, failed, aborted, or terminal result.
An `ok` result resolves the actor and reaches `invoke.onDone`; `aborted` and
`error` results reject it and reach `invoke.onError`.
The rejection shall be an `Error` whose public readonly `result` property is
the exact normalized `PlaybookCallResult`; throwing the result object directly
or discarding its status prevents the FSM from distinguishing abort from
failure during recovery.
Unknown, duplicate, or stale call ids reject without changing actor state.
The finish trace shall therefore precede any parent FSM transition caused by
the child return.
The host independently validates every evaluated target against its enabled
registry; linker-time metadata is not authorization to call a target.

Disposal shall settle an outstanding call as aborted and drain its finish
trace before `session.disposed`.
Child output and errors must be JSON-safe; a non-JSON-safe result is a
control-plane error.

## Session lifecycle

The `PlaybookRuntime` shall:

- Reject use before `init`, a second active turn or resume, and re-initializing
  a live session. `handleBossInput` and `resumePlaybookCall` share one active
  turn sentinel; neither may overlap the other, and disposal shall not race a
  live boundary. A dispose request made during an active public boundary shall
  reject without beginning teardown. Idle concurrent dispose requests shall
  share one disposal promise; later calls after disposal shall return that
  settled disposal outcome without emitting another boundary. Once disposal
  begins, no new turn or resume may start.
  The generated `dispose` method shall not be declared `async`, because an
  async wrapper returns a distinct promise and breaks identity coalescing; it
  shall return the retained teardown promise directly and use
  `Promise.reject(...)` for precondition failures.

- In `init`, bind the immutable `PlaybookSession`, emit
  `session.started` with the initial normalized state descriptor, and
  construct the XState actor with FSM `input` derived
  from `options`. The actor is session-scoped, not turn-scoped. Use XState v5's
  public actor inspection `@xstate.snapshot` event for the root actor so each
  transition's triggering event and snapshot can be surfaced via `emitStatus`
  and `emitTelemetry` before the next event fires; do not consult private actor
  nodes or infer the event later from context. Filter inspection events by
  `inspectionEvent.actorRef === rootActor`, not merely by the actor-system root
  id, so promise-child snapshots are not emitted as root FSM transitions. The
  inspection callback shall only validate and synchronously enqueue emission
  work, catching validation/enqueue failures into the control/background-error
  latch; it shall not let an exception escape or call an async port directly.
  Construct the actor without starting it, read its public initial snapshot,
  emit and drain `session.started`, and only then call `actor.start()`. The
  initial inspection-driven transition/status emissions shall not precede the
  session-start trace. Have any actor-construction helper return the actor and
  assign it at the call site; TypeScript does not narrow a captured optional
  actor variable from assignment hidden inside a helper. Retain a non-optional
  local actor reference across terminal reconstruction and event sending.
  Generated code shall pass the repository's full strict `tsc` build with no
  unused helper or destructured parameter, not only a transpile-only or
  target-local syntax check.
  Where the FSM input declares `selfPlaybookId`, seed it from the immutable
  `session.playbookId`; do not expose a caller option or reuse a working leaf's
  `stateId` as the self-call identity.
- If initialization fails after attempting `session.started`, stop the actor,
  abort/drain nested and host work, and make one best-effort
  `session.disposed` attempt before clearing the bound session. Preserve the
  original initialization error if cleanup or disposal emission also fails.
  Suppress root inspection emissions before stopping the failed actor because
  XState emits a stop snapshot; that teardown snapshot shall not retry a
  transition/status sink that already failed initialization. Reset the
  inspection gate, queues, error latches, prior state, and all per-session
  sequence counters so a permitted retry starts with trace sequence `1`.
- Per `handleBossInput`:
  1. Allocate a runtime-local turn id and trace the exact Boss text.
  2. Classify `turn.text` through the Boss-event mapping.
     If it produces no event, return after draining any port emissions.
     If the classifier port rejects, emit and drain the Boss-settled error
     boundary, send no event, leave the actor unchanged (including a terminal
     actor), and reject the original error. If the port resolves but its reply
     cannot be recovered or validated, emit the one recovery status required
     by §Boss-event mapping, send no event, leave the actor unchanged, and
     return `no-action` after the ordinary settled boundary drains.
  3. Only after classification produces a real event, if the actor is in a
     `final` state, dispose and reconstruct it — `final` is terminal and cannot
     accept new events. `NO_ACTION`, classifier rejection, and malformed
     classification shall leave a terminal actor untouched.
  4. Bind the active public-boundary signal and send the classified event to
     the actor.
  5. **Drive to quiescence**: provide each invoked actor according to its
     declared kind. For `player`, build a player prompt, call `callPlayer`,
     adjudicate, and resolve the invoke. For `captain`, build a direct Captain
     prompt, call `callCaptain` visibly, adjudicate through the shared hidden
     judge path, and resolve the invoke. For `playbook`, use §Nested playbook
     bridge. Parallel regions may run distinct resolved players independently;
     Captain and judge work remains serialized by the shared host queue. Use
     XState `waitFor` over public tags/status until no `playbook.busy` state is
     active, a registered child call is suspended, or the actor is
     terminal/error. Pass `pendingCalls: nestedBridge` so a suspended tag is
     quiescent only after its child identity exists. Under natural rejection,
     do not pass the already-aborted public turn signal as wait cancellation:
     it has already been combined into the invoked boundary, and the runtime
     must now wait for XState's `onError` transition and quiescence.
  6. Return a structured `PlaybookRunResult` after all in-flight calls and
     ordered emissions caused by the turn drain.
- Per `resumePlaybookCall`, follow §Nested playbook bridge and return the same
  structured run-result boundary without classifying new Boss text. Drain the
  transition/status/telemetry queue before returning, just as
  `handleBossInput` does. A resume shall not allocate a new Boss-input
  `turnId`; retain the original call-start turn id for its matching finish and
  for the parent continuation caused by that return. Every success and
  exceptional path shall drain ordered emissions, select the first latched
  non-abort control error before considering abort, and clear its boundary
  latches in `finally`, so a failed resume cannot leak an emission error into a
  later turn.
  This quiescence and drain path is mandatory even when
  `nestedBridge.resume(...)` rejects: capture that operation error, allow the
  promise actor's `onError` transition to settle, and select the first latched
  control error only after all ordered emissions have drained.
- In `dispose`, capture the final public state and stop the root actor before
  settling or aborting a suspended nested bridge, so the bridge rejection
  cannot reenter the FSM and start new actor work during disposal. Then drain
  pending port emissions and every in-flight Captain/player/judge/child opening, emit
  `session.disposed` with the final descriptor, and discard player resume
  tokens. Host child abort cleanup and child `session.disposed` shall drain
  before the parent call finish, which shall drain before parent
  `session.disposed`.

The actor's `lastError` field shall be surfaced via `emitStatus` when the machine enters its `failed` state.
Every provided actor boundary shall first drain the queued state-entry
transition/status/telemetry caused by entering its working leaf, so a call's
`*.started` trace cannot overtake the transition that explains it. Every public
runtime method shall drain that queue before it resolves or rejects.
This initial `await drain()` is required inside each provided `fromPromise`
body: XState may begin that body before publishing the root snapshot, and the
await yields so the synchronous inspection callback can enqueue the entering
transition first.

## Abort

`handleBossInput.signal` is the abort surface.
The runtime shall honor it at every `callPlayer`/`callCaptain`/`callJudge` and
at every poll between transitions.
Each provided Captain, player, judge, or nested-playbook boundary shall receive
a signal combined from its XState invocation-lifetime signal and the currently
active `handleBossInput` or `resumePlaybookCall` signal (for example with
the shared `combineAbortSignals`). On abort, the runtime shall not merely race the imperative
wait and return while an invocation remains live: it shall let the selected
rejection path settle and drive the actor to a quiescent state before returning
from the turn. No trace, status, state, or call completion caused by that turn
may appear after the public method returns.
Three strategies are permitted; the linker selects per FSM:

- **Natural rejection** — the runtime's Captain or player actor (e.g.,
  `fromPromise`) ends the invocation by rejecting, and the FSM routes
  the rejection through `onError` to a quiescent sink. The cancelled
  port call may _itself_ reject, or it may resolve with
  `PlayerResult` or `CaptainResult` with
  `{ status: 'aborted' | 'error' }` that the runtime
  inspects and converts into an actor rejection. Either shape
  is permitted — the contract is on the actor boundary, not on
  the port's promise behavior. Preferred when every Captain- or player-invoking
  state's `onError` lands somewhere quiescent; the FSM's own error
  wiring is the abort path.
- **Synthetic pre-emption to a quiescent target** — send the FSM's
  pre-emption event (e.g., `BOSS_INTERRUPT { targetId: <state> }`) with
  a target that is itself quiescent (typically `ready` or `failed`).
  The runtime shall not pick the active state as the target:
  `gears2fsm.md` prescribes `reenter: true` for `bossInterrupts`, so
  re-entering the active state restarts its `invoke` and spawns a
  fresh agent call.
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
  (recommended `playbook.fsm.state`), with structured `from`, `to`, `event`,
  `previousState`, and `state` fields. Descriptors carry the JSON-safe XState
  value, active stable ids from public state metadata, tags, status, and
  quiescence; they do not inspect private XState nodes.
  The payload shall additionally carry the exact pending Boss question or
  keyed questions selected from public snapshot context and normalize any
  transition error without retaining a raw `Error` instance.
  Observers consume telemetry; the runtime never interprets the topic.

Player prompts and adjudicator JSON may additionally ride the host's own record channels when the host has them (cligent's `captain_*` / `player_*`).
The `playbook.trace` copies are the host-agnostic runtime-boundary record required by §Playbook trace.

## Output

The link compiler emits **one** TypeScript module that:

- Imports the FSM artifact by relative path with an extension-bearing
  runtime specifier. When the linked TypeScript is part of a package that
  compiles and ships JavaScript siblings, the source shall use the
  NodeNext-compatible `.js` specifier (for example `./code.fsm.js`), never a
  `.ts` specifier that the package's supported Node versions cannot load.
  An explicitly source-only host may instead retain `.ts` only when that
  host supports direct TypeScript loading and no JavaScript build is shipped.
- Restricts itself to erasable TypeScript syntax — type annotations
  that strip cleanly, no constructor parameter properties, `enum`s, or
  namespaces — so a host running under type stripping loads it
  directly.
- Imports XState's actor primitives (`createActor`, `fromPromise`,
  `setup`'s `.provide`).
- Imports `PQueue` from `p-queue` for its single serialized emission channel.
- Imports the FSM's exported machine/actor input and output types and uses
  those exact types in `.provide(...)`; it shall not redeclare look-alike
  Captain, player, playbook, question, or output contracts beside the linked
  runtime.
- Imports the applicable shared helpers from the extension-bearing
  `xstate-runtime.js` sibling of the resolved shared `--link` contract module,
  with that sibling path relativized from the emitted artifact exactly as the
  contract import is. Every runtime uses `assertJsonSafe`, `snapshotJsonValue`,
  `snapshotPlaybookSession`, `normalizeError`,
  `normalizePlaybookSnapshot`, and `waitForPlaybookQuiescence`; it additionally
  imports `combineAbortSignals`, result validators, and
  `createNestedPlaybookBridge` only when its actor and composition paths need
  them. It shall use those helpers instead of emitting weaker local JSON,
  error, snapshot, nested-call, or imperative-wait implementations.
- Exports `createPlaybookRuntime` and the typed `PlaybookRuntimeOptions`
  interface for that playbook.
- Exposes, under an `_internal` export, the pure helpers verification
  needs — at least the player-prompt and Captain-prompt composers
  (`composePlayerPrompt` and `composeCaptainPrompt`) — so
  compilation-correctness tests can exercise composition without a host.
- Holds no host-specific types and no host primitive calls. The runtime
  speaks only `PlaybookPorts`.
- Records the linker inputs (FSM path, player binding, strategies) in a
  top-of-file header comment so the file is reproducible from the same
  inputs.
- Sources the contract types (`PlayerResult`, `PlayerCallOptions`,
  `CaptainResult`, `CaptainCallOptions`, `PlaybookPorts`, `PlaybookSession`,
  `PlaybookTraceEvent`,
  `PlaybookCallRequest`, `PlaybookCallResult`, `PlaybookCallStart`,
  `PlaybookStateValue`, `PlaybookState`, `PlaybookRunResult`,
  `PlaybookRuntime`, `PlaybookRuntimeFactory`) from a single shared
  type-only module instead of redefining them, and re-exports the names
  its consumers import, so every linked playbook shares one contract
  definition. The shared module imports no FSM or host types, so the
  dependency runs one way — from each linked module to the shared
  contract, never the reverse.

Internal trace/status helpers may accept `unknown`, validate it with the same
JSON-safety rules as the public boundary, and only then emit a `JsonValue`.
They shall not require nominally typed public interfaces such as
`NormalizedError`, `PlaybookState`, `PlaybookCallRequest`, or
`PlaybookCallResult` to satisfy a `JsonValue` index signature at compile time,
and they shall not silence that mismatch with an unchecked cast.
Prompt placeholder substitution shall make one callback-based pass over the
original template. Replacement strings are literal: placeholder-looking text
inside Boss/catalog/plan/result values and JavaScript replacement tokens such
as `$&`, `$$`, dollar-backtick, and `$'` shall not be interpreted or
substituted again.

## Host adaptation (informative, not normative)

A host integrates with playbooks via a small adapter that:

1. Accepts a path to a `PlaybookRuntime` module (either as a direct
   import in a playbook-specific adapter, or via the host's config
   surface in a generic adapter).
2. Imports the module and constructs the runtime with options forwarded
   verbatim from the host config.
3. Implements `PlaybookPorts` by wrapping the host's own primitives —
   for cligent/tmux-play this is `callPlayer ← context.callPlayer`, visible
   `callCaptain ← context.callCaptain`, hidden
   `callJudge ← context.callCaptain`, nested `callPlaybook ←` the Captain
   session stack, and `emitStatus`/`emitTelemetry` ←
   `session.emitStatus`/`session.emitTelemetry`. The two Captain-backed ports
   share one abort-aware concurrency-one queue.
4. Generates a unique playbook-session id, calls
   `runtime.init({ sessionId, rootSessionId: sessionId, depth: 0,
playbookId, ports })` once at session start, forwards each Boss turn to
   `runtime.handleBossInput`, and calls
   `runtime.dispose()` at session end.

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
- Persisting FSM context or the trace across sessions, multiple
  Boss-selected root engagements, recursive playbook calls, multi-Boss
  orchestration, or visualizer rendering — separate hosts/observers may add
  them without changing this spec. A host may persist the emitted trace, but
  the runtime does not rehydrate a disposed actor from it.

New behavior in any of these areas requires a separate slc spec.

## References

[1]: [text2gears](text2gears.md) "First phase: text → GEARS spec items."
[2]: [gears2fsm](gears2fsm.md) "Second phase: GEARS items → FSM artifact."
[3]: https://stately.ai/docs/actors "XState actors — `createActor`, snapshots, abort signal handling."
[4]: https://github.com/sindresorhus/p-queue#readme "p-queue concurrency and AbortSignal support."
