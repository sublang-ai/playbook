<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-119: Adopt Cligent 0.36.1

## Status

Floor, public lock, installed contract and automated release gates verified; manual UX and integration pending (2026-10-25).

## Intent

Consume the published browser-readiness and dependency repairs without allowing an older Cligent floor.

## Deliverables

- [x] Raise the declared minimum and its package-surface guard to 0.36.1.
- [x] Resolve the public package in the lock and verify the override-free installed contract.
- [x] Pass affected package and automated release gates.
- [ ] Complete manual UX and integration before publication.

## Tasks

1. Adopt the published Cligent patch with a matching caret floor, resolved lock and package verification.

## Verification

The authorized lockfile-only update completed successfully with Cligent 0.36.1 and Zod 4.6.6; only those versions, their integrities and affected peer snapshot references changed.
The workspace configuration, manifest and installed lock remained unchanged during that command.
This metadata activity overlapped the ongoing Space diagnostic and is no isolated performance measurement.
The subsequent frozen install passed and resolves public Cligent 0.36.1, with the original workspace configuration unchanged and no override or local link.
The normal TypeScript build and spec lint passed; the focused CODE/package-surface run passed 166 tests and the separate Cligent release-capability suite passed 146 tests, each with one worker.
The original full run failed 13 fixture tests and remains preserved; root-reviewed current-CODE selectors and explicit foreign-file fixture permissions corrected those test inputs without changing production code.
The successor normal gate passed 2,900 tests with 24 skipped, followed by 146 capability tests; packed smoke passed all 11 steps and fresh exact-model live acceptance passed all 14 cases.
The candidate metadata is 18.0.1; manual packed-tmux UX and integration remain pending; required prepush passed with spec lint and type checking clean, with no publication claimed.

The full normal, packed smoke and live gates preceded the version-only 18.0.1 metadata preparation; unchanged model suites were not rerun.
The 18.0.1 tag/changelog validation and 25 selected metadata/package tests passed, with 85 unrelated package cases not selected.
