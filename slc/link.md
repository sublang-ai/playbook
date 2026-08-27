<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# FSM-to-Runtime Linking

Third phase of a playbook (a state-machine agent orchestrating other agents).
Compiles the [gears2fsm](gears2fsm.md) artifact into a **`PlaybookRuntime`**: a host-agnostic runner that:

- Drives the FSM.
- Classifies Boss input into typed events.
- Runs direct-Captain, delegated-player, and nested-playbook actors.
- Executes deterministic script actors locally, without any agent.
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
  readonly retainedGenerationMetadata?: PlaybookRetainedGenerationMetadata;
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

interface PlaybookRetainedGenerationMetadata {
  readonly unfinishedFinalStateIds: readonly string[];
}

interface PlaybookSession {
  sessionId: string;
  playbookId: string;
  rootSessionId: string;
  parentSessionId?: string;
  parentCallId?: string;
  depth: number;
  roleBindings?: Readonly<Record<string, PlaybookRoleBinding>>;
  playerSessions?: PlayerSessionStore;
  ports: PlaybookPorts;
}

interface PlaybookRoleBinding {
  readonly playerId: string;
  readonly promptIdentity: string;
}

interface PlaybookPendingBossQuestion {
  questionId: string;
  asker: { kind: 'captain' } | { kind: 'role'; roleId: string };
  question: string;
  sourceItem?: string;
}

