<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-018: GEARS grammar provenance from @sublang/spex

## Status

Accepted.

## Context

`slc/text2gears.md` cited the GEARS grammar as `[GEARS syntax](/specs/meta.md#item-syntax)` — a root-relative link that rebinds to whichever repository hosts a copy of that file, so vendoring or installing the definition silently changes which grammar is the authority.
The published `@sublang/spex` package ships the canonical GEARS definition in its scaffold: `scaffold/specs/meta.md` (English, META-6) and, from 0.3.0, `scaffold/i18n/zh/specs/meta.md` (Chinese: `[给定 <静态前置条件>] [如果 <状态前置条件>] [当 <触发>] <主体>应<行为>。`), each citing its canonical rendition at <https://sublang.ai/ref/gears-ai-ready-spec-syntax> (en) and <https://sublang.ai/zh/ref/gears-ai-ready-spec-syntax> (zh).
`@sublang/spex` declares no `exports` field, so those subpaths resolve freely from any consumer's module tree.
The language contract for compiled GEARS was fragmented: `slc/text2gears.md` said only "Target should be written in the same language as Source", while the fixed-English machine-syntax rule was stated only for the script clause in `slc/optimize.md`.

## Decision

- The grammar authority for the shipped `slc/*` definitions is the GEARS definition shipped by the installed `@sublang/spex` package — `@sublang/spex/scaffold/specs/meta.md` (English) and `@sublang/spex/scaffold/i18n/zh/specs/meta.md` (Chinese) — cited in numbered-reference style together with the two canonical URLs.
- `@sublang/spex` becomes a regular runtime dependency (`^0.3.0`), so the cited files resolve in every install closure ([RELEASE-22](../dev/release.md#release-22), verified by [RELEASE-23](../test/release.md#release-23)).
- `slc/text2gears.md` carries the unified language rule: an item's condition prose, acting prompts, and result descriptions follow the Source language, per the matching localization of the GEARS definition; the four `Captain shall` acting-clause forms, guard names, and the `Players:`/`Results:` labels are fixed machine syntax in exact English regardless of Source language.
- `slc/optimize.md` keeps its script-clause fixed-English sentence and repoints it to the same authority.
- Playbook's own `specs/meta.md` remains this repository's spec-authoring convention, unchanged; the shipped `slc/*` definitions simply no longer cite it.

## Consequences

- Consumers of the shipped `slc/*` definitions pin the published grammar artifact instead of a local copy; vendoring the definitions no longer rebinds the citation.
- Localized sources compile under one language contract, with machine syntax stable for downstream compilers (`gears2fsm`, conformance tooling).
- The install closure grows by one dependency-free documentation package.
- The `slc/*` surface stays semver-stable per [RELEASE-16](../dev/release.md#release-16); the provenance change is citation wording, not surface shape.
