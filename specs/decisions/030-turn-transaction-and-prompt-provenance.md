<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-030: The turn transaction and prompt provenance

## Status

Accepted.

## Context

Nine review rounds over the session Captain shell ([DR-029](029-session-scoped-conversational-captain.md)) closed the same three defect classes, each round at sites the round before had not touched:

- a Boss turn ending without a truthful visible settlement;
- an error attributed to an operation that did not throw;
- control data reaching Boss prose, or Boss prose refused as control data.

The shell has no domain model for a turn or for a prompt fragment, so every invariant is re-enforced by convention wherever a new site appears, and two contracts are missing: what a turn records, and what a prompt fragment carries.
One selected action can perform several effecting operations — `switch` dismisses the stack and then starts the target, and [DR-029 §4](029-session-scoped-conversational-captain.md) requires both facts reported when the start then fails — so a single-valued account of what a turn did cannot describe a real turn.
A rejected presentation is not proof of non-delivery: cligent's record dispatcher awaits each observer in turn (`src/app/tmux-play/records.ts:170`, `:212`), so the presenter can render to the Boss before a later observer throws.
And the shell's two memory paths — an append-only journal and a separate refusal carry-forward — are where round 8 found a settlement carried to the conversation twice on one path and never on another, and a replayed record putting a control identifier into a prompt with nothing live advertising it.

## Decision

### 1. A turn records ordered evidence; its settlement is derived from that record

- The turn's record is the ordered sequence of the operations its selected action performed. Each entry names the single operation invoked, whether it took effect, and what it produced.
- An entry exists only because an invocation minted it, at that invocation. No turn-scoped flag, enclosing region, or later site may write, amend, or infer one, and a turn that selected nothing carries an empty sequence.
- Whether an operation took effect is that operation's own report and never the shape of what it produced; a raised value is part of what it produced and decides none of the three by itself:
  - **none** — proven no effect: the operation was refused, or failed before it could apply one;
  - **applied** — proven it took effect;
  - **unknown** — it failed after its effect may have been applied, or reported nothing that proves either way, this being what an operation carries absent a report of its own; it is not a kind of failure but the absence of proof, and no settlement, retry, or later turn may resolve it in either direction.
- The settlement is a total function of the sequence, computed when the turn settles and never assigned. It states every entry and claims nothing beyond what they prove: an `unknown` effect is stated as unproven, never dropped from the account and never softened into either certainty.
- An aborted turn is terminal on the evidence it holds: reported entries stand, an operation still in flight is `unknown`, and its settlement is derived and recorded as on any other turn — only delivery may be foreclosed (§2).
- The representation is the IR's. What must hold: no entry without an invocation, no settlement except by derivation, and no second account of the turn standing beside the sequence.

### 2. Delivery is a reported truth, not an assumption

- Delivery truth is reported by the boundary that attempts it — the shell's one Boss-visible settlement seam, over whichever cligent surface the settlement kind leaves through — as one of three: **shown**, it accepted; **not shown**, it proves nothing was emitted; **unknown**, it rejected after emission may have begun, which is also what a boundary unable to prove non-delivery reports, so the safe value is the default rather than the exception.
- A settlement is presented once. Another channel may be tried only where non-delivery is proven; where delivery is `unknown` the turn claims nothing about what the Boss saw, a retry there being able to show one settlement twice.
- Idempotent presentation is the alternative, and is rejected on merit: the Boss surface is rendered by another process behind seams that return `Promise<void>` and carry no settlement identity (cligent `CaptainContext.emitReply`, `src/app/tmux-play/contract.ts:108`; `CaptainSession.emitStatus`, `:30`), so the shell can neither deduplicate what it cannot identify nor unshow what was shown, whereas the three-valued truth is implementable on the shell's side today and is what §3 must record anyway.

### 3. One record per settlement, one arrival

- Every settlement is recorded, with its evidence and its delivery truth, whether or not the Boss saw it.
- Each recorded settlement reaches the durable Captain conversation exactly once, riding the first call the shell was making anyway that carries it and returns: recomposing or re-issuing that call is not a second arrival, and a call that never returns leaves the record unread. Arrival is counted per conversation, so a replacement conversation is seeded with everything the one it replaces was told.
- That is one path and not two: what seeds a replacement conversation and what a live conversation is told next are the same records, read by the same rule. Storage, ordering, and queue mechanics are the IR's.

