<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-025: GEARS grammar provenance

## Status

Done

## Intent

Implement [DR-018](../decisions/018-gears-grammar-provenance-from-spex.md): cite the GEARS grammar from the installed `@sublang/spex` package and codify the unified language rule in the maintained definitions.

## Deliverables

- [x] [DR-018](../decisions/018-gears-grammar-provenance-from-spex.md), [[release-22](../packages/release.md#release-22)], [[release-23](../packages/release.md#release-23)], and their `map.md` rows landed.
- [x] [`slc/text2gears.md`](../../slc/text2gears.md) cites the spex-shipped GEARS definition (English and Chinese, with the two canonical URLs) and carries the unified language rule.
- [x] [`slc/optimize.md`](../../slc/optimize.md) repoints its fixed-English script-clause note to the same authority.
- [x] `package.json` declares `@sublang/spex` `^0.3.0` as a regular dependency with `pnpm-lock.yaml` updated, and the package-surface tests pin the specifier and resolution.

## Tasks

1. Author DR-018, release-22, release-23, and their `map.md` rows.
2. Add the `@sublang/spex` dependency, amend the two definitions, pin the resolution in the package-surface tests, and record the change in `CHANGELOG.md`.

## Verification

- No `slc/*` file cites `/specs/meta.md`; `slc/text2gears.md` and `slc/optimize.md` cite the installed `@sublang/spex` GEARS definition files and the two canonical URLs.
- `pnpm test` passes, including resolution of `@sublang/spex/scaffold/specs/meta.md` and `@sublang/spex/scaffold/i18n/zh/specs/meta.md` from the repo root.
- This repository's own `specs/meta.md` is unchanged by the iteration.
