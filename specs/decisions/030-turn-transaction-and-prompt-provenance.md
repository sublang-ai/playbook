<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-030: The turn transaction and prompt provenance

## Status

Accepted.

## Context

The session Captain shell ([DR-029](029-session-scoped-conversational-captain.md)) has no domain model for a turn, for the session's memory, or for what a prompt fragment carries.
Three defect classes therefore recur at whichever site the last review round did not touch: a turn ending without a truthful settlement, an effect claimed or a failure blamed beyond what the operation itself reported, and control data reaching Boss prose or Boss prose refused as control data.
Two earlier revisions of this record patched the sites a round had found, and each shipped an invariant no real turn could satisfy.
This record replaces that method with three contracts adopted whole — one turn transaction, one session log, and provenance carried on the text — which together resolve the empty-sequence contradiction, compound `switch`, truthful failure reporting, refusal duplication and loss, the final turn of a session, stale identifier leakage across turns, and prose-label false positives.

## Decision

### 1. One authoritative turn transaction

- Every Boss turn the shell takes up produces exactly one transaction, recording the Boss input, the decision outcome, the selected action if any, ordered operation receipts, the derived settlement, and the delivery receipt. Input carrying no text is not taken up and produces no transaction. No second account of the same turn stands beside it.
- Each operation reports one of **not applied** (proven no effect), **applied** (proven effect), or **unknown** (it failed after its effect may have landed, or proved neither). The report states what that one operation proves about its own effect: a raised failure is `unknown` unless the operation proves it left none, and no report is read off the shape of a return or the fact that something threw.
- `unknown` is the absence of proof, not a kind of failure. No settlement, retry, or later turn resolves it in either direction.
- A receipt exists only because an operation was invoked, and names that one operation. A compound action produces one receipt per operation, in order: `switch` dismisses and then starts, so a failed start stands beside the succeeded dismissal instead of replacing it.
- The settlement derives from the decision outcome **and** the receipts, never from the receipts alone — a successful `respond`, a refusal before any effect, and a failed decision with no selection all hold no receipts yet owe different settlements.
- The settlement is derived when the turn settles, never assigned, and claims nothing the transaction does not hold: an `unknown` receipt is stated as unproven, neither dropped nor softened into certainty.
- The delivery receipt reports one of **shown**, **not shown** (proof that nothing was emitted), or **unknown** (it failed after emission may have begun, or the boundary cannot prove that nothing was emitted). Absence of proof is `unknown`, never `not shown`.
- A further presentation attempt is allowed only after **not shown**; **unknown** is never retried and never represented as seen. The presentation boundary must supply this truth; the API carrying it is the IR's.
- A turn that aborts settles on the evidence it holds, an operation still in flight being `unknown`. A presentation the abort forecloses before anything is emitted is **not shown**; one cut off once emission may have begun is **unknown**.

### 2. One authoritative session log with a per-conversation position

- The session log holds the turn transactions in order. It is the session's only memory of past turns and the only source of what any prompt carries about them; the live-state and catalog digests keep being composed from live state ([CAPTAIN-9](../dev/playbook-captain.md#captain-9)).
- Each Captain conversation holds its own position in the log. While the session lasts a healthy conversation is given each new record once and never twice; a replacement conversation is given the complete log, so it is told everything the conversation it replaces was told.
- Records a conversation was never given simply remain recorded when the session ends. No model call is made for the sole purpose of delivering them, so the final turn of a session needs no special case.
- This is one channel and not two: it replaces both DR-029 §2's reseed-only journal and the separate refusal notice, so no settlement can be delivered twice by two paths or lost by belonging to neither. Storage, ordering, and position mechanics are the IR's.

### 3. Provenance survives as long as the conversation knows the text

| Property | Values | What follows from it |
| --- | --- | --- |
| exposure | speakable \| quoted evidence \| control | what may appear in Captain prose: a control identifier never may, speakable content may, quoted evidence only as quotation |
| trust | Boss \| shell \| foreign | encoding: shell text is carried as written, Boss text is escaped and carried whole, foreign text is escaped and bounded |

- The properties are independent and all prompt content carries both. A runtime-authored action label is speakable *and* foreign, so it is escaped and bounded yet never forbidden, while that runtime's action id is control *and* foreign. Reading either property as evidence of the other is what refused a legitimate label and what let unregistered identifiers through.
- A control identifier is forbidden for the lifetime of every conversation that received it, not for the turn that composed it, and is restored with the log when a replacement conversation is seeded (§2). A stale identifier leaking across turns and the duty lapsing at a reseed are one defect.
- No lexical guessing anywhere: neither property is re-derived from the shape of composed text, in either direction, and composition carries the properties its parts already held.
- Nothing else about the host's validation duty changes: live session and engagement-state identifiers stay known by identity from live shell state, and a value the shell cannot tell from ordinary English is still not refused ([CAPTAIN-9](../dev/playbook-captain.md#captain-9)).

## Supersessions

- [DR-029 §2](029-session-scoped-conversational-captain.md) — the reseed-only journal, replaced by §2's log.
- [CAPTAIN-9](../dev/playbook-captain.md#captain-9) — the supplied-identifier set scoped to this turn's prompts, replaced by §3's exposure; and the bar on journal-derived text reaching a conversation that is not being reseeded, replaced by §2's log.
- [CAPTAIN-34](../user/playbook-captain.md#captain-34) — "exactly one visible settlement" is withdrawn as unsatisfiable; §1 settles every turn and shows a settlement at most once.
- [CAPTAIN-35](../dev/playbook-captain.md#captain-35) — the journal-plus-carry-forward arrangement, replaced by §2's single channel.
- No item file is amended here; the implementing IR lands every edit.

## Alternatives considered

- **Patch the sites each round finds** — the method that shipped two unsatisfiable invariants, named by review as the error itself.
- **A per-turn status summary standing beside the transaction** — a second account of one turn, free to disagree with the first.

## Consequences

- Unconstructible rather than avoided: a settlement claiming more than its transaction holds, an effect attributed to an operation that reported none, a compound action reporting one fact, a settlement delivered twice or lost, and a control identifier reaching Boss prose through a site nobody registered.
- The presentation boundary owes a delivery truth where it returns nothing today, and its callers handle three outcomes.
- The shell is restructured around the transaction and the log: operations invoked through a seam that mints receipts, settlement derived rather than assigned, prompt content carrying exposure and trust, one log feeding every conversation.
