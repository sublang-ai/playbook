<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-113: The Subagent Model Is Tuning

## Status

In progress on `subagent-model` (2026-09-30).

## Intent

Realize [DR-075](../decisions/075-subagent-model-is-tuning.md): `subagentModel` as a fourth tuning field of agent blocks and role bindings, validated through the installed Cligent, carried in every complete call setting, erased from the structural projection, and the Cligent floor at the first release serving it.

## Deliverables

- [x] DR-075 with its reciprocal links to DR-021, DR-032 and DR-074, the map row, and the CLI, Captain, storage and release items naming the fourth field.
- [x] The launcher, session store, headless run and Captain shell carry the field as tuning, with the tests of each class extended and the Cligent capability probes naming the new surface.
- [x] The documentation, template comment and help texts name the field; nothing seeds one.
- [x] `@sublang/cligent` at `^0.29.0` with a lockfile from the public registry and release-19 checking that floor; the changelog.

## Tasks

1. [x] Record DR-075 and amend the spec items.
2. [x] Carry the field through the launcher, the session store, the headless run and the Captain shell, and extend the suites and the capability probes.
3. [x] Document the field and add the changelog entries.
4. [x] Once Cligent 0.29.0 is published, require `^0.29.0` with a refreshed lockfile and move release-19's floor check.
5. [ ] Record the verification.

## Verification

