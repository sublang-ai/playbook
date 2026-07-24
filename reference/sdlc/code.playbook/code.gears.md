<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CODE: Coding Workflow

Players:

- Coder
- Reviewer
- Committer = Coder | Reviewer

## Coder

### CODE-1

When Boss gives a coding intent, Captain shall relay it to Coder along with the following prompt:
> Assess whether this can be completed in a single commit, following best practices.
> If yes, implement and test, updating both code and specs; otherwise, decompose into tasks as a new IR under @specs/iterations and stop without implementing any IR task.
> For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.
> Ensure @specs/map.md reflects the changes.
> Do not commit.
The resulting changes are Initial Changes.

### CODE-2

When Reviewer raises any findings, Captain shall relay them to Coder along with the following prompt:
> For each review item below for the above changes, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.
> Stage all current changes that belong in the repo before making any edits, and leave your edits unstaged/untracked.

### CODE-3

When a new IR or IR task passes review and is committed, Captain shall prompt Coder:
> Continue to implement IR-<#> if not all deliverables and tasks are done.
> Implement one task at a time (including corresponding tests if any).
> Stop after each task for review — do not commit yet.
> If relevant, mark progress in the IR.
The resulting changes are Initial Changes.

### CODE-4

When an IR is done, Captain shall prompt Coder:
> Read IR-<#> and corresponding commits.
> According to @specs/meta.md, add or update spec items to fully capture:
>
> - the external behavior users rely on,
> - the internal system behavior, and
> - the integration/system test cases.
>
> The spec items should be the *minimal* set needed to reimplement code without the IR.
> The set should be complete and coherent.
> Avoid implementation specifics.
> Avoid redundant spec items.
> Ensure @specs/map.md reflects the changes.

## Reviewer

For each finding in a review round, Coder either addresses it with changes or challenges it with a rebuttal.
Any code change to address findings starts a new round of review, even if some findings are also rebutted.
Rounds continue until Reviewer raises no findings.

Spec item files are the files under @specs/ that hold spec items — @specs/packages/ and @specs/compositions/ in the current layout, or @specs/user/, @specs/dev/, and @specs/test/ in the legacy one; decision and iteration records, @specs/map.md, and @specs/meta.md are not spec item files.

### CODE-5

When Committer commits Initial Changes from a Boss coding intent involving changes only in spec item files, Captain shall relay the Boss's coding intent to Reviewer along with the following prompt:
> Review the latest commit.
> Refer to the commit message.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
> - Well organized: spec packages are finely scoped, with high cohesion and low coupling.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### CODE-6

When Committer commits Initial Changes from a Boss coding intent involving changes only outside spec item files, Captain shall relay the Boss's coding intent to Reviewer along with the following prompt:
> Review the latest commit.
> Refer to the commit message.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### CODE-7

When Committer commits Initial Changes from a Boss coding intent involving changes both in and outside spec item files, Captain shall relay the Boss's coding intent to Reviewer along with the following prompt:
> Review the latest commit.
> Refer to the commit message.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
> - Well organized: spec packages are finely scoped, with high cohesion and low coupling.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### CODE-8

When Committer commits Initial Changes from an IR task involving changes only in spec item files, Captain shall relay the IR's task description to Reviewer along with the following prompt:
> Review the latest commit.
> Refer to the commit message.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
> - Well organized: spec packages are finely scoped, with high cohesion and low coupling.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### CODE-9

When Committer commits Initial Changes from an IR task involving changes only outside spec item files, Captain shall relay the IR's task description to Reviewer along with the following prompt:
> Review the latest commit.
> Refer to the commit message.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### CODE-10

When Committer commits Initial Changes from an IR task involving changes both in and outside spec item files, Captain shall relay the IR's task description to Reviewer along with the following prompt:
> Review the latest commit.
> Refer to the commit message.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
> - Well organized: spec packages are finely scoped, with high cohesion and low coupling.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### CODE-11

When Coder makes unreviewed changes (outside of any Initial Changes) involving changes only in spec item files without raising rebuttals, Captain shall prompt Reviewer to begin a review round:
> Review the unstaged and untracked changes in the context of the staged changes.
> Understand the intent.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
> - Well organized: spec packages are finely scoped, with high cohesion and low coupling.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### CODE-12

