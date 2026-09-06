<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-054: Portable Session Contract

## Status

Done (2026-09-06): published as `@sublang/playbook` 13.0.0 from tag `v13.0.0` at `ad6a411`.

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
- Review fixes: 381 applicable integration cases passed, including unknown-version history preservation; two packed-document link checks passed.
- Spec lint: no errors; 232 existing style warnings.
- Historical `3444353` gates: CI `34001590898` passed 1,743 tests, Node 20/22 builds, generated-artifact checks, SPDX checks and installation smoke; local packed smoke passed 11 steps and live acceptance passed 6/6.
- Final candidate `ad6a411`: `pnpm test` 1681+86 passed with spec lint clean, `pnpm smoke:release` 11/11, `pnpm test:acceptance` 6/6 with real Claude and Codex adapters, the manual terminal check [[release-26](../packages/release.md#release-26)] passed at 120x40, 80x24 and 160x50 with a clean Ctrl-C exit, compiled siblings in sync, CI `34021079897` success; release workflow `34021987115` published 13.0.0 with provenance and created the GitHub release.
