<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-025: Resilient Captain control adjudication

## Status

Accepted.
[DR-029](029-session-scoped-conversational-captain.md) extends §One corrective re-ask to the interactive decision call and supersedes §Internal-root failure resets the shell: disposal-on-failure is replaced by the conversation reseed — the stack and completed work survive, and only the model-side conversation is replaced.
§Explicit shared adjudication reply contract stands: `defaultBuildCaptainJudgePrompt` stays exported and reused.

## Context

A first-time user's conversational opening (`hello, what can you do?`) produced a correct visible routing reply from the compiled default Captain, then aborted the turn with `adjudicator selected undeclared guard undefined` and left every later `/code` selection refused with an already-running message [[1]].

The compiled Captain's private adjudication prompt asks the judge to "Return one JSON object with exactly one declared guard", which a judge can satisfy with `{"question": …}` and no `guard` key.
The shared engine's direct-Captain adjudication prompt already states the explicit `{ guard, …structuralPayloadFields }` reply shape, but that builder is module-private and its wording is pinned by no test, so the hand-maintained artifact shipped a weaker paraphrase unnoticed.
Every maintained suite scripts well-formed judge replies, so no test exercises whether the prompt reliably elicits a `guard` key from a real model, and the opt-in real-agent acceptance flow only drives task-shaped first turns.

A malformed control reply latches as a control-plane error and the boundary rejects; the shell then leaves the parentless internal Captain frame on the stack, where it blocks every differently named registered command although it holds no recoverable work.
The surfaced diagnostics expose internal adjudication vocabulary to the Boss and offer no next step.

`ROUTING_RESULTS` already declares a `question` outcome, so a conversational reply needs no new guard — only a contract the judge reliably follows, plus a recovery path when control replies stay malformed.

## Decision

### Explicit shared adjudication reply contract

The engine's direct-Captain judge-prompt builder shall be exported as `defaultBuildCaptainJudgePrompt` on `@sublang/playbook/xstate-runtime` and shall remain the single statement of the reply contract: the fenced visible Captain output, the backticked declared result keys with descriptions, and the instruction to pick exactly one outcome by `guard` and return JSON `{ guard, …structuralPayloadFields }` with no `question` or `response`.
The compiled default Captain runtime shall compose its `captain-output-adjudication` prompts through that exported builder instead of a private paraphrase.

### One corrective re-ask on a malformed control reply

When an adjudication reply fails structural validation — no recoverable JSON object, a missing or undeclared `guard`, an undeclared field, or a missing or malformed required structural field — the compiled default Captain runtime shall issue exactly one corrective judge call that appends the rejection reason and the restated reply shape to the same prompt, then adjudicate the second reply.
A second malformed reply shall keep the existing semantics: the control error latches and the machine parks in its recoverable `failed` state.
A rejected or aborted judge transport call shall not trigger the corrective re-ask.
Each judge call, initial or corrective, shall trace its own paired `judge.call.started` / `judge.call.finished` boundaries.

### Internal-root failure resets the shell

Where the parentless internal Captain frame's delivered boundary call rejects, the shell shall dispose the complete stack under a `failure` disposal reason and return to idle `chat`, so the next Boss message or registered command engages cleanly.
The rethrown boundary error shall carry Boss-appropriate prose naming a concrete next step, shall contain no internal control vocabulary (such as `adjudicator`, `guard`, or hidden control JSON), and shall preserve the original diagnostic as its `cause`; the raw diagnostic remains on the trace telemetry channel.
A parentless external root's rejected turn shall retain the frame for later Boss recovery and propagate its boundary error unchanged, because a delivered external engagement may hold recoverable work.

## Consequences

- A conversational first message now settles as the Captain's declared routing `question` outcome; the happy path no longer depends on a judge inferring an implicit reply shape.
- The exported builder is an additive, semver-minor engine surface; the generic factory keeps its single-call adjudication, and adopting the corrective re-ask there needs its own decision.
- One extra hidden judge call occurs only when a control reply is malformed.
- Boss-facing failure prose and hidden control diagnostics gain distinct contracts at the shell boundary, extending DR-013's control/presentation separation to the failure path.
- The adjudication prompt contract and the re-ask are pinned by integration tests, closing the coverage gap that let the paraphrase drift ship.

## References

[1]: https://github.com/sublang-ai/playbook/issues/13 "Issue #13 — conversational first turn crashes and poisons the session"
