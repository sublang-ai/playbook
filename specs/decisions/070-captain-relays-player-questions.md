<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-070: Captain relays player questions

## Status

Accepted.
Amends [DR-007](007-hidden-judge-captain-pane.md).
Amended by [DR-073](073-durable-step-progress.md).

## Context

Boss must be able to run a playbook without reading player panes.
Raw questions can be hard to understand; shortening them before Captain reads them can lose the decision Boss must make.

## Decision

Captain receives every current question in full and explains it briefly in plain language, preserving the choices, constraints, and uncertainty Boss needs to answer.
The runtime retains the original question and delivers Boss's answer unchanged.
Question status lines carry a presentation marker so the shell can replace them with Captain's reply, without another model call or any change to the waiting state.
This supersedes the raw-question presentation requirement of [DR-007](007-hidden-judge-captain-pane.md).
A question addressed to Captain does not answer a player or resume work; an answer or follow-up addressed to the player goes through the existing delivery path.
Hosts accept Boss messages only between active turns, including a question or other pause, and must not consume a waiting question merely because Captain spoke.

## Consequences

All playbooks use the same question and delivery contracts.
Player panes remain optional evidence; they are never an input channel.
Captain's wording is model-generated; exact question storage and answer delivery remain runtime responsibilities.