When Coder makes unreviewed changes (outside of any Initial Changes) involving changes only outside spec item files without raising rebuttals, Captain shall prompt Reviewer to begin a review round:
> Review the unstaged and untracked changes in the context of the staged changes.
> Understand the intent.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### CODE-13

When Coder makes unreviewed changes (outside of any Initial Changes) involving changes both in and outside spec item files without raising rebuttals, Captain shall prompt Reviewer to begin a review round:
> Review the unstaged and untracked changes in the context of the staged changes.
> Understand the intent.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
> - Well organized: spec packages are finely scoped, with high cohesion and low coupling.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.

### CODE-14

When Coder raises rebuttals without making code changes, Captain shall relay them to Reviewer along with the following prompt:
> For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.
> Do not edit files or commit; report findings only.

### CODE-15

When Coder makes unreviewed changes (outside of any Initial Changes) involving changes only in spec item files and also raises rebuttals, Captain shall prompt Reviewer to begin a review round and relay the rebuttals along with the following prompt:
> Review the unstaged and untracked changes in the context of the staged changes.
> Understand the intent.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
> - Well organized: spec packages are finely scoped, with high cohesion and low coupling.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.
> For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.

### CODE-16

When Coder makes unreviewed changes (outside of any Initial Changes) involving changes only outside spec item files and also raises rebuttals, Captain shall prompt Reviewer to begin a review round and relay the rebuttals along with the following prompt:
> Review the unstaged and untracked changes in the context of the staged changes.
> Understand the intent.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.
> For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.

### CODE-17

When Coder makes unreviewed changes (outside of any Initial Changes) involving changes both in and outside spec item files and also raises rebuttals, Captain shall prompt Reviewer to begin a review round and relay the rebuttals along with the following prompt:
> Review the unstaged and untracked changes in the context of the staged changes.
> Understand the intent.
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> Verify any affected spec items are:
>
> - Complete & coherent: sufficient for you to reimplement code.
> - Right level: external behavior users rely on or internal system behavior (organized per @specs/meta.md), not implementation specifics; integration/system testing, not unit testing.
> - Minimal: essential and concise; every item earns its place; also check with other items.
> - Well organized: spec packages are finely scoped, with high cohesion and low coupling.
>
> Flag anything missing, redundant, over-specified, or under-specified.
> For context discovery, @specs/map.md indexes all spec files and @specs/meta.md describes the spec format.
> Verify @specs/map.md reflects the changes.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.
> For each rebuttal below, challenge or accept it, with strong reasoning, solid evidence, and comprehensive thinking.

## Committer

### CODE-18

When Coder makes any Initial Changes and Reviewer has not played since the last commit, Captain shall prompt Committer:
> Make a commit of the changes that belong in the repo, following @specs/packages/git.md (reread if necessary).
> If that spec is absent, follow the legacy @specs/dev/git.md; if neither exists, follow the repository's existing commit conventions and do not search elsewhere.
> Write the commit message concisely.
> Coder is <coder-llm>.
> Format the `Co-authored-by` `<model>` token as the conventional human form of the substituted id (e.g., `claude-opus-4-7` → `Claude-Opus-4.7`, `gpt-5.5` → `GPT-5.5`).

Result guard: `needsBossInput` — Committing requires additional Boss input or rescoping rather than a specific answer to resume this same state.

### CODE-19

When Coder makes any Initial Changes and Reviewer has played since the last commit, or Reviewer raises no findings on uncommitted changes and Coder has played since the last commit, Captain shall prompt Committer:
> Make a commit of the changes that belong in the repo, following @specs/packages/git.md (reread if necessary).
> If that spec is absent, follow the legacy @specs/dev/git.md; if neither exists, follow the repository's existing commit conventions and do not search elsewhere.
> Write the commit message concisely.
> Coder is <coder-llm>; Reviewer is <reviewer-llm>.
> Format the `Co-authored-by` `<model>` token as the conventional human form of the substituted id (e.g., `claude-opus-4-7` → `Claude-Opus-4.7`, `gpt-5.5` → `GPT-5.5`).

Result guard: `needsBossInput` — Committing requires additional Boss input or rescoping rather than a specific answer to resume this same state.
