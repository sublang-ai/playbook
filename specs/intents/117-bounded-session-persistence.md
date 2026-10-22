<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-117: Bounded Session Persistence

## Status

In progress.

## Intent

Prevent runtime recovery and replay files from growing beyond a portable per-file bound while preserving exact evidence and safe recovery.

## Deliverables

- [ ] Versioned bounded persistence, explicit migration and complete export/deletion.
- [ ] Compatible CLI and Spex storage integration.
- [ ] Integration, recovery, package and release verification.

## Tasks

1. Specify and implement bounded session-owned chunks and replay persistence with filesystem integration coverage.
2. Integrate the shared lifecycle, migration, export and recovery checks.
3. Verify compatible hosts and deliver the coordinated release.

## Verification

Exercise real stores with large repeated evidence and oversized single replay records, interrupted publication, corrupt or absent chunks, concurrent reads, explicit legacy migration, recovery and two-home Sync.
Run specification lint, build, normal tests, packed smoke and applicable release acceptance.
