<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-100: DEV Analyst Plans the Path

## Status

Complete.

## Intent

Bound DEV's Analyst to choosing the development path with a short planning note, leaving analysis, design, and implementation to the playbooks DEV calls.

## Deliverables

- [x] DR-061 records the bounded planning result, the route-changing Boss question, and its amendment scope over DR-044.
- [x] The playbook package requires the planning-note bound, the question rule, and their prompt-contract coverage.
- [x] The maintained DEV source, GEARS, FSM, registry intent, docs, and changelog carry the new planning instruction together.

## Tasks

1. [x] Record DR-061 with its reciprocal DR-044 link and map row, and add the DEV prompt-composition and prompt-coverage items.
2. [x] Rewrite the DEV planning instruction through source, GEARS, and FSM, extend the prompt-contract suite, and update the registry intent, docs, and changelog.

## Verification

- `pnpm build` regenerated `dev.fsm.js`, `dev.playbook.js`, and `dev.registry.js`; every declaration output stayed byte-identical.
- `node scripts/check-slc-source-gears.mjs reference/sdlc/dev.md reference/sdlc/dev.playbook/dev.gears.md` reported no findings.
- On a clean lockfile install, `pnpm test` ran `spex lint` with 0 errors and 253 warnings — one more advisory sentence-count finding than before, for the new two-statement item — and 1962 passing Vitest tests, including the DEV suites.
- The one failure, the temp-directory case in `src/fsm-scaffolding.test.ts`, fails identically on the untouched `main`.
- `node scripts/check-links.mjs` resolved all 3057 relative links in 186 files.
