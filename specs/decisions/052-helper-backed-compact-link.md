<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-052: Helper-Backed Compact Linking Recipe

## Status

Rejected (2026-09-12): the controlled successful comparison demonstrated no compilation-speed improvement.

## Context

The optional materializer of [DR-051](051-link-materialization-tool.md) removes repetitive output generation.
A compact metadata recipe was compared with the complete helper-instructed definition after the compiler supplied the actual definition directory to both executions.
Both cold link runs used GPT-6 Astra at low effort, installed Playbook 12.3.0, the same compiler and harness, and the same 12,554-byte FSM with SHA-256 `4de885cae296bfa1802aaeb9526142d174c1ef98c9d56259008f2416bb0b4d22`.

| Definition | Run | Link phase | Tools | Result |
| --- | --- | --- | --- | --- |
| Full helper-instructed contract | `compile-B6ZwA7` | 70.284 s | 6 | Passed strict TypeScript, link conformance and real-Git execution. |
| Compact metadata recipe | `compile-VWL108` | 96.695 s | 8 | Passed the same checks and real-Git execution. |

Compiler fingerprint `03e2960950937414ba617c7feaf4ca86bf1b4f8823f471505a77197348da252d` and harness fingerprint `3c8b3d825c7c59498c3d694a743ea9f8eba84e41370aa5f06437dcec4e08cb0d` match across the two summaries under `/private/tmp/slc-performance-evidence/<run>/summary.json`.
The corresponding `/private/tmp/slc-fixed-link-runtime-probe/B6ZwA7.json` and `VWL108.json` record the separate real-runtime acceptance checks.

## Decision

Restore the complete link definition as the shipped entry and remove the production compact companion and its packaging/closure dependency.
Retain the rejected compact entry only as an explicitly named, non-shipped experiment fixture for reproducing the comparison.
Keep the materializer's independent retention decision under [DR-051](051-link-materialization-tool.md) pending its own controlled baseline evidence.

## Consequences

This pair provides no evidence for retaining the compact recipe; it does not establish that smaller prompts are intrinsically slower.
The complete runtime contract and existing conformance checks remain mandatory.
The experiment builder can reproduce the rejected compact form explicitly, while its normal form uses the full definition.
