<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-057: Public Linked Option Validator

## Status

Accepted.

## Context

A deterministic registry entry cannot reconstruct arbitrary workflow option schemas from TypeScript annotations.
The linked artifact already owns the pure option snapshot used by its shared factory.
A generated required input annotation can also accidentally duplicate per-turn Boss text, independently of this entry boundary.

## Decision

Newly linked artifacts expose their existing option snapshot function as public synchronous `validateOptions(value: unknown): PlaybookRuntimeOptions` and bind the same function as `snapshotOptions`.
Only absent `undefined` normalizes to an empty option slice; required options, exact JSON validation, snapshots and source-authored defaults remain artifact-owned.
Validation requires no runtime construction or host capabilities.
Entry hosts detect this explicit export, retain their legacy boundary when it is absent, and never infer an option schema from types or runtime versions.
Boss text already delivered by the entry event is required at construction only when Source independently demands it before that turn; a generated type annotation is not that evidence.

## Consequences

The additive export needs no engine ABI or package version change.
Required catalogs remain possible without casts or invented defaults in the entry host.
Existing artifacts and frozen experiment inputs remain unchanged.
