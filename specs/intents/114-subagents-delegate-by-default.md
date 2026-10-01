<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-114: Subagents Delegate by Default

## Status

In progress on `subagent-effort` (2026-10-01).

## Intent

Realize [DR-076](../decisions/076-subagents-delegate-by-default.md): `subagentModel` admitting `inherit` and defaulting to it where the adapter serves one, `subagentEffort` as a fifth tuning field, both carried as tuning through the launcher, the session store and the Captain shell on Cligent 0.30.

## Deliverables

- [x] DR-076 with its reciprocal links and the map row.
- [x] The CLI, Captain, storage and release items naming the literal, the default and the fifth field.
- [x] The launcher, session store, headless run and Captain shell carrying both, the default resolved at the launcher, the suites extended, the capability probes naming the new setting.
- [x] The documentation, template comment and help texts; the changelog naming the default change.
- [x] `@sublang/cligent` at `^0.30.0` with a lockfile from the public registry and release-19's floor check; the release.

## Tasks

1. Record the decision.
2. Amend the spec items.
3. Carry the field and the default through the code, and extend the suites and probes.
4. Document and add the changelog entries.
5. Once Cligent 0.30.0 is published, require `^0.30.0` with a refreshed lockfile, move release-19's floor check, and release.

## Verification

