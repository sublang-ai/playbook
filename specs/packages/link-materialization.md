<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# link-materialization: Optional Thin Module Materialization

## Intent

This package defines the experimental phase-owned helper of [DR-051](../decisions/051-link-materialization-tool.md), which deterministically emits the existing thin runtime module while leaving semantic compilation with the linking agent.

## External Behavior

### link-materialization-1

When invoked with `--fsm <path>` and `--out <path>`, the helper shall consume one JSON descriptor from standard input and emit one erasable TypeScript module at the declared target, using the shared factory and contract imports of [[playbook-runtime-5](playbook-runtime.md#playbook-runtime-5)] without adding a runtime dependency on the helper.
The helper shall support JavaScript FSM loading on the package's supported Node versions and TypeScript FSM loading only when the running Node version supports native type stripping, diagnosing unsupported loading without changing the target.

### link-materialization-2

The helper shall accept only schema `sublang.playbook.link.v1`, profile `flat-defaults`, flat ordinary player/script machines, and string, boolean, or finite-number options whose descriptors declare requiredness.
The descriptor shall carry the exact FSM export, label, option-to-input mappings, deterministic entry contract or explicit null, additional Boss-event contracts, outcome authorities and repository dispositions [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)], placeholder exceptions, transition fields, verbatim fields, resumable states, unfinished final states, and ordered safe context projection through these required members:

| Member | Shape |
| --- | --- |
| `schema`, `profile` | The exact identifiers above. |
| `machineExport`, `label` | Exported JavaScript identifier and nonblank diagnostic label. |
| `options` | Option-name map of `{ type: 'string' \| 'boolean' \| 'number', required: boolean }`; constrained primitive types require ordinary linking. |
| `inputMapping` | FSM input-field to declared option-name map; every non-`cwd` option is mapped. |
| `entryEvent` | `{ type, textField, contextField? }` strings, or explicit null. |
| `bossEvents` | Exact additional event contracts with `type` and optional `fields` mapping each field to `{ source: 'judge' \| 'text', required?: boolean, values?: string[] }`. |
| `outcomeAuthority` | `{ governedPlayerStates: { [state]: { [outcome]: { fields, repositoryDisposition } } } }` with the existing schema-3 authorities and dispositions. |
| `placeholderFields` | Authored placeholder-token to input-field string map. |
| `transitionEventFields`, `verbatimPayloadFields`, `resumableStateIds`, `unfinishedFinalStateIds`, `controlContextFields` | Explicit duplicate-free string arrays, including empty arrays. |
The helper shall reject unknown descriptor members and shall never infer erased types, result contracts, authored context visibility, or unfinished terminal meaning by evaluating an invocation with invented context.

### link-materialization-3

When materializing an accepted descriptor, the helper shall copy player state identities, roles, and descriptions from the loaded FSM, capture the installed engine's schema-3 compatibility as a literal, and generate matching option types and immutable JSON validation, input mappings, factory wiring, and applicable default-composer verification exports.
Where the FSM declares a script actor, the helper shall include optional string `cwd` independently of option-to-input mappings.
The generated construction type shall require opaque live authority alongside the shared repository and effect-ledger capabilities, without defining a host-specific type or synthesizing a capability value.

### link-materialization-4

Before replacing the declared target, the helper shall validate the descriptor and invoke the actual artifact-resolved shared factory for structural preflight, require the output location to resolve that same engine, and atomically replace only the declared target after successful generation.
An unsupported profile, topology, actor, or option shape shall produce an `unsupported` diagnostic with exit status 2; an invalid descriptor, import, engine, preflight, or output failure shall produce an error diagnostic with exit status 1; success shall report the target with exit status 0.
Every refusal shall preserve an existing target and remove any temporary output.

### link-materialization-5

The optional tool shall leave the full normative [link contract](../../slc/link.md) and its emitted conformance checks binding, including source prompt fidelity and exact semantic metadata, and shall direct unsupported cases to ordinary linking.
The shipped phase-set sidecar shall include the helper in the link definition's semantic-input closure so a helper-content change invalidates incremental link reuse.

## Verification

### link-materialization-6

Where the integration suite runs the real helper against an ordinary FSM and the actual shared engine, the suite shall load the emitted module and verify its factory compatibility and exact labels, exercise generated option validation and default prompt composition, and type-check the emitted interface and construction surface [[link-materialization-1](#link-materialization-1)] [[link-materialization-2](#link-materialization-2)] [[link-materialization-3](#link-materialization-3)].
The suite shall invoke the real CLI for unsupported topology, actor, option shape, native TypeScript loading, invalid metadata, and output failure, asserting diagnostics and preservation of existing targets [[link-materialization-4](#link-materialization-4)].

### link-materialization-7

Where a built SLC installation is supplied to the integration probe, the probe shall run its real definition discovery, semantic closure, and incremental runner, verifying unchanged reuse and invalidation after a helper-content change without treating the helper as another phase [[link-materialization-5](#link-materialization-5)].
