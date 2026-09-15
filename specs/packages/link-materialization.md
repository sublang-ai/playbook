<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# link-materialization: Optional Thin Module Materialization

## Intent

This package defines the optional phase-owned helper of [DR-058](../decisions/058-link-materialization-tool.md), leaving semantic compilation with the linking agent.

## External Behavior

### link-materialization-1

When invoked with `--fsm <path>` and `--out <path>`, the helper shall consume one JSON descriptor from standard input and emit one erasable TypeScript module at the declared target using the shared factory and contract imports [[playbook-runtime-5](playbook-runtime.md#playbook-runtime-5)], without adding a runtime dependency on the helper.

### link-materialization-2

When loading the source FSM, the helper shall accept JavaScript on supported Node versions and accept TypeScript only where the running Node supports native type stripping.

### link-materialization-3

The helper shall accept only schema `sublang.playbook.link.v1`, profiles `flat-defaults` and `flat-quoted-relays` for flat ordinary player/script machines, the `flat-labelled-relays` profile for flat player/script/nested-playbook machines, and unconstrained string, boolean, or finite-number options with explicit requiredness.

### link-materialization-4

The descriptor shall carry the exact erased and authored metadata through these required members, including the source-derived outcome authorities and repository dispositions [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)]:

| Member | Shape |
| --- | --- |
| `schema`, `profile` | Exactly `sublang.playbook.link.v1` and one of the profiles in [[link-materialization-3](#link-materialization-3)]. |
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

When materializing an accepted descriptor, the helper shall derive the emitted module's player identities, roles and labels from the loaded FSM, schema-3 compatibility from the installed engine, and option types, immutable JSON validation with the public validator and identical snapshot binding of [[compiler-entry-options-1](compiler-entry-options.md#compiler-entry-options-1)] and [[compiler-entry-options-2](compiler-entry-options.md#compiler-entry-options-2)], input mappings, factory wiring and applicable default-composer verification exports from the validated descriptor.

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

### link-materialization-16

Where an FSM satisfies one supported materializer profile, when linking implementation is selected, the linker shall apply this policy:

| Case | Required behavior |
| --- | --- |
| Supported profile | Derive the complete source-owned descriptor and try `materialize-link.mjs` with the matching composer profile before ordinary handwritten linking. |
| Unsupported-profile exit | Continue ordinary linking under the complete link definition. |
| Invalid metadata | Correct the metadata before treating linking as successful. |
| Profile fit constraints | Do not widen options, omit required custom strategies, change the FSM, or relax verification. |

### link-materialization-22

Where the descriptor selects the `flat-labelled-relays` profile, the helper shall additionally require the exact exported player-input type name in `playerInputExport`, an explicit duplicate-free `omitEmptyRelayLines` array of complete source lines matching `> ` followed by an optional literal label and one terminal placeholder, and an explicit `identityPlaceholders` token-to-canonical-local-role map; it shall reject overlapping identity/field mappings, identity-backed omitted lines, undeclared roles, or any of these extra members on another profile.

### link-materialization-23

Where that profile is selected, the emitted player composer shall import the declared FSM player-input type and render each original line once, replacing string placeholders literally, quoting every continuation line of a value inserted into an authored `> ` line, preserving LF/CRLF separators and placeholder-looking inserted text, and removing an exact declared optional relay line with its separator only when its mapped string value is empty; missing or non-string values shall remain source tokens, and undeclared empty relays shall retain their authored text.

### link-materialization-24

Where that profile declares an identity placeholder, the emitted composer shall obtain its value only through the invocation-scoped identity lookup for the declared local role, preserve the source input, and expose the same canonical composer arguments as the runtime uses; fresh/resumed continuation shall come from the installed shared `composePlayerContinuation` [[playbook-runtime-92](playbook-runtime.md#playbook-runtime-92)], with absence of that API making the profile unsupported.

### link-materialization-25

Where that profile encounters a nested `playbook` invocation, the helper shall leave its input, text, target, output guards, recovery, and terminal semantics in the unchanged FSM and let the shared factory provide the bridge; direct Captain actors, compound or parallel topology, structured/custom prompt strategies, and nonprimitive option contracts shall remain outside this profile [[link-materialization-5](#link-materialization-5)].

## Verification

### link-materialization-17

Where the real CLI emits an ordinary workflow against the actual shared engine, the integration suite shall load and exercise the result to verify factory compatibility, exact labels, option validation, default prompt composition and strict interface type checking [[link-materialization-1](#link-materialization-1)] [[link-materialization-4](#link-materialization-4)] [[link-materialization-6](#link-materialization-6)] [[link-materialization-7](#link-materialization-7)] [[link-materialization-8](#link-materialization-8)] [[link-materialization-9](#link-materialization-9)].

### link-materialization-18

When the integration suite invokes the real CLI over supported and unsupported source loading, profile, topology, actor, option shape, invalid metadata and output failure cases, it shall verify each diagnostic and existing-target preservation [[link-materialization-2](#link-materialization-2)] [[link-materialization-3](#link-materialization-3)] [[link-materialization-5](#link-materialization-5)] [[link-materialization-10](#link-materialization-10)] [[link-materialization-11](#link-materialization-11)].

### link-materialization-19

Where a built SLC installation is supplied, the integration probe shall execute real discovery, semantic closure and incremental runs to verify unchanged reuse followed by link-only invalidation after mutating the helper [[link-materialization-13](#link-materialization-13)].

### link-materialization-20

When checking the packed definition surface, the integration suite shall verify the reviewed helper, complete normative entry, supported-profile preference, and resolving contract references [[link-materialization-1](#link-materialization-1)] [[link-materialization-12](#link-materialization-12)] [[link-materialization-16](#link-materialization-16)].

### link-materialization-21

When the real CLI emits and loads a quoted-relay module against each supported installed continuation API, the integration suite shall verify mapped and ordinary literal tokens, empty relay positions, LF/CRLF and blank lines, missing values, unchanged source inputs, and fresh/resumed Q&A rendering [[link-materialization-14](#link-materialization-14)] [[link-materialization-15](#link-materialization-15)].

### link-materialization-26

When the real CLI emits the labelled profile and loads it with the shared factory, the integration suite shall verify exact optional-line and multiline literal rendering, field and identity mapping, fresh/resumed Q&A, legacy-profile bytes preserved except the explicit common public-validator export and absent-slice normalization of [[link-materialization-6](#link-materialization-6)], strict typing against the declared FSM input, rejection with existing-target preservation, and maintained CODE/DEV nested-call execution without altering their FSMs [[link-materialization-22](#link-materialization-22)] [[link-materialization-23](#link-materialization-23)] [[link-materialization-24](#link-materialization-24)] [[link-materialization-25](#link-materialization-25)].
