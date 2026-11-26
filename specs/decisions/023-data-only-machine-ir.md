<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-023: Data-Only Machine IR for Linked Artifacts

## Status

Accepted.
Amended by [DR-024](024-runtime-engine-provisioning.md).

## Context

A thin linked module imports the shared engine through the bare specifier `@sublang/playbook/xstate-runtime`, and its generated FSM artifact imports `xstate` directly.
A global-only install (`npm install -g @sublang/playbook`) does not make either specifier resolvable from an arbitrary working directory, so compiled artifacts only run where a project-local install supplies the closure.

A resolution-hook bridge — Node module customization hooks redirecting `@sublang/playbook/*` to the global install for global-only consumers — was considered and is rejected:

- Generated FSM artifacts import `xstate` at artifact level, so a hook scoped to `@sublang/playbook/*` does not cover them; widening it to third-party specifiers is interposition on packages this project does not own.
- Synchronous `module.registerHooks()` is outside the supported Node floor (`engines` `>=20.6.0`) and carries Release-Candidate stability, so the bridge would raise the floor or ship on an unstable API.
- Redirection papers over resolution instead of versioning it: it invites exactly the artifact/engine skew [DR-022](022-runtime-compatibility-contract.md) exists to reject, while making the skew invisible.

## Decision

- The accepted long-term direction, staged into a future major and not yet implemented: Playbook emits validated, data-only machine specifications with no external package imports; the host materializes each specification into an executable machine using its own playbook and xstate.
- Precondition: a closed, validated machine-IR vocabulary that covers all executable machine semantics — guards, assign actions, actor input builders, parsing, error handling, counters, and resume transformations — not guards alone.
  No partial migration ships before the vocabulary provably closes over everything current FSM artifacts execute.
- A data-only artifact declares a new `artifactSchema` under the [DR-022](022-runtime-compatibility-contract.md) contract, so older engines reject it by name instead of misinterpreting it.
- This direction does not gate the documented global-only consumption model, whose near-term mechanism and acceptance gate are those of [DR-024](024-runtime-engine-provisioning.md).

## Consequences

- Materialization moves from load-time module resolution to host-side construction, removing the artifact-level package imports that make global-only installs fail today.
- The IR vocabulary is the cost: every executable semantic must be expressible, validated, and versioned before the format can carry real workflows.
- Delivery is breaking by design and lands in a future major; until then, [DR-022](022-runtime-compatibility-contract.md) metadata and [DR-024](024-runtime-engine-provisioning.md) provisioning are the shipped posture.
