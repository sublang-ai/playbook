<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-057: Prototype Deterministic Link Materialization

## Status

In progress (2026-09-12); experiment awaiting measured retention decision.

## Intent

Provide a bounded optional materializer for a controlled compilation-performance experiment.

## Deliverables

- [x] Strict descriptor, pure emitter, atomic CLI, and optional phase-owned invocation guidance.
- [x] Real-engine emission checks and actual SLC closure evidence.
- [x] Same-engine Playbook 12.3 overlay for independent fixed-FSM and full-cold measurements.

## Tasks

1. [x] Implement and verify the bounded helper and package surface with no engine or release change.
2. [x] Move existing host-boundary guidance into the common full definition and reproduce a fresh baseline/helper pair with exact instruction-only differences.
3. [x] Add and verify the bounded explicit quoted-relay profile and reproduce new comparison inputs without changing prior frozen versions.
4. Record the measurement-based retention or rejection decision.

## Verification

- The real-CLI matrix passes against the worktree's Playbook 13.1 and the separately locked Playbook 12.3, including factory preflight, exact labels, typed and snapshotted options, actual shell execution, native TypeScript loading, and target preservation on refusals.
- The packed-file and packed-Markdown checks include the helper and sidecar and retain valid definition links.
- `scripts/check-slc-definition-closure.mjs` against the current built SLC runs its real source, FSM, and link gates: the unchanged second run performs no phase calls, and a helper-only content mutation reruns only `link.md`.
- `/private/tmp/playbook-materializer-overlay-12.3-v2` preserves the installed 12.3 phase definitions and adds only the optional helper recipe, three source-effect disposition sentences, helper, and sidecar; the runtime engine remains the exact installed 12.3 package.
- A copied real minimal FSM produces a 4,584-byte module that passes the locked SLC TypeScript 6 compiler and current prompt-conformance checks; this is correctness evidence, not a measured compilation-speed gain.
- The common-guide comparison is reproduced with `node scripts/build-link-experiment-12.3.mjs <installed-playbook-12.3-root> <new-directory> --baseline` and the same command with `--full`; only the optional helper section differs between their declared semantic inputs, with identical common host-boundary guidance and unchanged helper bytes.
- The exact-version builder matrix and full-contract suite pass 12 tests, including inverse reconstruction to the installed source, baseline/full instruction parity, unchanged rejected compact reproduction, and refusal of changed baselines or existing outputs.
- Fresh outputs are `/private/tmp/playbook-materializer-baseline-common-guide-12.3` and `/private/tmp/playbook-materializer-full-common-guide-12.3`; the previous frozen matched pair still agrees with all its recorded output hashes.
- The v3 real-CLI matrix passes 19 tests against each actual Playbook 12.3 and 13.1 engine, including both strict-typed profiles, literal mapped relays, empty lines, CRLF, missing values, both installed continuation forms, unchanged `flat-defaults` emission relative to archived v2, and unsupported-profile target preservation.
- The pure v3 module over the unchanged `compile-aZda4G` FSM passes all four unchanged generated suites (8 tests), locked strict TypeScript checking, the actual SLC link-fidelity gate, and a real Git run with one player call, exact quoted Boss text, one commit, and terminal success; `/private/tmp/playbook-materializer-v3-aZ-probe/emission-evidence.json` and `runtime-evidence.json` retain source identities and results.
- Current builder `--full` and `--baseline` outputs are `/private/tmp/playbook-materializer-full-quoted-v3-12.3` and `/private/tmp/playbook-materializer-baseline-quoted-v3-12.3`; `--compact` instead retains the rejected experiment's archived v2 helper, recipe, and exact full companion.
- The current built SLC closure probe still reuses unchanged output and reruns only linking after a helper mutation; independent review found no actionable v3 composition, API-compatibility, or comparison-boundary issue.
- Controlled materializer retention evidence remains pending; the experiment is not retained or released.
