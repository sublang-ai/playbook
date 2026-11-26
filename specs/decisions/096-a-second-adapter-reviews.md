<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-096: A Second Adapter Reviews

## Status

Accepted (2026-10-26).
Amends [DR-053](053-seeding-picks-a-ready-adapter.md).
Amended by [DR-099](099-seeds-run-at-medium-effort.md).

## Context

[DR-053](053-seeding-picks-a-ready-adapter.md) seeds every agent on the first ready adapter.
On a machine where both Claude and Codex are configured, that seeds a Reviewer on the same provider as the Coder whose commits it reviews.
A reviewer from another provider brings a different model's blind spots to the same change, and the user has already paid for both.

Spex seeds the same starter for its own users.
It copies the template, so on the same machine the two front ends can seed different agents, a gap [DR-053](053-seeding-picks-a-ready-adapter.md) recorded as a consequence.
Spex cannot adopt the rule while it exists only inside the launcher: a copy would drift the first time the table or the rule changes.
This record changes [DR-053](053-seeding-picks-a-ready-adapter.md) in two scopes — the both-ready `dev.reviewer` takes the second adapter, and the selection becomes a public export, so that record's consequence of a differently seeded desktop lineup no longer holds once a host adopts the export; the credential-only readiness test, the fixed order, the efforts, the none-ready notice, and the one exclusive create stand.

## Decision

- Where both `claude` and `codex` are ready, the seed shall set only `dev.reviewer` to the second adapter (`codex`, with the models Cligent selects under [DR-105](105-runtime-owned-seed-and-delegation.md) and the `.git` writable-path grant every codex agent takes); the Captain and every other player keep the first adapter, as written in the template.
  Where only one adapter is ready, or none, the seed is unchanged: every agent on that adapter, or the template with its notice.
- The second-adapter Reviewer takes effort `high` ([DR-099](099-seeds-run-at-medium-effort.md)); beyond that, only the adapter, model, and writable-path grant change, so the template still supplies structure, comments, and efforts.
- Readiness stays credentials alone, checked synchronously before the file is written; no runtime probe, model call, or quota check takes part.
- The selection ships as the public subpath `@sublang/playbook/seed-config`, which returns the text the launcher would seed under a given environment and home.
  The launcher seeds through that same implementation, so a host that seeds through the export selects the same agent settings (`adapter`, `model`, `effort`, `writablePaths`) for the Captain and every player under the same credentials and home.
- Hosts may still write different files: a host chooses its own path and may transform the text, as Spex drops `playbooks.*.from`.
  Unifying file locations and `from` conventions is out of scope.

## Consequences

- A fresh install with both credentials runs its Reviewer on Codex and every other agent on Claude.
- A present credential still does not prove the second adapter works; a failed Reviewer call surfaces through the host's failure reporting and remains tunable in place.
- Existing configs are untouched: seeding writes only an absent file.
- A suite asserting the both-ready row must pin both credentials, as the other rows already pin theirs.
- Hosts adopting the export pick up later rule and table changes by upgrading Playbook, with nothing to keep in sync by hand.
