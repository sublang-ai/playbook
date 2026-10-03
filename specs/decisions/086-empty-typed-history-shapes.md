<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-086: Empty Typed History Shapes

## Status

Accepted (2026-10-03).

## Context

A generated workflow left Source-owned array discussion absent until an earlier exchange existed.
Real reached calls composed correctly, but the existing initial-context prompt probe substituted a scalar sentinel for the absent field and the strict array composer refused it.
The probe deliberately retains initialized non-string shapes; changing the checker or accepting strings would obscure a malformed actual input.

## Decision

Generated context represents Source-owned empty array history as `[]`, preserving that declared shape through actor inputs and resetting it only at its Source lifecycle boundaries.
This structural empty value establishes no caller intent, prerequisite report, domain evidence, approval or prior-stage result.
Required facts remain unavailable until actually established.

## Consequences

The compiler definition guides future artifacts without repairing existing bundles or changing checker, composer, runtime or public interface behavior.
A recovered artifact needs separate equivalence and conformance evidence; its prior failure remains recorded.
Real XState and selected-compiler integration controls verify current shape and prompt behavior, not future model output.
