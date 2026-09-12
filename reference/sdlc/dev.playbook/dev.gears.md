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

> > Original request: <development-request>
> > Prior discussion: <discussion-context>
> > Run results: <run-results>
>
> Inspect the request and the relevant repository and specs only as needed to determine the smallest sound next step.
> Do not change files or commit while planning or discussing the request.
>
> - If useful analysis or clarification should be discussed before any repository work, give Boss the useful response and ask one material question that advances the decision.
> - If the discussion has concluded after a Boss reply and no repository work should follow, choose `discussion complete`.
> - If implementation can proceed under the existing decisions, choose `code`.
> - If implementation first requires a new or amended durable decision that the existing specs do not settle, choose `decide then code`.
> - If the request names a GitHub issue (number or URL) or explicitly asks for pull-request delivery, read the issue and its comments as part of the analysis (`gh issue view --comments` with the issue number) and choose `code via pull request` or `decide then code via pull request` in place of `code` or `decide then code`.
>
> A question or exploratory discussion is not by itself authorization to create a durable decision or implement changes.
> Do not choose `decide then code` merely because the work is large.
> Consult @specs/map.md for relevant context and @specs/meta.md for spec requirements, if needed.

Results:
- `discussionComplete`: Analyst concluded the discussion after a Boss reply, with no repository work to follow.
- `code`: Analyst determined implementation can proceed under the existing decisions. Output shall include `planningResult: <verbatim final text>`.
- `decideThenCode`: Analyst determined implementation first requires a new or amended durable decision that the existing specs do not settle. Output shall include `planningResult: <verbatim final text>`.
- `codeViaPullRequest`: Analyst determined implementation can proceed under the existing decisions and the request names a GitHub issue or explicitly asks for pull-request delivery. Output shall include `planningResult: <verbatim final text>`.
- `decideThenCodeViaPullRequest`: Analyst determined implementation first requires a new or amended durable decision that the existing specs do not settle and the request names a GitHub issue or explicitly asks for pull-request delivery. Output shall include `planningResult: <verbatim final text>`.

Workflow outcomes:
- The planning result has six semantic outcomes: needs Boss reply, discussion complete, code, decide then code, code via pull request, and decide then code via pull request.
- Each outcome requires affirmative support in Analyst's result; absence of a reason to choose another outcome is not support, and no outcome depends on a fixed presentation format of Analyst's reply.
- Needs Boss reply uses the standard Boss-question suspension with Analyst's complete response; after Boss replies, `dev` resumes with the answer in the same Analyst conversation; the previous question is included only when that conversation must start fresh.
- Discussion complete is available only after a Boss reply, when any useful analysis has already been presented through needs Boss reply; it completes `dev` without a child call or repository change.
- `dev` acts on the accepted outcome itself and does not return to the session Captain for another routing decision.

## Nested development paths

### DEV-2

When the accepted planning result selects `code`, or `branch` succeeds for `code via pull request`, Captain shall call playbook `code`:

> > Original request: <development-request>
> > Prior discussion: <discussion-context>
> > Planning result: <planning-result>

Workflow outcomes:
- On a plain path, `code` success completes `dev` with the successful `code` result.
- On a pull-request path, `code` success provides the exact last `code`-owned commit and the exact final evaluated repository revision from `code`'s canonical structured result and continues with the `pr` call.
- An authored `code` abort or failure, or a terminal `code` result that does not prove the success required for the selected path, terminates `dev` with that canonical result relayed and no later child call.
- Any other nested-call error parks `dev` as failed and retains the control-plane error.
- `dev` consumes commit, revision, branch, and pull-request identities only from each child's canonical structured result, never from player prose.

### DEV-3

When the accepted planning result selects `decide then code`, or `branch` succeeds for `decide then code via pull request`, Captain shall call playbook `decide`:

> > Original request: <development-request>
> > Prior discussion: <discussion-context>
> > Planning result: <planning-result>

Workflow outcomes:
- `decide` success provides the `decide`-owned commit and the exact evaluated repository revision from `decide`'s canonical structured result and continues with the `code` call.
- An authored `decide` abort or failure, or a terminal `decide` result that does not prove that success, terminates `dev` with that canonical result relayed and no later child call.
- Any other nested-call error parks `dev` as failed and retains the control-plane error.
- `dev` does not separately call `review` for the design scope already reviewed by `decide`.

### DEV-4

When `decide` succeeds, Captain shall call playbook `code`:

> > Original request: <development-request>
> > Prior discussion: <discussion-context>
> > Planning result: <planning-result>
> > DECIDE commit: <decide-commit>
> > Evaluated revision: <evaluated-revision>

Workflow outcomes:
- On a plain path, `code` success completes `dev` with the successful `code` result.
- On a pull-request path, `code` success provides the exact last `code`-owned commit and the exact final evaluated repository revision from `code`'s canonical structured result and continues with the `pr` call.
- An authored `code` abort or failure, or a terminal `code` result that does not prove the success required for the selected path, terminates `dev` with that canonical result relayed and no later child call.
- Any other nested-call error parks `dev` as failed and retains the control-plane error.
- `dev` consumes commit, revision, branch, and pull-request identities only from each child's canonical structured result, never from player prose.

## Pull-request delivery

### DEV-5

When the accepted planning result selects `code via pull request` or `decide then code via pull request`, Captain shall call playbook `branch`:

> > Original request: <development-request>
> > Prior discussion: <discussion-context>
> > Planning result: <planning-result>

Workflow outcomes:
- `branch` success provides the exact branch name, the exact base revision, and the issue summary from `branch`'s canonical structured result and continues with the `code` call for code via pull request, or the `decide` call and then the `code` call for decide then code via pull request, each with the same input as its plain path.
- An authored `branch` abort or failure, or a terminal `branch` result that does not prove that success, terminates `dev` with that canonical result relayed and no later child call.
- Any other nested-call error parks `dev` as failed and retains the control-plane error.
- A plain request calls neither `branch` nor `pr`.

### DEV-6

When `code` succeeds on a pull-request path, Captain shall call playbook `pr`:

> > Original request: <development-request>
> > Issue summary: <issue-summary>
> > Branch: <branch>
> > Base revision: <base-revision>
> > CODE commit: <last-code-commit>
> > Evaluated revision: <final-evaluated-revision>

Workflow outcomes:
- `pr` success completes `dev` with the successful `pr` result.
- An authored `pr` abort or failure, or a terminal `pr` result that does not prove the success required for the selected path, terminates `dev` with that canonical result relayed and no later child call.
- Any other nested-call error parks `dev` as failed and retains the control-plane error.
- `dev` consumes commit, revision, branch, and pull-request identities only from each child's canonical structured result, never from player prose.
