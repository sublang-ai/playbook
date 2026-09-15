<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-workflow-contracts: Public Workflow Interfaces

## Intent

This package supplies builtin workflow output interfaces as independently consumable compiler data, per [DR-055](../decisions/055-public-workflow-contracts.md).
It changes neither the shared nested-call protocol nor the maintained workflow implementations.

## External Behavior

### compiler-workflow-contracts-1

When publishing the compiler definitions, Playbook shall include an independently readable `slc/workflow-contracts.json` catalog with schema `sublang.playbook.workflow-contracts.v1`, package identity `@sublang/playbook`, artifact schema `3`, runtime ABI `1` [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)], `literalTargetBindings` mapping `review`, `decide`, `code`, `branch`, and `pr` to their same-named packaged workflows, and their exact public success/failure output shapes, including field meanings and optionality, while excluding prompts, acting results, state identities, transition logic, and implementation imports.
Its JSON-schema vocabulary shall be limited to object properties and required keys, false or schema-valued `additionalProperties`, string/boolean/null/number/array types and array `items`, string or boolean constants, string enums, `anyOf` unions, local `$defs`/`$ref`, and descriptions; its recursive JSON value describes opaque child output rather than a callee implementation.
The output shapes shall preserve the maintained public return contracts [[playbook-22](playbook.md#playbook-22)], [[playbook-20](playbook.md#playbook-20)], [[playbook-24](playbook.md#playbook-24)], [[playbook-25](playbook.md#playbook-25)], [[playbook-26](playbook.md#playbook-26)], [[playbook-44](playbook.md#playbook-44)], [[playbook-48](playbook.md#playbook-48)], [[playbook-49](playbook.md#playbook-49)].

### compiler-workflow-contracts-2

When the selected pipeline supplies the catalog [[compiler-workflow-contracts-1](#compiler-workflow-contracts-1)], gears2fsm shall adopt its explicit `literalTargetBindings` as the default nested-target namespace, with an explicit Source or supplied compiler-dependency binding overriding a default and requiring its own public interface; runtime hosts shall honor the compiled dependency bindings as external ABIs.
Where compilation binds a nested target to a cataloged builtin dependency, when deriving an output predicate, gears2fsm shall read that declared interface [[compiler-workflow-contracts-1](#compiler-workflow-contracts-1)] and enforce only the caller's source-owned acceptance or relay conditions on its actual fields; the shared bridge's invocation correlation [[playbook-runtime-42](playbook-runtime.md#playbook-runtime-42)] supplies call identity, and source predicates remain distinct from successful bridge delivery [[playbook-runtime-84](playbook-runtime.md#playbook-runtime-84)].
A REVIEW success attests to the supplied scope with `noUnsettledFindings: true` and its exact `evaluatedRevision`, which may include REVIEW-owned fixes [[playbook-26](playbook.md#playbook-26)]; the caller shall not invent a `reviewedCommit` field or require that final revision to equal its own earlier commit.
The catalog shall not impose a builtin interface on an unrelated local source or custom target merely because its name matches.

### compiler-workflow-contracts-3

Where a source-owned child-output predicate requires an external interface, when that interface is unavailable or inconsistent with its declared dependency, the compilation definition shall report the missing or incompatible compiler input without inventing output fields or asking the author to repair sufficient domain behavior; a missing, contradictory, or materially ambiguous authored behavior remains a source clarification concern.

## Verification

### compiler-workflow-contracts-4

When the integration suite checks the published catalog, it shall verify its declared schema and public-interface-only scope, bidirectional structural agreement with the five exported output types, and acceptance of actual maintained runtime terminal outputs with rejection of altered or missing required fields [[compiler-workflow-contracts-1](#compiler-workflow-contracts-1)].

### compiler-workflow-contracts-5

When compiler-input integration checks the package and definition closure, it shall verify independent catalog inclusion, reference discovery and changed catalog identity in the declared semantic inputs [[compiler-workflow-contracts-1](#compiler-workflow-contracts-1)], explicit source-owned predicate and invocation-correlation guidance [[compiler-workflow-contracts-2](#compiler-workflow-contracts-2)], and separate missing-interface versus missing-behavior guidance [[compiler-workflow-contracts-3](#compiler-workflow-contracts-3)].
