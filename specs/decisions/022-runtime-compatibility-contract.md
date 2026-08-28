<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-022: Versioned Runtime Compatibility Contract

## Status

Accepted.
[DR-032](032-explicit-roles-session-players.md) uses the declared transition path to replace artifact schema `1` with schema `2`; every registry now advertises the artifact schema of every runtime profile, and declaration-free or schema-1 linked artifacts are incompatible with explicit local-role metadata in the next major.

## Context

A linked thin module is compiled once against the [SLC linker contract](../../slc/link.md) and the `@sublang/playbook/xstate-runtime` engine installed at link time, then executed by whatever engine instance its host resolves at run time.
Nothing bound those two moments: an artifact linked under engine major N could be interpreted by engine major M, and a changed strategy default, actor-input contract, or Boss-event semantics would surface as misbehavior deep in a session rather than as a load-time error.
Consumers that vendor and pin the `slc/link.md` text and adopt playbook releases atomically narrow the window but do not close it: globally installed engines and hand-carried artifacts still skew.
[DR-019](019-shared-linked-runtime-factory.md) §2 already fails factory construction on conflicting `bossEvents` metadata; there was no equivalent declaration for artifact/engine version agreement.

## Decision

### 1. The engine exports a self-report

- The `@sublang/playbook/xstate-runtime` engine surface exports `RUNTIME_ABI` (an integer, starting at 1) and `SUPPORTED_ARTIFACT_SCHEMAS` (a read-only integer array, starting `[1]`).
- Raising `RUNTIME_ABI` or removing a member of `SUPPORTED_ARTIFACT_SCHEMAS` is a breaking change under [[release-1](../packages/release.md#release-1)]; adding a newly supported schema is additive.

### 2. Artifacts declare, the factory checks

- `createXStatePlaybookRuntime(machine, spec)` accepts an optional `spec.compat: { artifactSchema: number; runtimeAbi: number }`.
- The declaration is checked against the self-report of the engine instance actually loaded — by construction the same module that will interpret the FSM, so the check can never consult a different engine copy than the one executing.
- The check is fail-fast at factory construction, before any machine interpretation:
  - an `artifactSchema` outside `SUPPORTED_ARTIFACT_SCHEMAS` throws a `TypeError` naming the declared schema and the supported set;
  - otherwise a `runtimeAbi` different from `RUNTIME_ABI` throws a `TypeError` naming the declared and the implemented value;
  - when both disagree, the schema error alone is raised — one clear diagnostic suffices;
  - a malformed `compat` value throws a `TypeError` naming the offending member.
- The original absent-`spec.compat` compatibility path is superseded by [DR-032](032-explicit-roles-session-players.md): the next-major factory rejects that artifact before interpretation because its player metadata cannot be reclassified safely as local roles.
- `slc/link.md` §Output binds newly emitted thin modules to supply `compat` with the values current at link time.

### 3. Scope

- Under [DR-032](032-explicit-roles-session-players.md), every entry registry adds required `artifactSchema: 2`; the Captain host validates it before runtime construction, and a shared-factory entry must agree with its `spec.compat.artifactSchema`.
- `playbook run` gains no compatibility flags: a construction-time throw from a selected entry's `createRuntime` settles through the shared Captain action and reply path, while a throw during headless host construction before a Boss turn starts remains a `playbook run: <message>` configuration diagnostic with exit `1` ([[playbook-cli-20](../packages/playbook-cli.md#playbook-cli-20)]), as amended by [DR-031](031-shared-captain-session-front-ends.md).
- Under [DR-032](032-explicit-roles-session-players.md), the DECIDE parallel-region registry carries the same schema-2 advertisement and its bespoke runtime implements the local-role artifact contract without claiming a shared-engine ABI.

## Consequences

- A skew-linked artifact fails loudly at load with a diagnostic naming both sides, instead of running under semantics it was not linked against.
- The original metadata addition was additive, but [DR-032](032-explicit-roles-session-players.md) makes removal of schema `1`, required registry advertisement, and declaration-free rejection a breaking next-major transition.
- Future format changes have a signal: a new artifact schema or engine ABI is declared by number, checked by the loaded engine, and rejected by name ([DR-023](023-data-only-machine-ir.md) stages the first planned use).
