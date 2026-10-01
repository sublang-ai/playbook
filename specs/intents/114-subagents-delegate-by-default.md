<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-114: Subagents Delegate by Default

## Status

Completed (2026-10-01): the subagent model admits `inherit` and defaults to it where the adapter serves one, the subagent effort is a fifth tuning field through the launcher, the session store, the headless run and the Captain shell on Cligent 0.30, documented, and released in 17.3.0.

## Intent

Realize [DR-076](../decisions/076-subagents-delegate-by-default.md): `subagentModel` admitting `inherit` and defaulting to it where the adapter serves one, `subagentEffort` as a fifth tuning field, both carried as tuning through the launcher, the session store and the Captain shell on Cligent 0.30.

## Deliverables

- [x] DR-076 with its reciprocal links and the map row.
- [x] The CLI, Captain, storage and release items naming the literal, the default and the fifth field.
- [x] The launcher, session store, headless run and Captain shell carrying both, the default resolved at the launcher, the suites extended, the capability probes naming the new setting.
- [x] The documentation, template comment and help texts; the changelog naming the default change.
- [x] `@sublang/cligent` at `^0.30.0` with a lockfile from the public registry and release-19's floor check; the release.

## Tasks

1. [x] Record the decision.
2. [x] Amend the spec items.
3. [x] Carry the field and the default through the code, and extend the suites and probes.
4. [x] Document and add the changelog entries.
5. [x] Once Cligent 0.30.0 is published, require `^0.30.0` with a refreshed lockfile, move release-19's floor check, and release.

## Verification
- Tasks 1–4 (2026-10-01): `spex lint` reported 0 errors; `pnpm build` passed; `pnpm test` passed 2,591 with 23 skipped and the Cligent release-capability suite 97 of 97 against a local build of Cligent 0.30; `pnpm check:links` resolved all relative links.
  An adversarial review confirmed three record and test lags, all amended, and no code defect.
- Task 5 (2026-10-01): with `@sublang/cligent` 0.30.0 from the public registry, `pnpm test` passed with the capability suite whole, `pnpm check:links` resolved every relative link, and the pull request's CI passed; `pnpm smoke:release` passed before tagging.
- The paid live acceptance gate was not run; Cligent 0.30.0's own live acceptance proved the subagent definitions, the inherit literal and the effort against the real Claude runtime.
