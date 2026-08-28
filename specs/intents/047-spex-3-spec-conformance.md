<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-047: Spex 3 Spec Conformance

## Status

Planned

## Intent

Complete the Spex 3 scaffold merge by bringing the project-local Spex dependency, decision and intent records, and the spec map into the refreshed law of [DR-000](../decisions/000-spec-structure-format.md) while preserving local policy, released item IDs, normative concerns, package boundaries, and implementation behavior.
The scaffold overwrite dropped the reviewed project amendment from `7123802`, which defines an item as one cohesive concern and permits multiple GEARS statements, preconditions, triggers, phases, or cases when they form one cohesive contract; this intent restores that local rule rather than treating 172 advisory sentence-count findings as migration tasks.

## Deliverables

- [x] The reviewed cohesive-concern rule and its matching agent guidance are restored over the scaffold overwrite.
- [x] The spec map states and implements its minimal decision-record and package index scope.
- [ ] The project-local Spex dependency and lockfile use version 3, and historical intent records obey the new prohibition on naming or citing another intent.
- [ ] All 39 decision records obey the refreshed References rule: internal spec and repository links are inline, while a References section contains only cited authoritative external sources.
- [ ] Project-local `spex lint` exits successfully with sentence-count findings treated as advisory review prompts under the local cohesive-concern rule, and the repository test suite passes.

## Tasks

1. **Align Spex and the record corpus.**
   One commit: upgrade the project dependency and lockfile to Spex 3, replace every cross-intent name or citation with self-contained historical wording, audit all 39 decision records under the refreshed References rule, relocate the internal links and delete the emptied References sections in DR-017, DR-019, DR-022, and DR-030, verify the map remains exact, run project-local `spex lint` plus the complete repository test suite, and close this intent.

## Verification

- The installed meta-29 wording and agent guidance retain the reviewed cohesive-concern boundary from `7123802`, and no released package item is split merely because Spex reports an advisory sentence-count finding.
- Every internal spec or repository link in a decision record appears inline, and a References section exists only when cited authoritative external sources require it.
- Every item citation uses the enclosed ID-text form, every decision citation uses the plain ID-text form, and no spec names or cites an intent except that intent itself.
- `specs/map.md` indexes every decision record and package, indexes no intent record, and gives an accurate package summary.
- Project-local `spex lint` reports no errors, its sentence-count warnings remain advisory under local meta-29, and the complete repository test suite passes.
