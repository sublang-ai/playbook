<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-008: Built-in Playbook Captain shell

## Status

Accepted.
The hand-authored chat, selection, and hidden-router policy portions of this record are superseded by [DR-012](012-default-captain-playbook.md).
The registry, host-adapter, one-Captain-session, lifecycle, visibility, and in-playbook event-authority constraints remain in force where later decisions have not amended them.
[DR-029](029-session-scoped-conversational-captain.md) supersedes, for the interactive shell, §3's and §9's residual prohibitions on pre-classified events and action surfaces: runtime-advertised actions now flow through the runtime-owned `describe`/`apply` pair, while the shell still fabricates no FSM event itself.
DR-029 also restores §4's one-durable-Captain-conversation intent — sub-runtime judge calls now stay fresh and isolated instead of sharing it — and amends §5: the deferred `getSnapshot()` arrives as `describe()`, with telemetry mirroring staying for the shell ledger.

## Context

[DR-004](004-link-code-fsm-to-playbook-runtime.md) links the CODE FSM into a host-agnostic `PlaybookRuntime`.
That runtime is currently adapted directly as the tmux-play Captain, so CODE is both the whole Boss-facing Captain and the runnable playbook.

The runtime contract already reserves slash-prefixed `/command` input for host-level or playbook-selection UX before a turn reaches `handleBossInput` ([slc/link.md "Boss-event mapping"](../../slc/link.md#boss-event-mapping), [[playbook-runtime-1](../packages/playbook-runtime.md#playbook-runtime-1)]).
Inside a playbook runtime, slash-prefixed text is ordinary Boss text classified by the playbook's own judge.
The reserved selection layer has not yet existed in this repo.

The desired surface is a built-in Captain that can chat with Boss, select a sub-playbook by an explicit command such as `/code`, infer a suitable sub-playbook from ordinary intent, and return to chat when the sub-playbook parks, finishes, or fails.
When a player asks Boss a question or the workflow fails, Boss should be able to chat with Captain and then continue the same sub-playbook context.

This requires one Captain-facing session across visible chat, hidden routing, and sub-playbook judge calls, while preserving [DR-007](007-hidden-judge-captain-pane.md)'s rule that control-plane JSON does not stream to the Boss pane.
It also must not teach the outer shell to classify in-playbook events, since [slc/link.md](../../slc/link.md) assigns that authority to each playbook runtime's Boss-event classifier.

## Decision

### 1. Add a built-in Captain shell over registered sub-runtimes

Introduce a built-in Playbook Captain shell as the tmux-play Captain.
The shell owns Boss chat, playbook selection, a small Captain FSM, and a registry of compiled `PlaybookRuntime` factories.
The shell FSM is built-in and hand-authored, not generated through `text2gears` / `gears2fsm`.
Its "player" is the Captain agent itself and its states are meta-level routing and engagement modes, which do not fit the playbook source player model.

The first registry entry is CODE:

| Field | Value |
| --- | --- |
| `id` | `code` |
| `command` | `code` |
| `intent` | software development / SDLC coding workflow |
| `idleStateId` | `ready` |
| `finalStateId` | `done` |
| `createRuntime` | `createCodePlaybookRuntime` |
| `validateOptions` | CODE `captain.options.code` validator |

DR-011 later retires the lifecycle state-id fields in favor of
structured run outcomes and XState descriptor tags.

The CODE source, GEARS, FSM, and linked runtime behavior stay unchanged for the first implementation.
The shell treats CODE as a sub-runtime session, not as an XState child state.

Runtime-level composition is chosen over one large XState tree because a linked playbook's quiescent states (`ready`, `failed`, `awaitBossReply`, and `done` for CODE) are return-to-Boss states, not `invoke` completion states.
Embedding the CODE machine directly would require the shell to reimplement the linker drive loop, Boss-event classifier, adjudicator, and port contract.

### 2. Captain FSM shape

The shell FSM shall model durable Boss-facing modes:

| State | Meaning |
| --- | --- |
| `chat` | No active sub-runtime is engaged. |
| `engaged.driving` | A Boss turn is in flight inside the active sub-runtime. |
| `engaged.parked` | A sub-runtime is engaged and quiescent, waiting for the next Boss turn. |

The shell context is a bounded control ledger:

- active playbook id;
- latest sub-runtime state id;
- pending Boss question, when telemetry carries one;
- normalized last error, when telemetry carries one;
- last route decision.

The ledger carries deterministic control state only.
It shall not duplicate the full Boss conversation; the Captain LLM session carries conversation history.

The shell parks the active sub-runtime when it returns at its idle state, `failed`, or `awaitBossReply`.
The shell disposes the active sub-runtime when it reaches its final state or Boss explicitly dismisses the engagement.
Only one engagement is supported in the first design.
[DR-011](011-composable-playbook-execution.md) preserves one
Boss-selected root engagement but supersedes the one-runtime limit with
a LIFO stack of nested child sessions.

### 3. Turn routing

Turn routing has three tiers.

1. Registered command parsing.
2. Hidden Captain router call.
3. The selected sub-runtime's own Boss-event classifier.

Only registered commands have deterministic slash semantics.
`/code <text>` engages CODE and forwards `<text>` as ordinary Boss text to CODE.
Bare `/code` engages CODE and lets Captain ask Boss for the task.
Any unregistered slash-prefixed input falls through as ordinary Boss text to the hidden router.
This avoids a second negative command namespace and preserves the runtime rule that slash-prefixed text is ordinary text once it reaches a playbook.

While a sub-runtime is already engaged, an explicit command for that same playbook shall route the command remainder to the existing sub-runtime and shall not reset, dispose, or reconstruct it.
A bare command for the already engaged playbook shall surface a clarification or status response and shall not reset the sub-runtime.
A different registered command while a sub-runtime is engaged shall not dispatch immediately in the first design; the shell shall ask Boss to finish, dismiss, or otherwise resolve the current engagement first.

The hidden router call shall receive the bounded ledger plus the registry's command list and intent descriptions.
It shall return exactly one closed control decision: `chat`, `dispatch`, `sub`, or `dismiss`.
`dispatch` shall carry the target playbook id and text to pass to that playbook; `sub` shall carry text for the active sub-runtime.
Near-miss command-like input should be handled as chat clarification rather than as a low-confidence dispatch.

When the router chooses a sub-runtime, the shell shall call that runtime's `handleBossInput` with text, not a pre-classified FSM event.
The shell shall not validate or choose `BOSS_INTERRUPT` targets, and the registry shall not expose jumpable states to the shell.
In-playbook events remain the sub-runtime classifier's authority.

### 4. Shared Captain session and prompt envelopes

The tmux-play adapter shall use one underlying Captain LLM session for:

- visible Boss chat;
- hidden router calls;
- hidden sub-runtime `callJudge` calls for classification and adjudication.

cligent documents the `context.callCaptain` primitive for custom Captains [[1]] and `Cligent` resume-token continuity across runs [[2]].
This DR additionally requires tmux-play to use those properties together as one continuous Captain session across shell chat, routing, and sub-runtime judge calls.
If upstream cligent specs do not yet pin that combined behavior, the implementing work shall add or verify the upstream contract before relying on it.

Hidden control calls shall pass `{ visibility: 'hidden' }` to `callCaptain`.
They shall also use a prompt envelope that identifies the call as hidden control work and asks for control JSON only.

Visible Boss-chat calls shall use a separate prompt envelope that allows normal conversation and forbids exposing hidden control JSON.
Visibility hides records from the Boss pane; prompt envelopes protect the model behavior in the shared session.

### 5. Mirror sub-runtime state from telemetry

The shell shall mirror the active sub-runtime's state from the `playbook.fsm.state` telemetry emitted through the shell's wrapped `PlaybookPorts`.
[[playbook-runtime-11](../packages/playbook-runtime.md#playbook-runtime-11)] requires `handleBossInput` to return only after quiescence and after draining emissions.
[[playbook-runtime-14](../packages/playbook-runtime.md#playbook-runtime-14)] requires ordered transition telemetry, failure error data, and `awaitBossReply` question data.
Those contracts are sufficient for the first shell implementation.

A new `getSnapshot()` method on `PlaybookRuntime` is deferred.
It may be added later if telemetry mirroring proves insufficient, but it is not part of the first contract.

### 6. Configuration and compatibility

The `playbook-code` composer shall point composed configs at the new Captain shell adapter with CODE registered.
CODE options remain under `captain.options.code`; the CODE registry entry owns validation and passes validated values to the CODE runtime.

The public `./code/tmux-play` package export shall remain available as a compatibility shim.
That shim shall delegate to the same Captain shell with CODE registered, not preserve a separate direct-CODE Boss surface.
This preserves explicit `--config <path>` users and published import specifiers while keeping one behavior.

The existing `playbook-code` executable remains the user entry point for this design.
A generic `playbook` executable is deferred until multi-playbook discovery and enablement are specified.

### 7. Shell status and telemetry

The shell shall pass sub-runtime `emitStatus` and `emitTelemetry` calls through to the host after mirroring any telemetry fields it needs for the bounded ledger.
This preserves the engaged playbook's existing Boss-visible status and observer contract.

The shell shall not emit its own FSM transitions on the `playbook.fsm.state` topic used by sub-runtimes.
Its own FSM telemetry shall use a distinct topic such as `playbook.captain.fsm.state`, or an implementing spec shall choose an equivalent discriminator that prevents observers from conflating shell and sub-runtime states.

Boss-visible shell engagement lines are part of the implementing CAPTAIN user/dev specs.
Those specs shall cover engagement, dismiss, and final-disposal status without changing the sub-runtime glyph vocabulary.

### 8. Contract amendments for implementation

The implementing specs shall reconcile this DR with released CODE runtime and launcher items.

- [[playbook-runtime-1](../packages/playbook-runtime.md#playbook-runtime-1)] and [[playbook-runtime-2](../packages/playbook-runtime.md#playbook-runtime-2)] shall be scoped to Boss turns that reach an engaged CODE runtime.
- [[playbook-runtime-15](../packages/playbook-runtime.md#playbook-runtime-15)] and [[playbook-runtime-16](../packages/playbook-runtime.md#playbook-runtime-16)] shall be amended so the tmux-play `captain.from` target is the Playbook Captain shell, which constructs registered sub-runtimes and wires their `PlaybookPorts`.
- [[playbook-runtime-30](../packages/playbook-runtime.md#playbook-runtime-30)] shall be amended so CODE option validation is owned by the CODE registry entry rather than by a direct CODE tmux adapter.
- [[playbook-runtime-29](../packages/playbook-runtime.md#playbook-runtime-29)] and the now-retired
  PBCODE-16 launcher contract shall be amended so the composer-injected
  `captain.from` value points at the Playbook Captain shell adapter.
- [[playbook-runtime-12](../packages/playbook-runtime.md#playbook-runtime-12)] remains a CODE runtime contract for direct runtime use; the Captain shell normally disposes final sub-runtime engagements instead of sending another Boss turn into a final sub-runtime.

### 9. Out of scope

- Multiple independently Boss-selected parked root engagements.
  Nested child sessions within one root are added by DR-011.
- A generic `playbook` binary.
- A new `PlaybookRuntime.getSnapshot()` API.
- A shell API that injects pre-classified sub-runtime events such as `handleBossEvent`.
- Exposing jumpable state lists to the shell.
- Changing CODE source, GEARS, FSM, or linked runtime behavior for the first implementation.

## Consequences

- The reserved slash-selection layer becomes real without reintroducing in-playbook slash commands.
- Captain can chat with Boss before, between, and after sub-runtime turns.
- Failure and Boss-question recovery reuse existing `BOSS_INTERRUPT` and `BOSS_REPLY` machinery inside CODE.
- The shell keeps deterministic control state from telemetry while using the shared Captain session for conversational continuity.
- Hidden control JSON stays out of the Boss pane and out of visible chat behavior by combining hidden visibility with prompt envelopes.
- The authority split stays clear: Captain selects sub-playbooks; sub-playbooks classify their own FSM events.
- The first implementation can be additive around compiled CODE artifacts.
- Compatibility configs that import `./code/tmux-play` keep working through a delegating shim.

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/docs/tmux-play.md#custom-captains "cligent tmux-play custom Captains"
[2]: https://github.com/sublang-ai/cligent/blob/main/docs/guide.md#session-continuity "cligent session continuity"
