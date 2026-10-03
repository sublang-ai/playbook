<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Code

Roles:

- Coder

## Coder

### CODE-1

Each completed phase ends with exactly one new Coder commit owned by `code`, and no existing commit is rewritten.
Captain uses the repository-effect receipt as the authoritative identity of the phase's new commit.
When the request may continue an existing IR that it does not identify unambiguously, Coder asks Boss before changing files, and Boss's answer resumes this same phase.

When the first coding phase begins for the caller's coding request and any relevant context, Captain shall prompt Coder:

> First determine whether the coding request starts a new coding intent or continues an existing IR with unfinished work.
> If the request may continue an existing IR but does not identify it unambiguously, ask Boss before changing files.
>
> For a new coding intent, assess whether it can be completed well in one commit.
> If it can, implement and test it, update the affected specs, and ensure @specs/map.md remains accurate.
> If it cannot, decompose it into tasks sized to exactly one commit each, add a new IR under @specs/intents, and do not implement any IR task in this phase.
> Plan affected spec updates before, with, or after their corresponding code changes, either as standalone IR tasks or as explicit work within related tasks.
>
> For an existing IR, read the identified IR and implement exactly its next unfinished task, including corresponding tests or specs if any.
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
> After the answer allows completion, make exactly one phase-owned commit before REVIEW.
> When the phase is complete, make its minimal changes and then one new commit, following @specs/packages/git.md; never amend an existing commit.
> Make the commit message explain concisely what changed and why, including relevant verification.
> Identify every new commit you make.
> Credit every AI that contributed to this commit: Coder <coder-llm>.
>
> > Original request: <caller-input>
> > Run results: <run-results>

Results:
- `directCommit`: Coder completed the new coding intent as one direct implementation phase and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.
- `irCommit`: Coder decomposed the new coding intent into a new IR, implemented no IR task, and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, and `irNumber` identifying the created IR.
- `moreTasks`: Coder continued an existing IR, implemented exactly its next unfinished task, made its one new commit, and at least one IR task remains unfinished; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the continued IR, and `irTask` naming the implemented task.
- `finalTask`: Coder continued an existing IR, implemented its final unfinished task, and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the continued IR, and `irTask` naming the implemented task.
- `needsBossReply`: At the end of this call, Coder has an unanswered clarifying question for Boss whose answer is required to complete the current coding phase. Earlier interim questions resolved or superseded by later affirmative current-phase completion, and prerequisites only for later review, acceptance or release stages, do not establish this outcome. Output shall include `question: <verbatim question text from the acting agent's prose>`.

### CODE-2

Captain waits until `review` passes with no unsettled findings; playbook `review` owns every review round and every review-fix commit, and no existing commit is rewritten.

When a direct implementation or new-IR phase ends with its one new `code`-owned commit, Captain shall call playbook `review`:

> > Original intent: <caller-input>
> > Review scope: the commit <code-commit> from this coding phase and its resulting repository state.
> > Coder output: <coder-output>

A nested `review` passes the phase only when its result applies to that supplied review scope, returns the exact evaluated repository revision, and affirmatively establishes that no unsettled findings remain.
On each successful nested REVIEW, Captain shall freeze the previous phase review as one record from the canonical child result and the phase's accepted receipt-owned scope: exact phase kind (direct, new intent or IR task), phase outcome, CODE scope commit, REVIEW evaluated revision, and IR/task identity when present.
CODE scope commit and evaluated revision remain distinct because REVIEW may create fix commits.
No caller option, player prose or repository status text supplies this record.
The record survives permitted restoration and the current task's Boss-answer continuation, and a fresh run or explicit Boss interruption clears it.
When `review` passes a direct implementation phase, `code` is complete and returns to its caller the exact last `code`-owned commit, the exact final evaluated repository revision, and the fact that every phase's review passed with no unsettled findings.
When `review` passes a new-IR phase, Captain continues with the next unfinished IR-task phase.
When `review` returns an authored abort or failure, or a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings, `code` starts no further phase and reports the failure and the last `code`-owned commit to its caller.
When the nested `review` call fails outside that authored result contract, `code` parks as failed and retains the control-plane error instead of reporting an authored review outcome.

### CODE-3

When absent, the previous phase review reads "No accepted prior-phase review is available.".

