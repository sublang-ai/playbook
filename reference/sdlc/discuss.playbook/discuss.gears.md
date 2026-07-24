<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Discuss

## Players

- Boss: the human user (default)
- Captain: the coordinating agent (default)
- Host
- Participant
- Committer = Host | Participant

## Initial Discussion

Host and Participant make their initial proposals in parallel.
Each later reconciliation round also runs Host and Participant in parallel, with both receiving only the proposals promoted by the previous completed round.
Captain shall wait for both branch results and promote them together before starting the next round.
If one branch asks Boss a question, only that branch waits; the sibling branch continues, and a completed sibling branch is not restarted when Boss replies.
Boss interrupts target the whole `initialProposalRound` or `reconciliationRound`; the four branch working states are resumable question destinations but are not independently jumpable.
Rounds continue until both Host and Participant state the end of initial discussion.

### DISCUSS-1

Parallel group: initial-proposal-round

When Boss gives a topic, Captain shall prompt Host:

> Boss's topic: <topic>
> Assess whether Boss's topic above is better expressed as a few spec items (per @specs/meta.md) or requires one or more DRs added to @specs/decisions/.
> Consult @specs/map.md, if necessary, to find relevant context.
> Each DR should be coherent and focused.
> Propose your design in reply.
> DRs, if any, need not include full detail here - describe the key points at a high level.
> Don't change any code.

### DISCUSS-2

Parallel group: initial-proposal-round

When Boss gives a topic, Captain shall prompt Participant:

> Boss's topic: <topic>
> Assess whether Boss's topic above is better expressed as a few spec items (per @specs/meta.md) or requires one or more DRs added to @specs/decisions/.
> Consult @specs/map.md, if necessary, to find relevant context.
> Each DR should be coherent and focused.
> Propose your design in reply.
> DRs, if any, need not include full detail here - describe the key points at a high level.
> Don't change any code.

### DISCUSS-3

Parallel group: reconciliation-round

While the initial discussion is not ended and Participant made a proposal in the previous round, when a new initial-discussion round begins, Captain shall prompt Host:

> Other agent's proposal: <participant-proposal>
> Your previous proposal: <host-previous-proposal>
> Consider the other agent's proposal below.
> (1) If there are essentially different points (including creation or division of DRs), list them, accept any reasonable ones, and challenge the rest with strong reasoning, solid evidence, and comprehensive thinking - make your argument.
> (2) Only if your proposal of the previous round is equivalent to the other's, with nothing to reconcile, state the end of initial discussion.
> Don't change any code.

### DISCUSS-4

Parallel group: reconciliation-round

While the initial discussion is not ended and Host made a proposal in the previous round, when a new initial-discussion round begins, Captain shall prompt Participant:

> Other agent's proposal: <host-proposal>
> Your previous proposal: <participant-previous-proposal>
> Consider the other agent's proposal below.
> (1) If there are essentially different points (including creation or division of DRs), list them, accept any reasonable ones, and challenge the rest with strong reasoning, solid evidence, and comprehensive thinking - make your argument.
> (2) Only if your proposal of the previous round is equivalent to the other's, with nothing to reconcile, state the end of initial discussion.
> Don't change any code.

### DISCUSS-5

When Host and Participant both state the end of initial discussion, Captain shall prompt Host:

> Agreement: <agreement>
> Write spec items or DRs according to the agreement.
> Update @specs/map.md to reflect your changes (if any) when done.

## Review

Review rounds proceed without waiting for Boss.
In the first step of each review round, Participant reviews the latest changes, addresses any rebuttals, and raises any findings.
In the second step of each review round, Host addresses any findings.
Rounds continue until Participant raises no findings.

Spec item files are the files under @specs/ that hold spec items — @specs/packages/ and @specs/compositions/ in the current layout, or @specs/user/, @specs/dev/, and @specs/test/ in the legacy one; decision and iteration records, @specs/map.md, and @specs/meta.md are not spec item files.

### DISCUSS-6

While new or updated spec items (in spec item files) are under review and no new or updated DR is under review, when Committer commits at the end of the initial discussion, Captain shall prompt Participant:

> Latest changes: <changes>
> Rebuttals to address, if any: <rebuttals>
> Review the latest spec changes, address any rebuttals, and raise any findings.
> Verify any new or updated spec items are:
> Complete & coherent: sufficient for you to reimplement code.
> Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.
> Minimal: essential and concise; every item earns its place; also check with other items.
> Well organized: spec packages are finely scoped, with high cohesion and low coupling.
> Flag anything missing, redundant, over-specified, or under-specified.
> Think thoroughly - don't just approve or reject.
> For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### DISCUSS-7

While new or updated spec items (in spec item files) are under review and no new or updated DR is under review, when Host addresses findings with changes, Captain shall prompt Participant:

