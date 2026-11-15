<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# decide: Decide

## Intent

`decide` settles a caller's topic as decision records (DRs) and/or spec items: Coder and Reviewer each propose a design without seeing the other's, Coder synthesizes both proposals into one commit, and `review` examines that commit.
It ends when `review` establishes that no unsettled findings remain for that commit, or with a failure reported to the caller.

Roles:

- Coder
- Reviewer

## External Behavior

### decide-5

When a caller starts `decide`, the caller shall supply the topic including any specific context.

### decide-6

`decide` shall complete, returning to its caller the `decide`-owned commit [[decide-14](#decide-14)] and the evaluated repository revision, only when `review` returns a result [[decide-4](#decide-4)] that:

- applies to the supplied review scope;
- gives the exact evaluated repository revision;
- affirmatively establishes that no unsettled findings remain.

### decide-7

When `review` [[decide-4](#decide-4)] returns an authored abort or failure, or a terminal result that leaves unestablished any fact that completion requires [[decide-6](#decide-6)], `decide` shall report the failure and the last `decide`-owned commit [[decide-14](#decide-14)] to its caller.

### decide-8

When the nested `review` call [[decide-4](#decide-4)] fails outside its authored result contract, `decide` shall park as failed and retain the control-plane error instead of reporting an authored review outcome.

### decide-9

While the parallel proposal pair [[decide-1](#decide-1)] [[decide-2](#decide-2)] is under way, when Boss interrupts, `decide` shall restart the whole pair so both players receive the same new topic and remain independent [[decide-11](#decide-11)].

## Internal Behavior

### decide-1

Parallel group: independent-proposals

When the caller gives a topic [[decide-5](#decide-5)] or a Boss interrupt restarts the parallel proposal pair with a new topic [[decide-9](#decide-9)], Captain shall relay the complete topic to Coder in quotes and prompt Coder:

> Assess whether the topic is better expressed as a few spec items under @specs/packages/ or requires one or more DRs under @specs/decisions/.
> Propose your design.
> Keep your proposal coherent, focused, and concise.
> Consult @specs/map.md for relevant context and @specs/meta.md for spec requirements, if needed.
> Do not change any files.
>
> > Original topic: <caller-topic>

Results:
- `proposed`: Coder affirmatively provided a complete design proposal; a progress report, status update, or promise of a later proposal supports no proposal outcome. Output shall include `coderProposal: <verbatim final text>`.

### decide-2

Parallel group: independent-proposals

When the caller gives a topic [[decide-5](#decide-5)] or a Boss interrupt restarts the parallel proposal pair with a new topic [[decide-9](#decide-9)], Captain shall relay the complete topic to Reviewer in quotes and prompt Reviewer:

> Assess whether the topic is better expressed as a few spec items under @specs/packages/ or requires one or more DRs under @specs/decisions/.
> Propose your design.
> Keep your proposal coherent, focused, and concise.
> Consult @specs/map.md for relevant context and @specs/meta.md for spec requirements, if needed.
> Do not change any files.
>
> > Original topic: <caller-topic>

Results:
- `proposed`: Reviewer affirmatively provided a complete design proposal; a progress report, status update, or promise of a later proposal supports no proposal outcome. Output shall include `reviewerProposal: <verbatim final text>`.

### decide-3

When both proposals are complete [[decide-1](#decide-1)] [[decide-2](#decide-2)], Captain shall relay the complete topic and Reviewer's complete proposal to Coder under their own labels in quotes and prompt Coder:

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
> Credit every AI that contributed to this commit: Coder <coder-llm> and Reviewer <reviewer-llm>, whose proposal it carries.
>
> > Original topic: <caller-topic>
> > Reviewer's independent proposal: <reviewer-proposal>

Results:
- `committed`: Coder synthesized the proposals into the necessary DRs and/or spec items and committed the result as one new commit. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.

### decide-4

When Coder commits the synthesized result [[decide-3](#decide-3)], Captain shall call playbook `review`:

> > Original intent: <caller-topic>
> > Review scope: the `decide`-owned commit <decide-commit> and its resulting repository state.
> > Coder's independent proposal: <coder-proposal>
> > Coder output: <coder-output>

### decide-10

`decide` shall request Coder's proposal [[decide-1](#decide-1)] and Reviewer's proposal [[decide-2](#decide-2)] concurrently and independently [[decide-11](#decide-11)], not waiting for either proposal before requesting the other.

### decide-11

Neither role's player shall receive the other role's proposal [[decide-1](#decide-1)] [[decide-2](#decide-2)] until both proposals are complete [[decide-12](#decide-12)].

### decide-12

`decide` shall treat a proposal as complete only when its player affirmatively provides a complete design proposal [[decide-1](#decide-1)] [[decide-2](#decide-2)]: a progress report, status update, or promise of a later proposal supports no proposal outcome.

### decide-13

`decide` shall let what follows either player's reply depend on no fixed presentation format of that reply [[decide-1](#decide-1)] [[decide-2](#decide-2)] [[decide-3](#decide-3)].

### decide-14

`decide` shall use the repository-effect receipt as the authoritative identity of Coder's new `decide`-owned commit [[decide-3](#decide-3)].

### decide-15

`decide` shall call `review` [[decide-4](#decide-4)] with its input in quotes (`>`).

## Verification

### decide-16

While both players have provided complete proposals and Coder has committed the synthesis, when `review` returns for the supplied scope an evaluated revision with no unsettled findings, a `decide` run shall:

- relay the caller's complete topic to Coder and to Reviewer [[decide-5](#decide-5)] [[decide-1](#decide-1)] [[decide-2](#decide-2)], requesting each proposal without waiting for the other [[decide-10](#decide-10)];
- give neither player the other's proposal before both proposals are complete [[decide-11](#decide-11)];
- prompt Coder to synthesize with the topic and Reviewer's complete proposal [[decide-3](#decide-3)];
- call `review` with a quoted input whose review scope names the commit the repository-effect receipt identifies [[decide-4](#decide-4)] [[decide-14](#decide-14)] [[decide-15](#decide-15)];
- complete, returning that commit and the evaluated revision to its caller [[decide-6](#decide-6)].

### decide-17

While one proposal is complete and the other is still pending, when Boss interrupts with a new topic, a `decide` run shall prompt Coder and Reviewer again [[decide-1](#decide-1)] [[decide-2](#decide-2)], each with the same new topic and neither with the other's earlier proposal [[decide-9](#decide-9)].

### decide-18

When a player replies, a `decide` run shall treat the reply as follows:

- a proposal reply that is a progress report, a status update, or a promise of a later proposal leaves that proposal incomplete and Coder unprompted to synthesize [[decide-12](#decide-12)];
- replies that differ only in presentation format lead to the same next step [[decide-13](#decide-13)].

### decide-19

When `review` returns any of the following, a `decide` run shall report the failure and the last `decide`-owned commit to its caller [[decide-7](#decide-7)] without completing [[decide-6](#decide-6)]:

- an authored abort or failure;
- a terminal result that leaves findings unsettled;
- a terminal result that gives no evaluated revision;
- a terminal result that does not apply to the supplied scope.

### decide-20

When the nested `review` call fails outside its authored result contract, a `decide` run shall park as failed, retaining the control-plane error and reporting no authored review outcome [[decide-8](#decide-8)].
