<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CODE: Commit-Based Coding Workflow

Roles:

- Coder

## Coder

### CODE-1

When the first coding phase begins, Captain shall prompt Coder:

> > <caller-input>
> > <run-results>
>
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
> If the IR will be finished after this phase, double-check that all acceptance criteria are met.
>
> Consult @specs/map.md for relevant context and @specs/meta.md for spec requirements, if needed.
>
> Keep to the original intent and follow what it asks.
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
> Make the phase's minimal changes and then one new commit, following @specs/packages/git.md; never amend an existing commit.
> Make the commit message explain concisely what changed and why, including relevant verification.
> Identify every new commit you make.
> Coder is <coder-llm>.

Results:
- `directCommit`: Coder completed and committed the direct implementation phase. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.
- `irCommit`: Coder created and committed a new IR without implementing an IR task. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, and `irNumber` identifying the created IR.
- `moreTasks`: Coder continued an existing IR, completed and committed exactly its next unfinished task, and at least one task remains. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the continued IR, and `irTask` naming the implemented task.
- `finalTask`: Coder continued an existing IR and completed and committed its final task. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the continued IR, and `irTask` naming the implemented task.

### CODE-2

When a direct implementation or new-IR phase has one new commit, Captain shall call playbook `review`:

> > Original intent: <caller-input>
> > Review scope: the commit <code-commit> from this coding phase and its resulting repository state.
> > Coder output: <coder-output>

Workflow outcomes:
- A nested `review` passes the phase only when its result applies to the supplied review scope, returns the exact evaluated repository revision, and affirmatively establishes that no unsettled findings remain.
- A pass after a direct implementation phase completes `code` with the exact last `code`-owned commit, the exact final evaluated repository revision, and the fact that every phase's review passed with no unsettled findings.
- A pass after a new-IR phase continues with the next unfinished IR-task phase.
- An authored `review` abort or failure, or a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings, terminates `code` with the failure and the last `code`-owned commit.
- Any other nested-call error parks `code` as failed and retains the control-plane error.

### CODE-3

When a later IR-task phase begins, Captain shall prompt Coder:

> > <caller-input>
> > <ir-number>
> > <run-results>
>
> Read the identified IR and implement exactly its next unfinished task, including corresponding tests or specs if any.
> Do not implement a later task in this phase.
> Mark the IR's progress and deliverables when relevant.
> If the IR will be finished after this phase, double-check that all acceptance criteria are met.
>
> Keep to the original intent and follow what it asks.
> Do not re-run tests or builds whose inputs have not changed since any previous reported run.
> Make the phase's minimal changes and then one new commit, following @specs/packages/git.md; never amend an existing commit.
> Make the commit message explain concisely what changed and why, including relevant verification.
> Identify every new commit you make.
> Coder is <coder-llm>.

Results:
- `moreTasks`: Coder completed and committed exactly the IR's next unfinished task and at least one task remains. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the continued IR, and `irTask` naming the implemented task.
- `finalTask`: Coder completed and committed the IR's final task. Output shall include `coderOutput: <verbatim final text>`, `latestCommit: <commit identity>`, `irNumber` identifying the continued IR, and `irTask` naming the implemented task.

### CODE-4

When an IR-task phase has one new commit, Captain shall call playbook `review`:

> > Original intent: <caller-input>
> > Review scope: the commit <code-commit> from this coding phase and its resulting repository state.
> > Coder output: <coder-output>
> > Current IR task: <ir-task>

Workflow outcomes:
- A nested `review` passes the phase only when its result applies to the supplied review scope, returns the exact evaluated repository revision, and affirmatively establishes that no unsettled findings remain.
- A pass after a nonfinal IR-task phase continues with the next unfinished IR-task phase.
- A pass after the final IR-task phase completes `code` with the exact last `code`-owned commit, the exact final evaluated repository revision, and the fact that every phase's review passed with no unsettled findings.
- An authored `review` abort or failure, or a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings, terminates `code` with the failure and the last `code`-owned commit.
- Any other nested-call error parks `code` as failed and retains the control-plane error.
