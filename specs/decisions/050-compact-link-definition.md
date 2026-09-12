<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-050: Compact Link Definition

## Status

Rejected (2026-09-12): no demonstrated compilation improvement.

## Context

An experimental split reduced the always-relayed linker definition by about 80%, moving normative runtime behavior into a companion while retaining shared-factory authoring obligations under [DR-019](019-shared-linked-runtime-factory.md).
Two cold minimal-workflow runs used the same source, Playbook 12.3.0, Cligent 0.24.0, Claude Opus 5 at low effort, optimization, and one compilation agent:

| Run | Total compilation | Link phase | Result |
| --- | --- | --- | --- |
| Baseline `compile-iS1Lmh` | 330.026 s | 158.223 s | Failed prompt-body fidelity because the FSM interpolated runtime text into its domain prompt. |
| Split `compile-umeUCL` | 356.240 s | 194.863 s | Failed linked-module construction because `roleStates.work.label` differed from the FSM description. |

Local evidence is retained in `/private/tmp/slc-performance-evidence/<run>/summary.json`, `diagnostics.log`, and emitted artifacts; both summaries record source SHA-256 `7e627b1d32e3b08fafdad971cbf97ce03ee6d64f5c8ddecf23b518c1e362cf92`.
The independent FSM generations and different failures prevent attributing the timing difference to the split, but neither run demonstrates a successful faster compile.

## Decision

Discard the definition split and all associated packaging, sidecar, and test changes rather than retain an optimization without measured benefit.
Keep the original monolithic definition and existing conformance gates.

## Consequences

The experiment records no claim that smaller input causes slower compilation.
A future experiment may compare linking one fixed, already-conformant FSM to isolate definition retrieval; that experiment is not an adopted technique.
Any future companion design must remain outside direct-child phase discovery and participate in machine-readable semantic-input closure; ordinary Markdown links alone do not invalidate SLC reuse.
