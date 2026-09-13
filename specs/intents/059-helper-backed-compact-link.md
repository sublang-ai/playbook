<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-059: Measure Helper-Backed Compact Linking

## Status

Done (2026-09-12); compact recipe rejected after controlled measurement.

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
3. [x] Record the measured rejection and restore the complete production entry.

## Verification

- The initial 13.1 entry is 14,793 bytes; reversing companion Markdown-link rebasing restores the complete `1e74eb4` definition exactly (SHA-256 `75e2e6e51a49a8621dd713d4d081db001a6256b28fc565a2ca192471ad084043`).
- The helper remains byte-identical to v2 (SHA-256 `fe7336bc4c1511c4170ac3cdaeda4ffc30f3848b40ae7301f6660c20067e58e0`).
- The real-CLI integration matrix passes all 16 cases against each of Playbook 13.1 and locked 12.3, including strict emitted TypeScript, minimal script execution, default composition and unsupported-target preservation.
- At prototype verification, all ten existing full-runtime contract checks read and verified the relocated contract; the compact integrity test and both selected packed-surface/link checks pass.
- The actual built SLC closure probe verifies unchanged reuse and link-only invalidation after independent helper and companion mutations, with no extra discovered phase.
- The initial frozen `/private/tmp/playbook-materializer-compact-reviewed-12.3` entry is 14,793 bytes against the v2 full definition's 158,445 bytes; reversing its companion rebasing restores that exact 12.3 full definition (SHA-256 `20f223c1ff58f2f59f69f250d47aa385fafabfcef63bfb6e2e0080cf5d7cc9dd`).
- That overlay's helper emits the copied real minimal FSM as a 4,584-byte module passing locked TypeScript 6 strict checking; the unchanged source-version phase files and installed 12.3 engine remain the controlled baseline.
- Reproduce an overlay with `node scripts/compact-link-definition.mjs <full-v2-definition-directory> <new-directory>`; the default recipe is the explicitly rejected, non-shipped fixture.
- Spex 3 lint reports zero errors; repository and packed Markdown links resolve.
- Reduced input bytes alone established no speed improvement; the completed controlled comparison below determines rejection.

The durable controlled candidate is reconstructed directly with `node scripts/build-link-experiment-12.3.mjs <installed-playbook-package-root> <new-definition-directory>`.
The builder verifies the exact installed 12.3 version and all four baseline definition hashes, reconstructs the reviewed contract additions and reversible relocation from committed sources, includes the independently corrected optimizer, and records every output hash in `experiment-proof.json`.
It changes no installed package or engine and refuses an existing target or modified baseline before output.
The optional real-CLI reconstruction matrix runs with `PLAYBOOK_MATERIALIZATION_BASELINE=<installed-playbook-package-root> node node_modules/vitest/vitest.mjs run src/compact-link-definition.test.ts`.
The emitted candidate can be checked through actual SLC discovery and reuse with `node scripts/check-slc-definition-closure.mjs <built-slc-root> <new-definition-directory>`.

Independent review corrected the compact recipe's resumption registry to follow Boss-reply suspension rather than interrupt targets; the regression exercises a real FSM with `BOSS_REPLY` routing and no `BOSS_INTERRUPT`, and verifies refusal of an empty registry without replacing the accepted artifact.

Subsequent paired measurements use the builder's full and compact forms with the independently required canonical completion-mapper correction applied identically; prior frozen candidates remain audit records and establish no retained gain.

The controlled successful comparison linked the fixed FSM in 70.284 seconds with the full helper recipe and 96.695 seconds with the compact recipe; both passed strict/link checks and independent real-Git acceptance.
The compact technique is rejected, and `slc/link.md` again contains the full contract.
The historical compact entry is retained only at `scripts/experiments/rejected-compact-link.md`, outside the package surface and production semantic closure.
The builder's default is now full; `--compact` explicitly reproduces the rejected experiment, while `--baseline` reproduces the full contract without helper instructions.

After restoration, the full-contract tests read `slc/link.md` again, the packed surface excludes the companion and rejected fixture, and production incremental closure tracks the helper alone alongside the existing phase definitions.
