<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPPLAY: Default Captain playbook

## Intent

This spec defines end-to-end acceptance tests for the compiled default generic Captain and its shell integration.

### CAPPLAY-11

Verifies: [CAPPLAY-6](../dev/captain-playbook.md#capplay-6), [CAPPLAY-10](../dev/captain-playbook.md#capplay-10)

Where the Captain source is compiled through `slc playbook`, the test suite shall fail unless the canonical GEARS, FSM, linked runtime, and generated verification artifacts exist, the generated checks pass, direct Captain and dynamic playbook actors match the source, and the machine returns `{ response }` after a finite successful run.

### CAPPLAY-12

Verifies: [CAPPLAY-1](../user/captain-playbook.md#capplay-1), [CAPPLAY-2](../user/captain-playbook.md#capplay-2), [CAPPLAY-3](../user/captain-playbook.md#capplay-3), [CAPPLAY-7](../dev/captain-playbook.md#capplay-7)

Where the shell provides two or more enabled playbooks, when tests drive one material clarification, one-child delegation, and a revised multi-child plan, the suite shall fail unless the Captain preserves the exact intent and prior results, has no initial direct or terminal arm, calls only catalog ids sequentially with standalone inputs, rejects an unknown or self target, rejects a continuation whose `remainingPlan` is not strictly shorter, and returns one final response.
The generated reassessment prompt shall retain that broader semantic
instruction. Independently, the FSM shall reject a continuation using the same
stable target id and exact complete input after an `ok`, `aborted`, or `error`
return, and shall accept a strictly shorter continuation whose revised input
carries new information.
After a routing or reassessment question is answered, the next delegated
child state and its telemetry shall carry no consumed pending question.
Immediate and resumed child success, abort, and error results shall be reduced
to target, status, actual output, or compact error evidence before the next
visible Captain prompt; that prompt shall contain no child session id, call id,
child state, stack, or opaque runtime result.

### CAPPLAY-13

Verifies: [CAPPLAY-4](../user/captain-playbook.md#capplay-4), [CAPPLAY-9](../dev/captain-playbook.md#capplay-9)

Where a Captain child or grandchild parks for Boss input, when Boss replies with
ordinary text and the descendants later return, the integration suite shall
fail unless only the active leaf receives the original unchanged reply, a
rejected, thrown, non-`ok`, absent-text, malformed, or unknown lifecycle
classification fails open to that delivery, registered command forms retain
the shell behavior specified by CAPTAIN-2, every parent remains the same
suspended instance, returns occur in LIFO order through matching call
identities, and the Captain resumes its remaining plan only after the child
disposal and call-finish boundary drain.

### CAPPLAY-14

Verifies: [CAPPLAY-5](../user/captain-playbook.md#capplay-5), [CAPPLAY-8](../dev/captain-playbook.md#capplay-8), [CAPPLAY-9](../dev/captain-playbook.md#capplay-9)

Where the default Captain runs under the real shell ports, the test suite shall fail unless visible Captain calls and hidden judge calls are single-flight, paired Captain trace boundaries are complete and ordered, the internal root creates no player, makes no visibility request, and emits no synthetic `/captain` lifecycle status, child calls and returns name the internal parent as literal `Captain` rather than `/captain`, and visible responses, child statuses, and summaries contain no catalog internals, control JSON, session or call identity, stack data, or private reasoning.
The real shell shall discard internal-runtime status messages and payloads such
as entered state ids while retaining their structured state telemetry.

### CAPPLAY-17

Verifies: [CAPPLAY-1](../user/captain-playbook.md#capplay-1), [CAPPLAY-5](../user/captain-playbook.md#capplay-5), [CAPPLAY-8](../dev/captain-playbook.md#capplay-8), [CAPPLAY-16](../dev/captain-playbook.md#capplay-16)

Where the default Captain is driven with a coding intent whose text can be paraphrased and investigated from the workspace, when the real shell and generated runtime process the turn, the integration suite shall fail unless ready-state entry preserves the text exactly, routing and adjudication calls are fresh and receive an explicit empty tool allowlist, the initial machine can only ask or delegate, delegation enters the selected child automatically, and no Captain control call can inspect or execute the task.
The suite shall also fail unless acting prompts contain no declared guard or
result-property schema, a classifier-authored paraphrase cannot replace Boss
text, an adjudicator-authored question or response cannot replace visible
Captain final text, and a terminal response communicates the child-backed
result rather than a bare acknowledgement or completion announcement.
