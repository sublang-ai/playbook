<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-088: Nested Call Definition Corrections

## Status

Complete.

## Intent

Tighten nested-call compiler-definition wording so text2gears keeps the fixed call verb phrase and gears2fsm omits impossible redundant child-success fallbacks.

## Deliverables

- [x] text2gears nested-call wording for exact literal and dynamic call syntax.
- [x] gears2fsm nested-call wording for unreachable `onDone` arm omission after preserving authored and control-error routes.
- [x] compiler-nested-calls spec package and map entry.
- [x] Focused structural definition test.
- [x] Root-reviewed final architecture before commit.

## Tasks

1. [x] Update the nested-call definitions, spec, and focused test without changing runtime code, frozen cohorts, experiment builders, or provider behavior.

## Verification

- `./node_modules/.bin/vitest run src/compiler-nested-calls.test.ts` passed two focused structural definition tests.
- `spex lint` passed with zero errors and the existing warning profile.
- `git diff --check -- slc/text2gears.md slc/gears2fsm.md specs/map.md specs/packages/compiler-nested-calls.md specs/intents/088-nested-call-definition-corrections.md src/compiler-nested-calls.test.ts` passed.
