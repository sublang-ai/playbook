<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Captain GEARS

### CAPTAIN-1

While this Captain playbook is the active playbook, when Boss gives a new intent, Captain shall decide whether to handle it directly, ask Boss one routing question, or select the first call in a one- or multi-playbook plan:

> Boss intent: <boss-intent>
> Enabled playbooks: <enabled-playbooks>
> Preserve Boss's intended outcome and constraints.
> Treat the enabled-playbooks catalog as immutable host input containing only each enabled callable playbook's stable id, command, and intent.
> Prefer a matching specialized playbook when delegation materially improves execution; otherwise handle the intent directly.
> Ask exactly one concise question only when its answer would materially change routing or call order.
> For a complex intent, divide it into the smallest finite ordered plan of useful playbook calls.
> Put only calls after the selected first call in remainingPlan.
> Keep the plan finite and ordered, and issue at most one child call at a time.
> Do not call a playbook merely to restate or classify the intent.
> Call only stable ids in the enabled-playbooks catalog, and never call this Captain playbook itself.
> Select exactly one next enabled playbook by stable id and give it complete standalone input containing only the context it needs.
> Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.
> A direct decision shall carry a concise JSON-safe response and complete.
> A question decision shall carry one concise question and wait for Boss without losing the original intent.
> A delegation decision shall carry a finite remainingPlan plus non-empty nextPlaybookId and nextPlaybookInput for its first call.

### CAPTAIN-2

Where `nextPlaybookId` is a non-empty stable id in the immutable enabled-playbooks catalog and does not identify this Captain playbook, when Captain selects a next call, Captain shall call playbook selected by `nextPlaybookId`:

> <nextPlaybookInput>

### CAPTAIN-3

While this Captain playbook resumes from the matching child return, when the called playbook returns successfully, aborts, or fails, Captain shall reassess the original intent, remaining plan, and completed call results:

> Boss intent: <boss-intent>
> Enabled playbooks: <enabled-playbooks>
> Remaining plan: <remaining-plan>
> Completed call results: <completed-call-results>
> Preserve Boss's intended outcome and constraints.
> Treat the enabled-playbooks catalog as immutable host input containing only each enabled callable playbook's stable id, command, and intent.
> Treat each returned result as evidence and revise the remaining plan when needed.
> A continuing decision must strictly reduce the remaining plan length.
> Each completed call result shall contain only the selected playbook id, its ok, aborted, or error status, and either the child's actual JSON-safe output or a compact error with only name and message.
> Never retain or expose a child session id, call id, child state, stack trace, or an opaque runtime result object.
> Treat a child abort or failure as a completed call result for reassessment; do not route this playbook directly to its generic failure state.
> Do not repeat an equivalent failed or completed call without new information.
> Keep the plan finite and ordered, and issue at most one child call at a time.
> If the intent is fulfilled, give Boss one concise final response.
> If information from Boss is now necessary, ask exactly one concise question.
> Otherwise select exactly one next enabled playbook by stable id and give it complete standalone input containing only the context it needs.
> Call only stable ids in the enabled-playbooks catalog, and never call this Captain playbook itself.
> Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.
> A final decision shall carry a concise JSON-safe response and complete.
> A follow-up question shall carry one concise question and wait for Boss without losing the original intent, plan, or completed results.
> A continuing decision shall carry a strictly shorter finite remainingPlan plus non-empty nextPlaybookId and nextPlaybookInput.
