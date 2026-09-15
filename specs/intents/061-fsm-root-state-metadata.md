<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-061: Reserve Public Metadata for Workflow States

## Status

Done (2026-09-12)

## Intent

Make the GEARS-to-FSM producer omit machine-root public-state metadata so the shared snapshot reader sees only authored workflow states.

## Deliverables

- [x] Narrow producer namespace rule and real XState snapshot evidence.
- [x] Future experiment overlays include the rule while earlier frozen pairs remain unchanged.

## Tasks

1. [x] Clarify root metadata placement and verify the definition and reproducible overlay correction.

## Verification

The observed `compile-ebky3Y` FSM declared a machine-root public state identity, causing the always-active machine root and current workflow node to appear as two public states.
The actual shared snapshot reader treats any own `meta.playbook` namespace as a state declaration, so an empty root namespace also fails and the producer must omit the namespace rather than only its `stateId` member.

Three real XState/shared-reader cases pass: root id and unrelated metadata preserve one changing public state, a root public id remains active beside the workflow node, and an empty root Playbook namespace is rejected.
The paired experiment builder verifies that removing exactly the new producer sentence restores the installed 12.3 definition hash, and its full/compact outputs retain identical non-entry hashes.
The new candidates are `/private/tmp/playbook-materializer-compact-root-corrected-12.3` and `/private/tmp/playbook-materializer-full-root-corrected-12.3`; their corrected `gears2fsm.md` hashes to `3e42baf526a46bbda89f20c3a3db250648e99e381e303925724ca6d62839a619`.
The existing frozen comparison directories are unchanged, and the actual SLC closure probe passes for the new compact candidate.
