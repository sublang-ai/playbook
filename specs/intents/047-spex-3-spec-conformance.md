<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-047: Spex 3 Spec Conformance

## Status

Planned

## Intent

Complete the Spex 3 scaffold merge by bringing the project-local Spex dependency, historical intent records, and every spec package into the refreshed law of [DR-000](../decisions/000-spec-structure-format.md) while preserving released item IDs, normative concerns, package boundaries, and implementation behavior.

## Deliverables

- [ ] The project-local Spex dependency and lockfile use version 3, and historical intent records obey the new prohibition on naming or citing another intent.
- [ ] Every package item states one requirement in one GEARS statement while preserving all released concerns and IDs.
- [ ] Package behavior remains correctly classified as External or Internal relative to its users.
- [ ] Behavior bindings and verification evidence remain inline, correctly enclosed, and confined to their lawful package scope.
- [ ] The spec map remains a minimal and accurate index of decision records and packages.
- [ ] Project-local `spex lint` and the repository test suite pass against the migrated tree.

## Tasks

1. **Align the Spex toolchain and historical records.**
   One commit: upgrade the project dependency and lockfile to Spex 3, replace every cross-intent name or citation with self-contained historical wording, normalize or split the one flagged `cross-references.md` item with its behavior placement audited, and verify that remaining lint findings are confined to the package tasks below.
2. **Migrate the compiled Captain package.**
   One commit: audit and normalize or split the 16 flagged items in `captain-playbook.md`, keep each released ID on its existing core concern, assign each other separated concern the lowest available unreserved ID, confirm External/Internal placement, update affected inline citations, and confirm the map summary remains exact.
3. **Migrate the maintained playbook package.**
   One commit: audit and normalize or split the three flagged items in `playbook.md`, keep each released ID on its existing core concern, assign each other separated concern the lowest available unreserved ID, confirm External/Internal placement, update affected inline citations, and confirm the map summary remains exact.
4. **Migrate the Captain host package.**
   One commit: audit and normalize or split the 42 flagged items in `playbook-captain.md`, keep each released ID on its existing core concern, assign each other separated concern the lowest available unreserved ID, reclassify hidden behavior where required, update affected inline citations, and confirm the map summary remains exact.
5. **Migrate the CLI package.**
   One commit: audit and normalize or split the 41 flagged items in `playbook-cli.md`, keep each released ID on its existing core concern, assign each other separated concern the lowest available unreserved ID, reclassify hidden behavior where required, update affected inline citations, and confirm the map summary remains exact.
6. **Migrate the linked-runtime package.**
   One commit: audit and normalize or split the 48 flagged items in `playbook-runtime.md`, keep each released ID on its existing core concern, assign each other separated concern the lowest available unreserved ID, reclassify hidden behavior where required, update affected inline citations, and confirm the map summary remains exact.
7. **Migrate release behavior and close the merge.**
   One commit: audit and normalize or split the 21 flagged items in `release.md`, keep each released ID on its existing core concern, assign each other separated concern the lowest available unreserved ID, confirm External/Internal placement, update affected inline citations, verify the unchanged `git.md` and `licensing.md` packages, reconcile the final map summaries, and run project-local `spex lint` plus the complete repository test suite.

## Verification

- A released item ID remains attached to its prior core concern, and every other separated concern receives the lowest positive ID that is neither assigned nor reserved by a public release.
- Every package contains only the lawful sections in order, with a self-contained intent and correctly classified behavior.
- Every item citation uses the enclosed ID-text form, every decision citation uses the plain ID-text form, and no spec names or cites another intent.
- Every behavior binding appears at the phrase it makes specific, and every verification citation appears at the assertion it verifies within the containing package.
- `specs/map.md` indexes every decision record and package, indexes no intent record, and gives an accurate package summary.
- Project-local `spex lint` reports no findings, and the complete repository test suite passes.
