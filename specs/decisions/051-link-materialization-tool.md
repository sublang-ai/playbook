<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-051: Optional Deterministic Link Materialization

## Status

Proposed experiment; retention requires a measured successful compilation improvement.

## Context

The shared factory already owns interpretation under [DR-019](019-shared-linked-runtime-factory.md), but the linking agent still generates repetitive types, option validation, and factory wiring.
The measured minimal baseline spent 158 seconds in linking; [DR-050](050-compact-link-definition.md)'s input-only split demonstrated no gain.
Some required metadata disappears under TypeScript erasure or belongs to authored policy, so runtime inspection cannot replace semantic linking.

## Decision

An optional Playbook-owned tool materializes the existing thin module from the loaded FSM and a strict declarative descriptor.
Its initial domain is flat ordinary player/script workflows using shared default strategies and primitive options.
The agent remains responsible for exact erased and authored metadata and every requirement of the complete link definition.
Unsupported workflows retain ordinary normative linking; invalid descriptors and preflight failures produce diagnostics without replacing the target.
The tool uses the artifact's installed engine, emits no dependency on itself, and belongs to the definition's machine-readable semantic-input closure.
The experiment changes no interpreter, engine compatibility declaration, public workflow adoption, or release.

## Consequences

Deterministic output can remove repetitive generation and exact-label mistakes without inventing source semantics.
Factory preflight checks structure but does not prove erased field declarations or prompt fidelity; existing conformance remains mandatory.
A fixed-FSM comparison followed by a cold full compilation must establish improvement before retaining the technique.
