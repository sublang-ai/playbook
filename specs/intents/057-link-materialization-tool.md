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
2. Record the measurement-based retention or rejection decision.

## Verification

- The real-CLI matrix passes against the worktree's Playbook 13.1 and the separately locked Playbook 12.3, including factory preflight, exact labels, typed and snapshotted options, actual shell execution, native TypeScript loading, and target preservation on refusals.
- The packed-file and packed-Markdown checks include the helper and sidecar and retain valid definition links.
- `scripts/check-slc-definition-closure.mjs` against the current built SLC runs its real source, FSM, and link gates: the unchanged second run performs no phase calls, and a helper-only content mutation reruns only `link.md`.
- `/private/tmp/playbook-materializer-overlay-12.3-v2` preserves the installed 12.3 phase definitions and adds only the optional helper recipe, three source-effect disposition sentences, helper, and sidecar; the runtime engine remains the exact installed 12.3 package.
- A copied real minimal FSM produces a 4,584-byte module that passes the locked SLC TypeScript 6 compiler and current prompt-conformance checks; this is correctness evidence, not a measured compilation-speed gain.
- Live fixed-FSM and full-cold measurements remain pending; the experiment is not retained or released.
