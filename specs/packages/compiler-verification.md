<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-verification: Compiler-Owned Check Integration

## Intent

This package specifies how Playbook's published SLC phase definitions cooperate with the invoking compiler's verification authority under [DR-110](../decisions/110-managed-artifact-environments.md).
Essential project-specific references are the `slc/` compiler definitions published by `@sublang/playbook`, consumed by SLC, and the FSM metadata used only for verification.
The compiler owns checker implementation, budgets, acceptance, and diagnostics; generated workflows retain their source-defined behavior.

## External Behavior

### compiler-verification-1

When a phase definition directs an Agent to verify generated code, it shall use the invoking compiler's supplied check operation and selected environment, preserving compiler-owned TypeScript, Node ambient types and fixed flags, and shall not require a project manifest, SDK installation, project tsconfig or guessed project/global `tsc` command as a substitute acceptance authority.

### compiler-verification-2

Where a source-permitted public input cannot be derived by generic coverage probing, when gears2fsm supplies an entry witness, it shall export only JSON `coverageWitnesses` of shape `{ schema: "sublang.slc.coverage-witnesses.v1", entries: [{ input?: <JSON startup-options record>, events: [<JSON public event>, ...] }, ...] }`, identifying actual public startup inputs and event payloads without private context patches, state jumps, weakened guards or invented domain defaults, and require compiler replay from the real initial state under the same finite coverage budgets before claiming the route is covered.

### compiler-verification-3

When a phase definition describes verification failure, it shall preserve the compiler's distinction among an environment failure, an established artifact defect and an unverified obligation, directing artifact corrections only from concrete findings and never presenting exhausted bounded search as proof that a source-defined route is impossible.

## Verification

### compiler-verification-4

When integration drives the published phase definitions through a supplied SLC installation against isolated valid and invalid ESM artifacts, the suite shall verify compiler-owned check selection without a project Node setup [[compiler-verification-1](#compiler-verification-1)], actual initial-state replay of a source-permitted absolute-path witness with refusal of context-patched and false-guard controls [[compiler-verification-2](#compiler-verification-2)], and preservation of environment, defect and unverified diagnoses [[compiler-verification-3](#compiler-verification-3)].
