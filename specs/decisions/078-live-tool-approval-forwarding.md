<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-078: Live Tool Approval Forwarding

## Status

Accepted.

## Context

A provider can suspend a running tool call while a human decides whether to allow it.
A workflow question is a semantic outcome after an actor returns; it cannot answer an in-flight native permission request.
Application hosts need live approval identity without putting callback closures or approval authority into model data or portable configuration.

## Decision

The shared session host accepts the tmux runtime's typed approval callback as an ephemeral host dependency.
Its envelope retains the native request, concrete actor and unique invocation, while the host projects the local runtime turn onto the actual persisted Captain turn sequence.
Only the embedding host adds its session or authoring-draft ownership scope.
Hidden control and tool-free calls receive no callback.
Normal native approval request and response events remain durable actor observations, never pending authorization handles on replay.
No compiler, workflow, effect receipt or semantic Boss-question contract changes.

Disposal closes this host's approval callback scope before draining active work.
Outstanding callbacks receive cancellation and resolve to denial even when a host handler ignores cancellation; late answers cannot authorize a closed wait.
Ordinary work keeps the existing graceful drain semantics.
Handler failures and invalid answers retain native error classification instead of becoming ordinary denials.
Native cancellation, expiry and provider permission precedence remain the adapter's responsibility.
No answer or native OS permission is inferred from a saved approval event.

Tool consent does not supply a typed answer to a native question, form, or URL-authentication request.
Playbook requires Cligent 0.33.1 or later so unsupported OpenCode questions proven to belong to the current invocation receive explicit native rejection, releasing that native answer wait.
Foreign or unproven requests retain their native ownership and receive no answer from this invocation.
The dependency update changes no compiler or workflow contract, and an ordinary later Boss reply does not answer that rejected native request.

## Consequences

- A fresh host without a callback retains the adapter's existing fail-closed behavior.
- Reopen creates new live callback scopes and invocation identities; replay never recreates an actionable prompt.
- Approval UI and session/draft authorization belong to the application, while Playbook supplies only generic runtime context.
