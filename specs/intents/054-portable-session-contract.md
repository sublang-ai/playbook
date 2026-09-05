<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-054: Portable Session Contract

## Status

Planned; implementation awaits the owner's review of the coordinated storage paperwork.

## Intent

Implement [DR-049](../decisions/049-portable-session-contract.md).

## Deliverables

- [ ] Implement schema-7 codec, migration and token-free nested recovery.
- [ ] Publish the shared host lifecycle and adopt it in both CLI front ends.
- [ ] Add context recording, durable replay digests and persistent incompleteness.
- [ ] Implement local hint consumption and classified fresh fallback.
- [ ] Verify cross-host continuation, migration, deletion and path-refusal matrices.

## Tasks

1. Implement schema-7 codec, migration and token-free nested recovery.
2. Publish the shared host lifecycle and adopt it in both CLI front ends.
3. Add context recording, durable replay digests and persistent incompleteness.
4. Implement local hint consumption and classified fresh fallback.
5. Verify cross-host continuation, migration, deletion and path-refusal matrices.

## Verification

- Required integration matrices are defined in the owning spec packages.
- No implementation tests or builds have run for this intent.
