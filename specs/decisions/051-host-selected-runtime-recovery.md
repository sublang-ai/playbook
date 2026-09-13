<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-051: Host-Selected Runtime Recovery

## Status

Accepted.
Amends [DR-029](029-session-scoped-conversational-captain.md) in one scope: a `runtime` turn may be decided by the embedding host instead of the hidden decision call, preserving every validation and effect rule that decision carries.

## Context

A workflow that fails recoverably parks and advertises its own recovery actions through the leaf runtime's control view, and the shell executes one only while that view still advertises it.
Nothing of that list reaches an embedding host: the host holds a session controller whose only turn entry takes Boss text, while the control view is read inside the shell to compose the hidden decision prompt.
A host that wants to offer the Boss a recovery control can therefore only type prose into the same composer and hope the session Captain reads it as a recovery request.
Two things follow. The host cannot draw what the leaf actually offers, so it must guess both the control and its wording; and the recovery it asks for depends on a model call, which is the failure mode a refused adjudication already demonstrated — recovering from a refused model call by making another one shares its fate.
The list cannot be reconstructed outside the shell: it is computed per call from live repository evidence, never persisted, and it leaves the shell only as prose inside a hidden prompt that no host may parse.

## Decision

- The Captain shell publishes the active leaf's currently advertised runtime actions — the ids and Boss-facing labels its ControlView digest would name — to its embedding host between turns, taking the digest's own rules: an unreadable control view advertises nothing, and a fenced leaf advertises only its fence controls.
- A host may select one advertised action as the next Boss turn's decision. Such a turn enters with its decision already made and allocates no decision call, exactly as a parse-resolved command does; the selection reaches the shell through the controller port as `runtime`, and validation against the leaf's current `describe()`, the per-turn idempotency key, the outcome report, and the closing reply are unchanged.
- The shell remains the sole effector. A selection is a selection, never an execution: an id the leaf no longer advertises is refused with a reason and starts no turn, and one the leaf stops advertising between selection and settlement settles `rejected` like any other invalid selection.
- The selection carries the turn it decides. The shell returns the selected action's own Boss-facing label as that turn's text, so the conversation records what was asked in words the Boss can read, and a turn carrying other text drops the selection and is decided the ordinary way.
- The host surface is additive and optional: a shell that publishes neither member advertises nothing, which is what an older shell already means to a host.

## Consequences

- A host can draw one control per action the leaf actually offers, rather than one guess, and draws none where nothing is advertised.
- The recovery path spends no model call, so a provider refusal cannot block the recovery from a refused call.
- Read and write stay honest about time: the answer is read live between turns and enters no snapshot, so a stale list cannot outlive what the leaf offers.
- The durable turn is an ordinary Boss turn carrying the action's label, so an uncertain-turn retry replays that text rather than the selection; a replay reaching the decision call again is decided from the same advertised list, one model call later than the original.
- The closed action set and its effect rules are untouched: nothing new executes, and nothing executes by a new route.
