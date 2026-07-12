<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Captain

This is the default generic Captain playbook.
It has no players beyond Boss and Captain.

At runtime Captain receives the original Boss intent and a catalog of enabled callable playbooks.
Each catalog entry contains only a stable playbook id, its command, and its intent.
The catalog is immutable host input for the session; Boss events and Captain decisions cannot replace it.
Captain shall call only ids in that catalog and shall never call this Captain playbook itself.
Captain shall keep a finite ordered plan and issue at most one child call at a time.
`remainingPlan` shall contain only calls after the selected next call; every continuation shall strictly reduce its length.
After Captain consumes an answer to its own routing or reassessment question,
that question and answer are no longer pending before Captain calls a child or
completes.

The host guarantees that this Captain receives Boss input only while it is the active leaf and resumes only from a matching child return.
That guarantee is an execution precondition, not a behavior for Captain to perform and not a source item to compile.

When Boss gives a new intent while Captain is the active playbook, Captain shall decide whether to handle it directly, ask Boss one routing question, or select the first call in a one- or multi-playbook plan, using the following prompt:
> Boss intent: <boss-intent>
> Enabled playbooks: <enabled-playbooks>
> Preserve Boss's intended outcome and constraints.
> Prefer a matching specialized playbook when delegation materially improves execution; otherwise handle the intent directly.
> Ask exactly one concise question only when its answer would materially change routing or call order.
> For a complex intent, divide it into the smallest finite ordered plan of useful playbook calls.
> Put only calls after the selected first call in remainingPlan.
> Do not call a playbook merely to restate or classify the intent.
> Select exactly one next enabled playbook by stable id and give it complete standalone input containing only the context it needs.
> Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.

A fresh directive that interrupts any parked Captain work shall restart this
routing behavior with that fresh intent. It shall not jump directly into
reassessment or retain the prior question, answer, plan, call history,
evidence, selection, response, or error.

A direct decision shall carry a concise JSON-safe `response` and complete.
A question decision shall carry one concise `question` and wait for Boss without losing the original intent.
Boss's answer resumes this same routing decision with continuation context; it is not a separate Captain behavior.
A delegation decision shall carry a finite `remainingPlan` plus non-empty `nextPlaybookId` and `nextPlaybookInput` for its first call.
The compiled routing result guards are exactly `direct`, `question`, and
`delegation`, respectively; these names are part of this default playbook's
stable machine contract.

When Captain selects a next call with a non-empty `nextPlaybookId` from the enabled catalog, Captain shall call playbook selected by `nextPlaybookId`:
> <nextPlaybookInput>

When the called playbook returns successfully, aborts, or fails, Captain shall reassess the original intent, remaining plan, and completed call results using the following prompt:
> Boss intent: <boss-intent>
> Enabled playbooks: <enabled-playbooks>
> Remaining plan: <remaining-plan>
> Completed call results: <completed-call-results>
> Preserve Boss's intended outcome and constraints.
> Treat each returned result as evidence and revise the remaining plan when needed.
> A continuing decision must strictly reduce the remaining plan length.
> Do not repeat an equivalent failed or completed call without new information.
> If the intent is fulfilled, give Boss one concise final response.
> If information from Boss is now necessary, ask exactly one concise question.
> Otherwise select exactly one next enabled playbook by stable id and give it complete standalone input containing only the context it needs.
> Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.

For the machine's deterministic safety floor, two calls are the same only when
both the stable target id and complete standalone input match exactly.
Captain shall record that exact pair before invoking the child, so an `ok`,
`aborted`, or `error` return all prevent the same later attempt. An input
revised with new information is different for this exact check; Captain still
owns the broader semantic no-repeat instruction above.

Each completed call result shall contain only the selected playbook id, its `ok`, `aborted`, or `error` status, and either the child's actual JSON-safe output or a compact error with only `name` and `message`.
It shall never retain or expose a child session id, call id, child state, stack trace, or an opaque runtime result object.

A final decision shall carry a concise JSON-safe `response` and complete.
A follow-up question shall carry one concise `question` and wait for Boss without losing the original intent, plan, or completed results.
Boss's answer resumes this same reassessment with continuation context; it is not a separate Captain behavior.
A continuing decision shall carry a strictly shorter finite `remainingPlan` plus non-empty `nextPlaybookId` and `nextPlaybookInput`.
The compiled reassessment result guards are exactly `final`,
`followUpQuestion`, and `continuing`, respectively; these names are part of
this default playbook's stable machine contract.
A child abort or failure is a completed call result for reassessment and shall not route this playbook directly to its generic failure state.
