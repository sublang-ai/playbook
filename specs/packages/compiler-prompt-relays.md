<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-prompt-relays: Authored Context Delivery

## Intent

This package specifies compiler duties to deliver source-authored runtime context through acting prompts and typed actor inputs, including relay requirements stated in prose rather than explicit templates and values the Source defines as a labelled section of another relayed text.
It introduces no new domain behavior or semantic adjudicator.

## External Behavior

### compiler-prompt-relays-1

When Source requires a runtime value relayed to an acting role, text2gears shall include the required quoted placeholder [[playbook-6](playbook.md#playbook-6)] in the complete prompt blockquote of every acting behavior governed by that relay, including a relay described only in prose; mentioning the value in a condition, result contract, or machine context shall not substitute for delivery in the prompt.

### compiler-prompt-relays-3

Where Source names a relayed value without authoring its prompt template, text2gears shall render the value as a bare quoted prompt-content line `> <token>` [[playbook-6](playbook.md#playbook-6)], written as `> > <token>` in the GEARS file because its first marker encloses the prompt, without an added label or surrounding prose; Source-authored template labels shall remain part of their original prompt fragments.

### compiler-prompt-relays-5

Where a direct-Captain or delegated-player prompt carries a Source-declared runtime-value placeholder other than an invocation-scoped local-role identity [[playbook-runtime-15](playbook-runtime.md#playbook-runtime-15)], when gears2fsm emits the call, it shall include that value in its corresponding named typed field in the actual `invoke.input` object beside the unchanged `prompt`, backed by typed machine context; declaring the field only in a type or storing its value only in context shall not satisfy the actor-input relay ([DR-019](../decisions/019-shared-linked-runtime-factory.md)).

### compiler-prompt-relays-7

Where Source defines a placeholder as a labelled section of another relayed value, naming the label that opens the section and the labels that end it, text2gears shall state that definition in a requirement item that keeps the Source's defining words, name the placeholder as Source does, and declare no result property for it, because the value is derived from the relayed text rather than produced by any player ([DR-068](../decisions/068-labelled-section-placeholders.md), [DR-104](../decisions/104-compiled-gears-is-a-spec-package.md)).

### compiler-prompt-relays-9

Where GEARS defines a placeholder as a labelled section of another relayed text, naming the label that opens the section and the labels that end it, gears2fsm shall derive the placeholder's typed context field from that text as read — each line without its leading `>` and one optional space where every non-blank line begins with `>`, and the text unchanged otherwise — in the entry action or transition that stores the text and in every action that replaces it ([DR-068](../decisions/068-labelled-section-placeholders.md)):

| Case | Derived field |
| --- | --- |
| A line begins with the opening label, and the section — the lines from the first such line, the label removed, through the line before the first later line that begins with an ending label, or through the last line — is nonempty once trimmed | That section, trimmed, including any line inside it that merely looks labelled |
| No line begins with the opening label, or that section is empty once trimmed | The whole text as read, trimmed |

## Verification

### compiler-prompt-relays-2

When the integration suite parses GEARS and composes the resulting acting prompts through the real runtime composer, it shall verify that each governed prompt with a quoted placeholder delivers the exact supplied runtime value, while placing that value only in a condition, result contract, or available input field does not deliver it [[compiler-prompt-relays-1](#compiler-prompt-relays-1)].

### compiler-prompt-relays-4

When the integration suite parses authored instructions with a prose-required untemplated relay and composes the acting prompt, it shall verify that the two GEARS quote markers retain one literal marker and the exact runtime value, while the supplied SLC Source-fidelity checker rejects a single-marker additional token and an added label but accepts an exact Source-authored labelled template [[compiler-prompt-relays-3](#compiler-prompt-relays-3)].

### compiler-prompt-relays-6

When the [task-input integration suite](../../src/compiler-task-input.test.ts) inspects the shipped gears2fsm definition and drives real XState invocations through the shared prompt composer, it shall verify exact actor-input delivery from fresh entry text, text replacing a Source-permitted seed, and an omitted event value retaining that seed, preserving the literal prompt and showing that a context-only value leaves its placeholder unresolved [[compiler-prompt-relays-5](#compiler-prompt-relays-5)].

### compiler-prompt-relays-8

When the integration suite reads the shipped text2gears and gears2fsm definitions, it shall verify that text2gears states the definition in a requirement item and declares no result for the derived placeholder [[compiler-prompt-relays-7](#compiler-prompt-relays-7)], that gears2fsm states the derivation [[compiler-prompt-relays-9](#compiler-prompt-relays-9)], and that the derivation as stated yields the defined section for a caller's quoted labelled request, a multi-line quoted section whose look-alike labelled lines stay in it, an unquoted request whose section runs to the end of the text and keeps its quoted lines as content, an empty section, and unlabelled plain and quoted requests [[compiler-prompt-relays-9](#compiler-prompt-relays-9)].