> Latest changes: <changes>
> Rebuttals to address, if any: <rebuttals>
> Review the latest spec changes, address any rebuttals, and raise any findings.
> Verify any new or updated spec items are:
> Complete & coherent: sufficient for you to reimplement code.
> Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.
> Minimal: essential and concise; every item earns its place; also check with other items.
> Well organized: spec packages are finely scoped, with high cohesion and low coupling.
> Flag anything missing, redundant, over-specified, or under-specified.
> Think thoroughly - don't just approve or reject.
> For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### DISCUSS-8

While new or updated DRs are under review and no new or updated spec item (in spec item files) is under review, when Committer commits at the end of the initial discussion, Captain shall prompt Participant:

> Latest changes: <changes>
> Rebuttals to address, if any: <rebuttals>
> Review the latest spec changes, address any rebuttals, and raise any findings.
> Review any new/updated decision following @specs/meta.md (reread if necessary).
> Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.
> Key statements must be backed by references unless they are common sense or widely acknowledged best practices.
> If the decision is well-thought-out and well-written, don't raise nitpicks.
> Remember to keep the DR simple and minimal.
> Think thoroughly - don't just approve or reject.
> For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### DISCUSS-9

While new or updated DRs are under review and no new or updated spec item (in spec item files) is under review, when Host addresses findings with changes, Captain shall prompt Participant:

> Latest changes: <changes>
> Rebuttals to address, if any: <rebuttals>
> Review the latest spec changes, address any rebuttals, and raise any findings.
> Review any new/updated decision following @specs/meta.md (reread if necessary).
> Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.
> Key statements must be backed by references unless they are common sense or widely acknowledged best practices.
> If the decision is well-thought-out and well-written, don't raise nitpicks.
> Remember to keep the DR simple and minimal.
> Think thoroughly - don't just approve or reject.
> For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### DISCUSS-10

While new or updated spec items (in spec item files) are under review and new or updated DRs are under review, when Committer commits at the end of the initial discussion, Captain shall prompt Participant:

> Latest changes: <changes>
> Rebuttals to address, if any: <rebuttals>
> Review the latest spec changes, address any rebuttals, and raise any findings.
> Verify any new or updated spec items are:
> Complete & coherent: sufficient for you to reimplement code.
> Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.
> Minimal: essential and concise; every item earns its place; also check with other items.
> Well organized: spec packages are finely scoped, with high cohesion and low coupling.
> Flag anything missing, redundant, over-specified, or under-specified.
> Review any new/updated decision following @specs/meta.md (reread if necessary).
> Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.
> Key statements must be backed by references unless they are common sense or widely acknowledged best practices.
> If the decision is well-thought-out and well-written, don't raise nitpicks.
> Remember to keep the DR simple and minimal.
> Think thoroughly - don't just approve or reject.
> For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### DISCUSS-11

While new or updated spec items (in spec item files) are under review and new or updated DRs are under review, when Host addresses findings with changes, Captain shall prompt Participant:

> Latest changes: <changes>
> Rebuttals to address, if any: <rebuttals>
> Review the latest spec changes, address any rebuttals, and raise any findings.
> Verify any new or updated spec items are:
> Complete & coherent: sufficient for you to reimplement code.
> Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.
> Minimal: essential and concise; every item earns its place; also check with other items.
> Well organized: spec packages are finely scoped, with high cohesion and low coupling.
> Flag anything missing, redundant, over-specified, or under-specified.
> Review any new/updated decision following @specs/meta.md (reread if necessary).
> Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.
> Key statements must be backed by references unless they are common sense or widely acknowledged best practices.
> If the decision is well-thought-out and well-written, don't raise nitpicks.
> Remember to keep the DR simple and minimal.
> Think thoroughly - don't just approve or reject.
> For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### DISCUSS-12

When Participant raises any findings, Captain shall prompt Host:

> Review items: <review-items>
> For each review item below for the above changes, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.
> Stage all current changes that belong in the repo before making any edits, and leave your edits unstaged/untracked.

### DISCUSS-13

When Host raises any rebuttals, Captain shall prompt Participant:

> Rebuttals: <rebuttals>
> For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.

## Commit

Model ID formatting examples: `claude-opus-4-7` becomes `Claude-Opus-4.7`; `gpt-5.5` becomes `GPT-5.5`.

### DISCUSS-14

When the spec items or DRs are written at the end of the initial discussion, Captain shall prompt Committer:

> Then make a commit of the changes that belong in the repo, following @specs/packages/git.md (reread if necessary).
> If that spec is absent, follow the legacy @specs/dev/git.md; if neither exists, follow the repository's existing commit conventions and do not search elsewhere.
> Write the commit message concisely.
> Host is <host-llm>.
> Participant is <participant-llm>.
> Format the Host and Participant model IDs as conventional human forms.

### DISCUSS-15

When Participant raises no findings on uncommitted changes, Captain shall prompt Committer:

> Then make a commit of the changes that belong in the repo, following @specs/packages/git.md (reread if necessary).
> If that spec is absent, follow the legacy @specs/dev/git.md; if neither exists, follow the repository's existing commit conventions and do not search elsewhere.
> Write the commit message concisely.
> Host is <host-llm>.
> Participant is <participant-llm>.
> Format the Host and Participant model IDs as conventional human forms.
