<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-020: Spec-Layout-Agnostic Review Prompts

## Status

Accepted

## Context

- Playbook prompts must work across repositories whose spec items use either the packages layout or the user/dev/test layout.
- Repeating either layout in prompts makes the playbook stale when the repository structure changes.
- This repository and current scaffolds use `specs/intents/` for intent records while retaining the IR acronym and existing identifiers.

## Decision

- CODE and REVIEW shall describe spec quality without classifying changes by item-directory names.
- Their agents shall consult `@specs/map.md` for repository context and `@specs/meta.md` for the active spec structure and requirements.
- A new IR shall be filed under `@specs/intents`; prompts shall call it an intent record when the record type must be named.

## Consequences

- CODE and REVIEW remain portable across supported spec-item layouts.
- Spec placement stays centralized in `map.md` and `meta.md` rather than duplicated in prompts.
- Intent records use one current path and vocabulary without a legacy directory fallback.
