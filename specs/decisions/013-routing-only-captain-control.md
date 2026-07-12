<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-013: Routing-only Captain control

## Status

Accepted.

## Context

The default Captain's initial policy permits direct handling and gives a coding agent its normal project tools.
In an observed `playbook-dev` run, Captain investigated a code-review intent itself, chose the direct terminal arm, and ended the runtime without calling a specialized playbook.

The ready-state classifier also paraphrases Boss text before the compiled Captain sees it.
Generated acting prompts expose guard names and result-property instructions, and hidden adjudication may replace the human prose that Boss already saw.
Those behaviors blur routing, execution, machine control, and presentation even though the XState machine correctly completes its selected terminal transition.

## Decision

### Initial Captain is a router

The initial Captain decision shall have only two outcomes: ask one material routing question or call one enabled playbook.
It shall have no direct-to-terminal outcome.
Captain shall decide from the exact Boss text and the sanitized playbook catalog without investigating the task, inspecting the workspace, using tools, or attempting the specialized work.
If the available evidence cannot select a useful route, Captain shall ask the smallest question whose answer can do so.

After a child result, Captain may finish with a concrete Boss response, ask a material follow-up question, or call the next playbook.
A final response shall communicate the result or actionable conclusion and shall not merely acknowledge the turn or announce completion.

### Exact input provenance

An ordinary intent received by an idle shell shall enter the internal Captain runtime as the exact Boss text without model classification or rewriting.
When classification is required for an engaged or parked runtime, a classifier may choose only an event kind and routing metadata.
The host shall attach the exact original Boss text to the selected event and shall ignore classifier-authored copies or paraphrases.

### Control and presentation separation

Guard names, result property names, and other machine-control schema shall be generated from explicit source metadata outside acting-agent blockquotes.
They shall not appear in a visible Captain prompt.
The visible Captain call shall produce only concise human routing, question, or final prose.

A hidden adjudicator may select a declared guard and structural plan fields, but it shall not author the visible `question` or terminal `response`.
For those outcomes, the runtime shall use the exact final text captured from the corresponding visible Captain call.

### Isolated control calls

Every visible routing or reassessment call and its hidden adjudication call in the default Captain runtime shall start a fresh agent conversation with an explicit empty tool allowlist.
The host shall serialize those calls through its Captain lane while the XState runtime remains the sole owner of workflow memory.
An adapter that cannot enforce an explicit empty tool allowlist shall fail closed instead of silently exposing tools.

Fresh conversation and tool isolation do not replace the authored evidence boundary.
The Captain prompt shall explicitly limit its decision evidence to the supplied Boss text, catalog, plan, and child results as applicable.

## Consequences

- Initial Captain turns always clarify or delegate; they cannot terminate by doing the work themselves.
- Exact Boss wording remains authoritative across routing and resume boundaries.
- XState continues to own wait, child-call, reassessment, and terminal control flow.
- Human-visible prose and hidden machine control have distinct contracts.
- Cligent adapters must honor or reject explicit tool isolation consistently.
- The maintained Captain source, SLC definitions, generated artifacts, and shell integration require coordinated changes without a package release.
