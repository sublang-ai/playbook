<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-037: Terminal Result Meaning

## Status

Accepted.
Extends [DR-035](035-truthful-terminal-meaning.md) from authored final-state identity to the public runtime result that carries that meaning to a host.

## Context

- [DR-035](035-truthful-terminal-meaning.md) makes each final state's description the Boss-facing meaning of that terminal outcome and requires materially different outcomes to use distinct final states.
- Shared-factory runtimes expose the current description through their optional control surface, and the Playbook Captain shell reads that view before disposing a terminal root.
- DECIDE correctly has distinct approval and REVIEW-failure final states with truthful descriptions, but its bespoke parallel runtime intentionally exposes no `describe`/`apply` pair.
- A real DECIDE root therefore reaches the right final state while the shell reports that its runtime published no result description, losing the material outcome [DR-035](035-truthful-terminal-meaning.md) exists to preserve.
- Terminal meaning is an outcome fact, not a runtime action capability, machine identifier, or opaque machine output.

## Decision

1. **A terminal run result carries the reached final state's meaning.**
   The `terminal` variant of `PlaybookRunResult` gains optional `stateDescription`.
   Where the reached final state declares a nonempty description, every maintained linked runtime shall copy that exact authored text into the field.
   A runtime shall omit the field when no description is authored and shall never substitute a state id or derive prose from opaque output.

2. **The shell consumes terminal meaning before disposal.**
   A terminal root's completion fact shall prefer the terminal result's `stateDescription`.
   For compatibility with an older runtime that omits the new optional field, the shell may read the still-live control view and shall otherwise retain the honest no-description fallback.
   The shell shall continue to escape and bound the text and shall never expose terminal output as Captain evidence.

3. **Control capabilities remain independent.**
   DECIDE shall remain without the optional `describe`/`apply` pair.
   The result field supplies only the terminal outcome already computed by the runtime and creates no action, idempotency, mid-run inspection, telemetry, or snapshot contract.

Considered and rejected: implementing DECIDE's full control-surface pair — terminal meaning needs no action semantics, and adding them would duplicate unrelated validation, receipt, and idempotency behavior.
Considered and rejected: adding descriptions to `PlaybookState`, telemetry, or durable snapshots — that would broaden every state boundary to solve a terminal-only gap.
Considered and rejected: deriving meaning from `PlaybookRunResult.output` — machine output is runtime-to-runtime data and is not authorized Boss-facing evidence under [DR-029](029-session-scoped-conversational-captain.md).

## Consequences

- A real DECIDE root now tells the Boss whether it completed with an approved commit or reported REVIEW's failure.
- Existing external runtimes remain source-compatible because the result member is optional and the shell retains its truthful fallbacks.
- Shared and bespoke maintained runtimes use the same terminal-result channel without making DECIDE advertise runtime actions.
