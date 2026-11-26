<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-027: Runtime Compatibility from Cligent

## Status

Accepted.
Amended by [DR-103](103-independent-ultracode-tuning.md), [DR-110](110-managed-artifact-environments.md).

## Context

No source file in this repository imports an agent SDK; `@sublang/cligent` owns every adapter.
Playbook first declared the SDKs as hard dependencies, which landed them where a nested Cligent could not resolve them in a two-root global install, and then as optional peers mirroring Cligent's ranges.
That left this repository holding three copies of knowledge that Cligent owns and publishes in cligent DR-013 [[1]]:

| Copy | Where | Failure it caused or invites |
| --- | --- | --- |
| Adapter-to-SDK map | `ADAPTER_SDKS` in the gate module | Goes stale silently; already omits runtimes cligent gates (`gemini`'s CLI) |
| Mirrored peer ranges | `peerDependencies` + the release-27 identity test | Every cligent floor move forces a playbook release; the mirror froze at `>=0.138.0` while cligent moved to `>=0.144.0` |
| Boolean probe verdict | `isAvailable()` collapsed to "not installed" | An installed-but-stale SDK was reported absent; a stale Codex passed the gate and failed mid-turn on a current model |

Cligent ships a runtime descriptor (`@sublang/cligent/runtime-targets`) declaring each adapter's runtimes, supported floors, tested versions, and pinned repairs; enforces the floors inside the loaders `isAvailable()` and `run()` share; exports a structured verdict distinguishing missing from unsupported; and publishes adapter-scoped capability metadata and validation.

Node resolves a bare specifier by walking directory ancestors and appending `node_modules` [[2]], so an SDK installed under another global root is unreachable from a nested Cligent, and an ephemeral `npx` tree is reachable by no install command at all.

## Decision

Playbook delegates all agent-runtime version knowledge to cligent and keeps none of its own.

### 1. Delivery

- The Claude and Codex SDKs arrive as ordinary dependencies of Cligent ([DR-110](110-managed-artifact-environments.md)); Playbook declares no agent-SDK dependency or peer range, so Cligent's own declaration is the single range npm checks.
- The SDKs remain `devDependencies` so this repository's tests and acceptance exercise real adapters.
- An adapter whose SDK stays an optional peer of Cligent is supplied by the package the user installs deliberately; it resolves only as a top-level install root or hoisted flat in a project `node_modules/`.

### 2. A readiness gate before work

- Both front ends check every declared adapter before work starts, independently of the credential check ([[playbook-cli-12](../packages/playbook-cli.md#playbook-cli-12)]).
- The probe is cligent's own `adapter.isAvailable()`, imported from cligent's installed location, so it performs exactly the dynamic import the adapter will perform at run time and a passing probe cannot disagree with a failing run; resolution-only probes are rejected because SDK `exports` maps make them report false negatives.
- The gate derives each adapter's runtimes, floors, and repairs from cligent's descriptor.
  Playbook retains only cligent module-path knowledge — which subpath exports which adapter class — which is API shape, not version.
- The gate covers every declared adapter for which cligent publishes runtime targets, `gemini`'s CLI included; adapters without targets keep the unknown-adapter warning.
- The gate renders cligent's structured verdict.
  A runtime installed below cligent's floor is reported as unsupported with its installed and required versions, distinctly from absent; the two have different repairs and conflating them sends a user to install what is already present.

### 3. Remedies

- A blocked launch names each unavailable adapter and the exact command that fixes it, installing cligent's pinned repair spec, so a printed repair can never install a version the gate would refuse again.
- For the included Claude and Codex stacks the remedy repairs or upgrades the running Playbook installation's own dependency tree.
- In an ephemeral npm exec tree, the remedy for an optional-peer adapter is a re-run naming every lineup SDK beside the running package at its own version and replaying the original arguments, because each package set materializes a distinct tree; Captain input already consumed from stdin is appended, quoted, behind one effective `--` end-of-options terminator, and any external CLI install the adapter's probe requires is printed first.

### 4. Agent-setting capability

Agent-setting capability also remains cligent knowledge.
Whenever `fastMode` is present, Playbook shall use cligent's public capability contract to accept or reject that literal boolean before registry preparation, import, readiness, or host work, and shall keep no adapter support list of its own; the same rule governs independent Ultracode ([DR-103](103-independent-ultracode-tuning.md)).

## Consequences

- A cligent upgrade alone moves playbook's compatibility policy: floors, verdicts, and repair pins arrive with the dependency, and no playbook release is forced by a cligent floor move.
- The same single-owner rule keeps Playbook's adapter-scoped tuning validation aligned with the runtime that enforces the call.
- Missing or stale runtimes fail before launch with versions named, instead of mid-turn with a vendor error.
- Playbook's manifest carries no agent-SDK version literals; the release-27 identity test is an absence test.

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/specs/decisions/013-cligent-owned-runtime-compatibility.md "cligent DR-013 — runtime compatibility ownership"
[2]: https://nodejs.org/api/modules.html#loading-from-node_modules-folders "Node.js — Loading from node_modules folders"
