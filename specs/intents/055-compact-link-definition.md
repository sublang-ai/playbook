<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-055: Compact Link Definition

## Status

Done (2026-09-12): experiment rejected and prototype reverted.

## Intent

Evaluate the compact-definition performance technique and retain it only with measured successful compilation evidence, as recorded in [DR-050](../decisions/050-compact-link-definition.md).

## Deliverables

- [x] Prototype compact authoring with preserved normative runtime content.
- [x] Check package closure and runtime contracts, then real SLC discovery and companion-change invalidation.
- [x] Compare cold compilation evidence under the same source, model, and engine.
- [x] Reject the unproven technique and restore all production files to the pre-prototype revision.

## Tasks

1. [x] Implement and check the isolated prototype (`c1cc1bd`).
2. [x] Evaluate the live evidence and revert the prototype while retaining the rejection record.

## Verification

- Prototype checks: 81 package/runtime-contract tests passed; the real SLC runner reused an unchanged build and executed affected phases again after only companion bytes changed.
- Live runs `compile-iS1Lmh` and `compile-umeUCL` failed without demonstrating an improvement; exact measurements and limitations are recorded in the decision.
- The final branch diff against `27e1bbb` contains only this record, the decision, and its map entry.
- Audit-only prototype files remain under `/private/tmp/playbook-link-split-audit/`; no split definition, companion, sidecar, package surface, or test remains active in the repository.
