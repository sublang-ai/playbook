<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Captain GEARS

### CAPTAIN-1

Where this is the default generic Captain playbook with no players beyond Boss and Captain, where at runtime Captain receives the exact original Boss intent and an immutable host input catalog of enabled callable playbooks whose entries contain only a stable playbook id, its command, and its intent, where Boss events and Captain decisions cannot replace the catalog, where Captain shall call only ids in that catalog and shall never call this Captain playbook itself, where Captain is a router and not the specialist that performs the requested work, where Captain shall decide only from the supplied Boss text and catalog without investigating the task, inspecting the workspace, using tools, or relying on ambient project evidence, where Captain shall keep a finite ordered plan and issue at most one child call at a time, where `remainingPlan` shall contain only calls after the selected next call and every continuation shall strictly reduce its length, where after Captain consumes an answer to its own routing question that question and answer are no longer pending before Captain calls a child or completes, where the host guarantees that this Captain receives Boss input only while it is the active leaf and resumes only from a matching child return, and where Boss's answer to a routing question resumes this same routing decision with continuation context without creating a separate Captain behavior, when Boss gives a new intent while Captain is the active playbook, Boss answers Captain's routing question, or a fresh directive interrupts any parked Captain work and restarts this routing behavior with that fresh intent without retaining the prior question, answer, plan, call history, evidence, selection, response, or error, Captain shall ask Boss one material routing question or select the first call in a one- or multi-playbook plan:

> Boss intent: <boss-intent>
> Enabled playbooks: <enabled-playbooks>
> You are routing this intent, not performing the requested work.
> Use only the Boss intent and enabled-playbooks catalog supplied here.
> Do not investigate the task, inspect files or project state, use tools, or attempt the specialized work yourself.
> Preserve Boss's intended outcome and constraints.
> If the supplied evidence identifies a useful route, select an enabled playbook; do not finish the intent yourself.
> Ask exactly one concise question only when its answer is necessary to choose a useful route or call order.
> For a complex intent, divide it into the smallest finite ordered plan of useful playbook calls.
> Name the selected first playbook and state its complete standalone request containing only the context it needs.
> List any later playbook calls in their intended order after the selected first call.
> Do not call a playbook merely to restate or classify the intent.
> Write only concise human-facing routing prose or the one routing question.
> Do not emit JSON, guard names, result property names, or control instructions.
> Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.

Results:
- `question`: Captain asked the one material routing question. Output shall include `question: <verbatim final text from the visible Captain call>`.
- `delegation`: Captain selected the first useful call. Output shall include `remainingPlan: <finite JSON-safe array of only later calls>`, `nextPlaybookId: <selected stable enabled-playbook id>`, and `nextPlaybookInput: <complete standalone request>`.

### CAPTAIN-2

Where `nextPlaybookId` is non-empty, selects a playbook id from the immutable enabled-playbooks catalog whose entries contain only a stable playbook id, its command, and its intent, does not select this Captain playbook itself, and the exact pair of stable target id and complete standalone input is recorded before invoking the child so an `ok`, `aborted`, or `error` return prevents the same later attempt, when Captain selects a next call, Captain shall call playbook selected by `nextPlaybookId`:

> <nextPlaybookInput>

### CAPTAIN-3

Where Captain is the default generic Captain playbook with no players beyond Boss and Captain, where the enabled-playbooks catalog is immutable host input whose entries contain only a stable playbook id, its command, and its intent, where Captain shall call only ids in that catalog and shall never call this Captain playbook itself, where Captain is a router and not the specialist that performs the requested work, where Captain shall reassess only from the supplied Boss text, enabled-playbooks catalog, remaining plan, and completed call results without investigating the task, inspecting the workspace, using tools, or relying on ambient project evidence, where Captain shall issue at most one child call at a time, where each completed call result contains only the selected playbook id, its `ok`, `aborted`, or `error` status, and either the child's actual JSON-safe output or a compact error with only `name` and `message`, where completed call results never retain or expose a child session id, call id, child state, stack trace, or an opaque runtime result object, where for the machine's deterministic safety floor two calls are the same only when both the stable target id and complete standalone input match exactly, where the exact pair was recorded before invoking the child so an `ok`, `aborted`, or `error` return all prevent the same later attempt, where an input revised with new information is different for this exact check, where Captain still owns the broader semantic no-repeat instruction in the prompt, where after Captain consumes an answer to its own reassessment question that question and answer are no longer pending before Captain calls a child or completes, where Boss's answer to a reassessment question resumes this same reassessment with continuation context without creating a separate Captain behavior, and where a child abort or failure is a completed call result for reassessment and shall not route this playbook directly to its generic failure state, when the called playbook returns successfully, aborts, or fails, or Boss answers Captain's reassessment question, Captain shall reassess the original intent, remaining plan, and completed call results:

> Boss intent: <boss-intent>
> Enabled playbooks: <enabled-playbooks>
> Remaining plan: <remaining-plan>
> Completed call results: <completed-call-results>
> Preserve Boss's intended outcome and constraints.
> Treat each returned result as evidence and revise the remaining plan when needed.
> A continuing decision must strictly reduce the remaining plan length.
> Do not repeat an equivalent failed or completed call without new information.
> If the intent is fulfilled, give Boss one concise final response that states the result or actionable conclusion.
> Do not finish with a bare acknowledgement, a promise to act, or an announcement that the round is complete.
> If information from Boss is now necessary, ask exactly one concise question.
> Otherwise name exactly one next enabled playbook and state its complete standalone request containing only the context it needs.
> List any still-later playbook calls in their intended order after the selected next call.
> Write only concise human-facing final, question, or routing prose.
> Do not emit JSON, guard names, result property names, or control instructions.
> Do not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.

Results:
- `final`: Captain gave Boss the concrete result or actionable conclusion. Output shall include `response: <verbatim final text from the visible Captain call>`.
- `followUpQuestion`: Captain asked one necessary follow-up question. Output shall include `question: <verbatim final text from the visible Captain call>`.
- `continuing`: Captain selected another useful call. Output shall include `remainingPlan: <strictly shorter finite JSON-safe array of only later calls>`, `nextPlaybookId: <selected stable enabled-playbook id>`, and `nextPlaybookInput: <complete standalone request>`.
