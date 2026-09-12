<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-052: Helper-Backed Compact Linking Recipe

## Status

Proposed experiment; retention requires measured successful compilation improvement.

## Context

The optional materializer of [DR-051](051-link-materialization-tool.md) removes repetitive output generation, while its original entry definition still relays the full runtime contract to every linking call.
The earlier input-only split of [DR-050](050-compact-link-definition.md) demonstrated no successful improvement and remains rejected.
A helper-backed recipe can separate semantic authoring from already implemented runtime machinery while retaining the complete normative contract.

## Decision

Use a self-contained compact entry for the helper's bounded flat ordinary-player/script profile, preserving every erased and authored metadata obligation relevant to that profile.
Keep the existing helper bytes and full runtime contract unchanged, except reversible relative Markdown-link rebasing when relocating the latter.
Keep existing section anchors as resolving references and include both executable helper and full companion in the machine-readable semantic closure.
Unsupported semantics require ordinary linking under the full contract; the compact recipe cannot widen contracts or weaken emitted checks.
No engine, installed-version adoption, or release changes belong to this experiment.

## Consequences

The measured intervention is reduced mandatory definition context with the same deterministic emitter and installed engine.
Both paired candidates incorporate independently required normative corrections identically; those corrections are not part of the performance intervention.
The agent still decides metadata from source semantics; structural preflight cannot prove those decisions correct.
A fixed-FSM comparison followed by a cold full compilation must demonstrate improvement before retention.
