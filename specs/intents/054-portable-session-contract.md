<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-054: Portable Session Contract

## Status

In progress; required live release verification is pending.

## Intent

Implement [DR-049](../decisions/049-portable-session-contract.md).

## Deliverables

- [x] Implement schema-7 codec, migration and token-free nested recovery.
- [x] Publish the shared host lifecycle and adopt it in both CLI front ends.
- [x] Add context recording, durable replay digests and persistent incompleteness.
- [x] Implement local hint consumption and classified fresh fallback.
- [x] Verify cross-host continuation, migration, deletion and path-refusal matrices.

## Tasks

1. Add schema-7 manifest/context codecs; verify closed variants and unsupported-version preservation.
2. Project nested recovery to token-free form; verify deferred operations and matching ledger copies.
3. Bind checkpoints to replay digests; verify write ordering and persistent incompleteness after crashes.
4. Add local hint consumption; verify exact-checkpoint binding and stale-token crash recovery.
5. Handle classified fresh fallback; verify Captain/player recovery and no ambiguous retry.
6. Publish the shared host lifecycle; verify embedding and CLI use the same store and authority.
7. Record context from CLI hosts; verify historical graphs without installed modules.
8. Add source-retaining legacy migration; verify CLI/sidecar compatibility and interrupted retries.
9. Add shared deletion; verify manifest-last cleanup, lease refusal and interrupted retry.
10. Add permission preparation; verify Git-created modes tighten and unsafe entries refuse.
11. Enforce destination compatibility; verify changed-path history-only behavior and same-path reconciliation.

## Verification

- Required integration matrices are defined in the owning spec packages.
- Build, 1,717-test normal gate and 11-step packed smoke gate passed.
- Later cutover changes passed 37 portable, 173 compatibility and 13 CLI checks; unchanged gates were reused.
- Spec lint: no errors.
- Live provider acceptance and publication remain pending.
