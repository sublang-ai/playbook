<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-013: Routing-only Captain control

## Status

Accepted.
Amends [DR-012](012-default-captain-playbook.md).
Amended by [DR-029](029-session-scoped-conversational-captain.md).

## Context

The default Captain's initial policy permitted direct handling and gave a coding agent its normal project tools.
In an observed `playbook-dev` run, Captain investigated a code-review intent itself, chose the direct terminal arm, and ended the runtime without calling a specialized playbook.

The ready-state classifier also paraphrased Boss text before the compiled Captain saw it.
Generated acting prompts exposed guard names and result-property instructions, and hidden adjudication could replace the human prose that Boss already saw.
Those behaviors blur routing, execution, machine control, and presentation even though the XState machine correctly completes its selected terminal transition.

Cligent's Codex, Kimi, and OpenCode adapters reject any `allowedTools` or `disallowedTools` value — including the empty list used to express tool-free — because their provider surfaces expose no enforced tool-registry restriction, so requesting an empty allowlist from them fails every control call.

## Decision

### Captain is a router

Captain shall decide from the exact Boss text, the session conversation, and the sanitized playbook catalog without investigating the task, inspecting the workspace, using tools, or attempting the specialized work.
It selects only from the closed action set of [DR-029](029-session-scoped-conversational-captain.md) or replies; it never ends a request by doing the work itself.
If the available evidence cannot select a useful route, Captain shall ask the smallest question whose answer can do so.
A reply after a result shall communicate the result or actionable conclusion and shall not merely acknowledge the turn or announce completion.

### Exact input provenance

Every Boss turn shall reach the session Captain as the exact Boss text without model classification or rewriting.
When classification is required for an engaged or parked runtime, a classifier may choose only an event kind and routing metadata.
The host shall attach the exact original Boss text to the selected event and shall ignore classifier-authored copies or paraphrases.

### Control and presentation separation

Guard names, result property names, and other machine-control schema shall be generated from explicit source metadata outside acting-agent blockquotes.
They shall not appear in a prompt that produces Boss-visible prose.
Captain's human prose reaches Boss as host-validated Captain speech; a hidden adjudicator may select a declared guard and structural fields, but it shall not author that prose.

### Tool-free control calls

Every Captain control call shall carry an explicit empty tool allowlist and run through the host's Captain lane, while the XState runtime remains the sole owner of workflow memory.
Session-Captain calls resume its durable conversation ([DR-029](029-session-scoped-conversational-captain.md)); every sub-runtime judge call starts a fresh conversation with no resume token.
An adapter that cannot enforce an explicit empty tool allowlist shall fail closed, except as follows:

- Where the host knows the Captain agent's adapter has no provider-enforced tool-restriction surface, it shall omit `allowedTools` rather than send an empty list.
- Isolation for such an adapter degrades to the authored prompt-level restriction — the hidden-judge envelope that forbids tool use, delimits the runtime prompt, and refuses instructions found inside quoted actor output — a documented reduction in enforcement, not an equivalence.
- Where the host cannot determine the adapter, it shall keep requesting the empty allowlist and fail closed.

Adapter capability is host knowledge, not runtime knowledge: linked runtimes keep emitting the same `CaptainCallOptions`, and each host resolves the substitution for the Captain agent it owns.
When Cligent publishes discoverable tool-restriction capability metadata, a host shall consult it instead of a maintained adapter list.

Conversation and tool isolation do not replace the authored evidence boundary.
The Captain prompt shall explicitly limit its decision evidence to the supplied Boss text, conversation, catalog, and action results as applicable.

## Consequences

- Captain turns clarify, reply, or delegate; they never terminate by doing the work themselves.
- Exact Boss wording remains authoritative across routing and resume boundaries.
- XState continues to own wait, child-call, and terminal control flow.
- Human-visible prose and hidden machine control have distinct contracts.
- Adapters without enforced tool restriction run control calls under prompt-level isolation rather than failing every turn.
