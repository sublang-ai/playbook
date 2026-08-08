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
   The `@sublang/playbook/captain/playbook` subpath stays maintained and keeps carrying the compiled Captain.
   Two of its named exports do not survive the rewrite — see [Addendum A2](#addendum-a2-the-rewrite-removes-two-named-exports), which withdraws this paragraph's original claim that nothing is removed and no major release is needed.

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
- Implementation rewrites the Captain playbook source and recompiles; it is blocked on the two upstream cligent contracts; no subpath, bin, or packed file is removed, but two named exports of the `captain/playbook` subpath are ([Addendum A2](#addendum-a2-the-rewrite-removes-two-named-exports)).
- Quoted player output inside a durable conversation is a known injection surface; the protections are prompt-level and the residual risk is documented and accepted.

## Addendum A1 (the ControlView context is a runtime-authored projection)

§3 says `describe()` returns a sanitized ControlView carrying "relevant context" and never says who decides what is relevant.
The engine answered with the only definition available to a generic engine: JSON-safety.
Every context member that survived strict JSON snapshotting was exported.

That is not a sanitizer, and the gap it leaves is not theoretical.
CODE's FSM context holds the resolved host player roster, the per-run option values, and raw player output — reviews, rebuttals, and whole prior results — and all of it reached the durable Captain conversation through §3's own view.
The host receiving that view is required by [CAPTAIN-9](../dev/playbook-captain.md#captain-9) to exclude rosters and option values from every prompt and to admit player output only as fenced quotes, and it cannot honor that against a blob whose members it cannot classify.
The two obligations are unsatisfiable together, and allow-by-default gives every member added to an FSM later the wrong default.

Relevance is the runtime's to declare, not the engine's to infer:

- A linked runtime shall author an explicit context projection naming the FSM context members its ControlView exposes; the engine shall export those and nothing else.
- A runtime that names none exposes no context. A member is private until an artifact names it, so extending an FSM leaks nothing by omission.
- Sanitization stays on top of the projection, not in place of it: named members are still normalized and dropped when they cannot be made JSON-safe, and the members the view surfaces first-class cannot be named.
- The host keeps its own duty. It composes the prompt block from the projection rather than pasting the projection in, so no runtime's exported value — however long, however structured — can forge a block into an envelope the host owns.

This addendum changes what §3's "relevant context" means; it changes nothing about `describe`/`apply` as a pair, their feature detection, the receipt contract, or the compatibility gate.
Artifacts that exposed context implicitly must now name what they expose, which is a one-line declaration per artifact and the point of the change.

## Addendum A2 (the rewrite removes two named exports)

§1 ended with a release posture: the `captain/playbook` export stays maintained, nothing is removed or deprecated, no major release is needed.
That was a planning assumption written before the rewrite, and the rewrite disproved it.
The implementation removed two named exports and the `Removed` section of `CHANGELOG.md` says so, while this record went on claiming the opposite — so the only honest account of a public-surface change lived outside the specs, which is the wrong place for it.
This addendum withdraws that posture and puts the removal on the record.

The compiled Captain artifact no longer declares `composeCaptainPrompt` or `composePlayerPrompt`.
Both were named exports of `@sublang/playbook/captain/playbook`, a subpath [RELEASE-20](../dev/release.md#release-20) declares public and semver-stable.
There is no drop-in replacement, and restoring one would be worse than the removal:

- `composePlayerPrompt` has no meaning under the new machine. The controller Captain makes no player calls at all, so a restored body would describe work the module cannot do.
- `composeCaptainPrompt` cannot be restored faithfully. The decision prompt is now the shell's labeled Boss / ControlView / catalog envelope ([CAPTAIN-9](../dev/playbook-captain.md#captain-9)) around the engine's shared `defaultComposeCaptainPrompt`. Re-exporting today's builder under the old name would keep an existing caller compiling and hand it prompts for a machine that no longer exists. A shim that silently changes behavior is a worse outcome than a removal stated plainly.

One thing is settled and one is not.
Settled, because it is a fact about what shipped: **the removal is breaking under [RELEASE-1](../dev/release.md#release-1)**, and the earlier minor reading is withdrawn as unsound.
Open, because it is the Boss's call: **whether to carry the removal at all.**
Keeping it makes the next release a major; withdrawing it in favour of the compatibility exports below keeps the release a minor.
No agent may settle that choice — this record states the evidence for it.

What 4.0.0 actually shipped, from the tag:

- `git show v4.0.0:reference/sdlc/captain.playbook/captain.playbook.js` declares both functions at column 0 — `export function composeCaptainPrompt(input)` and `export function composePlayerPrompt(input)` — module-level named exports, in addition to their appearance inside `_internal`.
- `git show v4.0.0:reference/sdlc/captain.playbook/captain.playbook.d.ts` declares both as `export declare function`.
- Extracted from the tag and imported through the package's own specifier, `@sublang/playbook/captain/playbook` resolved to named exports `_internal`, `composeCaptainPrompt`, `composePlayerPrompt`, `createPlaybookRuntime`, and `default`, both functions callable. The same probe at HEAD returns the first, fourth, and fifth, with both names `undefined`.

The minor column argued from intent and internal convention: that no item pinned the members, that link.md asked only for `_internal` composers, that the sibling artifacts keep theirs un-exported, and that the names appear in no document.
None of that unships a declared export.
SemVer 2.0.0 lets a public API be declared "in the code itself", and a `.d.ts` `export declare function` is exactly that declaration; a consumer who wrote `import { composeCaptainPrompt } from '@sublang/playbook/captain/playbook'` compiled and ran at 4.0.0 and breaks at HEAD with no replacement.
The link.md prop was unsound in the other direction besides: §Output *required* an `_internal` `composePlayerPrompt`, which the controller artifact cannot carry, so link.md could not be cited as the artifact's conformance standard until that clause was corrected (it now asks for the composers each machine uses).

The alternative — restoring the exact 4.0.0 bodies as frozen, deprecated, unused compatibility exports for a 4.x release — is available and remains open for the Boss to take.
Against it: it ships dead code describing a machine that no longer exists and defers the break rather than removing it, and the reasons above for not restoring either function stand.
For it: 4.0.0 is published on npm as `latest`, so an unknown external caller can import both names today.

RELEASE-20 now states which unit of a compiled-playbook subpath is semver-stable — the subpath entry plus every top-level named and default export of the JavaScript and declarations it resolves to, with `_internal` members explicitly outside it — and [RELEASE-21](../test/release.md#release-21) pins those export sets, so the next such removal goes red at the gate and is decided before the tag instead of adjudicated afterwards.
The version number belongs to the release checklist ([RELEASE-4](../dev/release.md#release-4)), and follows from the open choice above: a major if the removal stands, a minor if the compatibility exports are restored.

## Addendum A3 (the control view publishes the state's meaning, not its id)

§3 says `describe()` returns a view carrying "current state" and never says what a host may *speak* from it.
The engine answered with the only thing a normalized state descriptor carries: the state id.
That put the two contracts in direct conflict.
[CAPPLAY-5](../user/captain-playbook.md#capplay-5) forbids a captain reply to expose internal state ids, while a status answer is required to be grounded in the digest — and the digest's state line was the id, so the grounding could only be satisfied by violating the contract.
The landed acceptance rows made the conflict explicit by requiring the violation: a Boss-surfaced reply asserted to contain `state value awaitBossReply`.

Grounding needs the state's meaning, not its identifier, and the artifact already holds the meaning:

- The view carries `stateDescription`, the runtime's own Boss-facing statement of what its current state means, written from the same source state descriptions its action labels are written from.
- A state whose source declares no description publishes none. An id is never promoted into a description, and a host handed no description says so rather than substituting the id.
- The host composes its digest from the description, so no prompt carries a state id at all.
- Only then does the host owe a rejection duty, and only a narrow one: it refuses a reply carrying a live *machine-shaped* identifier — read from live shell state, never from a list of literals — and does not refuse a bare lowercase id such as `ready` or `failed`, which is ordinary English a Boss may hear in any sentence. A literal denylist over live state ids was the wrong remedy for exactly that reason.

This changes what §3's view carries and what a host may speak; it changes nothing about `describe`/`apply` as a pair, their feature detection, the receipt contract, or the compatibility gate.
