<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-052: Host-Selected Give-Up

## Status

Accepted.
Amends [DR-051](051-host-selected-runtime-recovery.md) in one scope: a host may also decide a give-up turn, whose result phase the shell settles itself instead of through the closing-reply call.
Amended by [DR-063](063-failures-explain-themselves.md): the shell's give-up control carries `standing` like every advertised action.

## Context

[DR-051](051-host-selected-runtime-recovery.md) gave an embedding host a recovery control: the Boss can run what a parked leaf advertises without the shell guessing prose.
It answers "make it work".
Nothing answers "stop asking me about this".
A Boss whose recovery keeps failing can reach `dismiss` three ways, and each costs something the moment deserves least: type prose and hope the hidden decision call reads it as a stop request, `switch` to other work, or delete the session with its whole conversation.

The failure a Boss gives up on is often a failing model call.
A refused adjudication parked a workflow in production, and a give-up that spends a model call shares the fate of the failure it escapes.
DR-051's own recovery is not free of this: its action runs with no decision call, but the result-phase closing reply is still a provider call, so a total refusal leaves the action executed and the turn uncertain.
An exit that works only while the provider is healthy is not an exit.

## Decision

- The shell publishes one Boss-facing control of its own between turns, disjoint from the leaf's advertised runtime actions: a give-up while a root is engaged, and nothing while idle or while a turn is active.
- A host may select it as the next Boss turn's decision, exactly as it may select a runtime action. The turn enters decided, reaches the shell through the controller port as `dismiss`, and every validation that selection carries is unchanged.
- A give-up turn makes no model call. Its decision is the host's, and its closing reply is the shell's own deterministic rendering of that settlement, presented through the one presentation seam under the same single-attempt rule. The durable conversation learns of the turn through the catch-up this shell already defines, never through a second memory channel.
- A give-up clears the root's retained generation instead of retaining it. An ordinary dismissal preserves the turn-start candidate so the work can resume; a Boss who gave up is not offered it back on their next message.
- A give-up reports unresolved repository effects rather than reconciling them. The control advertises whether or not the root stands behind the retained-effect fence, and the settlement carries the fence's own ordered report, so effects of unknown standing are named to the Boss and never vanish with the run.
- Where unresolved effects remain, give-up uses the existing durable abandonment transaction before removing the root; it needs no leaf action, and any persistence or disposal failure retains the unsafe boundary and cannot produce a successful-stop reply.
- The host surface stays additive and optional: a shell publishing neither member advertises nothing, which is what an older shell already means to a host.

## Consequences

- The Boss has an exit that does not depend on a provider, which is what "give up" has to mean when the provider is what failed.
- Only a give-up settles without the result-phase call. Every other turn keeps it, so DR-051's recovery keeps its own exposure to a refusing provider and the give-up is its backstop rather than its repair.
- The conversation records the gesture in words the Boss can read — the control's label as the turn's text, and the shell's own stopped line — without a Captain call being asked to describe it.
- Giving up is not resumable: re-running the command starts fresh work, and nothing durable offers the abandoned generation back.
- A session already holding an uncertain turn refuses every turn, so the route there stays Discard first, then give up.
- The shell now owns two Boss-facing control surfaces with different authors — the leaf's advertised actions and its own — and a host that draws both must keep them apart.
