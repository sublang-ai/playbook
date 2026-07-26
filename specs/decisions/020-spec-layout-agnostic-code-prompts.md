<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-020: Spec-Layout-Agnostic CODE Prompts

## Status

Accepted

## Context

- CODE's prompts and review-routing conditions hardcode the legacy three-folder item layout: the Coder IR-done prompt files items into `@specs/user`, `@specs/dev`, and `@specs/test`; the Reviewer "Right level" checklist line names the same folders; the Captain routes review rounds and classifies commits by whether changes touch `@specs/{user,dev,test}/`.
- Downstream scaffolds have moved to a packages layout — `specs/packages/` (one file per package with External Behavior / Internal Behavior / Verification sections) and `specs/compositions/` — where those folders do not exist.
  On such trees, agents hunt for missing paths (sometimes outside the project) and the commit classification misroutes review rounds.
- Downstream scaffolds have since renamed `specs/iterations/` to `specs/intents/` — *intent records*, with the `IR` acronym and existing ids unchanged (spex DR-017) — so the record vocabulary this decision excludes, and the path CODE files a decomposition record into, both have a current and a legacy spelling.
- Constraint: the adjudicating judge is a bare LLM call with no filesystem access, so result-guard descriptions must be self-contained; player prompts, by contrast, may lean on `@specs/map.md` and `@specs/meta.md`, which every scaffold layout ships.

## Decision

- Classify by one defined term, **spec item files**: the files under `@specs/` that hold spec items — `@specs/packages/` and `@specs/compositions/` in the current layout, or `@specs/user/`, `@specs/dev/`, and `@specs/test/` in the legacy one; decision and intent records (iteration records in older scaffolds), `@specs/map.md`, and `@specs/meta.md` are not spec item files.
  The definition lives once in `code.md`'s Reviewer preamble and carries into the GEARS artifact.
- Captain conditions and FSM state descriptions say "in / outside / both in and outside spec item files" instead of naming folders.
- Judge-facing result descriptions stay self-contained: they carry the term with a compact both-layouts parenthetical (and, on the "outside" arm, the records/map/meta exclusion) instead of citing files the judge cannot read.
- Player prompts name spec levels layout-neutrally — the external behavior users rely on, the internal system behavior, the integration/system test cases — deferring placement to the already-cited `@specs/meta.md`; the Reviewer "Right level" line drops folder paths the same way.
- Where a prompt must name a record location rather than a spec level — the Coder decomposition prompt filing a new IR — it names the current path with the legacy one as an explicit alternative (`@specs/intents`, or `@specs/iterations` in older scaffolds), the same both-layouts form this decision already uses for spec item files. Judge-facing descriptions name decision, intent, or legacy iteration records for the same reason.
- [PLAYBOOK-18](../dev/playbook.md#playbook-18)/[PLAYBOOK-19](../test/playbook.md#playbook-19) pin the new checklist wording; both prior "Right level" wordings become excluded legacy lines.

## Consequences

- CODE routes reviews and classifies commits correctly on packages-layout and legacy trees alike, with one compiled playbook.
- The judge decides commit scope from an explicit inline definition rather than a folder glob that may not exist in the target repo.
- Reviewer semantics are unchanged in substance; only the location vocabulary generalizes.
- The DISCUSS playbook and the draft DOC source carried the same legacy folder references and git-spec citation; both were ported to this decision's wording in the same unreleased cycle.
