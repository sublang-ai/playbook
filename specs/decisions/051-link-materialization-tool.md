<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-051: Optional Deterministic Link Materialization

## Status

Accepted for the measured flat single-player/script workflow with standalone quoted relays (2026-09-12).
Performance outside that case and the five-minute cold full-compilation goal remain unproven.

## Context

The shared factory already owns interpretation under [DR-019](019-shared-linked-runtime-factory.md), but the linking agent still generates repetitive types, option validation, and factory wiring.
The measured minimal baseline spent 158 seconds in linking; [DR-050](050-compact-link-definition.md)'s input-only split demonstrated no gain.
Some required metadata disappears under TypeScript erasure or belongs to authored policy, so runtime inspection cannot replace semantic linking.

## Decision

An optional Playbook-owned tool materializes the existing thin module from the loaded FSM and a strict declarative descriptor.
Its initial domain is flat ordinary player/script workflows using shared default strategies and primitive options.
An explicit `flat-quoted-relays` profile extends that domain only with deterministic string substitution for standalone `> <token>` lines, keeping shared continuation behavior and the same descriptor keys.
The linker selects it only when the source needs that exact relay convention; labelled relays, identity-specific composition, structured renderers, and other custom strategies still require ordinary linking.
The agent remains responsible for exact erased and authored metadata and every requirement of the complete link definition.
Unsupported workflows retain ordinary normative linking; invalid descriptors and preflight failures produce diagnostics without replacing the target.
The tool uses the artifact's installed engine, emits no dependency on itself, and belongs to the definition's machine-readable semantic-input closure.
The retained optional mechanism changes no interpreter, engine compatibility declaration, public workflow adoption, or release.

## Consequences

Deterministic output can remove repetitive generation and exact-label mistakes without inventing source semantics.
Factory preflight checks structure but does not prove erased field declarations or prompt fidelity; existing conformance remains mandatory.
A successful matched fixed-FSM comparison establishes the bounded linking improvement below; a cold full compilation remains necessary before claiming the overall five-minute goal.
The default profile remains byte-compatible with v2, but this pair measures only `flat-quoted-relays` and establishes no independent latency result for other workflows or profiles.

An isolated materializer comparison holds compiler behavior, FSM input, full runtime contract and independent correctness fixes constant while removing only optional helper instructions from the control entry.
The comparison may retain identical unused helper and companion files in the control's conservative semantic-input closure, provided the control definition neither cites nor instructs use of that tool.
Both entries place the existing construction-boundary guidance in their common introduction: the shared factory checks linked metadata and construction shape [[playbook-runtime-50](../packages/playbook-runtime.md#playbook-runtime-50)], while the Captain host validates the registry manifest and its live authority envelope before runtime construction [[playbook-captain-5](../packages/playbook-captain.md#playbook-captain-5)].
This common placement prevents the comparison from conflating mechanical emission with guidance against auditing host-owned validation at the bare factory; it changes no validation responsibility or runtime behavior.

The [recorded comparison](../../scripts/experiments/materializer-v3-pair-evidence.json) used the same valid FSM, compiler and verification-harness member hashes, dependency lock, GPT-6 low settings, disabled reviewer, and native tool policy; the baseline finished 22,171 ms before the helper run started.
Every declared input matched except `link.md`, whose exact difference was the optional helper section:

| Run | Link compilation | Performing calls | Tool calls | Strict types, link contract and real Git runtime |
| --- | ---: | ---: | ---: | --- |
| `oNiH7r`, ordinary linking | 213,000 ms | 2 | 17 | Pass |
| `YQHwJk`, quoted-relay materializer | 78,679 ms | 1 | 9 | Pass |

The observed reduction is 63.1% for this one sequential pair, not a population estimate; model variation and ordering effects remain possible.
Both real runtime checks preserved the original and copied source, delivered the exact quoted Boss task, performed one player call and one commit in the workflow's own repository, and reached terminal success.
The matching provider command invoked the frozen helper with the exact descriptor and exited successfully; replaying that command's descriptor regenerated all 5,886 bytes of the final linked module exactly, with SHA-256 `9e4c3b7bf85f7ce76e33432e703cab582dd55d0c9050c172779419552b354589`.
