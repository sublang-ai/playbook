<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Captain GEARS

### CAPTAIN-1

When Boss gives a new intent while Captain is the active playbook, or a fresh directive interrupts any parked Captain work, and Captain has the original Boss intent and the immutable host catalog of enabled callable playbooks whose entries each contain only a stable playbook id, its command, and its intent, Captain shall decide whether to handle it directly, ask Boss one routing question, or select the first call in a one- or multi-playbook plan:

> Boss intent: <boss-intent>
> Enabled playbooks: <enabled-playbooks>
> Preserve Boss's intended outcome and constraints.
> Treat the enabled-playbooks catalog as immutable host input for the session; Boss events and Captain decisions cannot replace it.
> Each enabled-playbooks catalog entry contains only a stable playbook id, its command, and its intent.
> Prefer a matching specialized playbook when delegation materially improves execution; otherwise handle the intent directly.
> Ask exactly one concise question only when its answer would materially change routing or call order.
> For a complex intent, divide it into the smallest finite ordered plan of useful playbook calls.
> Keep the plan finite and ordered, and issue at most one child call at a time.
> Put only calls after the selected first call in remainingPlan.
> Every continuation must strictly reduce the length of remainingPlan.
> Do not call a playbook merely to restate or classify the intent.
> Select exactly one next enabled playbook by stable id and give it complete standalone input containing only the context it needs.
> Call only ids in the enabled-playbooks catalog and never call this Captain playbook itself.
> Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.
> On a fresh directive that interrupts parked Captain work, restart this routing behavior with the fresh intent; do not jump directly into reassessment or retain the prior question, answer, plan, call history, evidence, selection, response, or error.
> A direct decision must carry a concise JSON-safe response and complete; its result guard is exactly direct.
> A question decision must carry one concise question and wait for Boss without losing the original intent; its result guard is exactly question.
> Boss's answer resumes this same routing decision with continuation context, not a separate behavior.
> After consuming the answer to the routing question, the question and answer are no longer pending before calling a child or completing.
> A delegation decision must carry a finite remainingPlan plus non-empty nextPlaybookId and nextPlaybookInput for its first call; its result guard is exactly delegation.

### CAPTAIN-2

When Captain selects a next call whose `nextPlaybookId` is a non-empty stable id in the immutable enabled-playbooks catalog, is not this Captain playbook, and whose finite ordered `remainingPlan` contains only calls after the selected call and will strictly shrink on every continuation, Captain shall call playbook selected by `nextPlaybookId`:

> <nextPlaybookInput>

### CAPTAIN-3

When the matching called playbook returns successfully, aborts, or fails while this Captain is the active leaf, and Captain has the original Boss intent, the immutable host catalog of enabled callable playbooks whose entries each contain only a stable playbook id, its command, and its intent, a finite ordered remaining plan containing only calls after the selected call, and completed call results, Captain shall reassess the original intent, remaining plan, and completed call results:

> Boss intent: <boss-intent>
> Enabled playbooks: <enabled-playbooks>
> Remaining plan: <remaining-plan>
> Completed call results: <completed-call-results>
> Preserve Boss's intended outcome and constraints.
> Treat the enabled-playbooks catalog as immutable host input for the session; Boss events and Captain decisions cannot replace it.
> Each enabled-playbooks catalog entry contains only a stable playbook id, its command, and its intent.
> Treat each returned result as evidence and revise the remaining plan when needed.
> Keep the plan finite and ordered, and issue at most one child call at a time.
> A continuing decision must strictly reduce the remaining plan length, and its remainingPlan must contain only calls after the selected next call.
> Do not repeat an equivalent failed or completed call without new information.
> For the deterministic safety floor, two calls are the same only when both the stable target id and complete standalone input match exactly.
> Record that exact stable-target-id and complete-standalone-input pair before invoking the child, so an ok, aborted, or error return prevents the same later attempt.
> Input revised with new information is different for this exact check; still apply the broader semantic no-repeat requirement.
> Each completed call result must contain only the selected playbook id, its ok, aborted, or error status, and either the child's actual JSON-safe output or a compact error containing only name and message.
> Never retain or expose a child session id, call id, child state, stack trace, or opaque runtime result object.
> If the intent is fulfilled, give Boss one concise final response.
> If information from Boss is now necessary, ask exactly one concise question.
> Otherwise select exactly one next enabled playbook by stable id and give it complete standalone input containing only the context it needs.
> Call only ids in the enabled-playbooks catalog and never call this Captain playbook itself.
> Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.
> A final decision must carry a concise JSON-safe response and complete; its result guard is exactly final.
> A follow-up question must carry one concise question and wait for Boss without losing the original intent, plan, or completed results; its result guard is exactly followUpQuestion.
> Boss's answer resumes this same reassessment with continuation context, not a separate behavior.
> After consuming the answer to the reassessment question, the question and answer are no longer pending before calling a child or completing.
> A continuing decision must carry a strictly shorter finite remainingPlan plus non-empty nextPlaybookId and nextPlaybookInput; its result guard is exactly continuing.
> Treat a child abort or failure as a completed call result for reassessment; do not route this playbook directly to its generic failure state.
