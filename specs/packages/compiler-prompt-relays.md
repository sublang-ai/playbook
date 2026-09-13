<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-prompt-relays: Authored Context Delivery

## Intent

This package clarifies the existing text-to-GEARS duty to deliver source-authored runtime context through acting prompts, including relay requirements stated in prose rather than explicit templates.
It introduces no new domain behavior or semantic adjudicator.

## External Behavior

### compiler-prompt-relays-1

When Source requires a runtime value relayed to an acting role, text2gears shall include the required quoted placeholder in the complete prompt blockquote of every acting behavior governed by that relay, including a relay described only in prose; mentioning the value in a condition, result contract, or machine context shall not substitute for delivery in the prompt.

## Verification

### compiler-prompt-relays-2

When the integration suite parses GEARS and composes the resulting acting prompts through the real runtime composer, it shall verify that each governed prompt with a quoted placeholder delivers the exact supplied runtime value, while placing that value only in a condition, result contract, or available input field does not deliver it [[compiler-prompt-relays-1](#compiler-prompt-relays-1)].
