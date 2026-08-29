<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-041: Working-directory-aware bare continuation

## Status

Accepted.
Amends [DR-031](031-shared-captain-session-front-ends.md) §4's globally newest implicit selection while preserving explicit selection and uncertain-turn recovery.

## Context

`playbook run --continue` selects the globally newest durable Captain-session record by update time.
When several repositories have sessions in flight, invoking it from one repository can therefore reopen another repository's Captain session without an explicit choice.
Each durable record already carries the normalized absolute working directory that restoration keeps authoritative.
Explicit `--session <id>` is the unambiguous cross-directory selector, and an uncertain record must still be selected before its existing refusal can protect against replay.

## Decision

Bare `playbook run --continue` shall normalize the invoking working directory by the same lexical absolute-path rule used for a fresh session's stored working directory.
It shall validate every canonical durable record before partitioning candidates, preserving released-schema notices and fail-closed malformed, unsafe, or unknown-schema handling.
Where one or more valid records have an exactly equal stored working directory, bare continuation shall select the newest of those records by canonical update time and the existing deterministic session-id tie-break.
Where valid records exist but none has that working directory, bare continuation shall select the globally newest record and print one stderr notice that no same-directory Captain session exists for the invoking working directory, naming the selected session id and its stored working directory.
Path equality shall use the normalized absolute strings without inferring a Git root, accepting an ancestor, or resolving symlink identity.
Explicit `--session <id>` shall bypass the working-directory preference and fallback notice.
A selected uncertain record shall reach the unchanged refusal and exact retry-or-discard remedies rather than fall through to an older settled record.

## Consequences

- A repository-local continuation normally resumes that repository's most recent Captain session even when another repository has newer work.
- The global fallback preserves the previous convenience when a directory has no session, while making the cross-directory choice visible.
- Explicit session selection, stored-working-directory authority after selection, deterministic ordering, corruption handling, and uncertain-turn replay protection remain unchanged.
