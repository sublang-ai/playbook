<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DEV: Development Planning Workflow

Roles:

- Analyst

`dev` is an optional repository-aware planner for a development request that needs more analysis before choosing a development path.
It coordinates existing playbooks and owns no repository commit itself.

## Analyst

### DEV-1

At the start of `dev` and after each Boss reply, Captain shall relay the development request, relevant discussion context, and any relevant run results to Analyst in quotes (`>`), along with the planning instruction:

> > <development-request>
> > <discussion-context>
> > <run-results>
>
> Inspect the request and the relevant repository and specs only as needed to determine the smallest sound next step.
> Do not change files or commit while planning or discussing the request.
>
> - If useful analysis or clarification should be discussed before any repository work, give Boss the useful response and ask one material question that advances the decision.
> - If the discussion has concluded after a Boss reply and no repository work should follow, choose `discussion complete`.
> - If implementation can proceed under the existing decisions, choose `code`.
> - If implementation first requires a new or amended durable decision that the existing specs do not settle, choose `decide then code`.
>
> A question or exploratory discussion is not by itself authorization to create a durable decision or implement changes.
> Do not choose `decide then code` merely because the work is large.
> Consult @specs/map.md for relevant context and @specs/meta.md for spec requirements, if needed.

Results:
- `discussionComplete`: Analyst concluded the discussion after a Boss reply, with no repository work to follow.
- `code`: Analyst determined implementation can proceed under the existing decisions. Output shall include `planningResult: <verbatim final text>`.
- `decideThenCode`: Analyst determined implementation first requires a new or amended durable decision that the existing specs do not settle. Output shall include `planningResult: <verbatim final text>`.

Workflow outcomes:
- The planning result has four semantic outcomes: needs Boss reply, discussion complete, code, and decide then code.
- Each outcome requires affirmative support in Analyst's result; absence of a reason to choose another outcome is not support, and no outcome depends on a fixed presentation format of Analyst's reply.
- Needs Boss reply uses the standard Boss-question suspension with Analyst's complete response; after Boss replies, `dev` resumes with the question and answer in the same Analyst conversation.
- Discussion complete is available only after a Boss reply, when any useful analysis has already been presented through needs Boss reply; it completes `dev` without a child call or repository change.
- `dev` acts on the accepted outcome itself and does not return to the session Captain for another routing decision.

## Nested development paths

### DEV-2

When the accepted planning result selects `code`, Captain shall call playbook `code`:

> > <development-request>
> > <discussion-context>
> > <planning-result>

Workflow outcomes:
- `code` success completes `dev` with the successful `code` result.
- An authored `code` abort or failure, or a terminal `code` result that does not prove the success required for the selected path, terminates `dev` with that canonical result relayed and no later child call.
- Any other nested-call error parks `dev` as failed and retains the control-plane error.
- `dev` consumes commit identities only from each child's canonical structured result, never from player prose.

### DEV-3

When the accepted planning result selects `decide then code`, Captain shall call playbook `decide`:

> > <development-request>
> > <discussion-context>
> > <planning-result>

Workflow outcomes:
- `decide` success provides the `decide`-owned commit and the exact evaluated repository revision from `decide`'s canonical structured result and continues with the `code` call.
- An authored `decide` abort or failure, or a terminal `decide` result that does not prove that success, terminates `dev` with that canonical result relayed and no later child call.
- Any other nested-call error parks `dev` as failed and retains the control-plane error.
- `dev` does not separately call `review` for the design scope already reviewed by `decide`.

### DEV-4

When `decide` succeeds, Captain shall call playbook `code`:

> > <development-request>
> > <discussion-context>
> > <planning-result>
> > <decide-commit>
> > <evaluated-revision>

Workflow outcomes:
- `code` success completes `dev` with the successful `code` result.
- An authored `code` abort or failure, or a terminal `code` result that does not prove the success required for the selected path, terminates `dev` with that canonical result relayed and no later child call.
- Any other nested-call error parks `dev` as failed and retains the control-plane error.
- `dev` consumes commit identities only from each child's canonical structured result, never from player prose.
