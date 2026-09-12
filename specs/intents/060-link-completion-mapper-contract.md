<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-060: Synchronize the Linked Completion Mapper Contract

## Status

Done (2026-09-12)

## Intent

Remove a stale closed-member clause from the link definition that conflicts with the existing canonical completion-mapper contract [[playbook-runtime-69](../packages/playbook-runtime.md#playbook-runtime-69)].

## Deliverables

- [x] Full link contract synchronized with the existing deferred and unresolved completion evidence.
- [x] Reproducible corrected full and compact 12.3 candidates with identical non-entry inputs.
- [x] Contract, real deferred-completion and paired-overlay checks.

## Tasks

1. [x] Synchronize the normative clause and reproduce both controlled definitions without changing the engine or helper.

## Verification

The live fixed-FSM `compile-kZMeS0` linker correctly refused the full-v2 definition because it forbade `deferred` and `unresolved` completion evidence already required by the canonical runtime spec and implemented by installed Playbook 12.3.
The compact `compile-XFta7p` run was cancelled before its result counted because its binding companion contained the same contradiction.

The corrected clause permits the existing `deferred` binding and literal `unresolved: true`, retaining the canonical mutual exclusions; no engine or helper bytes change.
The compact-integrity test reverses relocation and removes exactly this clause correction to restore the full `1e74eb4` contract hash.
The real repository tests exercise repeated deferred checkpoints with cumulative reconciliation and checkpoint mismatch fencing/restoration.
The paired-builder acceptance verifies identical hashes for every non-entry output and unchanged installed inputs, while the actual SLC probe confirms discovery and helper/companion invalidation for both forms.

Reproduce the compact candidate with `node scripts/build-link-experiment-12.3.mjs <installed-playbook-package-root> <new-compact-directory>` and the full candidate with the same command plus `--full`.
The immutable corrected candidates are `/private/tmp/playbook-materializer-compact-corrected-12.3` and `/private/tmp/playbook-materializer-full-corrected-12.3`; the old candidates remain untouched for audit.
The corrected full entry hashes to `683e4fbe489c8e70e03651ae725c1f85d9bdd93e4e4ebcf4bd51eee55173d8ec`, its rebased companion to `05bcbc67c28a3a4a65b17872c5fdafcaa0aa3e98ced0e34b188a060282c76021`, and the unchanged compact entry to `a00a5b7996d1449bff312299f804906256c6dcd5fef18d472dd99833c6d0f7dc`.
