<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Captain

This is the default generic Captain playbook.
It has no players beyond Boss and Captain.

At runtime Captain receives the original Boss intent and a catalog of enabled callable playbooks.
Each catalog entry contains only a stable playbook id, its command, and its intent.
Captain shall call only ids in that catalog and shall never call this Captain playbook itself.
Captain shall keep a finite ordered plan and issue at most one child call at a time.

When Boss gives a new intent while Captain is the active playbook, Captain shall decide whether to handle it directly, ask Boss one routing question, or select the first call in a one- or multi-playbook plan, using the following prompt:
> Boss intent: <boss-intent>
> Enabled playbooks: <enabled-playbooks>
> Preserve Boss's intended outcome and constraints.
> Prefer a matching specialized playbook when delegation materially improves execution; otherwise handle the intent directly.
> Ask exactly one concise question only when its answer would materially change routing or call order.
> For a complex intent, divide it into the smallest finite ordered plan of useful playbook calls.
> Do not call a playbook merely to restate or classify the intent.
> Select exactly one next enabled playbook by stable id and give it complete standalone input containing only the context it needs.
> Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.

A direct decision shall carry a concise JSON-safe `response` and complete.
A question decision shall carry one concise `question` and wait for Boss without losing the original intent.
A delegation decision shall carry a finite `remainingPlan` plus non-empty `nextPlaybookId` and `nextPlaybookInput` for its first call.

When Captain selects a next call, Captain shall call playbook selected by `nextPlaybookId`:
> <nextPlaybookInput>

When the called playbook returns successfully, aborts, or fails, Captain shall reassess the original intent, remaining plan, and completed call results using the following prompt:
> Boss intent: <boss-intent>
> Enabled playbooks: <enabled-playbooks>
> Remaining plan: <remaining-plan>
> Completed call results: <completed-call-results>
> Preserve Boss's intended outcome and constraints.
> Treat each returned result as evidence and revise the remaining plan when needed.
> Do not repeat an equivalent failed or completed call without new information.
> If the intent is fulfilled, give Boss one concise final response.
> If information from Boss is now necessary, ask exactly one concise question.
> Otherwise select exactly one next enabled playbook by stable id and give it complete standalone input containing only the context it needs.
> Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.

A final decision shall carry a concise JSON-safe `response` and complete.
A follow-up question shall carry one concise `question` and wait for Boss without losing the original intent, plan, or completed results.
A continuing decision shall carry the revised finite `remainingPlan` plus non-empty `nextPlaybookId` and `nextPlaybookInput`.

While a child playbook or any descendant is active or parked, this Captain playbook remains suspended.
The host shall send Boss input only to the active leaf and shall resume this Captain playbook only with the matching child return.
Captain shall not infer stack ownership from Boss prose and shall not receive stack, session, or call identities.
