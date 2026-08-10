<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-037: Markdown cross-reference check

## Goal

Make a broken spec cross-reference fail the suite instead of waiting for
someone to notice.

`specs/` is the declared source of truth and its item files cite each other
heavily — roughly 1200 relative links across 92 documents — yet nothing
validated them. Two manual audits had just repaired 33 dead links
(`68754ce`, `700bfdd`) with no guard against the next one.

Two defect classes drove the design, both drawn from links actually found
broken:

| Class | Instance | Why a naive check misses it |
| --- | --- | --- |
| Wrong file, live target | `(playbook-cli.md#pbcli-36)` from `specs/test/` | The path resolves — to the wrong group's file. Only the anchor check catches it. |
| Slug spelling | `#11-host-adapter-tmux-play` | GitHub drops the em dash but keeps both flanking spaces, so the real anchor is `#11-host-adapter--tmux-play`. Any slugger collapsing hyphen runs accepts the broken spelling. |

Scope is the XREF package: resolution rules and their acceptance tests. No
runtime, CLI, or published-surface change.

### Out of scope

- Markdown outside [XREF §Checked
  Files](../dev/cross-references.md#checked-files) — `slc/`, `docs/`, and
  `reference/` are unscanned, though links *into* them are resolved.
- Raw HTML `<a href>` links, declared out of scope in XREF §Exclusions.
- Prose or link-text edits; only dead link targets were repointed.

## Deliverables

- [x] IR-037 doc and its `map.md` row.
- [x] [`specs/dev/cross-references.md`](../dev/cross-references.md) — new
  XREF package: XREF-1 (target exists within the project directory), XREF-2
  (fragment matches a rendered anchor), plus the Checked Files, Exclusions,
  and Anchor Slugs scope sections and the github-slugger reference.
- [x] [`specs/test/cross-references.md`](../test/cross-references.md) —
  XREF-3 and XREF-4, each verifying its dev item.
- [x] `scripts/check-links.mjs` — dependency-free checker beside
  `check-spdx.sh`, exported for the suite and runnable as `pnpm check:links`.
- [x] `src/cross-references.test.ts` — the XREF-3 / XREF-4 acceptance case
  over the real tree, plus fixture cases for each rule. Unit coverage of the
  slug helper stays unspecified per [META-21](../meta.md#meta-21).
- [x] [`specs/decisions/002-in-page-xstate-visualizer.md`](../decisions/002-in-page-xstate-visualizer.md)
  — two links into a sibling `cligent` checkout repointed at its published
  URL, matching how DR-004, DR-009, and DR-027 already cite cligent.
- [x] `package.json` `check:links` script and the `CHANGELOG.md` entry.

## Tasks

1. **Land the XREF package, the checker, and its tests.** _[done]_
   One commit: spec items, `scripts/check-links.mjs`, the vitest case,
   `map.md` rows, `package.json`, and `CHANGELOG.md`, plus the DR-002 link
   repointing needed to make the check pass on a clean checkout.
   No CI change — `pnpm test` already runs in the `playbook` job, so the
   check rides the existing suite rather than taking its own job the way
   `check-spdx.sh` does (that one needs bash and git, and no install).

## Acceptance criteria

- `pnpm check:links` and `pnpm test` both report every relative link in the
  [checked files](../dev/cross-references.md#checked-files) resolving, on a
  clean clone with no neighboring repository present.
- [XREF-3](../test/cross-references.md#xref-3) and
  [XREF-4](../test/cross-references.md#xref-4) fail when their rule is
  broken: verified by mutation, with 21 mutations of the checker — among
  them collapsing hyphen runs, skipping the anchor check, accepting a target
  outside the repository, keying the anchor cache by basename, and scanning
  no files — each turning the suite red.
- The slug derivation agrees with `github-slugger` on every heading in the
  repository.
- `pnpm build` is clean and `specs/map.md` lists IR-037 and the XREF rows.
