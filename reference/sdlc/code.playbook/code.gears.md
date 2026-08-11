<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CODE: Commit-Based Coding Workflow

Players:

- Coder

## Coder

### CODE-1

When the first coding phase begins, Captain shall prompt Coder:

> > <caller-input>
> > <run-results>
>
> Assess whether the coding intent can be completed well in one commit.
> If yes, implement and test it, update the affected specs, and ensure @specs/map.md remains accurate.
> Otherwise, decompose it into tasks sized to exactly one commit each, add a new IR under @specs/intents, and do not implement any IR task in this phase.
> Plan affected spec updates before, with, or after their corresponding code changes, either as standalone IR tasks or as explicit work within related tasks.
>
> Consult @specs/map.md for relevant context and @specs/meta.md for spec requirements, if needed.
>
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
> Make the phase's minimal changes and then one new commit, following @specs/packages/git.md; never amend an existing commit.
> Make the commit message explain concisely what changed and why, including relevant verification.
> Report it as exactly one final-response line beginning `Commit: `, followed only by the exact commit identity.
> Coder is <coder-llm>; format the model token in conventional human form.

Results:
- `directCommit`: Coder completed and committed the direct implementation phase. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.
- `irCommit`: Coder created and committed a new IR without implementing an IR task. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber`, and `irTask` naming the exact next unfinished task.

### CODE-2

When the first phase has one new commit, Captain shall call playbook `review`:

> > Initial intent: <caller-input>
> > Coder output: <coder-output>

Workflow outcomes:
- Exact approval after a direct implementation phase completes `code`.
- Exact approval after a new-IR phase continues with its next unfinished IR task.
- An authored `review` abort, error, or invalid approval terminates `code` with the failure and last `code`-owned commit.
- Any other nested-call error parks `code` as failed and retains the control-plane error.

### CODE-3

When a reviewed IR has a next unfinished task, Captain shall prompt Coder:

> > <ir-task>
> > <run-results>
>
> Read IR-<#> and implement exactly the next unfinished task, including corresponding tests or specs if any.
> Do not implement a later task in this phase.
> Mark the IR's progress and deliverables when relevant.
> If the IR will be finished after this phase, double-check that all acceptance criteria are met.
>
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
> Make the phase's minimal changes and then one new commit, following @specs/packages/git.md; never amend an existing commit.
> Make the commit message explain concisely what changed and why, including relevant verification.
> Report it as exactly one final-response line beginning `Commit: `, followed only by the exact commit identity.
> Coder is <coder-llm>; format the model token in conventional human form.

Results:
- `moreTasks`: Coder completed and committed the current IR task and at least one task remains. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, and `irTask` naming the exact next unfinished task.
- `finalTask`: Coder completed and committed the final IR task. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.

### CODE-4

When an IR-task phase has one new commit, Captain shall call playbook `review`:

> > IR task: <ir-task>
> > Coder output: <coder-output>

Workflow outcomes:
- Exact approval after a nonfinal IR-task phase continues with its next unfinished IR task.
- Exact approval after the final IR-task phase completes `code`.
- An authored `review` abort, error, or invalid approval terminates `code` with the failure and last `code`-owned commit.
- Any other nested-call error parks `code` as failed and retains the control-plane error.
