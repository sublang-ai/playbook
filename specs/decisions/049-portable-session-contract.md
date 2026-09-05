<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-049: Portable Session Contract

## Status

Accepted (2026-09-05); implementation awaits the owner's review of the coordinated storage specifications.
Amends [DR-031](031-shared-captain-session-front-ends.md) for embedding-host lifecycle parity, [DR-042](042-shared-session-store-and-replay-stream.md) for manifest ownership, defaults, durable replay status and local hints, [DR-040](040-outcome-authority-effect-reconciliation.md) for token-free deferred-player identity, and [DR-029](029-session-scoped-conversational-captain.md) for definite-rejection-only immediate fresh retry.

## Context

- Spex desktop and the CLI need one durable session and one management path; separate sidecars and private lifecycle writers cannot provide that.
- Git can carry recovery evidence and history, but provider stores and machine paths remain external.

## Decision

- Playbook owns the shared session contract and lifecycle [[session-storage-1](../packages/session-storage.md#session-storage-1)] [[session-storage-11](../packages/session-storage.md#session-storage-11)]; application registries remain host-owned.
- Schema 7 binds token-free recovery to a durable replay prefix; context records retain historical participants/settings/graphs under the unchanged v1 envelope [[session-storage-2](../packages/session-storage.md#session-storage-2)] [[session-storage-4](../packages/session-storage.md#session-storage-4)] [[session-storage-5](../packages/session-storage.md#session-storage-5)].
- Local hints belong to an exact checkpoint and are consumed before use; deferred operations bind player identity, never a provider token [[session-storage-6](../packages/session-storage.md#session-storage-6)] [[session-storage-7](../packages/session-storage.md#session-storage-7)].
- Only definite pre-execution session rejection permits one fresh attempt; ambiguous execution preserves uncertainty [[session-storage-8](../packages/session-storage.md#session-storage-8)].
- The initial format supports no checkpoint path relocation: differing repository/module paths permit history only [[session-storage-9](../packages/session-storage.md#session-storage-9)].
- Shared migration retains ignored originals; deletion keeps retired guards and removes the manifest last [[session-storage-10](../packages/session-storage.md#session-storage-10)] [[session-storage-12](../packages/session-storage.md#session-storage-12)].

## Consequences

- Embedding hosts reuse recovery and effect-ledger code; they do not serialize their own session authority.
- Both Captain and player history travel, including graph definitions; exact provider knowledge does not.
- Historical formats remain readable, with execution limited to provably compatible checkpoints.
- The Spex home catalog is the cross-project review entry point [[1]]; each owning package defines its contract once.

## References

[1]: https://github.com/sublang-ai/spex/blob/main/docs/storage.md "Spex home catalog"
