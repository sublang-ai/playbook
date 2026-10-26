<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-120: Faithful Storage Verification

## Status

Fixture corrections and affected verification complete; integration pending (2026-10-25).

## Intent

Preserve native stat precision in generic storage observers and verify approval lifecycle scenarios independently under their existing deadlines, without changing production integrity or approval behavior [[session-persistence-11](../packages/session-persistence.md#session-persistence-11)] [[session-storage-23](../packages/session-storage.md#session-storage-23)].

## Deliverables

- [x] Forward stat options in generic fixtures and retain a consistently numeric no-nanosecond cache fixture.
- [x] Separate the existing five approval workflows into three cohesive cases with drained cleanup and prompt premature-settlement failure.
- [x] Pass affected integration verification and required prepush before integration.

## Tasks

1. Correct storage and approval verification fixtures in one focused commit.

## Verification

PR-88 run 40268082721 remains preserved: Node 20 timed out the aggregate approval case at 20 seconds; Node 22 rejected mixed-stat chunk metadata while testing replay readability and durability.
Each main suite reported 2,899 passed, one failed and 24 skipped; neither matrix reached the capability stage or build.
The exact CI timestamp values and approval timeout phase were not recorded, so no particular rounding value or production deadlock is claimed.
The corrections preserve chunk verification and the existing native approval contract and assertions [[session-persistence-9](../packages/session-persistence.md#session-persistence-9)] [[session-storage-24](../packages/session-storage.md#session-storage-24)].
No unchanged CI retry or whole-suite rerun has been performed for this intent.

The changed-input four-file integration run passed all 185 tests in 42.74 seconds with one worker.
All three approval cases passed under their unchanged 20-second deadlines; this does not establish the exact phase of the original CI timeout.
Required prepush passed with zero spec errors, 311 advisory warnings and clean type checking; independent review accepted the fixture-only repair.
Production files and their integrity checks remain unchanged; integration is pending.
