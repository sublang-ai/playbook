<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-100: DEV Analyst Plans the Path

## Status

In progress.

## Intent

Bound DEV's Analyst to choosing the development path with a short planning note, leaving analysis, design, and implementation to the playbooks DEV calls.

## Deliverables

- [ ] DR-061 records the bounded planning result, the route-changing Boss question, and its amendment scope over DR-044.
- [ ] The playbook package requires the planning-note bound, the question rule, and their prompt-contract coverage.
- [ ] The maintained DEV source, GEARS, FSM, registry intent, docs, and changelog carry the new planning instruction together.

## Tasks

1. [ ] Record DR-061 with its reciprocal DR-044 link and map row, and add the DEV prompt-composition and prompt-coverage items.
2. [ ] Rewrite the DEV planning instruction through source, GEARS, and FSM, extend the prompt-contract suite, and update the registry intent, docs, and changelog.

## Verification

- `pnpm build` regenerates the DEV runtime siblings from the edited FSM.
- `pnpm test` runs `spex lint` and the whole Vitest suite, including the DEV source-to-GEARS, GEARS-to-FSM, and prompt-contract suites.
- `node scripts/check-links.mjs` resolves the new decision and map links.
