<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Code

Roles:

- Coder

## Coder

### CODE-1

Each completed phase ends with exactly one new Coder commit owned by `code`, and no existing commit is rewritten.
Captain uses the repository-effect receipt as the authoritative identity of the phase's new commit and retains every phase's commit in order as this run's `code`-owned commits.
When the request may continue an existing IR that it does not identify unambiguously, Coder asks Boss before changing files, and Boss's answer resumes this same phase.
When a new-IR or a nonfinal IR-task phase completes, Captain continues with the next unfinished IR-task phase without a review.

When the first coding phase begins for the caller's coding request and any relevant context, Captain shall prompt Coder:

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

### CODE-2

Each completed phase ends with exactly one new Coder commit owned by `code`, and no existing commit is rewritten.
Captain uses the repository-effect receipt as the authoritative identity of the phase's new commit and retains every phase's commit in order as this run's `code`-owned commits.
When a nonfinal IR-task phase completes, Captain continues with the next unfinished IR-task phase without a review.

When a later IR-task phase begins, Captain shall prompt Coder:

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

### CODE-3

Captain waits until `review` passes with no unsettled findings; playbook `review` owns every review round and every review-fix commit, and no existing commit is rewritten.

When the direct phase or the final IR-task phase ends with its one new `code`-owned commit, Captain shall call playbook `review` once over every `code`-owned commit of this run, oldest first:

> > Original intent: <caller-input>
> > Review scope: every commit of this coding intent, namely <code-commits>, and its resulting repository state.
> > Coder output: <coder-output>
>
> > IR number: <ir-number>

A nested `review` passes only when its result applies to that supplied review scope, returns the exact evaluated repository revision, and affirmatively establishes that no unsettled findings remain.
When `review` passes, `code` is complete and returns to its caller the exact last `code`-owned commit, the exact final evaluated repository revision, and the fact that the intent's review passed with no unsettled findings.
When `review` returns an authored abort or failure, or a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings, `code` starts no further phase and reports the failure and the last `code`-owned commit to its caller.
When the nested `review` call fails outside that authored result contract, `code` parks as failed and retains the control-plane error instead of reporting an authored review outcome.
