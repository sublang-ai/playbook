<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-072: Caller-Owned Child Acceptance

## Status

Completed.

## Intent

Remove the contradictory blanket prohibition on child-output checks while preserving the existing distinction between bridge delivery, the child's compiled terminal kind and explicit caller-owned acceptance under [[playbook-runtime-84](../packages/playbook-runtime.md#playbook-runtime-84)].

## Deliverables

- [x] Aligned producer, link contract and decision wording with no engine or workflow change.
- [x] Real maintained CODE integration evidence for accepted, missing and invalid review evidence with and without a success terminal record.
- [x] A new immutable 13.2 baseline/full pair containing the same correction in both arms, with historical inputs preserved.

## Tasks

1. [x] Correct and verify the normative boundary, then reconstruct the new matched experiment inputs.

## Verification

The maintained CODE suite passes all 34 real-Git cases, including the ten-case child-acceptance matrix, and the shared bridge's seven typed-terminal cases pass without an engine change.
The 11 builder/discovery/closure cases and the package/archive case pass; the historical 12.3 opt-in case remains skipped rather than substituted with current inputs.
Production TypeScript checking passes; comparing the changed standalone test against its previous committed bytes finds no new diagnostics and retains its two existing harness type errors.
The new pair differs only in the optional helper section, and each arm changes only its active producer and link definition from the prior pair, with helper, original semantic inputs and historical outputs preserved.
Active definition cross-references resolve adjacent corrected definitions; copied published counterparts are separately identified semantic-input evidence.
The [local evidence](../../scripts/experiments/link-experiment-13.2-child-acceptance-evidence.json) retains this correction's exact identities and test scope.
No provider call or performance acceptance is part of this correction.
