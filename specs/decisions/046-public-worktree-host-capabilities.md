<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-046: Public Worktree Host Capabilities

## Status

Accepted

## Context

Schema-3 governance under [DR-040](040-outcome-authority-effect-reconciliation.md) requires every host to supply live repository and effect-ledger capabilities: observe the Git worktree around a governed call, classify what the call did, and hand the engine a receipt it validates.
The package publishes only the interfaces; the one correct implementation lives inside the CLI host at `reference/sdlc/code.playbook/bin/repository-effects.js`.
Two more implementations therefore grew outside it — the SubLang Compiler's demo host and its compiled-phase executor — and an adversarial review found the compiler's copy diverging from the engine in seven confirmed ways, one of which silently accepted uncommitted edits as `unchanged`.
[DR-042](042-shared-session-store-and-replay-stream.md) already established the pattern for sharing a CLI-host facility with external hosts: a narrow, self-contained, typed facade over the host's own module, published as a semver-stable subpath.

## Decision

The package publishes `@sublang/playbook/host-capabilities`: a narrow self-contained JavaScript and TypeScript facade over the CLI host's repository-effect module, so every embedding host constructs live worktree capabilities and classifies receipts through the same implementation the engine ships with.

- The facade exposes exactly what an embedding host needs: constructing live schema-3 `{ repository, effectLedger }` capabilities for a Git worktree from a host-owned ledger seed, observing a worktree, capturing and classifying a receipt against the declared dispositions, and a fail-closed capabilities constructor for hosts that run no governed states.
- Lease, session-record, and Captain-lifecycle members stay private to the CLI host; the facade carries no resume credential and no manifest access.
- `bin/repository-effects.js` remains the single implementation; the facade re-exports it and declares its types, and the CLI host keeps consuming the module directly.
- The facade binds the governed worktree lazily, at each governed call and observation, to the nearest worktree containing the working directory or else to that directory as its own prospective root, and the shared observer reports a HEAD naming no commit as the null OID — because an embedding host's workflow may initialize its own repository and make its first commit under governance, which a worktree resolved once at construction and an observer that refuses an unborn HEAD cannot classify.
- The subpath joins the packed and pinned public surfaces under the same release gates as `./session-store`, including the packed external-consumer type-check.

## Consequences

- Hosts that copied the classifier delete their copies at their next adoption and inherit every engine-contract change, such as [DR-045](045-unchanged-receipt-revision-authority.md), automatically.
- Any change to receipt classification is made once and verified once.
- Removing or renaming the facade is a breaking release under the package's SemVer policy.
