<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# code: Code

## Intent

`code` has Coder carry out a coding request in phases of one commit each, either directly or task by task through an IR, and then has `review` review every commit of the intent once.
It ends when that review passes or fails.

Roles:

- Coder

## External Behavior

### code-4

When a caller starts `code`, the caller shall supply a coding request together with any relevant context.

### code-5

When the `review` call [[code-3](#code-3)] passes [[code-18](#code-18)], `code` shall be complete and return to its caller:

- the exact last `code`-owned commit [[code-19](#code-19)];
- the exact final evaluated repository revision;
- the fact that the intent's review passed with no unsettled findings.

### code-6

When `review` [[code-3](#code-3)] returns an authored abort or failure, or a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings [[code-18](#code-18)], `code` shall start no further phase and report the failure and the last `code`-owned commit [[code-19](#code-19)] to its caller.

### code-7

When the `review` call [[code-3](#code-3)] fails outside the authored result contract [[code-5](#code-5)] [[code-6](#code-6)], `code` shall park as failed and retain the control-plane error instead of reporting an authored review outcome.

### code-8

`code` shall end each completed phase [[code-1](#code-1)] [[code-2](#code-2)] with one new Coder commit, owned by `code`.

### code-9

`code` shall not rewrite any existing commit.

### code-10

`code` shall leave every review round and every review-fix commit to `review` [[code-3](#code-3)], which owns them.

### code-11

While the request may continue an existing IR that it does not identify unambiguously, Coder shall ask Boss in the first phase [[code-1](#code-1)] before changing files.

### code-12

When Boss answers a question Coder asked in a phase [[code-1](#code-1)] [[code-2](#code-2)] [[code-11](#code-11)], `code` shall resume that same phase.

## Internal Behavior

### code-1

When the first phase begins for the caller's coding request [[code-4](#code-4)], Captain shall prompt Coder:

> First determine whether the request starts a new change intent or continues an existing IR with unfinished work.
> If the request may continue an existing IR but does not identify it unambiguously, ask Boss before changing files.
>
> Treat standalone documentation or status maintenance that does not implement an identified unfinished IR task as a new change intent, even when it refers to an IR with no unfinished task.
> Do not invent or reopen an IR task, claim unperformed work complete, or infer an owner decision not supplied by the caller.
>
> For a new change intent, assess whether it can be completed well in one commit.
> If it can, implement and test it, update the affected specs, and ensure @specs/map.md remains accurate.
> If it cannot, decompose it into tasks sized to exactly one commit each, add a new IR under @specs/intents, and do not implement any IR task in this phase.
> Plan affected spec updates before, with, or after their corresponding code changes, either as standalone IR tasks or as explicit work within related tasks.
>
> For an existing IR with unfinished work, read the identified IR and implement exactly its next unfinished task, including corresponding tests or specs if any.
> Do not implement a later task in this phase.
> Mark the IR's progress and deliverables when relevant.
> After implementing an IR task, identify it and state whether any IR task still has unfinished Coder work; if so identify the next unfinished task, otherwise state this was the final IR task's Coder work.
> Report pending independent REVIEW, owner acceptance and later delivery/workshop steps separately; they imply an unfinished IR task only when the IR assigns that work to a remaining task.
> Report only what the IR and completed work establish, in ordinary prose without a required marker.
> If the IR will be finished after this phase, double-check that all acceptance criteria are met.
>
> Consult @specs/map.md for relevant context and @specs/meta.md for spec requirements, if needed.
>
> Keep to the original intent and follow what it asks.
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
> If a required Boss answer prevents completion of the current phase or IR task, ask that question and return without committing.
> Preserve permitted uncommitted work for the deferred continuation; do not create a partial or blocker-only commit to meet the one-commit requirement.
> After the answer allows completion, make exactly one phase-owned commit.
> When the phase is complete, make its minimal changes and then one new commit, following @specs/packages/git.md; never amend an existing commit.
> Make the commit message explain concisely what changed and why, including relevant verification.
> Identify every new commit you make.
> Credit every AI that contributed to this commit: Coder <coder-llm>.
>
> > Original request: <caller-input>
> > Run results: <run-results>

Results:
- `directCommit`: Coder completed the new change intent, including standalone documentation or status maintenance that does not implement an identified unfinished IR task (even when it refers to an IR with no unfinished task), as one direct implementation phase and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.
- `irCommit`: Coder decomposed the new change intent into a new IR, implemented no IR task, and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, and `irNumber` identifying the created IR.
- `moreTasks`: Coder continued an existing IR, implemented exactly its next unfinished task, made its one new commit, and at least one IR task remains unfinished; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the continued IR, and `irTask` naming the implemented task.
- `finalTask`: Coder continued an existing IR, implemented its final unfinished task, and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the continued IR, and `irTask` naming the implemented task.

### code-2

When the first phase completes as a new-IR phase or a nonfinal IR-task phase [[code-1](#code-1)], or a later IR-task phase completes as nonfinal, Captain shall prompt Coder:

> Read the identified IR and implement exactly its next unfinished task, including corresponding tests or specs if any.
> Do not implement a later task in this phase.
> Mark the IR's progress and deliverables when relevant.
> After implementing an IR task, identify it and state whether any IR task still has unfinished Coder work; if so identify the next unfinished task, otherwise state this was the final IR task's Coder work.
> Report pending independent REVIEW, owner acceptance and later delivery/workshop steps separately; they imply an unfinished IR task only when the IR assigns that work to a remaining task.
> Report only what the IR and completed work establish, in ordinary prose without a required marker.
> If the IR will be finished after this phase, double-check that all acceptance criteria are met.
> The earlier phases of this intent await the one REVIEW that follows its final task; do not ask Boss to review or approve them.
>
> Keep to the original intent and follow what it asks.
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
> If a required Boss answer prevents completion of the current phase or IR task, ask that question and return without committing.
> Preserve permitted uncommitted work for the deferred continuation; do not create a partial or blocker-only commit to meet the one-commit requirement.
> After the answer allows completion, make exactly one phase-owned commit.
> When the phase is complete, make its minimal changes and then one new commit, following @specs/packages/git.md; never amend an existing commit.
> Make the commit message explain concisely what changed and why, including relevant verification.
> Identify every new commit you make.
> Credit every AI that contributed to this commit: Coder <coder-llm>.
>
> > Original request: <caller-input>
> > IR number: <ir-number>
> > Run results: <run-results>

Results:
- `moreTasks`: Coder implemented exactly the IR's next unfinished task, made its one new commit, and at least one IR task remains unfinished; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the IR, and `irTask` naming the implemented task.
- `finalTask`: Coder implemented the IR's final unfinished task and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the IR, and `irTask` naming the implemented task.

### code-3

When the direct phase [[code-1](#code-1)] or the final IR-task phase [[code-1](#code-1)] [[code-2](#code-2)] ends with its one new commit [[code-8](#code-8)], Captain shall call playbook `review`:

> > Original intent: <caller-input>
> > Review scope: every commit of this coding intent, namely <code-commits>, and its resulting repository state.
> > Coder output: <coder-output>
>
> > IR number: <ir-number>

### code-13

`code` shall run the caller's request [[code-4](#code-4)] as one of these phase sequences [[code-1](#code-1)] [[code-2](#code-2)]:

- for a new change intent, including standalone documentation or status maintenance that does not implement an identified unfinished IR task, either one direct implementation phase or a new-IR phase followed by one phase for each IR task;
- for an existing IR, one IR-task phase for each remaining unfinished task, starting with its next unfinished task.

### code-14

`code` shall start no review after a new-IR or a nonfinal IR-task phase [[code-1](#code-1)] [[code-2](#code-2)].

### code-15

`code` shall call `review` [[code-3](#code-3)] once over every `code`-owned commit of this run [[code-19](#code-19)], oldest first.

### code-16

`code` shall wait until the `review` call [[code-3](#code-3)] passes with no unsettled findings [[code-18](#code-18)].

### code-17

While the coding intent follows an IR [[code-13](#code-13)], `code` shall additionally input the IR number to `review` [[code-3](#code-3)].

### code-18

`code` shall treat the `review` call [[code-3](#code-3)] as passed only on a result that:

- applies to the supplied review scope;
- returns the exact evaluated repository revision;
- affirmatively establishes that no unsettled findings remain.

### code-19

`code` shall retain every phase's commit [[code-8](#code-8)], in order, as this run's `code`-owned commits.

### code-20

`code` shall use the repository-effect receipt as the authoritative identity of each phase's new commit [[code-8](#code-8)].

### code-21

`code` shall require affirmative support in Coder's result for each semantic outcome of a phase [[code-1](#code-1)] [[code-2](#code-2)]:

- what follows a phase depends on no fixed presentation format of Coder's reply;
- a commit statement alone does not establish semantic completion;
- contradictory or insufficient evidence supports no forced commit outcome.

## Verification

### code-22

While Coder has completed a new change intent in one direct phase, when `review` passes, a `code` run shall:

- prompt Coder once with the caller's request [[code-1](#code-1)] [[code-4](#code-4)];
- identify the phase's one new commit from the repository-effect receipt [[code-8](#code-8)] [[code-20](#code-20)];
- call `review` once, with that commit as the review scope [[code-3](#code-3)] [[code-15](#code-15)] and no IR number [[code-17](#code-17)];
- return, only once `review` has passed [[code-16](#code-16)], that commit, the evaluated revision `review` returned, and the fact that the review passed with no unsettled findings [[code-5](#code-5)] [[code-18](#code-18)].

### code-23

While Coder has decomposed a new change intent into an IR of two tasks and completed each task in its own phase, when `review` passes, a `code` run shall:

- prompt Coder three times, for the new-IR phase [[code-1](#code-1)] and then for each IR task in turn [[code-2](#code-2)] [[code-13](#code-13)], with no review between the phases [[code-14](#code-14)];
- call `review` once, after the final task, over the three phase commits oldest first [[code-15](#code-15)] [[code-19](#code-19)] and with the IR number [[code-17](#code-17)];
- return the final task's commit as the last `code`-owned commit, whatever review-fix commits `review` added [[code-5](#code-5)] [[code-10](#code-10)], with no existing commit rewritten [[code-9](#code-9)].

### code-24

While the request identifies an existing IR with one or two unfinished tasks, when `review` passes, a `code` run shall:

- prompt Coder once for each remaining task, starting with the IR's next unfinished task [[code-1](#code-1)] [[code-2](#code-2)] [[code-13](#code-13)];
- call `review` once, after the final task, over every phase commit and with the IR number [[code-3](#code-3)] [[code-15](#code-15)] [[code-17](#code-17)] [[code-19](#code-19)].

### code-25

While Coder has asked Boss a question in a phase, when Boss answers, a `code` run shall prompt Coder again in that same phase [[code-12](#code-12)], by case:

- on a first-phase question about which existing IR the request continues, which Coder asked before changing files [[code-11](#code-11)], with the first-phase instruction [[code-1](#code-1)];
- on a question in a later IR-task phase, with the IR-task instruction [[code-2](#code-2)].

### code-26

When the `review` call [[code-3](#code-3)] does not pass, a `code` run shall end by case:

- on an authored abort or failure, start no further phase and report the failure and the last `code`-owned commit [[code-6](#code-6)];
- on a terminal result that omits the evaluated revision or does not establish that the supplied scope was evaluated with no unsettled findings, report in the same way [[code-6](#code-6)] [[code-18](#code-18)];
- on a failure outside the authored result contract, park as failed with the control-plane error retained and no review outcome reported [[code-7](#code-7)].

### code-27

When Coder replies at the end of a phase, a `code` run shall settle the phase outcome by case [[code-21](#code-21)]:

- on affirmative support for one semantic outcome, in whatever presentation format, take that outcome;
- on a commit statement alone, or on contradictory or insufficient evidence, take no commit outcome.