### 4. A prompt fragment carries a role and a trust

| Dimension | Values | What follows from it |
| --- | --- | --- |
| role | control identifier \| Boss-facing | forbidden-set membership: an identifier enters the set, Boss-facing text never does |
| trust | shell-authored \| foreign evidence \| Boss text | encoding: shell-authored is carried as written, foreign evidence is escaped and bounded, Boss text is escaped and carried whole |

- The dimensions are independent and every fragment carries both: a runtime-authored action label is Boss-facing *and* foreign, so it is escaped and bounded yet never forbidden, while that runtime's action id is foreign *and* a control identifier. Reading either dimension as evidence of the other is what refused a legitimate label and what let unregistered identifiers through.
- Both dimensions survive composition. A composed prompt carries the forbidden set its fragments' roles produced, and no classification is re-derived from the lexical shape of composed text — shape was wrong in both directions.
- Both dimensions survive memory replay. A value re-entering a prompt from a recorded settlement (§3) carries the role and trust it had when first composed, so a replayed identifier is forbidden again and a replayed label is not.
- This replaces which values the supplied-identifier duty covers and nothing else about it: the live session and engagement-state identifiers a reply may not carry stay known by identity from live shell state and reachable by no fragment, and the narrowing that spares ordinary English bounds both bases — role decides membership, and a member the shell cannot tell apart from ordinary English is still not refused ([CAPTAIN-9](../dev/playbook-captain.md#captain-9)).

## Supersessions

- [CAPTAIN-34](../user/playbook-captain.md#captain-34) — "Every Boss turn shall reach exactly one visible settlement" is unsatisfiable when every channel rejects, leaving the shell to violate it in silence; §1 and §2 replace it with one settlement always derived and recorded, and at most once presented. Its three settlement kinds and their Boss-facing content rules stand, and its no-selection-no-speech clause is the empty sequence's own settlement.
- [DR-029 §4](029-session-scoped-conversational-captain.md) — one decision call per turn and at most one selected action stand. The outcome report and one closing reply do not: §1's derivation and §2's delivery replace them, a refusal having no closing reply and delivery being indeterminate or foreclosed. [DR-029 §3](029-session-scoped-conversational-captain.md)'s three-outcome receipt stands and is the source of §1's effect report.
- [DR-029 §5](029-session-scoped-conversational-captain.md) and Addendum A3, with [CAPTAIN-9](../dev/playbook-captain.md#captain-9) — the host's duty to validate returned prose stands and A3's live machine-shaped identifier criterion stands unchanged; the supplied-identifier criterion CAPTAIN-9 grew on top of it is replaced by §4, and CAPTAIN-9's one-seam escaping duty and "membership shall follow the prompt and not the composing call site" become consequences of §4 rather than duties restated per site. Its bar on journal-derived text outside a reseed is re-based on §3: no prompt carries a raw record, and shell-composed text drawn from the one record is no longer the reseed's privilege, one path not being two.
- [CAPTAIN-35](../dev/playbook-captain.md#captain-35) — attribution recorded at the effect invocation is what mints §1's entries, and "a region is not an operation" is why an entry names one; its append-only journal and separate refusal carry-forward are replaced by §3's one record, one arrival, and its unconditional retry "where a settlement channel remains untried" is bounded by §2's proof, the rows pinning that fallback ([CAPTAIN-39](../test/playbook-captain.md#captain-39)) moving with it.
- No item file is amended here; the implementing IR lands every edit above.

## Alternatives considered

- **Keep patching enumerated call sites** — nine rounds of evidence against it.
- **A per-turn state summary standing beside the evidence** — a second account of the same turn, free to disagree with the first, which is what today's flags are.

## Consequences

- Unconstructible rather than avoided: a settlement claiming more than its evidence, an error attributed to an operation never invoked, a multi-operation action reporting one fact, and a control identifier reaching Boss prose through a site nobody registered.
- Every caller of the presentation boundary handles three outcomes where it may assume delivery today, and each cligent surface a settlement leaves through — DR-029's captain-speech presentation contract among them — gains one obligation: report delivery truth rather than `Promise<void>`.
- The shell is restructured around the record: effects invoked through a boundary that mints entries, settlement derived from them, prompts composed from fragments carrying role and trust, and one record feeding the conversation.
