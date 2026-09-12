<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# link-materialization: Optional Thin Module Materialization

## Intent

This package defines the experimental phase-owned helper of [DR-051](../decisions/051-link-materialization-tool.md), leaving semantic compilation with the linking agent.

## External Behavior

### link-materialization-1

When invoked with `--fsm <path>` and `--out <path>`, the helper shall consume one JSON descriptor from standard input and emit one erasable TypeScript module at the declared target using the shared factory and contract imports [[playbook-runtime-5](playbook-runtime.md#playbook-runtime-5)], without adding a runtime dependency on the helper.

### link-materialization-2

When loading the source FSM, the helper shall accept JavaScript on supported Node versions and accept TypeScript only where the running Node supports native type stripping.

### link-materialization-3

The helper shall accept only schema `sublang.playbook.link.v1`, profiles `flat-defaults` and `flat-quoted-relays`, flat ordinary player/script machines, and unconstrained string, boolean, or finite-number options with explicit requiredness.

### link-materialization-4

The descriptor shall carry the exact erased and authored metadata through these required members, including the source-derived outcome authorities and repository dispositions [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)]:

| Member | Shape |
| --- | --- |
| `schema`, `profile` | Exactly `sublang.playbook.link.v1` and either `flat-defaults` or `flat-quoted-relays`. |
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

The optional tool shall leave the full normative [link contract](../../slc/link.md) and emitted conformance checks binding, including source prompt fidelity and exact semantic metadata.

### link-materialization-13

The shipped phase-set sidecar shall include the helper in the link definition's semantic-input closure so a helper-content change invalidates incremental link reuse.

### link-materialization-14

Where the descriptor selects `flat-quoted-relays`, the emitted player composer shall render the unchanged source template in one literal callback pass according to this case matrix:

| Template/value case | Rendered body |
| --- | --- |
| Recognized syntax | A token is `#` or `[A-Za-z_$][A-Za-z0-9_$-]*`; a standalone relay starts at column zero and contains exactly `> <token>` followed by LF, CRLF, or end of input. |
| Ordinary `<token>` with a string value | The exact string, without interpreting replacement metacharacters or placeholder-looking content. |
| Standalone `> <token>` line with an empty string | Omit the entire line, including its line ending. |
| Standalone `> <token>` line with a nonempty string | Prefix every nonempty value line with `> `, preserving blank lines, LF or CRLF separators, and the template line ending without inventing empty quoted lines. |
| Missing or non-string value | Preserve the source token or relay line unchanged. |
| Token-to-field lookup | Use `placeholderFields` first, then `<#>` to `irNumber`, otherwise the shared kebab-token-to-camel-field convention. |

### link-materialization-15

Where the descriptor selects `flat-quoted-relays`, the emitted player composer shall prefix its rendered body once with the installed shared composer's continuation for an empty body, forwarding the continuation mode only when the engine exposes that API and leaving question, reply, and source input values unchanged under the [full prompt contract](../../slc/link.md#player-prompt-composition).

## Verification

### link-materialization-17

Where the real CLI emits an ordinary workflow against the actual shared engine, the integration suite shall load and exercise the result to verify factory compatibility, exact labels, option validation, default prompt composition and strict interface type checking [[link-materialization-1](#link-materialization-1)] [[link-materialization-4](#link-materialization-4)] [[link-materialization-6](#link-materialization-6)] [[link-materialization-7](#link-materialization-7)] [[link-materialization-8](#link-materialization-8)] [[link-materialization-9](#link-materialization-9)].

### link-materialization-18

When the integration suite invokes the real CLI over supported and unsupported source loading, profile, topology, actor, option shape, invalid metadata and output failure cases, it shall verify each diagnostic and existing-target preservation [[link-materialization-2](#link-materialization-2)] [[link-materialization-3](#link-materialization-3)] [[link-materialization-5](#link-materialization-5)] [[link-materialization-10](#link-materialization-10)] [[link-materialization-11](#link-materialization-11)].

### link-materialization-19

Where a built SLC installation is supplied, the integration probe shall execute real discovery, semantic closure and incremental runs to verify unchanged reuse followed by link-only invalidation after mutating the helper [[link-materialization-13](#link-materialization-13)].

### link-materialization-20

When checking the packed definition surface, the integration suite shall verify the reviewed helper, complete normative entry and resolving contract references [[link-materialization-1](#link-materialization-1)] [[link-materialization-12](#link-materialization-12)].

### link-materialization-21

When the real CLI emits and loads a quoted-relay module against each supported installed continuation API, the integration suite shall verify mapped and ordinary literal tokens, empty relay positions, LF/CRLF and blank lines, missing values, unchanged source inputs, and fresh/resumed Q&A rendering [[link-materialization-14](#link-materialization-14)] [[link-materialization-15](#link-materialization-15)].
