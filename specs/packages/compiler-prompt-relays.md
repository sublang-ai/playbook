<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-prompt-relays: Authored Context Delivery

## Intent

This package clarifies the existing text-to-GEARS duty to deliver source-authored runtime context through acting prompts, including relay requirements stated in prose rather than explicit templates.
It introduces no new domain behavior or semantic adjudicator.

## External Behavior

### compiler-prompt-relays-1

When Source requires a runtime value relayed to an acting role, text2gears shall include the required quoted placeholder in the complete prompt blockquote of every acting behavior governed by that relay, including a relay described only in prose; mentioning the value in a condition, result contract, or machine context shall not substitute for delivery in the prompt.

### compiler-prompt-relays-3

Where Source names a relayed value without authoring its prompt template, text2gears shall render the value as a bare quoted placeholder line `> <token>` without an added label or surrounding prose; Source-authored template labels shall remain part of their original prompt fragments.

## Verification

### compiler-prompt-relays-2

When the integration suite parses GEARS and composes the resulting acting prompts through the real runtime composer, it shall verify that each governed prompt with a quoted placeholder delivers the exact supplied runtime value, while placing that value only in a condition, result contract, or available input field does not deliver it [[compiler-prompt-relays-1](#compiler-prompt-relays-1)].

### compiler-prompt-relays-4

When the integration suite checks authored instructions with a prose-required untemplated relay through the supplied SLC Source-fidelity checker, it shall verify acceptance of the bare quoted placeholder and rejection of an added label, while accepting an exact Source-authored labelled template [[compiler-prompt-relays-3](#compiler-prompt-relays-3)].
