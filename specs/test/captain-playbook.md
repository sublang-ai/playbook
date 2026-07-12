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

Where the shell provides two or more enabled playbooks, when tests drive direct handling, one material clarification, one-child delegation, and a revised multi-child plan, the suite shall fail unless the Captain preserves the intent and prior results, calls only catalog ids sequentially with standalone inputs, rejects an unknown or self target, and returns one final response without repeating an equivalent completed or failed call absent new information.

### CAPPLAY-13
Verifies: [CAPPLAY-4](../user/captain-playbook.md#capplay-4), [CAPPLAY-9](../dev/captain-playbook.md#capplay-9)

Where a Captain child or grandchild parks for Boss input, when Boss replies and the descendants later return, the integration suite shall fail unless only the active leaf receives the reply, every parent remains the same suspended instance, returns occur in LIFO order through matching call identities, and the Captain resumes its remaining plan only after the child disposal and call-finish boundary drain.

### CAPPLAY-14
Verifies: [CAPPLAY-5](../user/captain-playbook.md#capplay-5), [CAPPLAY-8](../dev/captain-playbook.md#capplay-8), [CAPPLAY-9](../dev/captain-playbook.md#capplay-9)

Where the default Captain runs under the real shell ports, the test suite shall fail unless visible Captain calls and hidden judge calls are single-flight, paired Captain trace boundaries are complete and ordered, the internal root creates no player or empty visibility request, and visible responses, child statuses, and summaries contain no catalog internals, control JSON, session or call identity, stack data, or private reasoning.
