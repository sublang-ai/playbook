<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-entry-options: Public Linked Option Validation

## Intent

This package defines the artifact-owned public validator used by deterministic registry entries under [DR-057](../decisions/057-public-linked-option-validator.md).

## External Behavior

### compiler-entry-options-1

When emitting a linked artifact, the linker shall export a synchronous pure `validateOptions(value: unknown): PlaybookRuntimeOptions` function with this validation order:

1. Capture `value === undefined ? {} : value` through the public `snapshotJsonValue` exported by `@sublang/playbook/xstate-runtime` before reading option members, applying defaults, or constructing a replacement record, normalizing only top-level `undefined` and rejecting non-JSON input.
2. Validate the artifact's actual option shape, requiredness, source-authored defaults, unknown keys, and declared values against that detached snapshot, rejecting null and invalid options.
3. Return a detached immutable plain-JSON option record without runtime construction or live host capabilities.

### compiler-entry-options-2

Where the linked artifact uses the shared factory, the linker shall bind the same public validator function as `runtimeSpec.snapshotOptions`, preserving the configured-option and live-capability separation of [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)].

### compiler-entry-options-3

When deriving runtime options, the compiler shall treat Boss text supplied by an entry event as per-turn input unless Source independently requires it before the first Boss turn, preserve genuine startup options and source-appropriate optional seeds, and reject a generated required input annotation alone as evidence of a bootstrap requirement ([DR-019](../decisions/019-shared-linked-runtime-factory.md)).

## Verification

### compiler-entry-options-4

When the real materializer emits and loads modules for required and optional primitive options, the integration suite shall verify standalone validation before construction, absent-slice behavior, invalid JSON and unknown-key rejection, detached immutable output, exact shared snapshot binding in emitted code, and unchanged valid runtime execution [[compiler-entry-options-1](#compiler-entry-options-1)] [[compiler-entry-options-2](#compiler-entry-options-2)].

### compiler-entry-options-5

When the definition surface is checked, the suite shall verify the public validator and independent Source-bootstrap rules remain in the common full contract outside optional helper instructions [[compiler-entry-options-1](#compiler-entry-options-1)] [[compiler-entry-options-3](#compiler-entry-options-3)].
