<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Discuss

## Players

- Boss: the human user (default)
- Captain: the coordinating agent (default)
- Host
- Participant
- Committer = Host | Participant

## Host

### DISCUSS-1

When Boss gives a topic, Captain shall relay it to Host with the prompt:
> Assess whether Boss's topic above is better expressed as a few spec items (per @specs/meta.md) or requires one or more DRs added to @specs/decisions/.
> Consult @specs/map.md, if necessary, to find relevant context.
> Each DR should be coherent and focused.
> Propose your design in reply.
> DRs, if any, need not include full detail here — describe the key points at a high level.
> Don't change any code.

### DISCUSS-2

While the initial discussion has not ended and Participant made a proposal in the previous round, when a new initial-discussion round begins, Captain shall prompt Host:
> Consider the other agent's proposal below.
> (1) If there are essentially different points (including creation or division of DRs), list them, accept any reasonable ones, and challenge the rest with strong reasoning, solid evidence, and comprehensive thinking — make your argument.
> (2) Only if your proposal of the previous round is equivalent to the other's, with nothing to reconcile, state the end of initial discussion.
> Don't change any code.

### DISCUSS-3

When both Host and Participant state the end of initial discussion, Captain shall prompt Host:
> Update @specs/map.md to reflect your changes (if any) when done.

### DISCUSS-4

When Participant raises any findings, Captain shall relay them to Host with the prompt:
> For each review item below for the above changes, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.
> Stage all current changes that belong in the repo before making any edits, and leave your edits unstaged/untracked.

## Participant

### DISCUSS-5

When Boss gives a topic, Captain shall relay it to Participant with the prompt:
> Assess whether Boss's topic above is better expressed as a few spec items (per @specs/meta.md) or requires one or more DRs added to @specs/decisions/.
> Consult @specs/map.md, if necessary, to find relevant context.
> Each DR should be coherent and focused.
> Propose your design in reply.
> DRs, if any, need not include full detail here — describe the key points at a high level.
> Don't change any code.

### DISCUSS-6

While the initial discussion has not ended and Host made a proposal in the previous round, when a new initial-discussion round begins, Captain shall prompt Participant:
> Consider the other agent's proposal below.
> (1) If there are essentially different points (including creation or division of DRs), list them, accept any reasonable ones, and challenge the rest with strong reasoning, solid evidence, and comprehensive thinking — make your argument.
> (2) Only if your proposal of the previous round is equivalent to the other's, with nothing to reconcile, state the end of initial discussion.
> Don't change any code.

### DISCUSS-7

While new or updated spec items under @specs/user, @specs/dev, or @specs/test are under review and no new or updated DR is under review, when Participant begins a review round, Captain shall prompt Participant:
> Verify any new or updated spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
> - Well organized: spec packages are finely scoped, with high cohesion and low coupling.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> Think thoroughly — don't just approve or reject.
> For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### DISCUSS-8

While new or updated DRs are under review and no new or updated spec item under @specs/user, @specs/dev, or @specs/test is under review, when Participant begins a review round, Captain shall prompt Participant:
> Review any new/updated decision following @specs/meta.md (reread if necessary).
> Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.
> Key statements must be backed by references unless they are common sense or widely acknowledged best practices.
>
> If the decision is well-thought-out and well-written, don't raise nitpicks.
> Remember to keep the DR simple and minimal.
> Think thoroughly — don't just approve or reject.
> For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### DISCUSS-9

While new or updated spec items under @specs/user, @specs/dev, or @specs/test are under review and new or updated DRs are under review, when Participant begins a review round, Captain shall prompt Participant:
> Verify any new or updated spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
> - Well organized: spec packages are finely scoped, with high cohesion and low coupling.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> Review any new/updated decision following @specs/meta.md (reread if necessary).
> Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.
> Key statements must be backed by references unless they are common sense or widely acknowledged best practices.
>
> If the decision is well-thought-out and well-written, don't raise nitpicks.
> Remember to keep the DR simple and minimal.
> Think thoroughly — don't just approve or reject.
> For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### DISCUSS-10

While new or updated spec items under @specs/user, @specs/dev, or @specs/test are under review and no new or updated DR is under review, when Host raises any rebuttals, Captain shall relay them to Participant with the prompt:
> For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.
> Verify any new or updated spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
> - Well organized: spec packages are finely scoped, with high cohesion and low coupling.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> Think thoroughly — don't just approve or reject.
> For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### DISCUSS-11

While new or updated DRs are under review and no new or updated spec item under @specs/user, @specs/dev, or @specs/test is under review, when Host raises any rebuttals, Captain shall relay them to Participant with the prompt:
> For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.
> Review any new/updated decision following @specs/meta.md (reread if necessary).
> Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.
> Key statements must be backed by references unless they are common sense or widely acknowledged best practices.
>
> If the decision is well-thought-out and well-written, don't raise nitpicks.
> Remember to keep the DR simple and minimal.
> Think thoroughly — don't just approve or reject.
> For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### DISCUSS-12

While new or updated spec items under @specs/user, @specs/dev, or @specs/test are under review and new or updated DRs are under review, when Host raises any rebuttals, Captain shall relay them to Participant with the prompt:
> For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.
> Verify any new or updated spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: user requirements (in @specs/user) or system behavior (in @specs/dev), not implementation specifics; integration/system testing (in @specs/test), not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
> - Well organized: spec packages are finely scoped, with high cohesion and low coupling.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> Review any new/updated decision following @specs/meta.md (reread if necessary).
> Flag any issues or propose any design suggestions (numbered; no duplication), with strong reasoning and evidence.
> Key statements must be backed by references unless they are common sense or widely acknowledged best practices.
>
> If the decision is well-thought-out and well-written, don't raise nitpicks.
> Remember to keep the DR simple and minimal.
> Think thoroughly — don't just approve or reject.
> For context discovery, consult @specs/map.md; @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

## Committer

### DISCUSS-13

When the spec items or DRs are written at the end of the initial discussion, Captain shall prompt Committer:
> Then make a commit of the changes that belong in the repo, following @specs/dev/git.md (reread if necessary).
> Write the commit message concisely.
> Host is <host-llm>.
> Participant is <participant-llm>.
> `<*-llm>` shall be the conventional human form of the substituted ID (e.g., `claude-opus-4-7` → `Claude-Opus-4.7`, `gpt-5.5` → `GPT-5.5`).

### DISCUSS-14

When Participant raises no findings on uncommitted changes, Captain shall prompt Committer:
> Then make a commit of the changes that belong in the repo, following @specs/dev/git.md (reread if necessary).
> Write the commit message concisely.
> Host is <host-llm>.
> Participant is <participant-llm>.
> `<*-llm>` shall be the conventional human form of the substituted ID (e.g., `claude-opus-4-7` → `Claude-Opus-4.7`, `gpt-5.5` → `GPT-5.5`).
