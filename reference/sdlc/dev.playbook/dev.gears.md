<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# dev: Dev

## Intent

`dev` is an optional repository-aware planner for a development request that needs more analysis before choosing a development path.
It has Analyst choose the path and then coordinates the existing playbooks `code`, `decide`, `branch`, and `pr` along it.
It ends with the result of the last playbook it called, or without repository work once a Boss reply settles that none should follow.

Roles:

- Analyst

## External Behavior

### dev-7

When a caller starts `dev`, the caller shall supply a development request including any desired outcome, scope, and context.

### dev-8

When the final child call of the selected path succeeds, `dev` shall complete with that call's successful result:

- `code` on the code path [[dev-2](#dev-2)] and on the decide then code path [[dev-4](#dev-4)];
- `pr` on the code via pull request path and on the decide then code via pull request path [[dev-6](#dev-6)].

### dev-9

When a child call [[dev-2](#dev-2)] [[dev-3](#dev-3)] [[dev-4](#dev-4)] [[dev-5](#dev-5)] [[dev-6](#dev-6)] returns an authored abort or failure, or a terminal result that does not prove the success required for the selected path [[dev-35](#dev-35)], `dev` shall start no later child and shall end by relaying that canonical result, a `branch` or `pr` failure included.

### dev-10

When a child call [[dev-2](#dev-2)] [[dev-3](#dev-3)] [[dev-4](#dev-4)] [[dev-5](#dev-5)] [[dev-6](#dev-6)] fails outside its authored result contract, `dev` shall park as failed and retain the control-plane error.

### dev-11

When `dev` accepts discussion complete [[dev-22](#dev-22)] from Analyst's planning result [[dev-1](#dev-1)], `dev` shall complete without a child call or repository change.

### dev-12

When Analyst's planning result needs a Boss reply [[dev-1](#dev-1)], `dev` shall use the standard Boss-question suspension with Analyst's complete response.

### dev-13

When `dev` suspends on a Boss question [[dev-12](#dev-12)], Boss shall receive Analyst's complete response from the session Captain.

### dev-14

When Boss replies to the presented response [[dev-13](#dev-13)], `dev` shall resume through the session Captain in the same Analyst conversation with:

- the answer;
- the previous question as well, only when that conversation must start fresh.

### dev-15

`dev` shall own no repository commit itself.

## Internal Behavior

### dev-1

When a caller starts `dev` with its development request [[dev-7](#dev-7)] or the session Captain resumes `dev` with a Boss reply [[dev-14](#dev-14)], Captain shall relay the development request, relevant discussion context, and any relevant run results to Analyst in quotes (`>`), along with the planning instruction:

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
>
> > Original request: <development-request>
> > Prior discussion: <discussion-context>
> > Run results: <run-results>

Results:
- `discussionComplete`: After a Boss reply that settles that no repository work should follow, Analyst concluded the discussion; dev completes without a child call or repository change.
- `code`: Analyst chose the code path because the existing decisions and spec items settle how the work is done. Output shall include `planningResult: <verbatim final text>`.
- `decideThenCode`: Analyst chose the decide then code path because the work turns on a rule, concept, term, shape, or trade-off the specs leave open or contradict. Output shall include `planningResult: <verbatim final text>`.
- `codeViaPullRequest`: Analyst chose the code via pull request path because the existing decisions and spec items settle how the work is done and the request names a GitHub issue or explicitly asks for pull-request delivery. Output shall include `planningResult: <verbatim final text>`.
- `decideThenCodeViaPullRequest`: Analyst chose the decide then code via pull request path because the work turns on a rule, concept, term, shape, or trade-off the specs leave open or contradict and the request names a GitHub issue or explicitly asks for pull-request delivery. Output shall include `planningResult: <verbatim final text>`.

### dev-2

When Analyst chooses the code path [[dev-1](#dev-1)] or `branch` succeeds on the code via pull request path [[dev-5](#dev-5)], Captain shall call playbook `code`:

> > Original request: <development-request>
> > Prior discussion: <discussion-context>
> > Planning result: <planning-result>

### dev-3

When Analyst chooses the decide then code path [[dev-1](#dev-1)] or `branch` succeeds on the decide then code via pull request path [[dev-5](#dev-5)], Captain shall call playbook `decide`:

> > Original request: <development-request>
> > Prior discussion: <discussion-context>
> > Planning result: <planning-result>

### dev-4

When `decide` succeeds [[dev-3](#dev-3)], Captain shall call playbook `code`:

> > Original request: <development-request>
> > Prior discussion: <discussion-context>
> > Planning result: <planning-result>
> > DECIDE commit: <decide-commit>
> > Evaluated revision: <evaluated-revision>

### dev-5

When Analyst chooses the code via pull request path or the decide then code via pull request path [[dev-1](#dev-1)], Captain shall call playbook `branch`:

> > Original request: <development-request>
> > Prior discussion: <discussion-context>
> > Planning result: <planning-result>

### dev-6

While the selected path is code via pull request or decide then code via pull request, when `code` succeeds [[dev-2](#dev-2)] [[dev-4](#dev-4)], Captain shall call playbook `pr`:

> > Original request: <development-request>
> > Issue summary: <issue-summary>
> > Branch: <branch>
> > Base revision: <base-revision>
> > CODE commit: <last-code-commit>
> > Evaluated revision: <final-evaluated-revision>

### dev-16

Analyst shall choose the path and state why in a short planning note [[dev-1](#dev-1)].

### dev-17

Analyst shall ask Boss a question [[dev-12](#dev-12)] only to serve the choice of path.

### dev-18

`dev` shall leave analysis, design, and implementation to the playbooks it calls [[dev-2](#dev-2)] [[dev-3](#dev-3)] [[dev-4](#dev-4)] [[dev-5](#dev-5)] [[dev-6](#dev-6)].

### dev-19

`dev` shall recognize six semantic outcomes of Analyst's planning result [[dev-1](#dev-1)]:

- needs Boss reply;
- discussion complete;
- code;
- decide then code;
- code via pull request;
- decide then code via pull request.

### dev-20

`dev` shall accept an outcome [[dev-19](#dev-19)] only on affirmative support in Analyst's result, never on the absence of a reason to choose another outcome.

### dev-21

`dev` shall make no outcome [[dev-19](#dev-19)] depend on a fixed presentation format of Analyst's reply.

### dev-22

`dev` shall accept discussion complete [[dev-19](#dev-19)] only after a Boss reply [[dev-14](#dev-14)] that settles that no repository work should follow.

### dev-23

`dev` shall act on the accepted outcome [[dev-20](#dev-20)] itself and shall not return to the session Captain for another routing decision.

### dev-24

While the selected path is code or decide then code, `dev` shall call neither `branch` [[dev-5](#dev-5)] nor `pr` [[dev-6](#dev-6)].

### dev-34

When `branch` succeeds [[dev-5](#dev-5)], `dev` shall continue with the `code` call for code via pull request [[dev-2](#dev-2)], or the `decide` call and then the `code` call for decide then code via pull request [[dev-3](#dev-3)] [[dev-4](#dev-4)], each with the same input as its plain path.

### dev-25

`dev` shall not separately call `review` for the design scope [[dev-4](#dev-4)] already reviewed by `decide` [[dev-3](#dev-3)].

### dev-26

`dev` shall consume commit, revision, branch, and pull-request identities only from each child's canonical structured result, never from player prose:

- the `decide`-owned commit and exact evaluated repository revision passed to `code` [[dev-4](#dev-4)], from the result of `decide` [[dev-3](#dev-3)];
- the issue summary, branch and base revision passed to `pr` [[dev-6](#dev-6)], from the result of `branch` [[dev-5](#dev-5)];
- the last `code`-owned commit and exact final evaluated repository revision passed to `pr` [[dev-6](#dev-6)], from the result of the successful `code` call [[dev-2](#dev-2)] [[dev-4](#dev-4)].

### dev-35

`dev` shall take a child's terminal result as proving the success its path requires only where that result affirmatively carries:

- from `branch` [[dev-5](#dev-5)], that the branch was created, with its branch name, base revision and issue summary;
- from `decide` [[dev-3](#dev-3)], that no unsettled findings remain, with the `decide`-owned commit and the exact evaluated repository revision;
- from `code` [[dev-2](#dev-2)] [[dev-4](#dev-4)], that it completed with every review passed, with its last `code`-owned commit and the exact final evaluated repository revision;
- from `pr` [[dev-6](#dev-6)], that the pull request was merged.

## Verification

### dev-27

While Analyst has chosen the code path, when `code` succeeds, a `dev` run shall:

- prompt Analyst once [[dev-1](#dev-1)], relaying the caller's development request [[dev-7](#dev-7)];
- receive from Analyst a short planning note that names the path and why [[dev-16](#dev-16)];
- accept the code outcome [[dev-19](#dev-19)] that the note affirmatively supports [[dev-20](#dev-20)], whatever the note's presentation format [[dev-21](#dev-21)];
- call `code` next with the request, the discussion context, and the planning note [[dev-2](#dev-2)], without returning to the session Captain for a routing decision [[dev-23](#dev-23)];
- prompt no other player, leaving analysis, design, and implementation to `code` [[dev-18](#dev-18)];
- call neither `branch` nor `pr` [[dev-24](#dev-24)];
- complete with the successful `code` result [[dev-8](#dev-8)], having made no commit of its own [[dev-15](#dev-15)].

### dev-28

While Analyst has chosen the decide then code path and `decide` has succeeded, when `code` succeeds, a `dev` run shall:

- call `decide` with the request, the discussion context, and the planning note [[dev-3](#dev-3)];
- call `code` after `decide` succeeds [[dev-4](#dev-4)], adding the `decide`-owned commit and evaluated revision from the canonical structured result of `decide` [[dev-26](#dev-26)];
- make no call of its own to `review` [[dev-25](#dev-25)] and none to `branch` or `pr` [[dev-24](#dev-24)];
- complete with the successful `code` result [[dev-8](#dev-8)].

### dev-29

While Analyst has chosen the code via pull request path or the decide then code via pull request path and every earlier child has succeeded, when `pr` succeeds, a `dev` run shall:

- call `branch` first [[dev-5](#dev-5)];
- call `code` on the code via pull request path [[dev-2](#dev-2)], or `decide` and then `code` on the decide then code via pull request path [[dev-3](#dev-3)] [[dev-4](#dev-4)], each with the same input as on its plain path [[dev-34](#dev-34)];
- call `pr` after `code` succeeds [[dev-6](#dev-6)], with the issue summary, branch and base revision from the result of `branch` and the last `code`-owned commit and final evaluated revision from the result of `code` [[dev-26](#dev-26)];
- complete with the successful `pr` result [[dev-8](#dev-8)].

### dev-30

When a child returns a result other than the success its path requires, a `dev` run shall start no later child and end by relaying that canonical result [[dev-9](#dev-9)], in each case:

- an authored abort or failure from `branch`, `decide`, `code`, or `pr`;
- a terminal result from `branch`, `decide`, `code`, or `pr` that does not prove the success the selected path requires [[dev-35](#dev-35)], such as a `code` result that reports completion without its review passed or without its last commit and final evaluated revision.

### dev-31

When a child call fails outside its authored result contract, a `dev` run shall park as failed and keep the control-plane error [[dev-10](#dev-10)].

### dev-32

While the request leaves the choice of path to an answer only Boss can give and Boss has answered that no repository work should follow, when Analyst concludes the discussion, a `dev` run shall:

- have Analyst ask Boss a question that serves only the choice of path [[dev-17](#dev-17)];
- suspend on a Boss question carrying Analyst's complete response [[dev-12](#dev-12)], calling no child;
- have the session Captain present that response to Boss [[dev-13](#dev-13)];
- be resumed with Boss's answer in the same Analyst conversation, with the previous question only when that conversation must start fresh [[dev-14](#dev-14)];
- prompt Analyst again [[dev-1](#dev-1)];
- complete without a child call or repository change [[dev-11](#dev-11)], accepting discussion complete only after that Boss reply [[dev-22](#dev-22)].

### dev-33

When Analyst replies in one of these ways, a `dev` run shall accept no outcome and call no child:

- the reply claims discussion complete before any Boss reply [[dev-22](#dev-22)];
- the reply gives no affirmative support for any outcome, only the absence of a reason to choose another [[dev-20](#dev-20)].
