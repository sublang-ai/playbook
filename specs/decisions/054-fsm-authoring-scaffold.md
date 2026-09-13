<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-054: Optional FSM Authoring Scaffold

## Status

Accepted as an unmeasured experiment.

## Context

A measured CODE compilation spent 363.822 seconds in its first FSM call, emitted a 37,004-byte machine and replaced a 17,104-byte tail after TypeScript action inference failed.
The first strict failure to first clean check spanned 110.920 seconds.
Acting prompts were also rendered prematurely instead of retaining their source constants.
Visible tool-boundary time does not isolate provider generation latency, and the complete run failed other checks.

## Decision

Provide an optional phase-owned initializer for exact source prompt/result constants and a typed XState setup pattern, as specified by [[fsm-scaffolding-1](../packages/fsm-scaffolding.md#fsm-scaffolding-1)].
The output is deliberately incomplete TypeScript requiring ordinary agent authoring of every workflow decision; it is not a machine intermediate representation or an executable reconstruction of maintained artifacts.
Register reusable assignments through a contextually typed setup extension and reference their action names, rather than directly reusing an externally typed action on heterogeneous actor completion events.
Nested-call prompt constants remain templates: runtime composition and child acceptance remain the existing phase contract.
Unsupported source forms use ordinary compilation rather than inferred defaults.
Retain this technique as a performance optimization only after a matched, accepted experiment demonstrates improvement; incomplete or failed compilations prove no speed benefit.

## Consequences

The helper can remove repeated byte copying and one demonstrated typing trap while leaving domain reasoning and all compiler checks intact.
It cannot promise that an agent will complete the scaffold correctly or quickly.
Its narrow input profile and deliberate authoring markers make omissions visible instead of supplying hidden semantics.
