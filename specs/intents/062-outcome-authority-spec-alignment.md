<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-062: Align Outcome Authority Specifications

## Status

Done (2026-09-12)

## Intent

Remove stale pre-extension effect-field restrictions from the canonical package so it agrees with accepted [DR-045](../decisions/045-unchanged-receipt-revision-authority.md), the full link contract and the existing reconciler.

## Deliverables

- [x] Align field eligibility, receipt-derived injection and verification with the accepted unchanged-receipt extension.
- [x] Keep the helper descriptor's schema and profile declaration self-contained.

## Tasks

1. [x] Synchronize the existing specifications and verify the real REVIEW receipt paths without changing runtime or benchmark definition bytes.

## Verification

The existing REVIEW integration cases cover a commit-fix round and an all-rejected round without a new commit, asserting `evaluatedRevision` from the actual acknowledged repository receipt.
The inspected reconciler selects effect-owned values by disposition rather than field name, matching the already-correct complete link contract.

Both real REVIEW integration cases pass; Spex 3 reports zero errors, and all repository links resolve.
The bounded branch review leaves the runtime engine, helper v2, frozen comparisons, package version and dependency lock unchanged; the materializer and compact recipe remain proposed experiments awaiting measured retention.
