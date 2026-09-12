<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-050: Compact Link Definition

## Status

Proposed; retain only after a controlled compilation benchmark demonstrates improvement.

## Context

The link definition is 154,025 bytes, while ordinary artifacts delegate runtime machinery to the shared factory under [DR-019](019-shared-linked-runtime-factory.md).
Most input describes runtime behavior already implemented by that factory, so the phase agent repeatedly reads lifecycle, trace, effect, and abort details while authoring a small set of workflow-specific declarations.
Those declarations still require semantic review: TypeScript erasure loses option and event contracts, repository dispositions depend on authored behavior, and some prompt shapes require narrow overrides.

## Decision

Keep `slc/link.md` as the compiler entry definition with its existing input, role, output, and compiled-execution sections, plus a compact shared-factory authoring procedure.
Move runtime sections without changing their text to the normative `slc/link-runtime.md` companion and retain forwarding headings at the original entry-file anchors.
Ordinary shared-factory linking reads the authoring procedure and relevant special-case references; bespoke parallel linking requires the complete runtime contract.
The split changes retrieval, not emitted semantics, actor adjudication, metadata authority, or conformance gates.
Both files form the definition's semantic dependency closure and must be retained together by a host that snapshots or pins it.

## Consequences

The always-relayed entry definition is substantially smaller while existing runtime-contract citations remain resolvable.
Consumers must preserve the companion's bytes and relative path when pinning the definition; hashing only `link.md` is insufficient.
The benchmark must hold the engine version and Source fixed to isolate the split from runtime upgrades.