interface PlayerSessionStore {
  select(roleId: string): string | false;
  // Called only for a replacement token or an authorized ok-status clear.
  update(roleId: string, resumeToken?: string): void;
  snapshot(): Readonly<Record<string, string>>;
  restore(tokens: Readonly<Record<string, string>>): void;
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

interface PlaybookSuspendedCall extends PlaybookPendingCall {
  stateId: string;
  text: string;
  turnId?: number;
}

interface PlaybookRuntimeSnapshot {
  schemaVersion: 3;
  playbookId: string;
  machine: JsonValue;
  roleResumeTokens: { readonly [roleId: string]: string };
  sequences: {
    trace: number;
    turn: number;
    judgeCall: number;
    playerCall: number;
    playbookCall: number;
    captainCall?: number;
  };
  state: PlaybookState;
  pendingBossQuestions: readonly PlaybookPendingBossQuestion[];
  suspendedCall?: PlaybookSuspendedCall;
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
      stateDescription?: string;
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
JSON output and the exact authored `stateDescription` of the reached final
state when one is declared; `aborted` means the turn signal ended work; and `suspended` means
exactly one `pendingCall` is active.
Only the terminal variant may carry `stateDescription`; the runtime shall omit it when the final state declares none and shall never substitute a state id or derive it from opaque output ([DR-037](../specs/decisions/037-terminal-result-meaning.md)).
Control-plane exceptions reject the runtime method rather than masquerade as a
recoverable workflow `failed` result.

`PlaybookRuntimeOptions` is host-agnostic and carries only _per-run_ workflow knobs, strategy overrides the linker exposes, and — where the compiled playbook's policy needs a host seam — host-supplied port-shaped callbacks the linker exposes as option members whose types the artifact itself declares, so the six-member `PlaybookPorts` contract and the shared contract module stay free of host types.
The link compiler emits a typed options interface per playbook based on the FSM's `CodingInput` (or equivalent).
The CLI's absence of `--link-option` values does not mean that
`PlaybookRuntimeOptions` is empty. CLI link options are compile-time inputs;
the runtime options interface is independently derived from every required FSM
input field that is not supplied by `PlaybookSession` or another linker-owned
source. In particular, a required immutable `enabledPlaybooks` catalog shall
remain a required readonly runtime option passed through to machine input; the
linker shall neither invent an empty catalog nor require it to be baked into a
CLI link option.

Concrete player binding and prompt identity are host policy and shall not enter `PlaybookRuntimeOptions`, machine input, or the emitted artifact.
For a shell-hosted runtime, `PlaybookSession.roleBindings` shall carry exactly the runtime's local roles, map each to its resolved player id and current prompt identity, and be the sole source for call targeting, player-facing prompt identity, concurrency keys, and trace player ids.
The host shall derive `promptIdentity` from the current effective model when present and the established adapter otherwise; a standalone runtime may omit the map and retain only its local role identity.

## PlaybookPorts contract

```typescript
interface PlaybookPorts {
  callPlayer(
    roleId: string,
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
  resume: string | false;
  allowedTools?: readonly string[];
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
An `ok` player result whose `finalText` is missing, empty, or whitespace-only
earns exactly one corrective re-ask: the same player call repeated under the
stored resume selection, traced as its own player-call pair, before a second
such result routes through the same error path.

`callCaptain` runs a direct-Captain FSM actor against the host's Captain
agent. The linked runtime shall pass
`{ visibility: 'visible', resume: false }` for authored workflow calls so
XState context, rather than an agent conversation, owns workflow continuity.
The tool restriction is source-owned: the runtime shall additionally pass
`allowedTools: []` exactly when the GEARS source itself restricts the acting
Captain from tools (a routing-only Captain policy such as the default generic
Captain). A transformation-performing Captain — e.g. a compiler phase compiled
from a transformation-spec source, whose behavior writes a declared target
artifact — works through the host Captain's own tools, so its calls shall
carry no `allowedTools` restriction.
Accordingly, `CaptainCallOptions.allowedTools` is optional: an explicit empty
array requests a tool-free call, while omission preserves the host Captain's
configured tools.
`CaptainResult` carries no resume token or player-continuation selection.
A non-`ok`
result, or an `ok` result whose `finalText` is missing, empty, or
whitespace-only, shall record that failure on the call's single finish trace.
A non-`ok` result shall then reject the actor through the FSM's error path
with no corrective re-ask; an empty `ok` result shall first earn exactly one
corrective re-ask — the same call repeated, traced as its own
started/finished pair — and only a second such result shall reject the actor
the same way. These structured host-result failures are recoverable
workflow failures, not control-plane failures: the runtime shall let the actor
take `onError`, drive it to quiescence, drain ordered emissions, and resolve
the public method with `{ outcome: 'failed' }` carrying the failure state's
error. This matches the delegated-player result boundary.
A non-abort thrown `callCaptain` port, a malformed host result, and a rejecting
trace sink remain control-plane failures that reject the public method. If the
required finish sink rejects after a structured host-result failure, the
actor's error and failure-state evidence shall remain the host-result failure,
while the public method rejects with the sink failure surfaced by the turn's
emission drain. Absent such a control-plane failure, if the combined signal
has aborted, ordinary abort settlement remains authoritative after the actor
reaches its error path.

Every standalone linked runtime owns a private continuation map keyed by resolved player id when `roleBindings` is supplied and by local role id otherwise.
Before reading a resolved direct-Captain or delegated-player result, the
runtime shall validate, detach, and freeze it through the shared
`validateCaptainResult` or `validatePlayerResult` helper. The accepted object
shape is exact: only the declared status and optional string fields are
allowed, JSON-unsafe members reject, and caller mutation after resolution
cannot change trace evidence or player continuity. Validation happens before
adopting a resume token or reading final text.
The first call to each private continuation key in a standalone playbook session shall pass `{ resume: false }`; later calls shall pass the exact stored token, so two sequential roles explicitly bound to one player id share one token even without a supplied `PlayerSessionStore`.
After a validated resolved call, the runtime shall replace the token when the result carries one, clear it only for an `ok` result that omits one, and preserve it for an `aborted` or `error` result that omits one; a rejected call with no result likewise leaves the prior token unchanged.
After awaiting a host Captain or player promise, the runtime shall re-check the
combined invocation/public-boundary signal before validating the result,
adopting a resume token, or emitting a successful finish. A host promise that
ignores cancellation and resolves late shall be paired as aborted and shall
not mutate continuity or masquerade as success.
The map survives actor reconstruction inside the same runtime and is discarded at `dispose`.
The runtime shall keep an in-flight set keyed by resolved player id when the
host supplies binding metadata, otherwise by local role id, and reject a
second concurrent call to the same key before crossing the host port.
Calls to distinct keys may overlap.

`callJudge` returns free-form text.
The runtime parses it per the state's adjudication strategy (§Captain adjudication).
One port serves both classifier and adjudicator — they vary only in prompt.
Concurrent `callJudge` attempts within one linked runtime shall pass through
one abort-aware local FIFO. After the host promise resolves, the runtime shall
require a string reply and re-check the combined signal before tracing or
parsing success, so a non-cooperative late judge cannot outlive cancellation.
The host shall serialize `callCaptain` and `callJudge` together through one
shared abort-aware concurrency-one FIFO because both use the same single-flight
Captain lane, even when distinct player ports overlap [[4]]. A direct Captain
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
Each payload shall carry `schemaVersion: 3`, the immutable session identity and
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
  | 'apply.started'
  | 'apply.finished'
  | 'fsm.transition'
  | 'status.emitted'
  | 'boss.input.settled'
  | 'session.disposed';

interface PlaybookTraceEvent {
  schemaVersion: 3;
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

A composing host may supply `playerSessions` as a frame-local view of player continuation owned by the logical Captain session.
The runtime shall select through that view before allocating or tracing a player call and shall update or clear it from a validated player result before emitting the matching finish trace.
Snapshot export and restore shall use the same view, failed restore shall leave its prior contents unchanged, and child disposal shall not clear host-owned continuation.
A host that omits the view retains the runtime's private per-session continuation behavior.

The trace types are `session.started`, `boss.input.received`,
`judge.call.started`, `judge.call.finished`, `player.call.started`,
`player.call.finished`, `captain.call.started`, `captain.call.finished`,
`playbook.call.started`,
`playbook.call.finished`, `apply.started`, `apply.finished`,
`fsm.transition`, `status.emitted`,
`boss.input.settled`, and `session.disposed`.
Call pairs carry exact prompts and replies, normalized failures, actor and state
identity, and their boundary-specific options.
`apply.started` and `apply.finished` are the paired apply boundary of a
executed `apply()` call on a runtime implementing the optional control surface
(§Control surface): both carry the action id and idempotency `key` (plus the
singular `stateId` on start when one exists), the pair shares one
session-unique `apply-<n>` call id and the boundary's turn id, and the finish
adds the receipt `disposition` with its `reason`, normalized `error`, or
projected `run` result, all JSON-safe. A repeated idempotency key returns the
recorded receipt without a new pair.
Direct-Captain start and finish payloads shall carry `allowedTools` exactly when
the originating `CaptainCallOptions` selects it and shall omit the member when
the call preserves the host Captain's configured tools.
`session.started` and `session.disposed` carry their descriptor as top-level
`state` and its singular `stateId` when present. Every judge start and finish
carries the working snapshot's singular `stateId` when one exists;
classification uses the current descriptor and adjudication uses the invoking
actor input. The default Captain always has such a singular id, while a
parallel snapshot may omit it. Every judge finish also carries
`status: 'ok' | 'aborted' | 'error'`. Every `status.emitted` carries the
described top-level `state` and its singular `stateId` when present, as well as
its message and optional data; consumers shall not have to recover state
identity from a nested ad hoc object.
Judge results use `reply`; player start and finish payloads both carry the
local `roleId`, the resolved `playerId` when host binding metadata is
available, and the selected `resume`; Captain start and finish payloads both carry
the exact composed prompt, the boundary's selected `visibility`, the direct
invocation's `stateId` and `sourceItem`, and no player resume selection or
resume token — a visible workflow call carries its runtime-owned
`resume: false` selection, while a hidden controller call
(§Captain adjudication) omits the `resume` member altogether, its
durable-conversation selection being host-owned;
judge `purpose` is
`boss-input-classification`, `player-output-adjudication`, or
`captain-output-adjudication`; and every error uses
`{ name, message, stack? }` rather than a raw string or `Error` instance.
The Captain finish payload shall preserve the exact `CaptainResult` status and
final text when present, while carrying any failure in normalized form.
An `ok` result without non-empty `finalText` therefore retains status `ok` but
also carries the normalized missing-text failure; the corrective re-ask that
follows (§PlaybookPorts contract) traces as its own started/finished pair, and,
when that corrective call happens, only a second such finish makes the actor
reject.
If the Captain port rejects before returning a result, the finish instead
carries explicit `status: 'aborted'` when the combined signal has aborted or
`status: 'error'` otherwise. A finish boundary never omits status merely
because there was no structured host result.
The pair obligation also applies when a port promise rejects or throws: the
linked runtime shall emit and drain one normalized finish boundary before it
propagates the failure. No started call boundary may be left without its
matching finished boundary.
If a started-boundary sink records the event and then rejects, the runtime
shall make one best-effort normalized error-finish attempt with the same call
id and then reject the original start error. It shall not retry either event or
let a failure of that finish attempt replace the start error.
A start-sink rejection causally identical to the applicable signal reason is
the cancellation itself, not a control error: no host call begins, the
best-effort paired finish carries the boundary's canonical aborted evidence —
`status: 'aborted'` for a host call, or the rejected-before-effect disposition
and reason for apply — and nothing is latched. An ordinary run boundary settles
as §Abort prescribes. At the apply boundary the same event remains
pre-acceptance: `apply` rejects with that exact reason, records no receipt, and
leaves the key reusable
([DR-036](../specs/decisions/036-coherent-abort-settlement.md)).
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
An XState inspection callback shall synchronously enqueue the transition
trace, state telemetry, status trace, and human status in that order before it
returns. `emitStatus` likewise enqueues its trace and port emission in the same
synchronous call. Do not enqueue state telemetry or the status port from a
`trace(...).then(...)` continuation: the queue can become momentarily idle,
letting an invoked actor's `await drain()` overtake those dependent enqueues.
All validation happens before these synchronous enqueues; later sink failures
are caught into the appropriate latch without changing their queue position.
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
- An **adjudication strategy** (default: LLM-judge per state) and a
  **Boss-event mapping** (default: free-text judge classification).
  Both strategies are host-agnostic.

The host's identity does not enter compilation; the linked module runs unchanged under any host that implements `PlaybookPorts`.

## Role identity

Each delegated GEARS state names exactly one canonical local role id (`player` actor `invoke.input.role`).
The linker shall retain that id in `PlaybookPorts.callPlayer(roleId, …)` without selecting a concrete player.
The host shall bind that local role id explicitly when it constructs the runtime.
Every direct-Captain and delegated-player invocation shall also carry its
working leaf's explicit
`stateId`; a linked runtime shall use that field for call identity and shall
not infer one leaf from a structured root snapshot.
Direct `captain` actor states call `PlaybookPorts.callCaptain`; the linker shall not synthesize a local role or concrete player id named `captain` for them.
The linker shall reject an alias-shaped role declaration rather than choose a runtime identity.

## Player prompt composition

The runtime shall compose the actual player prompt from the state's
`PlayerInput`.
The shared-factory `composePlayerPrompt` seam shall receive an
invocation-scoped `promptIdentity(roleId)` lookup as its second argument.
The lookup shall return the current detached session binding's prompt identity,
or the canonical local role id when bindings are absent, and shall reject an
undeclared role.
It shall expose neither the resolved player id nor the binding map, and the
runtime shall not place the lookup or any value read through it in options,
machine input, FSM context, or a persisted snapshot.
`input.prompt` is the GEARS-derived domain prompt body and shall not be mutated, re-flowed, or treated as a place to store framework control instructions.
A leading `>` inside that body is authored quoted-context content and shall reach the player unchanged.

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
For the default Captain catalog, every entry has exactly the own enumerable
data keys `id`, `command`, and `intent`; all three values are non-empty strings,
and `id` values are unique. Empty values, duplicate ids, extra keys, accessors,
non-plain objects, and non-JSON data reject runtime construction rather than
being silently repaired or discarded.

When a direct Captain task resumes from its own Boss question, the composer
shall prepend the same continuation preamble and labelled Q&A blocks defined in
§Player prompt composition. The runtime shall pass the complete composed prompt
once to `callCaptain` with `{ visibility: 'visible', resume: false }` and the
same source-owned tool restriction as the originating call; it shall not
expose the
subsequent adjudicator prompt or structured judge reply through that visible
call.
The composed prompt shall contain only the GEARS blockquote, typed runtime
evidence blocks, and the continuation preamble.
It shall not append the state's result map, guard names, result-property
schema, adjudication request, workspace context, or tool instructions.
The shared Captain composer shall replace every known placeholder whose
matching typed field is present in the supplied input. It shall not choose one
exclusive replacement set from `stateId`, source-item identity, or another
variant discriminator. Verification may deliberately combine catalog,
intent, plan, result, question, and reply fields in one synthetic input; every
matching placeholder in that template still has to be rendered.
Construct the replacement table from field presence alone. In particular,
populate `<remaining-plan>` when `remainingPlan` is supplied and
`<completed-call-results>` when `completedCallResults` is supplied, regardless
of the input's `stateId` or `sourceItem`. An implementation branch such as
`if (input.stateId === 'reassessment')` around either replacement is
nonconformant.

## Boss-event mapping

The FSM's `events` union enumerates every Boss-originated event.
The runtime receives Boss input as a free-form string
(`handleBossInput.text`).
Where the current ready, recoverable-failure (`failed`), or reconstructed
terminal machine accepts exactly one
ordinary textual entry event and no Boss question is pending, the runtime
shall send that event deterministically and attach the exact original text to
its declared textual payload field without invoking `callJudge`: each of the
three is an entry awaiting a fresh intent, so delivered text has exactly one
meaning there and a judge call could only spend budget or settle the restart
as no action.
The default Captain — the controller playbook of
[gears2fsm "Setup"](gears2fsm.md#setup) — is deterministic at every parked
entry: the runtime maps each Boss turn from the exact text and the host's
deterministic command-parse resolution, supplied through the linked options'
controller port, to the rewritten machine's hub entry union —
`{ type: 'BOSS_TURN', bossText: turn.text }` for an undecided turn,
`{ type: 'PARSED_RESPOND', bossText: turn.text }` for a parse-resolved
`respond`, `{ type: 'PARSED_ACTION', bossText: turn.text, decision }` carrying
the injected parse-resolved decision object, and `{ type: 'SHUTDOWN' }` for the
host's teardown resolution — and invokes no classifier judge call; the exact
original text still rides only the runtime-owned textual payload field.
All other non-empty turns shall use `callJudge` only to choose one of the FSM's
event kinds and non-text routing fields, or no FSM action.
The classifier prompt shall include the exact, unmodified `turn.text` in a
clearly labelled Boss-message block so the judge can make that choice. Omitting
the message makes a parked-state classifier unable to distinguish an answer,
a fresh directive, and no action; including it does not authorize the judge to
rewrite the runtime-owned textual payload fields.
For `BOSS_INTENT` and `BOSS_INTERRUPT`, the runtime shall attach the exact
original text as `bossIntent`; for `BOSS_REPLY`, it shall attach the exact
original text as `answer`.
The classifier prompt shall neither request nor accept a copy of those fields,
and classifier-authored paraphrases shall never become machine context.
Empty or whitespace-only text produces no event, judge call, Captain call,
player call, status emission, or FSM transition; its received and settled
session-trace events are still emitted.

The classifier prompt shall demand JSON against the FSM's typed event union and any state-specific Boss input contract, including non-text routing payload fields required for each event but excluding the runtime-owned textual fields above.
Fields the FSM's event union declares optional shall stay optional in the classifier contract and the reply parser; the classifier shall not promote them to required.
The runtime shall parse the judge reply tolerantly before validating the
event. It shall recover the intended JSON object from surrounding prose or a
Markdown fence, ignore earlier non-JSON bracketed prose, remove a trailing
comma before a closing brace or bracket, and complete a truncated
unterminated string or unclosed object/array. When several values are
recoverable, it shall choose the first object in document order, preferring a
strict parse at each candidate position before repairing that same candidate.
For each opening-brace position, first scan strings and nesting to find that
candidate's earliest balanced closing boundary. Both the strict parse and the
trailing-comma repair shall operate on only that bounded substring. If no
closing boundary exists, repair may complete the unterminated suffix. The
implementation shall never repair the entire remaining document after a
balanced candidate, because later prose or a later clean object would make the
earlier repair fail. Advance to the next opening brace only after strict and
repaired parsing of the current bounded candidate both fail; an earlier
repairable object therefore wins over every later strict object.
When no object is recoverable or the recovered event/payload is invalid, the
runtime shall emit exactly one status and send no FSM event; a malformed
classification is recoverable control input, not a public boundary rejection.
If a recovered `BOSS_REPLY` names no question that is currently pending, it is
such a malformed classification: emit the one recovery status, send no event,
leave the actor unchanged, and return `no-action` after emissions drain.
Host-owned runtime options, role-to-player bindings, and enabled-playbook catalogs are
not Boss-event payload. The classifier schema and parser shall not invite or
accept them, and classified prose shall never overwrite their machine context.
Every recovered classifier object shall have exactly `type` plus the declared
non-text routing keys for its selected event arm. Extra own keys, including a
classifier-authored `bossIntent` or `answer`, reject the classification; the
parser shall not accept and discard injected catalog, option, state, or
routing fields.
`NO_ACTION` in particular is exactly `{ type: 'NO_ACTION' }`.
A valid `NO_ACTION` returns `no-action` without an invalid-classification
status and leaves the actor untouched. It is a successful classifier choice,
not the same parser result as malformed or unrecoverable classifier output.
After any successful classifier call drains, re-check the active Boss signal
before reconstructing a terminal actor or sending the selected event. If it
aborted while the classifier finish emission was pending, return and trace the
same structured `aborted` result against the unchanged actor.
When the FSM supports a Boss-reply suspension state, the prompt shall inspect
the actor snapshot context and include each exact pending Boss question,
question id, and discriminated Captain-or-role asker so the judge can distinguish a reply from a fresh directive.
With one pending question, a classified `BOSS_REPLY` that omits its optional id shall be filled with that sole id.
With several pending questions, the classifier shall require a known id.
A reply shall re-enter only
its recorded resume state and preserve the original intent, plan, prior child
results, and Q+A continuation context.
The classifier-facing pending-question block contains only `questionId`, `asker`, and `question`.
Internal `resumeStateId`, source-item identity, and
other machine-routing fields remain authoritative in snapshot context and
shall not be serialized into the judge prompt.
The allowed fresh directives while parked include every applicable root entry
event and `BOSS_INTERRUPT`; accepting one shall abandon and clear the pending
question and reply context before new work begins.

A playbook runtime shall not define slash-prefix commands for states or features inside that playbook.
The `/command` namespace is reserved for host-level or playbook-selection UX before a turn reaches `handleBossInput`.
If a host forwards text beginning with `/` to `handleBossInput`, the runtime treats it as ordinary Boss text and maps it through the same deterministic-or-classified Boss-event rules.

Hosts that receive structured control input shall resolve host-level concerns before choosing a playbook runtime.
Once they call `handleBossInput`, they shall pass the Boss content as text and shall not pre-classify in-playbook FSM events or rely on slash forms as a runtime protocol.

Within `handleBossInput` classification, `BOSS_INTERRUPT` (or the FSM's equivalent explicit-state-jump event) is reached only by the judge choosing it and supplying its required target payload; `apply()` of a runtime-advertised action (§Control surface) is the second, runtime-validated path to the same events, and on neither path does the host fabricate an FSM event itself.
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
Extraction is limited to the description's explicit `Output shall include`
clause (or equivalent typed output metadata). Backticked prose before that
clause can name statuses, guards, or concepts such as `ok`, `aborted`, and
`error`; those names are not output properties and shall never become required
judge fields.
For a delegated-player field annotated exactly `` `<field>: <verbatim final text>` ``, the judge shall select the guard but the runtime shall replace any judge-supplied value with the player's canonical non-empty final text before returning the actor output.
The linker shall derive the complete `verbatimPayloadFields` set from those annotations across the FSM result maps.
A field name that is annotated in one result map and unannotated in another is a link error because the shared adjudication strategy cannot give one property both ownership policies.
For a direct Captain result, `question` and `response` are human-presentation
fields owned by the visible call rather than fields authored by the hidden
judge.
The adjudicator shall select the guard and supply only other structural fields
required by that guard.
After validating that selection, the runtime shall inject the exact non-empty
`CaptainResult.finalText` as the selected output's `question` or `response`.
It shall reject a judge reply that supplies either presentation field as an
undeclared extra key, so hidden adjudication cannot replace, paraphrase, or
decorate prose Boss already saw.
Delegated-player adjudication retains extraction of every required field from
the judge reply, including a player-authored Boss question.
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
  `{ guard, …structuralPayloadFields }` answer keyed to exactly one of the
  declared guards, excluding the runtime-owned direct-Captain `question` and
  `response` fields above. The prompt shall identify hidden control work,
  prohibit tool use, file inspection, and external evidence, direct the judge
  to decide only from the supplied actor output and declared outcomes, and
  require exactly one JSON object with no prose. The judge prompt shall not
  interpret the player's output, paraphrase it, or alter the FSM's `result`
  text — it carries the description verbatim.
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

When the direct Captain result selects a terminal `response`, the exact
already-visible `CaptainResult.finalText` is the machine response and Boss
presentation. The linked
runtime shall not make a second visible Captain call or expose the hidden
structured adjudication merely to present the same response.

That visible-call presentation — visible Captain prose as the Boss
presentation, a separate hidden adjudicator that never authors the
`question`/`response` fields, and runtime injection of the visible
`finalText` — stays scoped to a working playbook whose FSM declares a visible
direct-Captain state. For a controller playbook, whose FSM declares the controller
decision-state class of [gears2fsm "Setup"](gears2fsm.md#setup), the
Captain-call presentation admits the hidden controller form instead
(DR-029): the decision and closing-reply Captain calls run
`{ visibility: 'hidden' }` on the host's durable conversation, whose resume
token the host pins and rotates (DR-029), and the decision call's reply
is the `{ action, … }` control JSON itself — validated by the linked runtime
against the declared decision-state contract rather than adjudicated through
a separate judge call, with exactly one corrective re-ask appending the
rejection reason and the restated reply contract (the DR-025 corrective
pattern). Because the host owns that conversation, the `resume` member the
runtime is required to pass on a controller call carries no continuity
meaning: the runtime passes `resume: false` because it holds no token, and
the host's pinned durable selection overrides it — a controller call shall
never be read as a request for a fresh conversation.

The validated selection is not itself an effect. The linked runtime shall
submit it through the host-supplied controller port the linker exposed as an
option member (§PlaybookRuntime contract) and shall take the returned
settlement as the only evidence of what happened. That settlement, carried
beside the selected action as the guard discriminant, is the decision
invocation's own result — the actor output the decision state's `onDone` arms
select on and its evidence action records — so the effect reports through the
same invocation that decided it, with no second boundary and no host-sent
event. A controller prose state (a parse-resolved `respond` reply, an acting
turn's closing reply) settles on its declared single outcome and returns no
prose to the machine at all.

That reply is control data, never Boss presentation: the runtime
shall not inject the `question` or `response` presentation fields into a
controller result — no visible Captain call exists to own them. Controller
prose reaches the Boss only as host-validated captain speech surfaced
through the host's presentation seam, cligent `CaptainContext.emitReply`
(DR-029). Because no prose returns to the machine and no presentation
field is injected, the host's own `callCaptain` implementation is that seam:
it already holds the `CaptainResult` of the call it just served, and it
identifies which call that is from the paired `captain.call.started` boundary
the runtime emits before invoking the port, whose identity carries the
invoking `stateId` and `sourceItem` (§Playbook trace). No prose therefore
needs a return path through the machine, and none exists.
The visible-call `question`/`response` injection rule above and
the `{ visibility: 'visible', resume: false }` workflow-call selection
(§PlaybookPorts contract, §Captain prompt composition) stay the
visible-presentation shape for non-controller playbooks.

The adjudicator shall fail loudly on:

- A guard the state does not declare,
- A missing payload field the state's `result` description requires,
- An empty / malformed response.

These cases shall remain distinguishable in the thrown error: malformed JSON
recovery shall identify the missing JSON object, an unknown selection shall
identify an undeclared guard, and an incomplete selection shall identify the
missing required field. A generic “no declared guard selected” error for all
three cases is nonconformant.

Adjudicator failures are control-plane errors.
The runtime shall propagate them by throwing out of `handleBossInput` after attempting cleanup.
The host adapter surfaces the throw on its control-plane channel (cligent surfaces such throws as `runtime_error` per [TMUX-025](https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-025)).
The host's player-result channels (`player_finished` and equivalents) are reserved for failures the player itself produced; the host emits them when `callPlayer` resolves with `status !== 'ok'`.
Direct-Captain host-result failures stay on the Captain actor boundary and
shall not be reported as player failures; they follow the recoverable FSM
failure path specified above. Captain transport, result-shape, trace-sink, and
adjudication failures remain control-plane errors unless the transport failure
is causally identical to the active abort signal.
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
An `AbortError`-named transport, validation, or trace-sink failure is still a
non-abort control error unless it is causally identical to the applicable
signal reason. Error names shall never change original-error or first-latch
precedence.
When a host port or structured-result validator fails after a call-start
boundary, latch that original error before attempting the required finish
trace. If the finish sink records the event and then rejects, do not emit a
second finish and do not let the sink failure replace the earlier control
error returned by the public boundary; retain the sink failure only as
independent cleanup evidence.

## Script execution

Where the FSM declares the typed `script` actor from
[gears2fsm "Setup"](gears2fsm.md#setup), a factory-backed linked runtime shall
provide its implementation through the shared factory (§Output); the linker
shall not regenerate a script executor inside a factory-backed emitted module.
A script invocation is the one actor kind that runs without any agent:
it makes no `callPlayer`, `callCaptain`, or `callJudge` call and needs no
adjudication.

The provided actor shall:

- Execute `input.command` verbatim through the platform's POSIX shell
  (`sh -c`), with the working directory taken from the emitted
  `PlaybookRuntimeOptions.cwd` when the caller supplies it, else the process
  working directory. The linker shall declare the optional `cwd` option on the
  emitted options interface whenever the FSM contains a script state; the
  validated option reaches the shared script actor through the spec.
- Resolve deterministically from the child's exit status: status zero resolves
  `{ guard: <first declared guard>, exitStatus: 0 }`; any nonzero status
  resolves the second declared guard with that status. Guard selection is
  mechanical; the runtime shall not route script output through the judge.
- Reject when the command cannot be spawned at all, routing through the
  state's ordinary `onError` path. Beyond spawn failure, the invocation
  rejects only per the abort bullet below or when one of its own script
  emissions rejects; a completed command's exit status itself never rejects.
- Honor the active turn's abort signal per §Abort: the actor shall reject
  without spawning when the combined signal is already aborted; shall run the
  shell detached as its own process-group leader; and on abort — whenever it
  lands before the invocation settles, including only after the shell's own
  exit — shall deliver
  `SIGTERM` to the entire group, escalate to `SIGKILL` after a bounded grace,
  and settle only after the shell process itself has exited and the group has
  stopped being signalable, confirmed by an `ESRCH` liveness probe, rejecting
  with the signal's reason. The same
  bounded grace caps the post-`SIGKILL` wait for kernel teardown, so an
  unreaped member outside the runtime's control cannot stall settlement. If
  the group remains signalable through that bound, or confirmation fails
  without `ESRCH`, the boundary rejects with a distinct teardown control error
  rather than reporting a clean abort over unconfirmed cleanup. The kill is
  always posted before the actor settles. Abort ownership — the
  listener and its escalation — spans the whole invocation, not the
  spawn-to-exit window
  ([DR-036](../specs/decisions/036-coherent-abort-settlement.md)). An abort
  observed only after the shell's exit shall additionally reject before guard
  resolution and before starting any script emission not already in flight; an
  emission already started when the abort lands completes through the
  ordinary serialized channel and the rejection follows it. A
  descendant that leaves the process group is beyond the runtime's kill
  scope.
- Emit, after the child settles and before the invocation resolves, one status
  line `Executed script for <stateId> (exit <status>).` and one telemetry
  event under topic `playbook.script` with payload
  `{ stateId, sourceItem, exitStatus }`, through the ordinary serialized
  emission channel.

Script execution emits no `*.call.*` trace pair: the surrounding FSM
transition trace and the `playbook.script` telemetry are its record, so trace
schema consumers see no new event types.
Script stdout and stderr are not workflow data: the runtime shall not place
them in machine context, prompts, or trace payloads.

## Nested playbook bridge

Where the FSM declares the typed `playbook` actor from
[gears2fsm](gears2fsm.md#nested-playbook-calls), the linked runtime shall provide
it with the shared `createNestedPlaybookBridge(...).actorLogic` — wired by the
shared factory per §Output — and shall not regenerate a second pending-call,
identity-validation, or abort-cleanup substrate inside each linked artifact.
Instantiate the generic bridge with the FSM-exported `PlaybookInput` type so
XState `.provide(...)` receives the exact declared actor input rather than a
structurally similar local type.
Construct one bridge per runtime and wire every integration hook: allocate ids
with `nextCallId`; return the currently active public-boundary signal from
`getBoundarySignal`; capture an immutable cancellation classifier for the
invocation's signal identities; compose `resumePlaybookCall.signal` into that
classifier through `bindResumeSignal`; pass the applicable classifier through
`emitStarted`, `emitFinished`, and `drain`; bind it to the root transition
caused by child settlement through `bindActorSettlement`; and pass it through
`onControlPlaneError` and `onBackgroundError`. Each receiving latch shall drop
only a failure the supplied classifier identifies as exact cancellation and
shall retain every distinct cleanup or observer failure for the owning public
boundary, the next drain, or disposal rejection as applicable. A stored
distinct failure shall never be reclassified against a later boundary. The
runtime shall not leave these optional API hooks unwired merely because their
TypeScript properties are optional for simpler bridge consumers.
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
The pending record shall also retain the call-start `turnId`. A resumed finish
and every parent transition, Captain reassessment, and status caused by that
return shall use this retained id, not an absent or newly allocated
current-turn value. The finish callback shall receive or close over that stored
id rather than read a mutable global turn id at resume time.
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
The optional output field may be absent from an otherwise valid successful
child result. Generated event and trace descriptors shall omit an absent or
`undefined` output instead of attempting to snapshot it as a JSON value.
When cancellation wins while the host's opening promise is still pending, the
shared bridge shall retain and drain that exact promise before emitting the
matching finish boundary. It shall ignore an abort-reason rejection from that
opening promise, surface any other late rejection as a control-plane cleanup
failure, and recover a child session identity from a late resolved start when
available. Generated runtimes shall pass the host port directly to the shared
bridge rather than recreate this opening-promise drainage locally.
In particular, aborting a public turn during that opening promise shall abort
the combined bridge signal, wait for opening cleanup and the paired finish,
let the promise actor reach its `onError` quiescent state, and only then return
an aborted run result. It shall neither hang waiting for a child-resume path
that was never registered nor return while the opening promise or finish
emission remains live.
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
If registered child abort cleanup rejects with a failure distinct from every
applicable abort reason, the bridge shall emit the paired finish with an error
result and reject `abortPending` or disposal with that original cleanup error,
or with an aggregate containing every distinct failure when more than one
remains;
an exact abort-reason rejection is cancellation evidence and shall not be
retained as a control failure. Parent disposal shall still drain, emit its one
`session.disposed` boundary, and clear the bound session before rejecting with
any preserved distinct cleanup error.
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
  Disposal requested during initialization shall retain one teardown promise,
  wait for initialization's success or failure cleanup, and emit at most one
  `session.disposed` boundary. Disposal before initialization is terminal and
  coalesced: later initialization rejects and every later disposal call
  returns the first retained promise.
  Represent in-flight initialization with a cleanup-complete latch resolved by
  `init`'s outer `finally`, after either successful startup or the complete
  failed-start cleanup. Do not expose the fallible inner startup promise as
  that latch: it rejects before the outer cleanup and lets concurrent disposal
  race the cleanup's own `session.disposed` attempt.
  Put session validation and snapshotting, bridge/actor construction, initial
  state reads, and startup emissions inside that guarded outer `try`; none may
  throw before the cleanup-complete latch's `finally` can resolve. A rejected
  session identity must not leave later disposal waiting forever.
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
  Its transition `event` field shall be a detached JSON-safe descriptor, never
  the raw XState inspection event. Preserve the string `type` (or use
  `unknown` when absent); copy only declared Boss-union payload fields and a
  validated actor `output`, and normalize an `error` member before inclusion.
  Omit `input`, `actorId`, system/ref data, and every other XState-internal
  field even when it happens to be JSON-safe, so `xstate.init.input` cannot
  leak the host catalog into transition telemetry. In particular, do not call
  `snapshotJsonValue(event)` on an `xstate.error.actor.*` event that contains a
  raw `Error`.
  Construct the actor without starting it, read its public initial snapshot,
  emit and drain `session.started`, and only then call `actor.start()`. The
  initial inspection-driven transition/status emissions shall not precede the
  session-start trace. Have any actor-construction helper return the actor and
  assign it at the call site; TypeScript does not narrow a captured optional
  actor variable from assignment hidden inside a helper. Retain a non-optional
  local actor reference across terminal reconstruction and event sending.
  An actor-construction helper may read the already-bound immutable session
  directly for machine input such as `session.playbookId`, but it shall not
  call a lifecycle assertion that also requires the actor to exist. The actor
  does not exist until that helper returns, so coupling session access to actor
  availability makes every valid `init` fail before construction completes.
  Generated code shall pass the repository's full strict `tsc` build with no
  unused helper or destructured parameter, not only a transpile-only or
  target-local syntax check.
  For the default Captain runtime, the initial quiescent `ready` snapshot may
  emit the ordinary structured transition trace and telemetry, but it is not a
  Boss-relevant transition and shall emit no human status. Any initial
  transition-trace or telemetry sink failure is part of `init`: initialization
  shall reject, stop the actor, and perform the failed-start cleanup below
  rather than swallowing it as a later background error.
  A root-actor error observed during startup — an initial entry action or a
  synchronously failing initial invocation — is equally part of `init` and
  `restore`: the boundary shall reject with that original error after the
  failed-start cleanup, and shall never resolve leaving the errored actor as
  later background state
  ([DR-036](../specs/decisions/036-coherent-abort-settlement.md)).
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
  2. Map `turn.text` through the Boss-event mapping, using deterministic exact
     entry where applicable and classification otherwise.
     If mapping produces no event, return after draining any port emissions.
     If the classifier port rejects, emit and drain the Boss-settled error
     boundary, send no event, leave the actor unchanged (including a terminal
     actor), and reject the original error. If that rejection is caused by the
     active Boss abort signal, return and trace the same structured `aborted`
     result instead of tracing `no-action`. If the port resolves but its reply
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
     bridge. For `script`, use §Script execution — no port call and no
     adjudication. Parallel regions may run distinct resolved players independently;
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
  for the parent continuation caused by that return.
  A resume whose signal is already aborted after identity and result
  validation shall deliver nothing: bind no resume signal, settle no deferred,
  emit no call finish, and preserve the pending call — the boundary settles
  `{ outcome: 'aborted' }` with the signal's reason while the suspended state
  and pending identity survive, so a later resume with the same call id and a
  fresh signal still delivers
  ([DR-036](../specs/decisions/036-coherent-abort-settlement.md)). Every success and
  exceptional path shall drain ordered emissions, select the first latched
  non-abort control error before considering abort, and clear its boundary
  latches in `finally`, so a failed resume cannot leak an emission error into a
  later turn.
  A resume is not a Boss-input turn and shall emit neither
  `boss.input.received` nor `boss.input.settled`; the structured result is the
  method return. Reusing the originating turn id on the child finish and
  continuation emissions does not create a second Boss trace pair.
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
  `session.disposed`. Use cleanup/finally structure so a bridge or emission
  failure cannot skip the parent disposal boundary or leave the runtime bound.

The actor's `lastError` field shall be surfaced via `emitStatus` when the machine enters its `failed` state.
Presence of linker-emitted `roleStates` selects the canonical factory-backed status profile.
That profile shall emit the selected Boss event type
before sending that event, exactly `→ <guard>` (with no payload-count or tally
rider) when a settling actor output carries a guard, and
`⤷ <Role>: <label>` only when the entered state appears in the linked module's `roleStates` metadata.
It shall emit no raw state-id fallback for any other state.
`roleStates` shall be a complete map of the FSM states
that invoke the typed `player` actor; each schema-2 value carries the exact
local role from that state's source-derived `meta.playbook.role` and the state's exact FSM description as `{ role, label }`.
The factory shall reject an
incomplete entry, a non-player state, or a role or label that differs from the FSM metadata.
Artifact schema `1` and a missing compatibility declaration
shall reject before interpretation because their legacy `player` values may
encode bindings or aliases rather than canonical local roles.
For the default Captain runtime, an initial `ready` state and a terminal `done`
state shall not emit human status. The terminal response is already visible
Captain prose; a synthetic “entered done” message would present it twice.
Structured transition trace and telemetry still apply to both states.
Every provided actor boundary shall first drain the queued state-entry
transition/status/telemetry caused by entering its working leaf, so a call's
`*.started` trace cannot overtake the transition that explains it. Every public
runtime method shall drain that queue before it resolves or rejects.
This initial `await drain()` is required inside each provided `fromPromise`
body: XState may begin that body before publishing the root snapshot, and the
await yields so the synchronous inspection callback can enqueue the entering
transition first.

If a `*.call.started` trace records and then its sink rejects, no host call may
begin. The runtime shall still enqueue exactly one synthetic paired
`*.call.finished` trace — with `status: 'error'`, or `status: 'aborted'` when
the sink rejection is causally identical to the applicable signal reason, in
which case nothing is latched and the turn follows abort settlement
([DR-036](../specs/decisions/036-coherent-abort-settlement.md)) — preserving
the original call
id, turn id, actor visibility, state/source identity, and prompt or request
metadata from the start boundary. A distinct rejection shall then follow the
same latched
control-error, FSM settlement, and ordered-drain path as any other call-start
failure; the synthetic finish must not replace the original sink error.

## Parked-session snapshot (optional)

A linked runtime may implement the optional durable-session capability of
`@sublang/playbook/runtime` — `exportSnapshot()` and
`restore(session, snapshot)` — so a host can persist a parked session and
rehydrate it in a later process (DR-014). A runtime that implements either
member shall implement both. When generated for a runtime whose host needs
durability, the pair shall behave as follows.

`exportSnapshot()` shall return `undefined` unless the runtime is at a safe
capture point: initialized, not disposing or disposed, no active
`handleBossInput`/`resumePlaybookCall` boundary, and the root actor at a
quiescent state with actor status `active`.
At a safe capture point it shall return a JSON-safe
`PlaybookRuntimeSnapshot` carrying:

- `schemaVersion`: literal `3`.
- `playbookId`: the bound session's playbook id.
- `machine`: the root actor's `getPersistedSnapshot()` result, passed
  through the shared JSON detachment with any raw `Error` context value
  (for example FSM `lastError`) normalized to `{ name, message, stack? }`
  first. The value is opaque to hosts.
- `roleResumeTokens`: the local-role resume-token projection as a plain object
  (§PlaybookPorts contract).
- `sequences`: the live `trace`, `turn`, `judgeCall`, `playerCall`, and
  `playbookCall` counters, plus `captainCall` when the runtime supports direct
  Captain calls.
  A direct-Captain-capable runtime shall persist it in every schema-version-3 export.
- `state`: the current normalized state descriptor.
- `pendingBossQuestions`: the pending Boss question(s) from FSM context as
  a list of `{ questionId, asker, question, sourceItem? }`, where `asker` is
  `{ kind: 'captain' }` or `{ kind: 'role', roleId }`, empty when the
  parked state awaits no reply. This list exists so hosts can surface the
  question without parsing status lines or telemetry.
- `suspendedCall`: omitted when no nested call is pending; otherwise the
  shared nested bridge's complete `callId`, source `stateId`, target
  `playbookId`, exact handed-off `text`, and `childSessionId`, enriched with
  the call-to-turn map's optional `turnId`.

A pending nested call is exportable only when the bridge's pending identity
and complete descriptor agree and the call-to-turn map owns that exact call
id, including ownership whose value is absent. A bridge descriptor that
already carries a turn id shall equal that map value. Any missing or
inconsistent bridge, descriptor, or turn-ownership record makes the capture
unsafe and returns `undefined`.

`restore(session, snapshot)` is an alternative to `init` under the same
lifecycle guards (§Session lifecycle): it shall reject when already
initialized, disposing, or disposed, and shall validate
schema version `3` and that `snapshot.playbookId` equals `session.playbookId` before touching state.
Runtime snapshot schemas `1` and `2` shall reject before state binding because their token and pending-question fields conflate local roles, concrete players, and Captain identity.
The host supplies the same immutable `PlaybookSession` identity the
snapshot was exported under and recreates the runtime through the same
factory with equivalent options; the runtime does not diff options, and
module identity — that the factory constructing this runtime still
belongs to the snapshot's playbook — is likewise the host's check to
make before calling `restore`.
`restore` shall bind the session and its current detached role bindings, restore the local-role token projection, the
sequence counters, and the
prior-state descriptor from the snapshot,
prepare the shared nested bridge with the suspended-call descriptor or its
explicit absence, restore a descriptor's call-to-turn map entry, construct
the actor with the persisted `machine` snapshot, and start it
with root inspection emissions suppressed so rehydration emits no
`session.started` trace, no transition trace, and no human status — the
session already started, and the next public boundary continues the
contiguous trace sequence. After start, the runtime shall normalize the
actual actor state with the prepared suspended call as its pending identity
and require it to equal the detached persisted state exactly, including
active status. It shall drain suppressed startup work and invoke the bridge's
`confirmRestore` as the final fallible restore step, publishing the pending
identity only after every other validation succeeds. A missing, extra, or
mismatched reconstructed invocation, an actual/persisted state mismatch, or
any other failed validation shall fail `restore` through the same
failed-start cleanup path as `init`, rolling back provisional bridge and turn
ownership without a child-host call or duplicate start/finish boundary.
A restore failure shall leave the runtime unbound so `dispose` remains
callable and terminal.

## Retained-generation classification (optional)

A linked runtime may expose the optional read-only
`retainedGenerationMetadata` marker of `@sublang/playbook/runtime` together
with the parked-session snapshot pair so a Captain can retain its safe
pre-terminal generations. Its `unfinishedFinalStateIds` array shall preserve
the artifact's link-time declaration exactly, including an explicitly empty
set, and shall be immutable and detached from that declaration. Absence means
the runtime contributes no retained generation; presence supplies only
terminal classification metadata and no snapshot-adoption operation.
Every runtime the shared `createXStatePlaybookRuntime` factory constructs from
a supplied `unfinishedFinalStateIds` spec member shall expose the marker; a
bespoke runtime opts in only by implementing the public member itself.

## Control surface (optional)

A linked runtime may implement the optional control-surface capability of
`@sublang/playbook/runtime` — `describe()` and `apply(...)` — so a host can
observe the parked machine and execute a runtime-advertised recovery or jump
action without fabricating an FSM event (DR-029). A runtime that
implements either member shall implement both; every runtime the shared
`createXStatePlaybookRuntime` factory constructs implements the pair. A
runtime lacking the pair advertises no actions, and plain text delivery is
the only verb against it. Presence is feature-detected like the
parked-session snapshot capability; the pair changes no runtime ABI and no
artifact or snapshot schema.

```typescript
interface PlaybookControlAction {
  id: string;      // stable within the returned view
  label: string;   // runtime-written, Boss-appropriate
}

interface PlaybookControlView {
  state: PlaybookState;
  stateDescription?: string;  // runtime-published meaning of the current state
  context?: JsonValue;   // the runtime's authored projection, sanitized
  pendingQuestions: readonly PlaybookPendingBossQuestion[];
  lastError?: NormalizedError;
  actions: readonly PlaybookControlAction[];
}

type PlaybookControlReceipt =
  | { disposition: 'rejected'; reason: string }          // before any effect
  | { disposition: 'executed'; run: PlaybookRunResult }
  | { disposition: 'failed'; error: NormalizedError };   // effects may exist

// Optional PlaybookRuntime members — both or neither:
describe?(): PlaybookControlView;
apply?(input: { actionId: string; key: string; signal: AbortSignal }): Promise<PlaybookControlReceipt>;
```

`describe()` shall be side-effect free — it emits no trace, status, or
telemetry and moves no machine state — and is valid at parked quiescence
outside an active `handleBossInput`/`resumePlaybookCall`/`apply` boundary;
during an active boundary, before `init`, or after disposal begins it shall
throw. The view carries the current normalized state descriptor, the state
description defined below, the authored context projection defined below, the
pending Boss questions with their stable ids, the last recorded error in
normalized form, and the currently valid actions.

`stateDescription` is the runtime's own Boss-facing statement of what its
current state means, taken from the same source state descriptions the action
labels below are written from. A controller host has no other grounding for a
status answer, and an internal state id is not text a reply may repeat, so the
runtime publishes the meaning rather than leaving the host to substitute the
identifier for it. A state whose source declares no description carries no
`stateDescription`: an id is never promoted into a description, so a host is
never handed an identifier dressed as meaning.

The view's `context` is an explicit projection the linked runtime **authors**,
never an allow-by-default serialization of the FSM context (PBRT-52).
Only the runtime knows which of its context members are safe and relevant
for a controller prompt, while the host receiving the view cannot inspect an
opaque blob for the player rosters, option values, and raw player output its
own prompts must exclude; exporting by default makes the two obligations
unsatisfiable together and gives every member added to an FSM later the wrong
default. The rules:

- The emitted module declares the projection in its `spec` as
  `controlContextFields` — the FSM context member names its view exposes, in
  the order it names them — and the factory exports those and nothing else.
- A runtime naming no member carries no `context` at all, so a member is
  private until an artifact names it and extending an FSM leaks nothing by
  omission.
- Sanitization sits on top of the projection, not in place of it: a named
  member is still normalized (raw `Error` values normalized) and dropped when
  it cannot be made JSON-safe, rather than thrown, since `describe` stays
  side-effect free and total.
- The two members the view surfaces first-class — the pending Boss question
  and the last error — cannot be named. A projection naming either is a
  construction error, failing runtime construction rather than being silently
  ignored.
- The host still composes its own prompt block from the projection rather than
  pasting the projection in, so no runtime's exported value can forge a block
  into an envelope the host owns.

Actions derive from the live snapshot, only at the same safe point the
parked-session snapshot uses (actor status `active`, quiescent, no pending
nested call); anywhere else `actions` is empty while the rest of the view
still describes the state. Two families exist, labeled from source state
descriptions:

- **Failure-state retry** — while the singular state id is the recoverable
  failure state and the live snapshot accepts the retry event sourced below,
  the runtime shall advertise `retry:<EVENT_TYPE>` replaying exactly that
  event. Where the emitted module's entry-event declaration names the FSM
  context member the machine's entry action copies the exact Boss text into
  (DR-034), the retry event is that deterministic entry event built from the
  live snapshot's member — excluded when the member is absent, not a string,
  or blank, and never falling back to the record. Where it names no member,
  the retry event is the recorded last classified event (the event a public
  Boss boundary sent that drove the run into `failed`, kept with its recorded
  payload), and there is none while the runtime holds none. The member is
  declared, never inferred from a context member that happens to match the
  entry event's text field.
- **Jump entries** — for each registered resumable state id whose
  explicit-state-jump event (`BOSS_INTERRUPT` with that `targetId`, optional
  textual fields omitted) the live snapshot accepts, guards included, the
  runtime shall advertise `jump:<stateId>`.

A candidate whose event requires a payload the runtime cannot source from
recorded state shall be excluded from `actions` — `apply` never invents free
text and never enters Boss-input classification. A candidate whose *label*
could only be an identifier is excluded on the same terms: a label never falls
back to a target id or to the replayed event type, because a controller host
names an executed or refused action by its label and never by its id, so an
identifier used as a label defeats that substitution. A jump whose target
publishes no description is therefore not advertised — borrowing another
state's description would name the wrong state — and a retry falls back from
its target's description to its own source state's, and is not advertised when
neither exists.

`apply({ actionId, key, signal })` shall revalidate the action against the
live state and settle `{ disposition: 'rejected', reason }` with no effect
when it is no longer advertised. It shall execute an accepted action at most
once per idempotency `key`: the receipt is recorded at acceptance, before
the settlement emissions, and a repeated key returns the recorded receipt
verbatim with no revalidation, no execution, and no new trace pair within the
runtime instance.
Only accepted receipts (`executed` or `failed`) are recorded and final for
their key. A rejection settles before acceptance and records nothing under
its key — a later call with that key revalidates afresh, traces its own
pair, and may execute once the action is advertised — and a key whose call
threw before reaching acceptance (lifecycle misuse, invalid input, a
pre-acceptance abort, a rejected start-boundary sink) likewise records
nothing, so a later call with that key may execute. Executing sends the
validated event through the same actor drive as `handleBossInput` — state
transitions, player/judge boundaries, statuses, and traces flow unchanged —
and settles `executed` with the projected run result, or `failed` with the
normalized error when the run settles in the failure state, aborts, or a
post-acceptance control-plane error lands (effects may exist). `signal`
follows §Abort exactly as a Boss-turn signal does; an abort after acceptance
settles the `failed` receipt rather than rejecting. The boundary traces as
the paired `apply.started` / `apply.finished` events of §Playbook trace, and
`apply` shares the single active-boundary sentinel with `handleBossInput`
and `resumePlaybookCall`.

Acceptance is also the line past which `apply` does not throw, and
publication — the `apply.finished` emission — is the line past which its
receipt no longer changes. A settlement failure after acceptance but before
publication (a rejecting emission drain) settles the `failed` receipt carrying
its normalized error, replacing the one recorded at acceptance so the finish
trace, the returned receipt, and any replay of the key report one settlement.
A settlement failure at or after publication (a rejecting `apply.finished`
sink) does not: the disposition is already emitted, so no rewrite can make the
trace and the return agree, and a receipt states what happened to the effect
rather than what happened to its telemetry. The published receipt stands, is
returned and replayed verbatim, and the delivery failure travels on the
runtime's emission-failure channel to surface from the next public boundary
that drains — unless the delivery failure is causally identical to the apply
signal's own abort reason, in which case it evidences the cancellation and is
dropped, not latched
([DR-036](../specs/decisions/036-coherent-abort-settlement.md)).

The recorded receipts and the recorded last classified event are
process-local: the durable runtime snapshot persists neither. A restored
runtime therefore advertises the retry of a declared entry-event source
immediately — that payload rides the persisted machine snapshot — while a
module declaring no source advertises a retry again only after its next
classified event.

## Abort

`handleBossInput.signal` is the abort surface.
The runtime shall honor it at every `callPlayer`/`callCaptain`/`callJudge` and
at every poll between transitions.
Each provided Captain, player, judge, or nested-playbook boundary shall receive
a signal combined from its XState invocation-lifetime signal and the currently
active `handleBossInput` or `resumePlaybookCall` signal (for example with
the shared `combineAbortSignals`). Classify a rejection as cancellation by its
causal identity with the applicable signal reason, not by an `AbortError` name
or by observing only that the signal is also aborted. Signals may carry an
ordinary `Error`, while a distinct transport or sink failure that occurs after
abort remains a non-abort control error and takes precedence. Classification
lives at each latch or report site, against the boundary signal applicable
there — the invocation-lifetime combined signal, and during a resume that
boundary's own signal — so a failure causally identical to the applicable
reason is the cancellation's own evidence: it is handled there under the phase
rules below, never mislabeled as a distinct failure and never carried to an
unrelated later boundary
([DR-036](../specs/decisions/036-coherent-abort-settlement.md)).
A failure already latched as distinct retains that ownership; a later drain
shall not reinterpret it against another boundary whose abort signal happens
to use the same object as its reason.
A public boundary settles on the machine's state at its quiescence point,
in this precedence: a suspended pending call, then a distinct actor error,
then terminal completion, then a coincident abort, then the recoverable
failure state — a completed machine settles `terminal` even when the signal
also aborted, because an `aborted` settlement over a terminal machine hides
work the next turn would silently restart.
An abort observed after the outcome is computed does not rewrite it, and a
settlement-channel rejection causally identical to the abort reason is
forgiven, so the returned result and the settlement trace state one fact.
A boundary entered with an already-aborted signal delivers nothing.
That entry refusal precedes the ordinary settlement order: a pre-aborted
resume reports `aborted` while preserving its suspended pending call rather
than reporting `suspended` for work it did not deliver.
Cancellation-coupled channel rejections obey this phase matrix:

- **Before a host call or effect starts (and before apply acceptance):** an
  identical start-channel rejection starts no host call or effect and latches
  no control error. A recorded start receives one best-effort `aborted` finish.
  An ordinary run boundary then settles by the precedence above; a
  pre-acceptance `apply` instead rejects with that exact reason, records no
  receipt, and leaves its key reusable.
- **After a host call or effect starts but before its finish or outcome is
  recorded:** an identical host, cleanup, observer, or in-flight-emission
  rejection is cancellation evidence. Invocation-owned cleanup completes, a
  started trace pair receives one `aborted` finish, and the ordinary boundary
  settles by the precedence above. A distinct rejection remains a control
  failure, produces the applicable error finish, and takes distinct-error
  precedence.
- **After a call finish is recorded but before the enclosing non-apply outcome
  is computed:** an identical finish-sink or drain rejection leaves the
  recorded finish unchanged, emits no corrective second finish, latches
  nothing, and lets the enclosing boundary settle by the precedence above.
- **After apply acceptance but before receipt publication:** every settlement
  failure, the exact apply abort reason included, is folded into the current
  `failed` receipt. Acceptance forbids throwing; the replacement receipt is
  published, returned, and replayed, and the failure is not carried as a later
  delivery error.
- **After a non-apply outcome is computed or an apply receipt is published:**
  an identical rejection is dropped without rewriting the outcome or receipt
  and without poisoning a later boundary. A distinct non-apply settlement
  rejection retains current-boundary control-error precedence; a distinct
  post-publication apply rejection retains the published receipt and travels
  on the delivery-failure channel to the next boundary that drains.
On abort, the
runtime shall not merely race the imperative
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
  Do not reduce this payload to the current state: `from` and `previousState`
  are the authoritative prior descriptor, while `to` and `state` are the new
  descriptor. On the first observed transition, use the initialized state as
  both the prior and new descriptor when no earlier transition exists.
  Snapshot and recursively freeze the complete described telemetry payload
  independently from the state retained as `previousState`, so an observer
  cannot mutate a later transition's authoritative `from` state.
  Observers consume telemetry; the runtime never interprets the topic.

Player prompts and adjudicator JSON may additionally ride the host's own record channels when the host has them (cligent's `captain_*` / `player_*`).
The `playbook.trace` copies are the host-agnostic runtime-boundary record required by §Playbook trace.

## Output

The link compiler emits one TypeScript module per playbook.
Every linked artifact shall emit an `unfinishedFinalStateIds` set beside its resumable-state registry as mechanical link-time metadata.
The set shall contain exactly the stable ids of root `type: 'final'` states whose terminal outcomes leave the procedure unfinished, and shall be explicitly empty when no terminal outcome does.
The linker shall not infer the set from a state description, opaque output, or procedure prose.
The linker shall reject a declared id that does not name a root final state, and the shared factory shall independently reject it at construction before runtime effects.
For a factory-backed artifact the set is a `spec` member; a bespoke artifact shall retain equivalent linked metadata, and the artifact declaration is not itself the public runtime retention marker or an adoption capability.
For an FSM that declares no `type: 'parallel'` state — necessarily flat
under [gears2fsm.md](gears2fsm.md)'s one-state-per-item mapping — it shall
emit the thin shared-factory module defined below.
For an FSM that declares a parallel state, it shall emit bespoke linked
machinery satisfying this document's runtime contract and shall not invoke
`createXStatePlaybookRuntime`, whose supported domain is flat single-region
FSMs under [DR-019](../specs/decisions/019-shared-linked-runtime-factory.md).
The FSM-interpreter machinery — actor wiring, boundary tracing, Boss-event
mapping, adjudication, script execution, nested-playbook bridging, session
lifecycle, abort handling, and the optional parked-session snapshot
capability — is not regenerated for a factory-backed artifact: it ships once
as the shared `createXStatePlaybookRuntime(machine, spec)` factory exported by
`@sublang/playbook/xstate-runtime`, and the emitted module hands its FSM and
a small per-playbook `spec` to that factory. Every behavioral section of
this definition still binds the emitted module's runtime; the shared factory
is how the emitted module satisfies them, so a runtime fix ships as a
package release instead of a re-link of every artifact.

The thin emitted module:

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
- Imports `createXStatePlaybookRuntime` (plus any shared strategy defaults
  its `_internal` surface re-exports) from the shared engine module through
  its bare package specifier `@sublang/playbook/xstate-runtime`, and the
  contract types through `@sublang/playbook/runtime`. It shall not copy,
  inline, or re-derive interpreter machinery — actor bridges, trace
  emission, judge-JSON recovery, lifecycle guards — beside the factory
  call, and shall not import `xstate`, `p-queue`, or `node:child_process`
  itself; those are the shared engine's dependencies.
- Declares and exports the typed `PlaybookRuntimeOptions` interface for that
  playbook, derived from every required FSM input field that is not supplied
  by `PlaybookSession` or another linker-owned source (§PlaybookRuntime
  contract), plus the optional `cwd` option whenever the FSM contains a
  `script` state (§Script execution).
- Supplies the spec's `snapshotOptions` with the same options-validation
  semantics previously generated inline: validate and JSON-snapshot the
  caller's options, rejecting undeclared keys and non-conforming values, so
  the factory binds an immutable options record before constructing any
  actor.
- Supplies in `spec` only what the factory cannot read from the FSM
  artifact's own data: the deterministic textual entry event where
  §Boss-event mapping prescribes deterministic entry, naming with it the FSM
  context member that event's own transition action copies the exact Boss
  text into wherever the machine keeps one, so the failure-state retry of
  §Control surface survives a restore; compact `bossEvents`
  metadata for each additional Boss-union arm whose exact required/optional
  judge fields, runtime-owned text fields, or closed string values disappear
  under TypeScript erasure; `placeholderFields` only for authored token/field
  exceptions not covered by the canonical kebab-token-to-camel-field mapping
  and the canonical `<#>` → `irNumber` special case; the
  transition-event payload fields the FSM's Boss union declares; the
  complete `roleStates` status map derived from every FSM state that invokes
  the typed `player` actor, with each `role` copied from that state's
  source-derived `meta.playbook.role` (an empty map when there is no such
  state); the
  `verbatimPayloadFields` set derived from annotated result fields above; the
  explicitly empty or populated `unfinishedFinalStateIds` set declared above;
  the `controlContextFields` projection of §Control surface; and any
  per-playbook strategy override (classifier, prompt composers,
  required-field extraction, status formatting) an earlier section of this
  definition requires for that playbook.
  `controlContextFields` is authored, not derived: the linker names the FSM
  context members the playbook's controller view exposes and no others, in the
  order the view should render them, omitting the member entirely where the
  playbook exposes no context. It is the one spec member whose default is
  *nothing* rather than everything — the factory exports no context for a
  module that supplies none — so a module emitted without it advertises a
  playbook with no Boss-visible context rather than one whose whole FSM
  context is Boss-visible. The linker shall not name a member the view
  surfaces first-class (the pending Boss question, the last error), which is a
  construction error, and shall not name a member carrying a resolved player
  roster, an option value, or player-authored text, which a controller host's
  prompts are required to exclude or to fence. The metadata shall keep the shared
  classifier's reply contract exactly flat `{ type, ...declaredFields }` and
  distinguish judge-authored routing fields from exact-text fields the
  runtime attaches itself. Everything else — player/script/captain/nested actor
  provisioning, prompt composition, classification, adjudication, statuses,
  resumable-state derivation — comes from the factory's generic defaults,
  which implement the behavioral sections of this definition.

