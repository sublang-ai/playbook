<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-067: Integrate Retained Compilation Work

## Status

Completed (2026-09-12).

## Intent

Integrate the retained compiler definitions, helper, checks, and evidence into the published 13.2 source baseline before evaluating more complex workflows, preserving [DR-050](../decisions/050-pull-request-delivery.md)'s maintained behavior and [DR-051](../decisions/051-link-materialization-tool.md)'s measured scope.

## Deliverables

- [x] Isolated merge of `32b0173` into the `a000e37` baseline without changing maintained workflow or engine bytes.
- [x] Preserve the published pull-request delivery record identities by moving the unpublished rejected split decision to DR-053 and its intent to `066-compact-link-definition.md` and updating their citations.
- [x] Build, definition/helper, source conformance, package surface, and spec checks.

## Tasks

1. Resolve the changelog and index conflicts, preserve both branches' package surfaces and requirements, verify the integration, and commit it without introducing another optimization.

## Verification

The project TypeScript build passes without changing any maintained workflow or shared-engine file from pinned baseline `a000e37`.
Every `slc/` member remains byte-identical to retained revision `32b0173`; package metadata retains version 13.2.0 and the published BRANCH/PR exports alongside the helper files.
The helper, definition, exact-version overlay builder, question/task-input, root-state, optimization, and source-contract suites pass 61 cases.
The package surface, runtime contract, CODE/DEV runtime, DEV source/coverage, and BRANCH/PR artifact-contract suites pass 175 cases.
The helper suite independently passes 19 cases against the installed 12.3 engine, including both helper profiles and strict generated types; the combined checks exercise the 12.3 and 13.2 continuation APIs.
Spex 3.0 reports zero errors and 233 advisory warnings; all 2,766 relative links in 135 Markdown files resolve.
The staged diff check passes except the imported v2 recipe's existing terminal blank line, preserved because the archived experiment builder verifies its exact bytes.
No provider execution or complex-workflow performance claim belongs to this merge.
