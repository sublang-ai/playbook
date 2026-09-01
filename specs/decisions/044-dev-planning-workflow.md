<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-044: DEV Planning Workflow

## Status

Accepted

## Context

The maintained set contains CODE, REVIEW, and DECIDE, and [DR-009](009-generic-playbook-cli-and-registry.md) enables exactly those through the starter registry.
Boss-level development requests often need repository-aware analysis before choosing a path: direct implementation, or a durable decision first.
Routing that judgment to the session Captain is wrong — [DR-013](013-routing-only-captain-control.md) keeps the Captain routing-only — and forcing Boss to pick `code` versus `decide` by hand forfeits the analysis a planner can supply.
The authored source `reference/sdlc/dev.md` defines that planner: one Analyst role, standard Boss-question suspension, and composition of the existing `code` and `decide` playbooks.

## Decision

DEV joins CODE, REVIEW, and DECIDE as a maintained workflow compiled from `reference/sdlc/dev.md` into `reference/sdlc/dev.playbook` under artifact schema 3 and the shared flat runtime factory.

- DEV declares exactly one local role, `Analyst`, and no concurrent role set.
- DEV owns no repository commit: every delegated Analyst state is governed with the `unchanged` repository disposition, so planning that mutates the repository fails authority instead of being adopted.
- The planning result has four semantic outcomes — needs Boss reply, discussion complete, code, and decide then code — each requiring affirmative support in Analyst's result; Boss-question suspension and reentry follow the standard path of [DR-005](005-boss-reply-suspension-path.md) within one Analyst conversation.
- DEV acts on the accepted outcome itself: it calls playbook `code`, or playbook `decide` and then `code`, as function-style nested literal calls through the shared bridge per [DR-011](011-composable-playbook-execution.md), consumes commit and revision identities only from each child's canonical structured result, and never returns to the session Captain for another routing decision.
- Terminal meaning follows [DR-035](035-truthful-terminal-meaning.md): distinct final states for discussion complete, completion through the final child's success, and an authored child abort, failure, or insufficient terminal result relayed as DEV's own failure outcome; a child failure outside its authored contract parks DEV recoverable with the control-plane error.
- The host surface adopts DEV completely: public `./dev/playbook` and `./dev/registry` subpaths, packaged artifact files, and starter-config enablement binding `analyst` to a new seeded `dev.analyst` player on `claude` / `claude-opus-5`, keeping the existing seeded lineup otherwise unchanged.
- `dev.analyst` is a distinct player rather than a reuse of `dev.reviewer`: equal player ids deliberately share conversation continuity, and planning context must not bleed into review conversations.

Recompiling CODE, REVIEW, and DECIDE artifacts to their current authored sources is ordinary maintenance under the existing decisions and needs no decision here.

## Consequences

- The conformance, registry, CLI, and release specs extend their maintained-workflow sets to include DEV.
- Boss reaches the planner as `/dev`; misrouted development requests no longer force a premature `code`-versus-`decide` choice.
- DEV inherits every schema-3 authority, suspension, resumption, and settlement guarantee without new runtime machinery.
