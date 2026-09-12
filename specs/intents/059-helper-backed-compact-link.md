<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-059: Measure Helper-Backed Compact Linking

## Status

In progress (2026-09-12); isolated experiment awaiting measurement.

## Intent

Build a compact definition candidate for controlled comparison with the unchanged helper and engine.

## Deliverables

- [x] Compact recipe, exact full-contract companion, and dependency closure.
- [x] Package, strict emitted typing, unsupported-case, and real SLC incremental verification.
- [x] Separate exact-version Playbook 12.3 overlay for live measurement.
- [x] Durable verified builder from installed 12.3, including the independently corrected optimizer.

## Tasks

1. [x] Implement and verify the compact candidate without changing the helper.
2. [x] Reconstruct the controlled candidate from installed baseline inputs with an auditable experiment-only builder.
3. Record the measurement-based retention or rejection decision.

## Verification

- The 13.1 entry is 14,793 bytes; reversing companion Markdown-link rebasing restores the complete `1e74eb4` definition exactly (SHA-256 `75e2e6e51a49a8621dd713d4d081db001a6256b28fc565a2ca192471ad084043`).
- The helper remains byte-identical to v2 (SHA-256 `fe7336bc4c1511c4170ac3cdaeda4ffc30f3848b40ae7301f6660c20067e58e0`).
- The real-CLI integration matrix passes all 16 cases against each of Playbook 13.1 and locked 12.3, including strict emitted TypeScript, minimal script execution, default composition and unsupported-target preservation.
- All ten existing full-runtime contract checks still read and verify the relocated contract; the compact integrity test and both selected packed-surface/link checks pass.
- The actual built SLC closure probe verifies unchanged reuse and link-only invalidation after independent helper and companion mutations, with no extra discovered phase.
- The frozen `/private/tmp/playbook-materializer-compact-reviewed-12.3` entry is 14,793 bytes against the v2 full definition's 158,445 bytes; reversing its companion rebasing restores that exact 12.3 full definition (SHA-256 `20f223c1ff58f2f59f69f250d47aa385fafabfcef63bfb6e2e0080cf5d7cc9dd`).
- That overlay's helper emits the copied real minimal FSM as a 4,584-byte module passing locked TypeScript 6 strict checking; the unchanged source-version phase files and installed 12.3 engine remain the controlled baseline.
- Reproduce an overlay with `node scripts/compact-link-definition.mjs <full-v2-definition-directory> <new-directory>`; the default recipe is extracted from the checked-in compact entry.
- Spex 3 lint reports zero errors; repository and packed Markdown links resolve.
- Controlled live measurements remain pending; reduced input bytes are not a speed-improvement or retention claim.

The durable controlled candidate is reconstructed directly with `node scripts/build-link-experiment-12.3.mjs <installed-playbook-package-root> <new-definition-directory>`.
The builder verifies the exact installed 12.3 version and all four baseline definition hashes, reconstructs the reviewed contract additions and reversible relocation from committed sources, includes the independently corrected optimizer, and records every output hash in `experiment-proof.json`.
It changes no installed package or engine and refuses an existing target or modified baseline before output.
The optional real-CLI reconstruction matrix runs with `PLAYBOOK_MATERIALIZATION_BASELINE=<installed-playbook-package-root> node node_modules/vitest/vitest.mjs run src/compact-link-definition.test.ts`.
The emitted candidate can be checked through actual SLC discovery and reuse with `node scripts/check-slc-definition-closure.mjs <built-slc-root> <new-definition-directory>`.

Independent review corrected the compact recipe's resumption registry to follow Boss-reply suspension rather than interrupt targets; the regression exercises a real FSM with `BOSS_REPLY` routing and no `BOSS_INTERRUPT`, and verifies refusal of an empty registry without replacing the accepted artifact.