Each completed phase ends with exactly one new Coder commit owned by `code`, and no existing commit is rewritten.
Captain uses the repository-effect receipt as the authoritative identity of the phase's new commit.

When a later IR-task phase begins, Captain shall prompt Coder:

> Read the identified IR and implement exactly its next unfinished task, including corresponding tests or specs if any.
> Do not implement a later task in this phase.
> Mark the IR's progress and deliverables when relevant.
> After implementing an IR task, identify it and state whether any IR task still has unfinished Coder work; if so identify the next unfinished task, otherwise state this was the final IR task's Coder work.
> Report pending independent REVIEW, owner acceptance and later delivery/workshop steps separately; they imply an unfinished IR task only when the IR assigns that work to a remaining task.
> Report only what the IR and completed work establish, in ordinary prose without a required marker.
> If the IR will be finished after this phase, double-check that all acceptance criteria are met.
> Use the quoted previous-phase review only for its exact recorded scope; committed pending-review text may predate that canonical result.
> Before treating it as current review evidence, verify clean current HEAD equals its evaluatedRevision; a mismatch is not approval.
> It does not replace independent review of this task or any new owner or release decision.
>
> Keep to the original intent and follow what it asks.
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
> If a required Boss answer prevents completion of the current phase or IR task, ask that question and return without committing.
> Preserve permitted uncommitted work for the deferred continuation; do not create a partial or blocker-only commit to meet the one-commit requirement.
> After the answer allows completion, make exactly one phase-owned commit before REVIEW.
> When the phase is complete, make its minimal changes and then one new commit, following @specs/packages/git.md; never amend an existing commit.
> Make the commit message explain concisely what changed and why, including relevant verification.
> Identify every new commit you make.
> Credit every AI that contributed to this commit: Coder <coder-llm>.
>
> > Original request: <caller-input>
> > IR number: <ir-number>
> > Run results: <run-results>
> > Previous phase review: <previous-phase-review>

Results:
- `moreTasks`: Coder implemented exactly the IR's next unfinished task, made its one new commit, and at least one IR task remains unfinished; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the IR, and `irTask` naming the implemented task.
- `finalTask`: Coder implemented the IR's final unfinished task and made its one new commit; Coder's result affirmatively supports this outcome, and no fixed presentation format of the reply is required. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the IR, and `irTask` naming the implemented task.
- `needsBossReply`: At the end of this call, Coder has an unanswered clarifying question for Boss whose answer is required to complete the current coding phase. Earlier interim questions resolved or superseded by later affirmative current-phase completion, and prerequisites only for later review, acceptance or release stages, do not establish this outcome. Output shall include `question: <verbatim question text from the acting agent's prose>`.

### CODE-4

Captain waits until `review` passes with no unsettled findings; playbook `review` owns every review round and every review-fix commit, and no existing commit is rewritten.

When an IR-task phase, including the first phase for an existing IR, ends with its one new `code`-owned commit, Captain shall call playbook `review`:

> > Original intent: <caller-input>
> > Review scope: the commit <code-commit> from this coding phase and its resulting repository state.
> > Coder output: <coder-output>
>
> > Current IR task: <ir-task>

A nested `review` passes the phase only when its result applies to that supplied review scope, returns the exact evaluated repository revision, and affirmatively establishes that no unsettled findings remain.
On each successful nested REVIEW, Captain shall freeze the previous phase review as one record from the canonical child result and the phase's accepted receipt-owned scope: exact phase kind (direct, new intent or IR task), phase outcome, CODE scope commit, REVIEW evaluated revision, and IR/task identity when present.
CODE scope commit and evaluated revision remain distinct because REVIEW may create fix commits.
No caller option, player prose or repository status text supplies this record.
The record survives permitted restoration and the current task's Boss-answer continuation, and a fresh run or explicit Boss interruption clears it.
When `review` passes a nonfinal IR-task phase, Captain continues with the next unfinished IR-task phase.
When `review` passes the final IR-task phase, `code` is complete and returns to its caller the exact last `code`-owned commit, the exact final evaluated repository revision, and the fact that every phase's review passed with no unsettled findings.
When `review` returns an authored abort or failure, or a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings, `code` starts no further phase and reports the failure and the last `code`-owned commit to its caller.
When the nested `review` call fails outside that authored result contract, `code` parks as failed and retains the control-plane error instead of reporting an authored review outcome.
