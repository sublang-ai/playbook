<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-051: Shared Host Capabilities, DEV Acceptance, and Data-Driven Definitions

## Status

Done — v12.1.0 carries the facade, the DEV live scenario, and the compiled-execution definitions

## Intent

Publish the single worktree host-capability implementation as a typed facade per [DR-046](../decisions/046-public-worktree-host-capabilities.md), cover the DEV workflow in the live release gate, and give each shipped compile definition its explicit compiled-execution contract per [DR-047](../decisions/047-compiled-execution-contract-in-definitions.md), so consumers stop copying the classifier and stop rebuilding compiled phases on rule edits.

## Deliverables

- [x] `@sublang/playbook/host-capabilities` is exported, packaged, spec-pinned, smoke-checked as a packed consumer, and documented.
- [x] The live acceptance suite drives `/dev` through its nested `code` and `review` chain against the packed candidate.
- [x] `slc/text2gears.md`, `slc/gears2fsm.md`, and `slc/link.md` carry their `## Compiled execution` sections and the meta-compile rule.
- [x] A release carries all three so consumers can adopt them together.

## Tasks

1. [x] Record [DR-046](../decisions/046-public-worktree-host-capabilities.md), [DR-047](../decisions/047-compiled-execution-contract-in-definitions.md), and this ledger.
2. [x] Publish the host-capabilities facade with its specs, surface pins, packed-consumer smoke step, and embedding guide section.
3. [x] Add the DEV live acceptance scenario and its fixture configuration.
4. [x] Add the compiled-execution sections and the meta-compile rule to the shipped definitions.
5. [x] Prepare and publish the release.

## Verification

- `npm test`, `npm run build`, `npm run check:links`, and the release smoke pass with the new subpath and definitions.
- The DEV scenario passes in the live acceptance suite against the packed candidate.
- The Spex 3.0.0 linter reports no errors.
