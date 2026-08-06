<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-029: Session-scoped conversational Captain

## Status

Accepted.

## Context

The Boss set three goals for the interactive shell's Captain:

- **G1** — the Captain knows the whole session; a failed turn loses nothing.
- **G2** — the Captain chats as naturally as its underlying agent while operating the playbooks.
- **G3** — the Captain can start a new playbook, clear a failed one, or resume from a chosen state.

A live session showed today's design failing all three.
Every turn runs up to three fresh Captain sessions; none remembers anything.
The event judge sees too little context, so "Retry and continue the iteration" from `failed` produced `NO_ACTION` four times in a row.
The summary call then claimed success that never happened, and printed `Saved you 0 interruptions…` after a turn that did nothing.

## Decision

1. **The Captain stays a compiled playbook — an always-present controller outside the engagement stack.**
   Its GEARS source is rewritten to the new policy and recompiled through the SLC pipeline.
   The Captain playbook runs for the whole shell session and receives every Boss turn; it is never a suspended parent inside the stack.
   The engagement stack holds only the working playbooks; the Captain operates them from outside, so [DR-011](011-composable-playbook-execution.md)'s stack semantics stay intact, and DR-011/DR-012 are amended to name this placement.
   Ownership splits three ways: the Captain playbook owns policy, conversation, and action selection; the shell owns host-level validation and effects — stack, registry, presentation, journal; the active runtime owns validation and execution of `runtime` actions.
   The `@sublang/playbook/captain/playbook` export stays maintained; nothing is removed or deprecated; no major release is needed.

2. **One durable Captain conversation per shell session.**
   The root's captain calls resume one conversation; each call's returned resume token replaces the pinned one.
   Sub-runtime judge calls stay fresh and isolated.
   A durable call that throws, returns non-`ok`, or returns no token marks the conversation unsynchronized: cligent reports no typed reason, so the shell can no longer prove the model-side session matches what was said in it, and continuing an unprovable session risks silent divergence — worse than a reseed.
   Only the model-side conversation is replaced: the engagement stack, player sessions, journal, and any completed work of the turn survive, and the failed call alone is re-issued.
   The next call starts one fresh conversation, seeded from the session journal.
   The journal is a host-kept log of Boss turns, Captain replies, validated actions, and outcomes; it exists only for this reseed.

3. **The runtime owns its control surface: `describe` and `apply`.**
   A runtime implements both or neither; the pair is compatibility-gated per [DR-022](022-runtime-compatibility-contract.md).
   `describe()` returns a sanitized ControlView: current state, relevant context, pending questions, last error, and the currently valid actions, each with an id and a runtime-written label.
   `apply(...)` revalidates the action, executes it at most once under an idempotency key, and returns a receipt.
   The receipt says which of three things happened: rejected before any effect, executed, or failed after effects may exist.
   The Captain playbook uses both through host ports.
   A runtime without the pair advertises no actions; plain text delivery is the only verb against it.

4. **Observe–act–result, as the Captain playbook's own Boss handling.**
   The decision step reuses the existing per-state Boss classification ([DR-004](004-link-code-fsm-to-playbook-runtime.md)).
   Two things change: the classifying call is the durable conversation, and the event menu is the closed action set `respond` | `start` | `switch` | `dismiss` | `deliver` | `runtime`.
   Each turn runs: one hidden decision call (exact Boss text plus a digest of the ControlView and catalog, with the digest outranking memory), at most one validated action, an outcome report, and one grounded closing reply.
   `respond` settles a chat turn in a single call.
   An invalid decision gets exactly one corrective re-ask ([DR-025](025-resilient-captain-control-adjudication.md) pattern).
   Retries are phase-local; an executed action is never executed again.
   `switch` replaces the root engagement: dismiss the stack, then start the target; there is no rollback, and if the start fails both facts are reported.
   Slash commands keep their deterministic parse and route through the same validated actions.
   A bare command, or a command naming an active non-leaf playbook, can only produce `respond` — never a restart.
   DR-012's intra-turn sequential multi-child plans are retired; multi-playbook planning continues conversationally across Boss turns.

5. **Turn summaries stay — fixed in timing and grounding.**
   The closing reply of an acting turn is the turn summary, composed from the outcome report instead of asserted.
   The saved-counts line is appended verbatim only when the turn's counted activity is nonzero; it never appears after a do-nothing turn, which was the bug.
   `summaryPolicy` stays a consumed registry surface; CAPTAIN-19/20/21 are amended, not retired.
   All durable calls are hidden; the host validates the returned prose and surfaces it as captain speech.
   The Captain keeps the routing-only tool posture; player output enters only as fenced quotes; actions may implement only the current Boss turn's request.

This DR supersedes, for interactive-shell turns: DR-013's isolated control calls and router-only settle; CAPTAIN-7's lifecycle classifier; DR-008 §3/§9's and DR-009 §7's prohibitions on pre-classified events and command switching; and DR-011 §4's manual-slash-selection sentence.
It amends DR-011/DR-012 to place the Captain outside the engagement stack and retires DR-012's intra-turn multi-child plans.
It amends CAPTAIN-19/20/21 and DR-009's summary policy to the gated, grounded form.
It restores DR-008 §4's one-Captain-session intent, with judge calls staying fresh.
Headless `playbook run` is untouched.
There are three external boundary contracts: cligent `CaptainRunResult.resumeToken` parity, a cligent captain-speech presentation surface, and the `describe`/`apply` pair.
One internal boundary is new and explicit: the controller–shell contract — the host ports through which the Captain playbook selects actions and receives their settlements.
The implementing IR lists every touched item and carries the detailed contracts.

## Alternatives considered

- **Shell-coded Captain loop** — puts orchestration beside the playbook language instead of in it; two policy layers; forfeits the proof that playbooks can express their own controller.
- **Stateless calls with richer prompts** — fixes classifier starvation but gives no memory and no conversation.
- **Tool-wielding Captain, or the raw agent session as the REPL** — loses machine validation, deterministic routing, and response ownership.
- **Static registry action menus with shell-derived state** — snapshots are host-opaque, static menus cannot express context-dependent validity, and parallel sources drift.

## Consequences

- G1–G3 hold by construction: one remembered conversation with a journal-backed reseed; replies grounded in reported outcomes; choose, clear, and resume as validated actions against runtime-advertised targets.
- A chat turn costs one model call; an acting turn costs two, plus bounded correctives.
- Implementation rewrites the Captain playbook source and recompiles; it is blocked on the two upstream cligent contracts; no public surface is removed.
- Quoted player output inside a durable conversation is a known injection surface; the protections are prompt-level and the residual risk is documented and accepted.
