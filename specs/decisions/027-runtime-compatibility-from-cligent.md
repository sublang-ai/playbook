<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-027: Runtime Compatibility from Cligent

## Status

Accepted

## Context

[DR-026](026-optional-adapter-sdks.md) made the agent SDKs optional peers and added a gate that probes each adapter before launch.
It also left this repository holding three copies of knowledge that `@sublang/cligent` now owns and publishes in cligent DR-013 [[1]]:

| Copy | Where | Failure it caused or invites |
| --- | --- | --- |
| Adapter-to-SDK map | `ADAPTER_SDKS` in the gate module | Goes stale silently; already omits runtimes cligent gates (`gemini`'s CLI) |
| Mirrored peer ranges | `peerDependencies` + the release-27 identity test | Every cligent floor move forces a playbook release; the mirror froze at `>=0.138.0` while cligent moved to `>=0.144.0` |
| Boolean probe verdict | `isAvailable()` collapsed to "not installed" | An installed-but-stale SDK was reported absent; a stale Codex passed the gate and failed mid-turn on a current model |

cligent now ships a runtime descriptor (`@sublang/cligent/runtime-targets`) declaring each adapter's runtimes, supported floors, tested versions, and pinned repairs; enforces the floors inside the loaders `isAvailable()` and `run()` share; exports a structured verdict distinguishing missing from unsupported; and publishes adapter-scoped fast-mode capability metadata and validation.

## Decision

Playbook delegates all agent-runtime version knowledge to cligent and keeps none of its own.

- The gate derives each adapter's runtimes, floors, and repairs from cligent's descriptor.
  Playbook retains only cligent module-path knowledge — which subpath exports which adapter class — which is API shape, not version.
- The gate renders cligent's structured verdict.
  A runtime installed below cligent's floor is reported as unsupported with its installed and required versions, distinctly from absent; the two have different repairs and conflating them sends a user to install what is already present.
- Remedies install cligent's pinned repair spec, so a printed repair can never install a version the gate would refuse again.
- Agent-setting capability also remains cligent knowledge.
  Whenever `fastMode` is present, Playbook shall use cligent's public capability contract to accept or reject that literal boolean before registry preparation, import, readiness, or host work, and shall keep no adapter support list of its own.
- `gemini`'s exemption ends.
  Its rationale — no missing-SDK failure mode — was true but incomplete: its CLI can be absent or below cligent's floor, and the descriptor now names both.
  The gate covers every declared adapter for which cligent publishes runtime targets; adapters without targets keep the unknown-adapter warning.
- Playbook declares no agent-SDK peer ranges.
  cligent's own optional-peer declaration is the single range npm checks; an identical second copy adds no acceptance and one more thing to drift, and a non-identical one is a bug by DR-026's own argument.
  This supersedes DR-026's identical-mirror clause and release-12's identity requirement.
  The SDKs remain `devDependencies` so this repository's tests and acceptance exercise real adapters.

## Consequences

A cligent upgrade alone moves playbook's compatibility policy: floors, verdicts, and repair pins arrive with the dependency, and no playbook release is forced by a cligent floor move.
The same single-owner rule keeps Playbook's adapter-scoped fast-mode validation aligned with the runtime that enforces the call.
Stale runtimes fail before launch with versions named instead of mid-turn with a vendor error.
The npx re-run names pinned repair specs, so a re-run installs versions the gate accepts.
Playbook's manifest carries no agent-SDK version literals; the release-27 identity test becomes an absence test.
This decision supersedes DR-026 in part, as stated above; DR-026's dependency placement, footprint, and gate-before-launch decisions stay in force.

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/specs/decisions/013-cligent-owned-runtime-compatibility.md "cligent DR-013 — runtime compatibility ownership"
