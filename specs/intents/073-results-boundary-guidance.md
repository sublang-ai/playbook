<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-073: Results Boundary Guidance

## Status

In progress; unmeasured experiment.

## Intent

Test whether explicit GEARS result-block boundaries prevent repeated mechanical formatting repairs without changing workflow semantics.

## Deliverables

- [x] Narrow definition guidance and actual-parser integration cases.
- [ ] Immutable baseline and treatment overlays differing only in that guidance, with complete semantic-input identities.
- [ ] Matched phase measurements and independent source-fidelity adjudication before retaining or rejecting the treatment.

## Tasks

1. [ ] Prepare the guidance, parser checks, and isolated comparison inputs.
2. [ ] Measure matched source cases, retain every attempt, and accept or discard the treatment based on correct outputs and measured efficiency.

## Verification

- Five specified clean/restored CODE, DECIDE, and REVIEW traces required result-placement repair; three second repairs contained only result-boundary findings and occupied 25.294, 25.927, and 23.854 seconds between dispatches.
- These intervals establish a candidate cost, not achieved savings; mixed source-format repairs remain separately attributed.
- Preserve nested-call continuation and authored prompt/result bytes in real parser fixtures.
- Keep source, model, effort, executor strategy, compiler, and all other semantic inputs equal within each comparison.
- Treat independent source-fidelity failures separately from clarification and do not count them as successful speed measurements.
- Reproducible private trace projections: `/private/tmp/slc-current-code-adjudication/repair-patterns.json` and `capture-round-two.py`.
