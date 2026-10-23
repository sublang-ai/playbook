<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-117: Bounded Session Persistence

## Status

Completed (2026-10-23).

## Intent

Prevent runtime recovery and replay files from growing beyond a portable per-file bound while preserving exact evidence and safe recovery.

## Deliverables

- [x] Versioned bounded persistence, explicit migration and complete export/deletion.
- [x] Compatible CLI and Spex storage integration.
- [x] Integration, recovery, package and release verification.

## Tasks

1. Specify and implement bounded session-owned chunks and replay persistence with filesystem integration coverage.
2. Integrate the shared lifecycle, migration, export and recovery checks.
3. Verify compatible hosts and deliver the coordinated release.

## Verification

Exercise real stores with large repeated evidence and oversized single replay records, interrupted publication, corrupt or absent chunks, concurrent reads, explicit legacy migration, recovery and two-home Sync.
Run specification lint, build, normal tests, packed smoke and applicable release acceptance.

Playbook 18.0.0 was published at `f231e0dd393cdf336754a09f8fddae8b42e6f818` after its normal, packed and live release gates [[1]].
Coordinated Spex integration, reviewed from candidate `2641f07aef58854ac2fc8978833a9a63179ef76b`, shipped as `app-v0.9.0-beta.16` at `2641f07aef58854ac2fc8978833a9a63179ef76b`, after exact-main CI and applicable fresh installed acceptance [[2]].
The bound is per file; no total-storage quota, RAM bound or garbage collection is claimed.

## References

[1]: https://github.com/sublang-ai/playbook/releases/tag/v18.0.0 "Playbook 18.0.0 verified release"
[2]: https://github.com/sublang-ai/spex/blob/af334de83bed3e366c0b08b2f5bac013e643485b/docs/releases/0.9.0-beta.16-preparation.md#completed-release "Spex beta16 publication and coordinated integration evidence"
