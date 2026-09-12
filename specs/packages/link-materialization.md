<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# link-materialization: Optional Thin Module Materialization

## Intent

This package defines the experimental phase-owned helper of [DR-051](../decisions/051-link-materialization-tool.md) and compact recipe of [DR-052](../decisions/052-helper-backed-compact-link.md), leaving semantic compilation with the linking agent.

## External Behavior

### link-materialization-1

When invoked with `--fsm <path>` and `--out <path>`, the helper shall consume one JSON descriptor from standard input and emit one erasable TypeScript module at the declared target using the shared factory and contract imports [[playbook-runtime-5](playbook-runtime.md#playbook-runtime-5)], without adding a runtime dependency on the helper.

### link-materialization-2

When loading the source FSM, the helper shall accept JavaScript on supported Node versions and accept TypeScript only where the running Node supports native type stripping.

### link-materialization-3

The helper shall accept only schema `sublang.playbook.link.v1`, profile `flat-defaults`, flat ordinary player/script machines, and unconstrained string, boolean, or finite-number options with explicit requiredness.

### link-materialization-4

The descriptor shall carry the exact erased and authored metadata through these required members, including the source-derived outcome authorities and repository dispositions [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)]:

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
| `resumableStateIds` | Explicit duplicate-free delegated-player state ids allowed to suspend for and resume from a Boss reply, according to the FSM's resumption registry or `BOSS_REPLY` branches, independently of its interrupt targets. |
| `transitionEventFields`, `verbatimPayloadFields`, `unfinishedFinalStateIds`, `controlContextFields` | Explicit duplicate-free string arrays, including empty arrays. |

### link-materialization-5

When validating metadata, the helper shall reject unknown descriptor members without inferring erased types, result contracts, authored context visibility, or unfinished terminal meaning by evaluating an invocation with invented context.

### link-materialization-6

When materializing an accepted descriptor, the helper shall derive the emitted module's player identities, roles and labels from the loaded FSM, schema-3 compatibility from the installed engine, and option types, immutable JSON validation, input mappings, factory wiring and applicable default-composer verification exports from the validated descriptor.

### link-materialization-7

Where the FSM declares a script actor, the helper shall include optional string `cwd` independently of option-to-input mappings.

### link-materialization-8

The generated construction type shall require opaque live authority alongside shared repository and effect-ledger capabilities, without defining a host-specific type or synthesizing a capability value.

### link-materialization-9

Before replacing the declared target, the helper shall validate the descriptor and invoke the artifact-resolved shared factory for structural preflight, require the output location to resolve that same engine, and atomically replace only the declared target after successful generation.

### link-materialization-10

When an invocation completes, the helper shall report its outcome according to this case matrix:

| Case | Diagnostic and exit status |
| --- | --- |
| Unsupported loading, profile, topology, actor, or option shape | `unsupported`, 2 |
| Invalid descriptor, import, engine, preflight, or output failure | Error, 1 |
| Successful emission | Declared target, 0 |

### link-materialization-11

When an invocation is refused, the helper shall preserve an existing target and remove any temporary output.

### link-materialization-12

The optional tool shall leave the full normative [link contract](../../slc/references/link-contract.md) and emitted conformance checks binding, including source prompt fidelity and exact semantic metadata.

### link-materialization-13

The shipped phase-set sidecar shall include the helper and full contract companion in the link definition's semantic-input closure so a content change to either invalidates incremental link reuse.

### link-materialization-14

Where a flat ordinary player/script workflow requires only shared default strategies and unconstrained primitive options, the compact definition shall supply a self-contained metadata-authoring recipe that invokes the unchanged helper without requiring a fresh audit of shared engine implementation.

### link-materialization-15

Where a workflow requires semantics outside that recipe's explicit scope, the compact definition shall direct the linker to the full normative contract for ordinary linking without widening, dropping, or guessing source requirements.

### link-materialization-16

The compact definition shall preserve the full contract's existing entry anchors as resolving references to its relocated sections, with full contract text unchanged apart from reversible relative Markdown-link rebasing.

## Verification

### link-materialization-17

Where the real CLI emits an ordinary workflow against the actual shared engine, the integration suite shall load and exercise the result to verify factory compatibility, exact labels, option validation, default prompt composition and strict interface type checking [[link-materialization-1](#link-materialization-1)] [[link-materialization-4](#link-materialization-4)] [[link-materialization-6](#link-materialization-6)] [[link-materialization-7](#link-materialization-7)] [[link-materialization-8](#link-materialization-8)] [[link-materialization-9](#link-materialization-9)].

### link-materialization-18

When the integration suite invokes the real CLI over supported and unsupported source loading, profile, topology, actor, option shape, invalid metadata and output failure cases, it shall verify each diagnostic and existing-target preservation [[link-materialization-2](#link-materialization-2)] [[link-materialization-3](#link-materialization-3)] [[link-materialization-5](#link-materialization-5)] [[link-materialization-10](#link-materialization-10)] [[link-materialization-11](#link-materialization-11)].

### link-materialization-19

Where a built SLC installation is supplied, the integration probe shall execute real discovery, semantic closure and incremental runs to verify unchanged reuse followed by link-only invalidation after independently mutating the helper and full contract companion [[link-materialization-13](#link-materialization-13)].

### link-materialization-20

When checking the packed definition surface, the integration suite shall verify the unchanged helper, reversible full-contract relocation and original anchor resolution alongside the compact recipe's complete descriptor obligations and explicit fallback boundary [[link-materialization-12](#link-materialization-12)] [[link-materialization-14](#link-materialization-14)] [[link-materialization-15](#link-materialization-15)] [[link-materialization-16](#link-materialization-16)].
