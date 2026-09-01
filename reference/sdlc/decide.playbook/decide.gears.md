<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Decide

## Roles

- Coder
- Reviewer

## Independent proposals

The caller supplies a topic as `callerTopic`.
Coder and Reviewer receive the complete topic concurrently and independently.
Neither role's player receives the other role's proposal before both proposals are complete.
A proposal is complete only when its player affirmatively provides a complete design proposal; a progress report, status update, or promise of a later proposal supports no proposal outcome.
A Boss interrupt during the parallel proposal pair restarts the complete pair with the new `callerTopic`.

### DECIDE-1

Parallel group: independent-proposals

When the caller gives a topic, Captain shall relay the complete topic to Coder in quotes and prompt Coder:

> > <caller-topic>
>
> Assess whether the topic is better expressed as a few spec items under @specs/packages/ or requires one or more DRs under @specs/decisions/.
> Propose your design.
> Keep your proposal coherent, focused, and concise.
> Consult @specs/map.md for relevant context and @specs/meta.md for spec requirements, if needed.
> Do not change any files.

Results:
- `proposed`: Coder affirmatively provided a complete design proposal; a progress report, status update, or promise of a later proposal supports no proposal outcome. Output shall include `coderProposal: <verbatim final text>`.

### DECIDE-2

Parallel group: independent-proposals

When the caller gives a topic, Captain shall relay the complete topic to Reviewer in quotes and prompt Reviewer:

> > <caller-topic>
>
> Assess whether the topic is better expressed as a few spec items under @specs/packages/ or requires one or more DRs under @specs/decisions/.
> Propose your design.
> Keep your proposal coherent, focused, and concise.
> Consult @specs/map.md for relevant context and @specs/meta.md for spec requirements, if needed.
> Do not change any files.

Results:
- `proposed`: Reviewer affirmatively provided a complete design proposal; a progress report, status update, or promise of a later proposal supports no proposal outcome. Output shall include `reviewerProposal: <verbatim final text>`.

## Synthesize and commit

### DECIDE-3

When both independent proposals are complete, Captain shall relay the complete topic and Reviewer's complete proposal to Coder under their own labels in quotes and prompt Coder:

> Synthesize your independent proposal with Reviewer's proposal below.
> Keep to the original topic below and follow what it asks.
> Keep the best, essential parts of either proposal and reject any point that is unsound, unnecessary, or outside the topic.
> Turn the resulting design into the necessary DRs and/or spec items.
> Follow @specs/meta.md and update @specs/map.md when needed.
> Do not change code or implement the design.
>
> Commit the result as one new commit, following @specs/packages/git.md.
> Make the commit message explain concisely what changed and why.
> Identify every new commit you make.
> Coder is <coder-llm> and Reviewer is <reviewer-llm>.
>
> > Original topic: <caller-topic>
> > Reviewer's independent proposal: <reviewer-proposal>

Results:
- `committed`: Coder synthesized both proposals and committed the resulting design as one new commit. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.

No transition depends on a fixed presentation format of either player's reply; the repository-effect receipt is the authoritative identity of Coder's new `decide`-owned commit.

## Review

### DECIDE-4

When Coder commits, Captain shall call playbook `review` with the following input in quotes:

> > Original intent: <caller-topic>
> > Review scope: the `decide`-owned commit <decide-commit> and its resulting repository state.
> > Coder output: <coder-output>

`decide` is complete only when `review` returns a result that applies to the supplied review scope, gives the exact evaluated repository revision, and affirmatively establishes that no unsettled findings remain; `decide` then returns the `decide`-owned commit and that evaluated revision to the caller.
An authored `review` abort or failure, or a terminal result that does not establish those facts, terminates with the failure and the last `decide`-owned commit reported to the caller.
Any other nested-call error parks `decide` as failed and retains the control-plane error.
