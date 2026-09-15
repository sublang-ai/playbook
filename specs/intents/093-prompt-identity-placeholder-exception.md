<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-093: Prompt Identity Placeholder Exception

## Status

Complete.

## Intent

Clarify that Source-declared local-role prompt identity placeholders are resolved by the linked runtime's invocation-scoped role identity lookup rather than persisted as ordinary runtime-value fields.

## Deliverables

- [x] The GEARS-to-FSM definition distinguishes ordinary runtime-value placeholders from Source-declared local-role prompt identity placeholders.
- [x] The playbook prompt placeholder spec records the ordinary-value and prompt-identity cases with the runtime binding citation.
- [x] Contract tests cover both ordinary runtime-value fields and local-role prompt identity non-persistence.
- [x] A real CODE run confirms the corrected definition in the current live compiler cohort.

## Tasks

1. [x] Update the definition, spec, and focused prompt-relay tests without changing runtime metadata architecture or published packages.
2. [x] Record live CODE evidence after the root-managed provider run settles.

## Verification

- Word-contract checks in `src/compiler-prompt-relays.test.ts` cover the definition and spec wording for ordinary runtime-value fields and local-role prompt identity non-persistence.
- Runtime integration coverage comes from `src/link-materialization-labelled.test.ts` for identity placeholders, actual current lookup, undeclared identity metadata rejection, overlapping identity metadata rejection, and maintained CODE/DEV factory wiring, plus existing runtime restoration coverage for prompt identity boundaries.
- `./node_modules/.bin/vitest run src/link-materialization-labelled.test.ts --reporter=verbose` passed all 5 labelled materializer tests.
- `./node_modules/.bin/vitest run src/compiler-prompt-relays.test.ts src/compiler-task-input.test.ts --reporter=verbose` passed with 6 tests and 3 existing skipped compiler-backed cases when no experiment compiler is configured.
- `PLAYBOOK_EXPERIMENT_COMPILER=/private/tmp/slc-c8-compiler-ezn78503 ./node_modules/.bin/vitest run src/compiler-prompt-relays.test.ts --reporter=verbose` passed all 5 prompt-relay tests against the frozen C8 compiler verifier before the final review wording correction; the final correction changed only the asserted Source-role phrase and was covered by the later prompt-relay rerun.
- `npm run build -- --pretty false` passed before final review wording corrections; the final corrections changed Markdown wording and test assertions only.
- The independent review task ran `/opt/homebrew/bin/spex lint` against installed `@sublang/spex` 3.0.0 with exit 0, 0 errors, and 253 existing warnings; evidence is `/private/tmp/slc-ir093-critical-review/checks-final.json`.
- `git diff --check -- slc/gears2fsm.md specs/packages/playbook.md specs/intents/093-prompt-identity-placeholder-exception.md src/compiler-prompt-relays.test.ts` passed in the independent review task.

- The [accepted C10/v13 CODE pair](../../scripts/experiments/c10-v13-code-link-pair-evidence.json) preserves original Source and accepted GEARS, then uses real resumed FSM `2E2YFN` and links `crYwRj` / `aMUkFr`; each ordinary emitted entry passes strict TypeScript, import, eight generated tests, and all eighteen runtime cases with real Git and controlled player/child responses.
- The accepted runtime cases preserve the literal Coder identity token in Source and obtain its value through the current host prompt-identity lookup, including restored resumed and fresh questions.
- Post-runtime checks preserve all 11921 baseline and 11922 candidate wrapper inputs; this is accepted resumed phase-chain correctness and a matched link measurement, not a cold full-source CODE timing.
