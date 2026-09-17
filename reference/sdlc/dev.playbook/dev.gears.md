<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DEV: Development Planning Workflow

Roles:

- Analyst

`dev` is an optional repository-aware planner for a development request that needs more analysis before choosing a development path.
It coordinates existing playbooks and owns no repository commit itself.
Analyst chooses the path and states why in a short planning note; analysis, design, and implementation belong to the playbooks `dev` calls, and a question to Boss serves only the choice of path.

## Analyst

### DEV-1

At the start of `dev` and after each Boss reply, Captain shall relay the development request, relevant discussion context, and any relevant run results to Analyst in quotes (`>`), along with the planning instruction:

> > Original request: <development-request>
> > Prior discussion: <discussion-context>
> > Run results: <run-results>
>
> Plan which playbooks run for this request; the playbooks do the work.
> Read the request, then the specs and the repository only as far as choosing the path requires.
> Do not change files or commit while planning or discussing the request.
>
> Choose exactly one:
>
> - `code`: the existing decisions and spec items settle how the work is done.
> - `decide then code`: the work turns on a rule, concept, term, shape, or trade-off the specs leave open or contradict; name what is open, do not settle it.
> - `code via pull request` or `decide then code via pull request`, in place of the two above, when the request names a GitHub issue (number or URL) or explicitly asks for pull-request delivery; read the issue and its comments (`gh issue view --comments` with the issue number) while choosing.
> - A question to Boss, only when the answer would change which path runs or whether any work is wanted: one short question naming the alternatives it decides between, and nothing else. When every answer leads to the same path, choose it; the playbook settles the open point.
> - `discussion complete`, after a Boss reply, when no repository work should follow.
>
> Your reply is the planning note the chosen playbook receives. It holds only the path and, in at most ten lines, why — the decisions and spec items that settle the work, or the open point a decision must settle — plus the scope the request implies and any fact from the issue the playbooks need.
> It holds no design, proposal, implementation instruction, or file-level finding: the playbooks own those.
> A reply that chooses a path asks Boss nothing; a reply that asks Boss chooses no path.
> A question or exploratory discussion is not by itself authorization to create a durable decision or implement changes.
> Do not choose `decide then code` merely because the work is large, nor `code` merely because it is small.
> Consult @specs/map.md for relevant context and @specs/meta.md for spec requirements, if needed.

Results:
- `discussionComplete`: Analyst concluded the discussion after a Boss reply, with no repository work to follow.
- `code`: Analyst chose `code`: the existing decisions and spec items settle how the work is done. Output shall include `planningResult: <verbatim final text>`.
- `decideThenCode`: Analyst chose `decide then code`: the work turns on a point the specs leave open or contradict. Output shall include `planningResult: <verbatim final text>`.
- `codeViaPullRequest`: Analyst chose `code via pull request`: the existing decisions settle the work, and the request names a GitHub issue or explicitly asks for pull-request delivery. Output shall include `planningResult: <verbatim final text>`.
- `decideThenCodeViaPullRequest`: Analyst chose `decide then code via pull request`: the work turns on a point the specs leave open or contradict, and the request names a GitHub issue or explicitly asks for pull-request delivery. Output shall include `planningResult: <verbatim final text>`.

Workflow outcomes:
- The planning result has six semantic outcomes: needs Boss reply, discussion complete, code, decide then code, code via pull request, and decide then code via pull request.
- Each outcome requires affirmative support in Analyst's result; absence of a reason to choose another outcome is not support, and no outcome depends on a fixed presentation format of Analyst's reply.
- Needs Boss reply uses the standard Boss-question suspension with Analyst's complete response; after Boss replies, `dev` resumes with the answer in the same Analyst conversation; the previous question is included only when that conversation must start fresh.
- Discussion complete is available only after a Boss reply, when that reply settles that no repository work should follow; it completes `dev` without a child call or repository change.
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
