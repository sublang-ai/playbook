<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-prompt-relays: Authored Context Delivery

## Intent

This package specifies compiler duties to deliver source-authored runtime context through acting prompts and typed actor inputs, including relay requirements stated in prose rather than explicit templates.
It introduces no new domain behavior or semantic adjudicator.

## External Behavior

### compiler-prompt-relays-1

When Source requires a runtime value relayed to an acting role, text2gears shall include the required quoted placeholder [[playbook-6](playbook.md#playbook-6)] in the complete prompt blockquote of every acting behavior governed by that relay, including a relay described only in prose; mentioning the value in a condition, result contract, or machine context shall not substitute for delivery in the prompt.

### compiler-prompt-relays-3

Where Source names a relayed value without authoring its prompt template, text2gears shall render the value as a bare quoted prompt-content line `> <token>` [[playbook-6](playbook.md#playbook-6)], written as `> > <token>` in the GEARS file because its first marker encloses the prompt, without an added label or surrounding prose; Source-authored template labels shall remain part of their original prompt fragments.

### compiler-prompt-relays-5

Where a direct-Captain or delegated-player prompt carries a Source-declared runtime-value placeholder other than an invocation-scoped local-role identity [[playbook-runtime-15](playbook-runtime.md#playbook-runtime-15)], when gears2fsm emits the call, it shall include that value in its corresponding named typed field in the actual `invoke.input` object beside the unchanged `prompt`, backed by typed machine context; declaring the field only in a type or storing its value only in context shall not satisfy the actor-input relay ([DR-019](../decisions/019-shared-linked-runtime-factory.md)).

## Verification

### compiler-prompt-relays-2

When the integration suite parses GEARS and composes the resulting acting prompts through the real runtime composer, it shall verify that each governed prompt with a quoted placeholder delivers the exact supplied runtime value, while placing that value only in a condition, result contract, or available input field does not deliver it [[compiler-prompt-relays-1](#compiler-prompt-relays-1)].

### compiler-prompt-relays-4

When the integration suite parses authored instructions with a prose-required untemplated relay and composes the acting prompt, it shall verify that the two GEARS quote markers retain one literal marker and the exact runtime value, while the supplied SLC Source-fidelity checker rejects a single-marker additional token and an added label but accepts an exact Source-authored labelled template [[compiler-prompt-relays-3](#compiler-prompt-relays-3)].

### compiler-prompt-relays-6

When the [task-input integration suite](../../src/compiler-task-input.test.ts) inspects the shipped gears2fsm definition and drives real XState invocations through the shared prompt composer, it shall verify exact actor-input delivery from fresh entry text, text replacing a Source-permitted seed, and an omitted event value retaining that seed, preserving the literal prompt and showing that a context-only value leaves its placeholder unresolved [[compiler-prompt-relays-5](#compiler-prompt-relays-5)].
