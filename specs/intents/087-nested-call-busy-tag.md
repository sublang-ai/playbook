<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-087: Nested Call Busy Tag

## Status

Complete.

## Intent

Correct the gears2fsm tagging guidance so suspended nested-playbook call states settle through the runtime's suspended-call path instead of remaining busy forever.

## Deliverables

- [x] gears2fsm busy-tag guidance scoped to direct-Captain, delegated-player, and script working leaves.
- [x] nested-call guidance requires `playbook.suspended` without busy on the call state or any ancestor through the machine root.
- [x] compiler-nested-tags spec package and map entry.
- [x] Narrow definition/runtime representation test.
- [x] Root-reviewed final correction before commit.

## Tasks

1. [x] Update the definition, spec, and narrow test without changing the runtime engine, frozen cohorts, or experiment builders.

## Verification

- `./node_modules/.bin/vitest run src/compiler-nested-tags.test.ts` passed one focused definition/runtime representation test with suspended-only, root-busy, ancestor-busy, and active-sibling-busy normalizer cases.
- `spex lint` passed with zero errors and the existing warning profile.
- `git diff --check -- slc/gears2fsm.md specs/packages/compiler-nested-tags.md specs/intents/087-nested-call-busy-tag.md specs/map.md src/compiler-nested-tags.test.ts` passed.
