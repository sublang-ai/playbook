<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-022: Versioned Runtime Compatibility Contract

## Status

Accepted.

## Context

A linked thin module is compiled once against the `slc/link.md` contract and the `@sublang/playbook/xstate-runtime` engine installed at link time, then executed by whatever engine instance its host resolves at run time.
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
- An absent `spec.compat` is a legacy artifact emitted before this contract: the factory constructs exactly as before, because [DR-019](019-shared-linked-runtime-factory.md) §4 keeps previously linked artifacts loadable.
- `slc/link.md` §Output binds newly emitted thin modules to supply `compat` with the values current at link time.

### 3. Scope

- No entry-registry-level compatibility fields are added in this iteration: the factory call is on every execution path — `playbook run`, test suites, embedding hosts — so the factory check already covers them all; a registry-level advertisement can be layered on later without changing this contract.
- `playbook run` gains no compatibility flags: a construction-time throw from a selected entry's `createRuntime` settles through the shared Captain action and reply path, while a throw during headless host construction before a Boss turn starts remains a `playbook run: <message>` configuration diagnostic with exit `1` ([[playbook-cli-20](../packages/playbook-cli.md#playbook-cli-20)]), as amended by [DR-031](031-shared-captain-session-front-ends.md).
- The DECIDE parallel-region runtime does not use the shared factory, carries no declaration, and remains out of scope until it converges on a compatible engine profile under its own record.

## Consequences

- A skew-linked artifact fails loudly at load with a diagnostic naming both sides, instead of running under semantics it was not linked against.
- The metadata is additive: every existing artifact, host, and export keeps working, so this ships as a minor release.
- Future format changes have a signal: a new artifact schema or engine ABI is declared by number, checked by the loaded engine, and rejected by name ([DR-023](023-data-only-machine-ir.md) stages the first planned use).

## References

- [SLC linker contract](../../slc/link.md)
- [[release-1](../packages/release.md#release-1)] defines the package's compatibility policy.
