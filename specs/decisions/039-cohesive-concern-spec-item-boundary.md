<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-039: Cohesive-Concern Spec Item Boundary

## Status

Accepted.

## Context

The Spex 3 scaffold defines each spec item as one requirement in one GEARS statement and uses sentence count as an advisory proxy for that rule.
This repository deliberately adopted a different boundary in `7123802`: one cohesive concern may need multiple GEARS statements, preconditions, triggers, phases, or cases, while independently changeable and verifiable subjects or outcomes remain separate items.
A `spex scaffold --update` refresh can replace `specs/meta.md`, `AGENTS.md`, and `CLAUDE.md`, and a refresh erased that local rule once already.
Without a repository-owned decision, deleting the migration intent would also delete the rationale and preservation duty for this project-wide constraint, contrary to [[meta-24](../meta.md#meta-24)] and [[meta-28](../meta.md#meta-28)].

## Decision

- The repository retains the cohesive-concern boundary in [[meta-29](../meta.md#meta-29)]: one item may use multiple GEARS statements, preconditions, triggers, phases, or cases when together they define one cohesive contract.
- Independently changeable and verifiable subjects or outcomes remain separate items.
- The scaffold's one-requirement-in-one-GEARS-statement wording is deliberately not adopted.
- After every `spex scaffold --update`, the merge shall reapply this local meta-29 wording and the matching `one cohesive concern per item (meta-29)` summary in `AGENTS.md` and `CLAUDE.md` when the refresh replaces them.
- An `item/sentence` finding from `spex lint` is an advisory prompt to inspect cohesion and does not by itself require splitting an item; lint errors remain failures to resolve.

## Consequences

- The item-boundary decision remains auditable after its implementation intent is deleted.
- Scaffold updates may adopt other framework changes while preserving the repository's item boundary.
- Cohesive multi-statement and case-matrix items may continue to produce advisory sentence-count findings.
- Independent concerns still require separate items; the policy is not a blanket exemption from review.
