<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-080: Relay and Return Representations

## Status

In progress; producer clarification and common-input adoption completed; live efficacy pending.

## Intent

Align prose-required relay and terminal-return guidance with the existing Source-fidelity and Results contracts, without changing authored behavior or weakening checks.

## Deliverables

- [x] Explicit bare-placeholder guidance and lawful terminal-return placement.
- [x] Actual Source-fidelity and Results parser representation cases.
- [x] New immutable common input assembly.
- [ ] Separately adjudicated live observations of the corrected inputs.

## Tasks

1. [x] Clarify untemplated relay rendering under [[compiler-prompt-relays-3](../packages/compiler-prompt-relays.md#compiler-prompt-relays-3)] and terminal-return placement under [[compiler-results-3](../packages/compiler-results.md#compiler-results-3)].
2. [x] Adopt the same correction in new comparison inputs without changing historical runs.
3. [ ] Report live efficacy separately from assembly.

## Verification

- C3 restored REVIEW `phase-S7Qx6S` retained the exact terminal return in all three complete-result descriptions but added sixteen un-authored labels to otherwise required quoted runtime values.
- The SLC Source-fidelity contract accepts a bare quoted placeholder in that case; the checker matched its existing contract while the phase wording left the lack of a label insufficiently explicit.
- Preserve Source-authored labels exactly; do not infer labels from field names or change the original source to satisfy the compiler.
- An explicit return clause in a complete Results description states caller-visible output, whereas a completion predicate alone does not.
- This is a correctness clarification, not a demonstrated latency improvement; preserve the failed run and every prior definition overlay.
- Eight integration cases pass against the actual C3 parser/checker and runtime composer, including bare versus un-authored labelled relays, exact Source-authored labels, and explicit return clauses inside complete Results descriptions.

The v5 builder reconstructs the exact prior v4 text-to-GEARS SHA by reversing only the two representation sentences, then retains its prior exact published-definition reconstruction.
All 14 real CLI/discovery/closure tests pass against the unchanged C3 compiler; both test files pass strict TypeScript.
New roots `/private/tmp/playbook-13.2-common-v5-baseline`, `/private/tmp/playbook-13.2-common-v5-full` and `/private/tmp/playbook-13.2-fsm-scaffold-v2-pair` share the corrected text-to-GEARS SHA `bbefc6806bd84c5b181ef1014a7cbe2d21663be3ce4e2098499b07b134835970`.
Only `playbook/link.md` differs in the link pair and only `playbook/gears2fsm.md` differs in the scaffold pair.
The 228-entry C3 compiler inventory, its existing cache, every v4 root and the prior durable v4 evidence remain unchanged.
[New assembly evidence](../../scripts/experiments/link-experiment-13.2-representation-evidence.json) records all output, input and preservation identities without a provider or performance claim.
