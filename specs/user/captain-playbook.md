<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPPLAY: Default Captain playbook

## Intent

This spec defines the Boss-visible behavior of the compiled default generic Captain playbook.
The Playbook Captain shell remains responsible for hosting it and for the nested stack.

### CAPPLAY-1

Where no selected playbook is active, when Boss submits an ordinary intent, the default Captain playbook shall either handle the intent directly, ask one concise question whose answer would materially change routing or call order, or delegate the intent to an enabled specialized playbook.

### CAPPLAY-2

Where a Boss intent requires several specialized workflows, when the default Captain plans the work, it shall divide the intent into the smallest finite ordered set of useful playbook calls, issue at most one call at a time, and reassess the remaining plan after each child result.
The remaining plan names only calls after the selected next call, and each
continuation shortens it, so one intent cannot create an unbounded call loop.
Captain shall not repeat semantically equivalent completed or failed work
without new information. Independently, the machine shall reject the same
stable target id plus exact complete input after any prior attempt while
allowing a revised input that carries new information.

### CAPPLAY-3

While the default Captain is waiting for its own routing clarification, when Boss answers, the same Captain runtime shall use that answer to continue deciding without discarding the original intent or completed child results.

### CAPPLAY-4

While a called playbook or any descendant is active or parked, after the shell
handles any registered command form specified by
[CAPTAIN-2](playbook-captain.md#captain-2), when Boss submits
ordinary input that does not explicitly request dismissal, the active leaf
playbook shall receive the original input and the suspended default Captain
shall not consume it; a failed or malformed lifecycle classification shall
still deliver it, and when the matching child returns, the default Captain
shall continue from that result.

### CAPPLAY-5

When the default Captain answers directly or completes its plan, it shall give Boss one concise response and shall not expose internal state ids, session ids, call ids, stack data, hidden control data, or private reasoning.
When it reassesses a child return, the evidence visible to Captain shall be
limited to the selected playbook, outcome status, actual child output, or a
compact error message; runtime identities and child state remain private.
