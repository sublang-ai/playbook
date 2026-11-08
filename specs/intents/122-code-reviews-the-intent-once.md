<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-122: CODE Reviews the Intent Once

## Status

Implemented (2026-11-08).

## Intent

Make CODE call REVIEW once after the whole intent is implemented, bound REVIEW to three rounds with a distinct terminal, and verify both end to end, per [DR-102](../decisions/102-code-reviews-the-intent-once.md).

## Deliverables

- [x] CODE source, GEARS, FSM, and linked runtime with one review state after the final phase and no prior-phase relay.
- [x] REVIEW source, GEARS, FSM, linked runtime, and public output interface with the three-round bound and its `unsettled` terminal.
- [x] Spec items, map, and changelog in agreement; `spex lint` clean.
- [x] Conformance, runtime, host, and acceptance expectations updated and green.

## Tasks

1. Specify, implement, and verify the one-review CODE and the bounded REVIEW in one commit.

## Verification

- `pnpm test` and `npm run prepush` pass on the branch.
- The CODE and REVIEW conformance suites pin the new routes, terminals, and relays.
