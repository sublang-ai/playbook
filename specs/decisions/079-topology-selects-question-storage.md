<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-079: Topology Selects Question Storage

## Status

Accepted (2026-10-02).
Clarifies the compiler guidance under [DR-005](005-boss-reply-suspension-path.md) and [DR-067](067-parallel-proposals-through-the-shared-factory.md); neither runtime contract changes.

## Context

The Boss-reply compiler guide permitted scalar storage when at most one task was active and required keyed storage for parallel tasks, without excluding keyed storage from a flat machine.
A real approval workflow consequently compiled to a flat FSM with keyed questions and failed linking because the shared factory discovers flat questions only through scalar context.
A test manually projected a keyed record into scalar input before calling the question reader, so it did not establish discovery from the actual flat machine context.

## Decision

Machine topology selects the canonical context form: no root parallel group requires scalar question and reply fields; a machine declaring a root parallel group requires keyed fields throughout, including sequential working leaves and their root reply wait.
Actor invocation inputs remain singular in both forms.
The compiler and its integration evidence follow the existing shared factory projection without adding an adapter or broadening the runtime contract.

## Consequences

Existing valid scalar flat artifacts and keyed parallel artifacts retain their behavior, API, artifact schema, and repository receipt guarantees.
Flat keyed artifacts require FSM regeneration; successful execution of a path that asks no question does not prove Boss-reply compatibility.
The integration evidence includes a materialized and compiled flat artifact running through the shared factory, with exact question discovery, resumed reply, and unchanged Git receipts.
