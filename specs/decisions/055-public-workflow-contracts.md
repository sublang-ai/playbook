<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-055: Public Workflow Contracts as Compiler Inputs

## Status

Accepted

## Context

A caller compiled from sufficient source invented output fields for the builtin REVIEW dependency because its public output type was available only inside an implementation-bearing FSM declaration.
Excluding maintained implementations from compiler inputs must not also remove the external interfaces required to compile calls to them.
The shared nested-call API deliberately transports arbitrary JSON-safe child output and does not prescribe workflow-specific fields.

## Decision

- Publish `slc/workflow-contracts.json` as an independently packaged compiler input describing only the public output contracts of builtin REVIEW, DECIDE, CODE, BRANCH, and PR.
- Declare the selected pipeline's default builtin target namespace through the catalog's explicit `literalTargetBindings`; an explicit source or supplied compiler-dependency binding overrides a default and needs its own interface, and runtime hosts must honor the compiled external ABI.
- A matching local filename or an undeclared custom runtime registration does not establish or override that compiler binding.
- Keep the catalog independent of prompts, acting results, states, transitions, runtime implementations, and maintained compiled declarations.
- Require callers to use the declared interface for source-owned output predicates without inventing correlation fields or confusing bridge success with domain acceptance.
- Keep missing required external interface information a compiler dependency failure, distinct from a missing or contradictory authored behavior requiring source clarification.
- Verify catalog drift against exported output types and real maintained runtime outputs; include the catalog in the compiler definition's semantic-input closure.

## Consequences

- Callers can compile against exact public field names without receiving the callee's implementation as an answer oracle.
- The existing runtime and registry ABIs remain unchanged; the catalog is documentation/data for compilation, not a new runtime validator or a substitute for the child's output authority.
- Existing failed observations remain failures; availability of the interface does not establish model compliance or a performance improvement.
