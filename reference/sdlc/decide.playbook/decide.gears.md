<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Decide

## Players

- Boss: the human user (default)
- Captain: the coordinating agent (default)
- Coder
- Reviewer

## Independent proposals

The caller supplies a topic as `callerTopic`.
Coder and Reviewer receive the complete topic concurrently and independently.
Neither player receives the other player's proposal before both proposals finish and Coder commits Coder's own proposal.
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
- `proposed`: Coder completed an independent proposal. Output shall include `coderProposal: <verbatim final text>`.

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
- `proposed`: Reviewer completed an independent proposal. Output shall include `reviewerProposal: <verbatim final text>`.

## Commit Coder's proposal

### DECIDE-3

When both independent proposals are complete, Captain shall prompt Coder:

> Turn your proposal into the necessary spec items or DRs.
> Follow @specs/meta.md and update @specs/map.md when needed.
> Do not inspect or incorporate Reviewer's proposal before this commit.
> Do not change code or implement the proposal.
>
> Commit the result as one new commit, following @specs/packages/git.md.
> Make the commit message explain concisely what changed and why.
> Coder is <coder-llm>; format the model token in conventional human form.

Results:
- `committed`: Coder committed Coder's proposal. Output shall include `latestCommit: <commit identity>`.

## Review

### DECIDE-4

When Coder commits, Captain shall call playbook `review`:

> Review the latest commit as a spec-design change against the initial intent.
> Compare it with your independent proposal and take the best of both.
> Make your suggestions.
>
> Initial intent: <caller-topic>.
> Coder's independent proposal: <coder-proposal>.

The successful child output is DECIDE's terminal output.
An authored child abort or failure terminates with the failure and `latestCommit` reported to the caller.
