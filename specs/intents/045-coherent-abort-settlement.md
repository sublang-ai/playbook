<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-045: Coherent abort settlement

## Status

Done

## Intent

Implement DR-036 so every public boundary of the linked runtime and of DECIDE's bespoke runtime classifies cancellation by exact causal identity at each latch site, settles on the machine's state under one precedence order, refuses delivery on an already-aborted signal, and holds invocation-acquired resources until settlement.

## Deliverables

- [x] The shared start helper and every nested-bridge latch or report site classify against immutable applicable-signal provenance and apply DR-036's phase matrix without reclassifying stored distinct failures.
- [x] Settlement precedence places terminal completion ahead of a coincident abort in the engine and in DECIDE.
- [x] An already-aborted resume delivers nothing and preserves the pending call for a later resume.
- [x] The apply boundary drops a post-publication delivery rejection identical to its own abort reason.
- [x] The script actor's abort ownership spans the invocation, and abort settlement awaits the group's confirmed teardown.
- [x] A startup actor error rides the emission channel into the failed-start cleanup, and the boundary sentinel releases on every settlement exit.

## Tasks

1. Record DR-036 and implement its settlement model across the shared runtime, nested bridge, script actor, and DECIDE, with probe-derived verification, in one commit.

## Verification

- Probe-derived suites cover each repaired class: exact-reason sink rejections at every start boundary; single recorded nested finishes under invocation and resume cancellation; immutable invocation-plus-resume provenance; nested emission drains, exact-filtered abort-cleanup aggregation, and background exact-versus-distinct reports that cannot be reclassified by a later boundary; the completed-machine abort race on both public run boundaries; pre-aborted Boss input and the refused pre-aborted resume with its later successful delivery; accepted-apply settlement before publication and exact-versus-distinct delivery failure after publication; post-exit and rejecting-tail script aborts with a surviving descendant, including `ESRCH`, persistent-`EPERM`, timeout, and probe-error teardown outcomes; null abort-reason identity; the init-time entry-action throw; and active-boundary sentinel release after every settlement exit.
- Deterministic suites, the link and SPDX checks, the packed release smoke, and the compiled-artifact fidelity gate pass.
