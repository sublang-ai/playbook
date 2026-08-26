<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-045: Coherent abort settlement

## Status

Done

## Intent

Implement DR-036 so every public boundary of the linked runtime and of DECIDE's bespoke runtime classifies cancellation by exact causal identity at each latch site, settles on the machine's state under one precedence order, refuses delivery on an already-aborted signal, and holds invocation-acquired resources until settlement.

## Deliverables

- [x] The shared start helper and every nested-bridge latch or report site classify against the applicable signal, finishing cancellation-coupled pairs `aborted`.
- [x] Settlement precedence places terminal completion ahead of a coincident abort in the engine and in DECIDE.
- [x] An already-aborted resume delivers nothing and preserves the pending call for a later resume.
- [x] The apply boundary drops a post-publication delivery rejection identical to its own abort reason.
- [x] The script actor's abort ownership spans the invocation, and abort settlement awaits the group's confirmed teardown.
- [x] A startup actor error rides the emission channel into the failed-start cleanup, and the boundary sentinel releases on every settlement exit.

## Tasks

1. Record DR-036 and implement its settlement model across the shared runtime, nested bridge, script actor, and DECIDE, with probe-derived verification, in one commit.

## Verification

- Probe-derived suites cover each repaired class: exact-reason sink rejections at every start boundary, the completed-machine abort race on both public boundaries, the refused pre-aborted resume with its later successful delivery, the post-exit script abort with a surviving descendant, and the init-time entry-action throw.
- Deterministic suites, the link and SPDX checks, the packed release smoke, and the compiled-artifact fidelity gate pass.
