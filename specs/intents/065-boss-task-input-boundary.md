<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-065: Preserve Boss Task Input Boundaries

## Status

Completed (2026-09-12).

## Intent

Clarify the existing producer boundary between entry-event task text, required construction configuration, and the typed actor-input relay under [DR-019](../decisions/019-shared-linked-runtime-factory.md).

## Deliverables

- [x] Source-faithful Boss-task input and actor relay clarification.
- [x] Real input/option/composer regressions and unchanged-input counterfactual evidence.
- [x] Reproducible new 12.3 overlay preserving archived experiment inputs.

## Tasks

1. Clarify the producer, verify supported seeds and required configuration, reproduce the failed and repaired task relay privately, and update the exact-version builder.

## Verification

The unchanged `compile-kqEmCN` FSM requires construction `inputTask` despite receiving it through `START`, and its player invocation omits the task field beside `<input-task>`.
The private real XState/composer audit in `/private/tmp/slc-kqEmCN-option-audit/` preserves all original artifact hashes and demonstrates both required-option refusal and the unresolved prompt token.
The failed cold run remains failed; a private repaired replay cannot establish successful compilation timing.

Four typed real-XState/shared-composer regressions pass for fresh task text, a replaced optional seed, a preserved optional seed, and the malformed context-only relay.
The existing helper, package/builder, canonical-question, and state-identity suites pass 30 cases, including genuine required-option validation for both helper profiles.
The 19 helper cases also pass against the actual installed 12.3 engine, retaining its genuine required construction-option checks.
The separate private counterfactual in `/private/tmp/slc-kq-counterfactual/` changes four FSM lines and only the descriptor's task-option requiredness, preserving source, prompt, START, and control-flow semantics.
Its shipped entry is byte-identical to the original; strict TypeScript and all four generated suites pass eight cases, and the installed 12.3 real-Git acceptance passes in 807 ms with one performing call, one commit, the exact Boss task, and terminal success.
Original failed-run hashes remain unchanged; this replay demonstrates the correction only.
The exact-version builder creates `/private/tmp/playbook-materializer-full-boss-task-12.3`; every declared member matches the preceding canonical-storage overlay except producer SHA-256 `576218f65416b0589197c3543aca4cd087e6d7061a466648df6337864eee9bda`.
The archived compact producer remains byte-identical to its reviewed earlier version.
Project TypeScript, relative links, and diff checks pass; Spex 3.0 reports zero errors and 232 pre-existing advisory warnings.
Independent review confirmed the scoped actor-placeholder rule and exact overlay reconstruction.
