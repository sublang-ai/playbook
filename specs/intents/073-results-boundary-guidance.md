<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-073: Results Boundary Guidance

## Status

Completed; retained for measured phase-formatting improvement.

## Intent

Test whether explicit GEARS result-block boundaries prevent repeated mechanical formatting repairs without changing workflow semantics.

## Deliverables

- [x] Narrow definition guidance and actual-parser integration cases.
- [x] Immutable baseline and treatment overlays differing only in that guidance, with complete semantic-input identities.
- [x] Matched phase measurements and independent source-fidelity adjudication before retaining or rejecting the treatment.

## Tasks

1. [x] Prepare the guidance, parser checks, and isolated comparison inputs.
2. [x] Measure the matched DECIDE case, retain every attempt, and activate the guidance after correct outputs and a measured reduction.

## Verification

- Five specified clean/restored CODE, DECIDE, and REVIEW traces required result-placement repair; three second repairs contained only result-boundary findings and occupied 25.294, 25.927, and 23.854 seconds between dispatches.
- These intervals establish a candidate cost, not achieved savings; mixed source-format repairs remain separately attributed.
- Preserve nested-call continuation and authored prompt/result bytes in real parser fixtures.
- Keep source, model, effort, executor strategy, compiler, and all other semantic inputs equal within each comparison.
- Treat independent source-fidelity failures separately from clarification and do not count them as successful speed measurements.
- Reproducible private trace projections: `/private/tmp/slc-current-code-adjudication/repair-patterns.json` and `capture-round-two.py`.
- Prepared phase pair: `/private/tmp/slc-results-boundary-pair-v1`, with proof SHA-256 `38d62f564aaaa69115fed561533895afd84c88e14c3b75740dc29e264f686a97` and reproduction instructions under `/private/tmp/slc-results-boundary-experiment`.
- Actual C2 discovery reports complete closures; synthetic `buildSlcDeps`/`runSlc` checks select interpreted execution in both arms and preserve every input, without provider calls.
- The sequential baseline/treatment pair `phase-HzK0ck`/`phase-bhO9RV` used the same DECIDE source, C2 compiler, Opus 5 low settings, disabled independent Reviewer and interpreted strategy; only the 379-byte Results guidance differed in the declared pipeline closure.
- Both final GEARS artifacts independently preserve parallel independence, the proposal barrier and restart, complete acting prompts, receipt authority, and strict scoped child success/failure.
- Execution elapsed time fell from 129,649 to 98,559 ms (31,090 ms; 23.98%), with three calls versus two.
- Both first corrections still included quote and Results-placement errors; only baseline required a second correction for four malformed Results entries.
- This single baseline-first pair establishes a retained phase improvement, not a universal or full-compilation speed claim.
- Sanitized measurements and source/definition/trace identities are retained in `scripts/experiments/results-boundary-evidence.json`; exact visible write/edit requests and current findings remain in `/private/tmp/slc-results-boundary-adjudication` without hidden reasoning.
- Six Results/relay integration cases pass against the actual C2 parser/composer; both observed final outputs pass the source/result checks and have four byte-identical prompt bodies.
