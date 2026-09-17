<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-061: DEV Analyst Plans the Path

## Status

Accepted (2026-09-17).
Amends [DR-044](044-dev-planning-workflow.md) in scope: the Analyst's result is the chosen path and a bounded planning note, a Boss question serves only that choice, and analysis, design, and implementation stay with the called playbooks; DR-044's outcomes, composition, governance, and suspension stand.

## Context

DEV's one Analyst role exists to choose which playbooks run for a development request.
Three consecutive `/dev` requests in an embedding host session showed it doing those playbooks' work instead.

- Every planning reply was a multi-page analysis of three to five thousand characters: a state model read out of the code, design proposals, a proposed vocabulary, file-level findings, and instructions phrased for the coder.
- Two of the three parked on a Boss question that changed no routing: the Analyst's own text named `decide then code` whichever way Boss answered, and the question asked Boss to settle a design choice that `decide` exists to settle.
- The Analyst's whole final text is relayed verbatim as the planning result into `code` and into `decide`, so DECIDE's two independent proposals both received that design agenda inside their topic, and the coder received a repository reading it would redo.

The authored instruction is the cause.
It opened by inviting a useful response and one material question before any repository work, bounded inspection only by "only as needed", never said what the planning result must and must not contain, and tied a Boss question to no routing criterion.
Because that reply is the children's instruction, the Analyst writes for the coder.

## Decision

- The Analyst's product is the chosen path plus a bounded planning note: the path; why, in at most ten lines — the decisions and spec items that settle the work, or the open point a decision must settle — plus the scope the request implies and any fact from a named GitHub issue the playbooks need.
- That note holds no design, proposal, implementation instruction, or file-level finding: the playbooks own those.
- The Analyst reads the specs and the repository only as far as choosing the path requires.
- A question to Boss is asked only when its answer would change which path runs or whether any work is wanted at all, as one short question naming the alternatives it decides between and nothing else; where every answer leads to the same path, the Analyst chooses that path and the playbook settles the open point — `decide` for a rule, concept, term, shape, or trade-off the specs leave open, `code` for implementation.
- A reply that chooses a path asks Boss nothing; a reply that asks Boss chooses no path.
- Everything else of [DR-044](044-dev-planning-workflow.md) and its [DR-050](050-pull-request-delivery.md) amendment stands unchanged: the six outcomes and their names, the FSM topology and its transitions, the verbatim planning-result relay into children, the `unchanged` repository governance of every Analyst outcome, the standard Boss-question suspension and resumption, and the pull-request variants.

## Consequences

- Planning turns become shorter and cheaper, because the Analyst stops producing what its children produce.
- DECIDE's independent proposals receive the request and the open point rather than a design, which is the independence DECIDE is built on.
- Boss questions become rare and route-changing; an open design point reaches `decide` instead of Boss.
- The maintained DEV source, GEARS, FSM, runtime siblings, tests, and docs change together, with no package release required.
- A request that only asks for an explanation now yields the question whether work is wanted rather than an analysis.