  ```ts
  interface XStateBossEventFieldSpec {
    source: 'judge' | 'text';
    required?: boolean;
    values?: readonly string[];
  }

  interface XStateBossEventSpec {
    type: string;
    fields?: Readonly<Record<string, XStateBossEventFieldSpec>>;
  }

  interface XStateRoleStateStatus {
    role: string;
    label: string;
  }

  bossEvents?: readonly XStateBossEventSpec[];
  roleStates?: Readonly<Record<string, XStateRoleStateStatus>>;
  placeholderFields?: Readonly<Record<string, string>>;
  ```

  Supplied `bossEvents` metadata shall merge with, and shall not replace or
  weaken, runtime-derived entry text ownership or closed interrupt targets.
  A conflicting duplicate field contract is a linker/runtime construction
  error.
  `NO_ACTION` and `BOSS_REPLY` are runtime-owned event types the factory
  supplies itself — `NO_ACTION` as exactly `{ type: 'NO_ACTION' }`, and
  `BOSS_REPLY` as an optional judge-selected `questionId` plus the exact-text
  `answer` the runtime attaches. `bossEvents` shall carry no entry for either
  type; supplying one is a construction error, so a linker that judges a
  runtime-owned arm to have lost payload detail under erasure shall report
  that gap rather than emit the entry.
- Supplies `spec.compat` with the compatibility values current at link time:
  `{ artifactSchema, runtimeAbi }`, where `artifactSchema` is `2` — the
  schema number of the local-role thin-module format this §Output defines — and
  `runtimeAbi` is the installed shared engine's `RUNTIME_ABI` self-report.
  The linker shall verify that the installed engine lists the emitted
  schema in `SUPPORTED_ARTIFACT_SCHEMAS` and treat its absence as a
  link-time error; it shall not stamp a different member (such as the
  highest) merely because that engine also supports a newer artifact
  format — the declaration names the format of the emitted module, not
  the capability of the emitting engine. The factory checks the
  declaration against the engine instance that actually loads the emitted
  module and fails construction on a mismatch, so an artifact linked under
  one engine cannot run silently skewed under another. Modules emitted
  before this contract carry no `compat` member and shall reject before interpretation.
- Requires the containing public registry manifest to advertise the same `artifactSchema: 2`; the Captain host shall reject a missing or disagreeing registry value before constructing this runtime, and a bespoke runtime profile shall advertise the same schema without claiming this shared factory's `runtimeAbi`.
- Default-exports the factory call as `createPlaybookRuntime`, typed
  `PlaybookRuntimeFactory<PlaybookRuntimeOptions>`. A registry module loads
  dynamically inside the host's caught boundary, so its eager module-scope
  factory call fails fast there. The compiled session Captain module is the
  exception: the shell and both CLI front ends import it statically, so it
  shall defer its factory call to the first runtime request — an eager call
  would turn a future `spec.compat` rejection into an uncaught module-load
  error that takes even `--help` down, instead of the caught
  host-construction boundary's setup diagnostic.
- Exposes, under an `_internal` export, the pure helpers verification
  needs — at least the prompt composers its own machine uses, which may
  re-export the shared defaults when the spec does not override composition —
  so compilation-correctness tests can exercise composition without a host.
  A playbook that calls players exposes `composePlayerPrompt`; a playbook
  whose states make direct-Captain calls exposes `composeCaptainPrompt`. A
  controller playbook that calls no players exposes no player composer:
  there is no composition to verify, and a stub under that name would
  describe work the module cannot do. `_internal` is not a public API — the
  leading underscore says so — and nothing in it is semver-stable; a helper
  a host is meant to call is a top-level export and is governed as one.
- Holds no host-specific types and no host primitive calls. The runtime
  speaks only `PlaybookPorts` for every agent and host concern; the
  `node:child_process` dependency of §Script execution lives in the shared
  factory, not in the emitted module.
- Records the linker inputs (FSM path and strategies) in a
  top-of-file header comment so the file is reproducible from the same
  inputs.
- Sources the contract types (`PlayerResult`, `PlayerCallOptions`,
  `PlayerSessionStore`,
  `CaptainResult`, `CaptainCallOptions`, `PlaybookPorts`, `PlaybookSession`,
  `PlaybookTraceEvent`,
  `PlaybookCallRequest`, `PlaybookCallResult`, `PlaybookCallStart`,
  `PlaybookStateValue`, `PlaybookState`, `PlaybookRunResult`,
  `PlaybookRuntime`, `PlaybookRuntimeFactory`) from the single shared
  type-only module instead of redefining them, and re-exports the names
  its consumers import, so every linked playbook shares one contract
  definition. The shared modules import no FSM or host types, so the
  dependency runs one way — from each linked module to the shared
  engine and contract, never the reverse.

Both output profiles remain subject to the behavioral sections above and the
verification requirements below.

When a co-located integration test for the linked runtime already exists, the
link compiler shall run it before reporting success and treat any failure as a
generation failure. It shall not delete, skip, or weaken that suite to make a
new artifact pass; the suite is executable evidence for lifecycle, ordering,
error-propagation, and host-boundary requirements that static artifact checks
cannot establish.

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
- Trace persistence, multiple Boss-selected root engagements, recursive
  playbook calls, multi-Boss orchestration, or visualizer rendering —
  separate hosts/observers may add them without changing this spec. A host
  may persist the emitted trace, but the runtime does not rehydrate a
  disposed actor from it. Parked-session durability is in scope only
  through the optional snapshot surface of §Parked-session snapshot
  (DR-014); everything beyond it remains out of scope.

New behavior in any of these areas requires a separate slc spec.

## References

[1]: text2gears.md "First phase: text → GEARS spec items."
[2]: gears2fsm.md "Second phase: GEARS items → FSM artifact."
[3]: https://stately.ai/docs/actors "XState actors — `createActor`, snapshots, abort signal handling."
[4]: https://github.com/sindresorhus/p-queue#readme "p-queue concurrency and AbortSignal support."
