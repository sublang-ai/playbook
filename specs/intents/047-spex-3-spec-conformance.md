<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-047: Spex 3 Spec Conformance

## Status

Done

## Intent

Complete the Spex 3 scaffold merge by bringing the project-local Spex dependency, decision and intent records, and the spec map into the refreshed law of [DR-000](../decisions/000-spec-structure-format.md) while preserving local policy, released item IDs, normative concerns, package boundaries, and implementation behavior.
The project-local item boundary and its preservation across scaffold refreshes are governed by [DR-039](../decisions/039-cohesive-concern-spec-item-boundary.md).

## Deliverables

- [x] The meta-29 wording and matching agent guidance required by [DR-039](../decisions/039-cohesive-concern-spec-item-boundary.md) are restored after the scaffold overwrite.
- [x] The spec map states and implements its minimal decision-record and package index scope.
- [x] The project-local Spex dependency and lockfile use version 3, and historical intent records obey the new prohibition on naming or citing another intent.
- [x] All 40 decision records obey the refreshed References rule: internal spec and repository links are inline, while a References section contains only cited authoritative external sources.
- [x] Project-local `spex lint` exits successfully, and the repository test suite passes.

## Tasks

1. **Align Spex and the record corpus.** _[done]_
   One commit: upgrade the project dependency and lockfile to Spex 3, replace every cross-intent name or citation with self-contained historical wording, audit all 40 decision records under the refreshed References rule, relocate the internal links and delete the emptied References sections in DR-017, DR-019, DR-022, and DR-030, verify the map remains exact, run project-local `spex lint` plus the complete repository test suite, and close this intent.

## Verification

- The installed meta-29 wording and matching agent guidance conform to [DR-039](../decisions/039-cohesive-concern-spec-item-boundary.md), and no released package item is split solely because of a sentence-count lint finding.
- Every internal spec or repository link in a decision record appears inline, and a References section exists only when cited authoritative external sources require it.
- Every item citation uses the enclosed ID-text form, every decision citation uses the plain ID-text form, and no spec names or cites an intent except that intent itself.
- `specs/map.md` indexes every decision record and package, indexes no intent record, and gives an accurate package summary.
- Project-local `spex lint` reports no errors, and the complete repository test suite passes.
