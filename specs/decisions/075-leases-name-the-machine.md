<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-075: Leases Name the Machine

## Status

Accepted (2026-09-30).
Extends [DR-042](042-shared-session-store-and-replay-stream.md) in one scope: the session lease's owner names its machine by a published machine identity rather than by the operating system's host name; the store, its files, and its lifecycle otherwise stand.
Extends [DR-046](046-public-worktree-host-capabilities.md) in one scope: the repository claim's owner names its machine by the same identity; the capabilities and the claim discipline otherwise stand.

## Context

A session lease ([[playbook-cli-23](../packages/playbook-cli.md#playbook-cli-23)]) and a repository claim ([[playbook-cli-59](../packages/playbook-cli.md#playbook-cli-59)]) each record the owning process's PID and `os.hostname()`, and each reclaims a dead owner only when the recorded host equals the current one, because a process on another machine cannot be probed.
A host name is not a stable name for a machine: macOS follows the name the network assigns (`Mac.lan` one day, `Minion.local` the next), and Linux hosts are renamed.
After such a change every lease the machine wrote reads as foreign, so a crashed owner's lease can never be reclaimed and the operator removes it by hand.
Spex's state-root lease keeps the same rule and met exactly this failure; its review found three mechanisms with one defect and chose one machine identity for all of them.

The session store is shared by the standalone CLI and by Spex, and any writer may take over a dead writer's session on the same machine.
A fix that only one writer adopts regresses that takeover: an identity in the owner's `hostname` field looks foreign to a reader still comparing host names, and vice versa.
The identity therefore belongs to Playbook, which owns the store, and every writer sharing a store adopts it together.

Considered and declined:

- an operating-system advisory lock as the admission authority: Node and Electron expose no `flock`, so each host would carry a native addon, and a local lock says nothing about a lease another machine holds;
- a heartbeat with a deadline: a paused live owner misses its deadline and writes on after a contender takes over;
- a new owner field beside `hostname`: both owner validators reject unknown keys, so every reader sharing a store would need a versioned format before any writer could publish;
- a process start time beside the PID: Node has no portable probe for it, and it needs the same versioned format; PID reuse today yields a refusal, never a second writer, so it waits.

## Decision

- **One machine identity per user and machine**, read from `${XDG_STATE_HOME:-~/.local/state}/playbook/machine-id` on macOS and Linux alike: a private regular file holding one tagged value `machine-id:v1:<UUID>`.
  It is not per Spex home: every store on the machine shares it, so it never lives inside a directory a sync service or Git may carry to another machine.
- **Playbook publishes and reads it** through `@sublang/playbook/machine-identity`, an asynchronous public facade; a host consumes that facade and keeps no copy of its rules.
  An absent file is published once, exclusively and complete; a concurrent creator that loses discards its value and reads the winner's.
  An unreadable or malformed file is never replaced: the identity is unavailable, every new writer refuses to start naming the file and the reason, and no writer falls back to `os.hostname()`.
  A safe file or directory with excess permissions is tightened in place by the store's verified rule; an unsafe path, a wrong owner, or a failed repair refuses.
- **The owner record keeps its shape**: the identity travels in the existing `hostname` field, so no schema changes.
  A reader recognizes only the exact tag as an identity and compares it with its own; an untagged value is a legacy host name, reclaimable only when it equals the current `os.hostname()` and the PID is dead; a value that looks tagged but fails the exact format is unverifiable and refused.
  Diagnostics name a tagged value as a machine identity, never as a host name.
- **The store and the coordinator resolve the identity by default** at their asynchronous lease and claim boundaries, so the CLI, embedding hosts, and every store construction take it without a call change; explicit injection remains for tests.
- **Former-location migration and any cleanup preserve** the `playbook/` state directory and the identity file, which is never a migration input.
- **Coordinated upgrade**: every writer sharing a store stops before the first new writer runs, as [[release-35](../packages/release.md#release-35)] requires for the recovery format.
  An old reader sees a tagged owner as foreign and refuses takeover; a new reader applies the legacy rule to records stopped old writers left; concurrent old and new writers are unsupported.

## Consequences

- A renamed machine reclaims its own dead leases and claims; a lease from another machine is still never broken.
- Spex resolves the same identity through the facade for its state-root lease, and both writers sharing a store take each other's dead sessions over again once both are upgraded.
- The first run after upgrade meets records stopped old writers left; a legacy record whose host name changed since still needs the operator, as today.
- A historical host name that exactly equals this machine's tag would read as local; the unchanged field cannot exclude that deliberate configuration, and a format change would be the price of excluding it.
- The state directory under XDG gains one file beside the former sessions location; nothing prunes or moves it.
