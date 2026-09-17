<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook: Compiled Workflow Conformance

## Intent

This package specifies agreement among the maintained CODE, REVIEW, DECIDE, DEV, BRANCH, and PR sources, their local roles, GEARS and FSM artifacts, and compiled workflow behavior.

## External Behavior

### Source and artifact agreement

#### playbook-1

Where a maintained workflow source declares an opening `Roles:` list, delegated-role instructions, nested playbook calls, acting-result contracts, or workflow outcomes, its compiled GEARS shall preserve the exact unique role list and every instruction, contract, and outcome in source order, may attach a workflow outcome to its corresponding item without creating a separate acting item, and shall assign the complete ordered item set `CODE-1` through `CODE-4`, `REVIEW-1` through `REVIEW-4`, `DECIDE-1` through `DECIDE-4`, `DEV-1` through `DEV-6`, `BRANCH-1`, or `PR-1` through `PR-7`, while the compiled FSM and runtime shall implement every preserved outcome.
Boss and Captain shall remain fixed actors outside `Roles:`, and the source and GEARS shall declare no role alias.
The registry manifest's `requiredRoleIds` under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)] shall equal the canonical lowercase local ids derived from that exact `Roles:` list, and source roles that collide after canonicalization shall reject.
The FSM artifact shall export and the registry manifest's `concurrentRoleSets` under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)] shall declare the same canonical role-id arrays derived in source order from the GEARS parallel groups: CODE, REVIEW, DEV, BRANCH, and PR shall declare none, and DECIDE shall declare exactly `[['coder', 'reviewer']]`.
Each maintained artifact, registry, and authored or generated runtime sibling shall declare artifact schema `3` and keep its compatibility declaration, delegated-player state/result topology, and authority metadata mutually exact by declaring every delegated-player state, outcome payload field, and repository disposition under [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)].

#### playbook-2

Where a delegated-role FSM state references a GEARS item through `sourceItem`, its authored prompt body shall equal that item's blockquote body verbatim, including fenced instruction text, quoted relay fragments, and placeholder tokens.

#### playbook-3

Where a delegated-role FSM state references a GEARS item, its `input.role` and `meta.playbook.role` shall equal the canonical local id of the `Coder`, `Reviewer`, or `Analyst` role under which that item is declared — `coder` for BRANCH's and PR's one delegated item each — and the compiled state metadata shall define no host-binding or player-id field.

#### playbook-4

Where a workflow FSM declares an ordered transition arm, the arm shall be reachable by an input and context that satisfy its guard and falsify every earlier arm under XState first-match semantics.

### Prompt composition

#### playbook-5

Where a compiled prompt combines authored instruction blocks and relayed runtime values, the composer shall retain their source order, preserve each quoted relay value as a blockquote with its purpose labeled, and keep a literal quote marker that the source authors outside a substituted value.

#### playbook-6

Where a compiled prompt contains a Source-declared runtime-value placeholder token, the compiler shall bind it to its authorized runtime value according to these cases:

| Case | FSM contract | Composer authority |
| --- | --- | --- |
| Ordinary Source value placeholder | Typed actor-input field backed by typed machine context, using the canonical kebab-token-to-camel-field mapping unless the compiler contract declares an explicit exception. | Substitute exactly that actor-input field. |
| Source-declared local-role prompt-identity placeholder | Preserve the literal token in the FSM prompt without an identity-value field in machine input, options, context, or actor input, whether required or optional. | Resolve only through the invocation-scoped `promptIdentity(roleId)` lookup for the declared local role identified by Source under [[playbook-runtime-15](playbook-runtime.md#playbook-runtime-15)]. |

#### playbook-16

Every REVIEW prompt that invokes Reviewer shall forbid Reviewer from editing files or committing and shall instruct Reviewer to review committed work and report findings only.

#### playbook-18

Where a REVIEW prompt asks Reviewer to assess affected specs, the prompt shall require checks for correctness and coherence, appropriate behavioral scope, minimality, organization, `specs/map.md` accuracy, and `specs/meta.md` conformance without naming a retired spec layout.

#### playbook-52

Every DEV prompt that invokes Analyst shall confine Analyst's reply to one chosen development path and a planning note of at most ten lines stating why — the decisions and spec items that settle the work, or the open point a decision must settle — carrying the scope the request implies and any fact from a named issue that the called playbooks need, and shall exclude design, proposals, implementation instructions, and file-level findings as the called playbooks' own work.
The prompt shall bound Analyst's reading of the specs and the repository to what choosing the path requires, shall permit a question to Boss only where its answer would change which path runs or whether any work is wanted — as one short question naming the alternatives it decides between and nothing else — and shall require a reply that chooses a path to ask nothing and a reply that asks Boss to choose no path.

### Workflow behavior

#### playbook-20

When CODE receives a coding request, CODE shall run its first phase as a direct implementation, a new-IR phase, or an existing IR's next unfinished task, obtain and retain from the qualifying repository receipt the exact Coder commit for each phase under [[playbook-32](#playbook-32)], call REVIEW at the end of every phase with the original intent, the review scope naming that exact commit, and the Coder output, start no later phase until REVIEW establishes that scope evaluated with no unsettled findings, and after the direct phase or the final IR task so passes terminate successfully reporting the exact last CODE-owned commit, the exact final evaluated repository revision, and the fact that every phase's review passed.

#### playbook-24

When REVIEW returns an authored abort or failure, or a terminal result that does not establish that the supplied review scope was evaluated at an exact repository revision with no unsettled findings, CODE shall start no later phase and shall terminate with the failure and the exact last CODE-owned commit.
When the nested REVIEW call fails outside that authored result contract, CODE shall park as failed and retain the control-plane error.

#### playbook-21

When REVIEW receives its caller's intent, scope, and context, REVIEW shall have Reviewer evaluate the review scope in its cumulative committed state against the relayed original intent, relay the complete caller input every round plus the receipt-derived review-fix commit and Coder feedback after each disposition, ask Coder to accept or reject every finding with one new review-fix commit or a no-commit all-rejected rebuttal, and begin a new receipt-validated Reviewer round after each disposition under [[playbook-34](#playbook-34)] until Reviewer affirmatively reports the requested review complete with no unsettled findings; a progress report, status update, or promise of a later result supports no review outcome.

#### playbook-26

When Reviewer affirmatively reports the requested review complete with no unsettled findings, REVIEW shall terminate successfully with `{ noUnsettledFindings: true, evaluatedRevision }`, where `evaluatedRevision` is the exact receipt-proven repository revision the final clean round evaluated per [DR-045](../decisions/045-unchanged-receipt-revision-authority.md), and its terminal state description shall report that completion.

#### playbook-22

When DECIDE receives a topic, DECIDE shall request independent Coder and Reviewer proposals concurrently under [[playbook-36](#playbook-36)], reveal neither proposal before both proposal outcomes are receipt-validated complete proposals, then have Coder synthesize both proposals into one DECIDE-owned commit whose identity a qualifying repository receipt proves, call REVIEW with the original intent, the review scope naming that exact commit, and the Coder output, and on REVIEW's establishing success terminate successfully returning the DECIDE-owned commit and the exact evaluated repository revision.

#### playbook-25

When REVIEW returns an authored abort or failure, or a terminal result that does not establish that the supplied review scope was evaluated at an exact repository revision with no unsettled findings, DECIDE shall terminate with the failure and the exact last DECIDE-owned commit.
When the nested REVIEW call fails outside that authored result contract, DECIDE shall park as failed and retain the control-plane error.

#### playbook-38

When DEV receives a development request, DEV shall relay it with relevant discussion context and any relevant run results to Analyst, accept only an affirmatively supported planning outcome among needs Boss reply, discussion complete, code, decide then code, code via pull request, and decide then code via pull request — with discussion complete available only after a Boss reply, and a pull-request outcome available only for a request naming a GitHub issue or asking for pull-request delivery, whose issue and comments Analyst reads while planning — and act on the accepted outcome itself without returning to the session Captain for another routing decision:

- for code, DEV calls playbook `code` with the request, discussion context, and planning result;
- for decide then code, DEV calls playbook `decide`, and only after its canonical success calls playbook `code` additionally relaying the `decide`-owned commit and exact evaluated revision consumed only from `decide`'s canonical structured result, never separately calling `review` for the scope `decide` already reviewed;
- for code via pull request and decide then code via pull request, DEV first calls playbook `branch` with the request, discussion context, and planning result, only after its canonical success continues with the code or the decide-then-code path above with that path's same child inputs, and only after `code`'s canonical success calls playbook `pr` with the request, issue summary, branch, base revision, last `code`-owned commit, and exact final evaluated revision, consuming the branch, base revision, and issue summary only from `branch`'s and the commit and revision only from `code`'s canonical structured result;
- a plain request calls neither `branch` nor `pr` and composes the same prompts, transitions, and child inputs as before the pull-request paths existed;
- DEV completes with the final child's successful result — `code`'s on a plain path, `pr`'s on a pull-request path — relays an authored child abort, failure, or insufficient terminal result, including one from `branch` or `pr`, as its own failure terminal starting no later child, and parks as failed retaining any other nested-call error.

#### playbook-43

When BRANCH receives a development request, BRANCH shall relay the complete request to Coder in one governed call that reads the named GitHub issue with its comments, requires a clean working tree and a `gh` authenticated for the repository's GitHub remote, and creates and checks out `issue-N-short-kebab-slug` — or a short kebab-case slug of an issue-less request — at the current commit without pulling, resetting, stashing, or moving HEAD, accept only an affirmatively supported outcome among branched, refused, and needs Boss reply — the last for a request ambiguous about the issue or work it means — and settle each outcome with the repository exact:

- for branched, BRANCH terminates successfully reporting the exact branch name and issue summary from Coder's result and the exact base revision taken from the `unchanged` receipt's observed HEAD, never from Coder's prose;
- for refused — a dirty tree, an unauthenticated `gh`, an issue that does not exist or cannot be read, or a branch of that name already existing locally or on the remote — BRANCH terminates with the failure carrying Coder's complete report and its reason, having created nothing;
- the absence of a reported obstacle supports no outcome, and no outcome depends on a fixed presentation format of Coder's reply.

#### playbook-44

When PR receives its caller's original request, issue summary, branch, base revision, last `code`-owned commit, and evaluated revision, PR shall relay the complete input to Coder in one governed call that confirms a clean working tree and that the checked-out branch is the branch to deliver rather than the default branch, pushes it to the repository's GitHub remote with its upstream set and never by force, reuses the branch's open pull request or opens one against the default branch with a title naming the change and a body carrying the summary from the base revision to the last commit, the verification the commits report, and a `Closes #N` line when the request names issue N, accept only an affirmatively supported outcome among opened and not published, and settle each with the repository exact:

- for opened, PR retains the exact pull request number and URL from Coder's result and proceeds to the check wait of [[playbook-45](#playbook-45)];
- for not published — a dirty tree, a wrong checked-out branch, a rejected push, or a pull request that cannot be opened — PR terminates with the failure carrying Coder's complete report and its reason, opening nothing further;
- no outcome depends on a fixed presentation format of Coder's reply.

#### playbook-45

Where PR waits for checks, publishes the fix, waits again, merges, or updates the local default branch, that step shall run exactly one static POSIX command in the repository, with no other action, no reading of its output, and no prose, whose exit status alone decides its two outcomes — `gh` inferring the pull request from the checked-out branch, and the fix publication and the merge each first requiring that inferred pull request to be exactly the one PR published, bound into the command as its only runtime value — a single-quoted shell literal, never interpolated text that could expand or execute — and left as the quoted placeholder when absent so the step refuses — and the maintained PR artifact shall be compiled with the optimize pass so that each of these items is a `script` state invoking no player, judge, adjudication, or governance boundary, its GEARS `## Optimizations` section listing exactly `PR-2`, `PR-4`, `PR-5`, `PR-6`, and `PR-7` as `captain → script`:

| Item | Step | Command | Exit zero | Exit nonzero |
| --- | --- | --- | --- | --- |
| `PR-2` | first check wait | poll `gh pr checks` while it reports no checks, at most six times ten seconds apart, exiting zero when checks are still absent; otherwise `gh pr checks --watch --fail-fast` | checks passed | checks failed |
| `PR-4` | fix publication | require the inferred pull request to be the published one; `git push`, then poll until `gh pr view --json headRefOid` equals `git rev-parse HEAD`, at most twelve times five seconds apart | fix published | fix not published |
| `PR-5` | second check wait | the same command as `PR-2` | checks passed | checks still failing |
| `PR-6` | merge | require the inferred pull-request URL to be the published one and to target the repository default branch, then `gh pr merge --merge --delete-branch --match-head-commit "$(git rev-parse HEAD)"`; require that same pull request to report `MERGED` and the local checkout to name the default branch | merged | merge refused |
| `PR-7` | local update | `git pull --ff-only` | local default updated | local default not updated |

- A pull request whose repository still reports no checks after the first wait's polling counts as passed.
- `PR-2` runs in `PR-1`'s own turn with no suspension before it, `PR-5` only watches, and `PR-7` runs on the default branch where the merged pull request is no longer inferable, so none of the three carries the identity.
- An unoptimized compile is a valid GEARS package whose mechanical steps run through the host Captain's own tools, but it is not the maintained artifact.

#### playbook-46

When the first check wait fails, PR shall call playbook `code` exactly once with the original request, the pull request URL, and a coding request to inspect the failing checks with `gh pr checks` and `gh run view --log-failed`, fix their cause on the checked-out branch with a minimal change, and make the checks pass, so the fix commit and its review are owned by `code` and `review`:

- only after `code`'s canonical success does PR publish the fix and wait for the checks again under [[playbook-45](#playbook-45)];
- an authored `code` abort or failure, or a terminal result that does not prove its success, terminates PR as fix failed relaying that canonical result and leaving the pull request open;
- a nested `code` failure outside that authored result contract parks PR as failed retaining the control-plane error;
- the `code` call suspends across Boss turns, so the fix publication pushes nothing until the checked-out branch still infers the published pull request [[playbook-45](#playbook-45)];
- a failed fix publication terminates PR as fix not published, and a failed second check wait terminates PR as checks still failing, each leaving the pull request open with no second fix attempt — the bound is the absence of any `code` target after the second wait, not a counter.

#### playbook-47

When the checks pass, before or after the one fix attempt, PR shall require the pull request the checkout infers to be the one it published and to target the repository default branch before merging it there with a merge commit, requesting deletion of the remote and local branch and checking out the local default branch — GitHub closing the linked issue — and then bring the local default branch to the merged head, terminating successfully whether or not that fast-forward succeeds:

- a checkout that no longer infers the published pull request, or a pull request that targets another branch, is never merged, so both checks precede the irreversible merge command [[playbook-45](#playbook-45)];
- a merge command that exits zero without confirming `MERGED` for the captured pull-request URL and a checkout of the repository default branch, or a merge refused for a conflict, a branch protection, a forbidden merge method, or a head that moved, or a merge that landed while the local switch or branch deletion failed, terminates PR as an unconfirmed merge leaving the pull request in the state GitHub reports;
- no outcome claims a branch was deleted and an unconfirmed merge claims neither a merge nor its absence, because only a script observes the merge, script output never enters context, and `gh` skips a requested remote deletion for a pull request from another repository or one already merged;
- the merged result reports the pull request number and URL, the fact that the pull request is merged, and whether the local default branch was fast-forwarded, and carries no merge-commit identity.

#### playbook-48

Where BRANCH or PR runs under artifact schema `3`, its compiled FSM shall declare exactly these final states, each with the terminal kind of [[playbook-41](#playbook-41)] and the output that its entering step proves:

| Workflow | Final state | Kind | Output | Entered by |
| --- | --- | --- | --- | --- |
| BRANCH | `branched` | success | `status: 'branched'`; semantic `branch` and `issueSummary`; effect `baseRevision` | branched [[playbook-43](#playbook-43)] |
| BRANCH | `refused` | failure | `status: 'refused'`; verbatim `coderOutput` | refused [[playbook-43](#playbook-43)] |
| PR | `merged` | success | `status: 'merged'`; semantic `pullRequest` and `pullRequestUrl`; `localDefaultUpdated: true` | local update exit zero [[playbook-47](#playbook-47)] |
| PR | `mergedLocalBehind` | success | as `merged` with `localDefaultUpdated: false` | local update exit nonzero [[playbook-47](#playbook-47)] |
| PR | `notPublished` | failure | `status: 'not-merged'`; `reason: 'not-published'`; verbatim `coderOutput` | not published [[playbook-44](#playbook-44)] |
| PR | `fixFailed` | failure | `status: 'not-merged'`; `reason: 'fix-failed'`; `pullRequest`; `pullRequestUrl`; `childResult` relaying `code`'s canonical result | the authored `code` failure [[playbook-46](#playbook-46)] |
| PR | `fixNotPublished` | failure | `status: 'not-merged'`; `reason: 'fix-not-published'`; `pullRequest`; `pullRequestUrl` | fix publication exit nonzero [[playbook-46](#playbook-46)] |
| PR | `checksStillFailing` | failure | `status: 'not-merged'`; `reason: 'checks-failed'`; `pullRequest`; `pullRequestUrl` | second check wait exit nonzero [[playbook-46](#playbook-46)] |
| PR | `mergeRefused` | failure | `status: 'merge-unconfirmed'`; `pullRequest`; `pullRequestUrl` | merge exit nonzero [[playbook-47](#playbook-47)] |

- `pullRequest` is a string, as `irNumber` is, and no final state carries a merge-commit field.
- The recoverable parked `failed` state of either workflow is not final and carries no output.

#### playbook-27

Where a workflow declares more than one authored terminal outcome, its compiled FSM shall declare one `type: 'final'` state per outcome, each carrying a state description true of every arm that enters it and of no other terminal outcome, so a host that can quote only that published description [[playbook-captain-20](playbook-captain.md#playbook-captain-20)] never announces an outcome the run did not reach:

| Workflow | Success terminal state | Failure-relay terminal state |
| --- | --- | --- |
| CODE | entered only after REVIEW establishes the direct phase's or final IR task's scope evaluated with no unsettled findings [[playbook-20](#playbook-20)] | entered on an authored REVIEW abort or failure, or on a terminal REVIEW result that does not establish the evaluated scope [[playbook-24](#playbook-24)] |
| DECIDE | entered only when REVIEW establishes the DECIDE-owned commit's scope evaluated with no unsettled findings [[playbook-22](#playbook-22)] | entered on those same authored REVIEW outcomes [[playbook-25](#playbook-25)] |
| DEV | entered only by the final child's proven canonical success [[playbook-38](#playbook-38)] | entered on an authored child abort, failure, or insufficient terminal result [[playbook-38](#playbook-38)] |
| BRANCH | `branched`, entered only by an affirmatively supported branched outcome whose receipt proves the repository exact [[playbook-43](#playbook-43)] | `refused`, entered only by an affirmatively supported refusal [[playbook-43](#playbook-43)] |
| PR | `merged` and `mergedLocalBehind`, entered only after the merge command exits zero and distinguished only by the local update's exit status [[playbook-47](#playbook-47)] | `notPublished`, `fixFailed`, `fixNotPublished`, `checksStillFailing`, and `mergeRefused`, each entered only from its own step's failure [[playbook-48](#playbook-48)] |

- DEV declares a third terminal state for discussion complete, entered only after a Boss reply with no child call [[playbook-38](#playbook-38)].
- DEV's pull-request paths add no terminal state: on them the success state is entered by `pr`'s proven canonical success, and the failure-relay state relays a `branch` or `pr` failure like any child's [[playbook-38](#playbook-38)].
- The recoverable parked `failed` state is not a terminal outcome: a nested control-plane failure parks there instead [[playbook-24](#playbook-24)], [[playbook-25](#playbook-25)], [[playbook-38](#playbook-38)].
- The declared machine output is unchanged, still deriving its status and fields from typed context.
- Each maintained runtime's terminal result carries the reached final state's exact description under [[playbook-runtime-41](playbook-runtime.md#playbook-runtime-41)], independently of whether that runtime implements optional control actions.

#### playbook-41

Every maintained workflow's compiled FSM shall declare each of its final states' terminal kind in `meta.playbook.terminal`, so a caller routes a completed child from the machine that child reached rather than from that child's output fields [[playbook-runtime-83](playbook-runtime.md#playbook-runtime-83)]:

- each success terminal state of [[playbook-27](#playbook-27)] — BRANCH's `branched` and both of PR's `merged` and `mergedLocalBehind` among them — REVIEW's one completion, and DEV's discussion-complete state declare `success`;
- each failure-relay terminal state of [[playbook-27](#playbook-27)] — BRANCH's `refused` and each of PR's `notPublished`, `fixFailed`, `fixNotPublished`, `checksStillFailing`, and `mergeRefused` among them — declares `failure`;
- the recoverable parked `failed` state is not final and declares no kind.

A caller's compiled FSM shall therefore route a maintained child's failure terminal through its `invoke.onError` authored-outcome arm [[playbook-runtime-84](playbook-runtime.md#playbook-runtime-84)], relaying the child's own output as its relayed failure evidence.

#### playbook-28

Where a maintained workflow runs under artifact schema `3`, its compiled runtime shall apply the automatic-replay fence of [[playbook-runtime-71](playbook-runtime.md#playbook-runtime-71)] at every governed delegated-player state regardless of whether linking emits the shared flat runtime or DECIDE's bespoke parallel runtime.

#### playbook-32

Where CODE runs under artifact schema `3`, each delegated Coder outcome shall declare and reconcile the exact authority, repository disposition, and accepted transition in this matrix under [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)]:

| Source state | Accepted outcome | Payload authority | Repository disposition | Target state |
| --- | --- | --- | --- | --- |
| `runFirstPhase` | `directCommit` | presentation `coderOutput`; effect `latestCommit` | `one-descendant-commit` | `reviewFirstCommit` |
| `runFirstPhase` | `irCommit` | presentation `coderOutput`; semantic `irNumber`; effect `latestCommit` | `one-descendant-commit` | `reviewFirstCommit` |
| `runFirstPhase` | `moreTasks` | presentation `coderOutput`; semantic `irNumber`, `irTask`; effect `latestCommit` | `one-descendant-commit` | `reviewIrTask` |
| `runFirstPhase` | `finalTask` | presentation `coderOutput`; semantic `irNumber`, `irTask`; effect `latestCommit` | `one-descendant-commit` | `reviewIrTask` |
| `runFirstPhase` | `needsBossReply` | presentation `question` | `deferred` | `awaitBossReply` |
| `runIrTask` | `moreTasks` | presentation `coderOutput`; semantic `irNumber`, `irTask`; effect `latestCommit` | `one-descendant-commit` | `reviewIrTask` |
| `runIrTask` | `finalTask` | presentation `coderOutput`; semantic `irNumber`, `irTask`; effect `latestCommit` | `one-descendant-commit` | `reviewIrTask` |
| `runIrTask` | `needsBossReply` | presentation `question` | `deferred` | `awaitBossReply` |

The Coder prompts shall continue to require the phase's one commit but shall prescribe no `Commit:` marker or other response formatting, while the reconciler shall treat `coderOutput` as opaque presentation, obtain `latestCommit` only from the matching receipt OID, and retain `irNumber`, `irTask` naming the exact implemented task, and the `moreTasks` versus `finalTask` choice as exact semantic evidence under [[playbook-runtime-77](playbook-runtime.md#playbook-runtime-77)].
Each accepted matrix arm shall execute one stable `playbook.acceptedOutcome` marker carrying its exact source, target, and accepted outcome under [[playbook-runtime-81](playbook-runtime.md#playbook-runtime-81)], and each deferred arm shall use the checkpoint-bound continuation of [[playbook-30](#playbook-30)].
The CODE source, GEARS, FSM, linked runtime, declarations, and registry shall move atomically to artifact schema `3` under runtime ABI `1` [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)] while preserving their agreement under [[playbook-1](#playbook-1)].

#### playbook-34

Where REVIEW runs under artifact schema `3`, each delegated outcome shall declare and reconcile the exact authority, repository disposition, and accepted transition in this matrix under [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)]:

| Source state | Accepted outcome | Payload authority | Repository disposition | Target state |
| --- | --- | --- | --- | --- |
| `reviewInitial` | `hasFindings` | presentation `reviewerOutput` | `unchanged` | `addressFindings` |
| `reviewInitial` | `noFindings` | effect `evaluatedRevision` | `unchanged` | `done` |
| `reviewInitial` | `needsBossReply` | presentation `question` | `unchanged` | `awaitBossReply` |
| `addressFindings` | `committed` | presentation `coderOutput`; effect `latestCommit` | `one-descendant-commit` | `reviewAfterCommit` |
| `addressFindings` | `rejectedAll` | presentation `coderOutput` | `unchanged` | `reviewAfterRebuttal` |
| `addressFindings` | `needsBossReply` | presentation `question` | `deferred` | `awaitBossReply` |
| `reviewAfterCommit` | `hasFindings` | presentation `reviewerOutput` | `unchanged` | `addressFindings` |
| `reviewAfterCommit` | `noFindings` | effect `evaluatedRevision` | `unchanged` | `done` |
| `reviewAfterCommit` | `needsBossReply` | presentation `question` | `unchanged` | `awaitBossReply` |
| `reviewAfterRebuttal` | `hasFindings` | presentation `reviewerOutput` | `unchanged` | `addressFindings` |
| `reviewAfterRebuttal` | `noFindings` | effect `evaluatedRevision` | `unchanged` | `done` |
| `reviewAfterRebuttal` | `needsBossReply` | presentation `question` | `unchanged` | `awaitBossReply` |

The reconciler shall treat `reviewerOutput`, `coderOutput`, and `question` as opaque presentation and shall require a matching `unchanged` receipt for every Reviewer arm, including each question and its separately governed authored continuation under [[playbook-12](#playbook-12)].
The reconciler shall obtain `latestCommit` only from the matching receipt OID and `evaluatedRevision` only from the matching `unchanged` receipt's observed HEAD per [DR-045](../decisions/045-unchanged-receipt-revision-authority.md).
The Coder reconciliation call shall accept `committed` only from a matching `one-descendant-commit` receipt, accept `rejectedAll` only from a matching `unchanged` receipt, and admit `needsBossReply` only through the restricted deferred continuation of [[playbook-30](#playbook-30)].
Missing, incomplete, mismatched, concurrent, foreign, or ambiguous evidence shall remain unresolved under [[playbook-runtime-77](playbook-runtime.md#playbook-runtime-77)] without replaying Coder.
Each accepted matrix arm shall execute one stable `playbook.acceptedOutcome` marker carrying its exact source, target, and accepted outcome under [[playbook-runtime-81](playbook-runtime.md#playbook-runtime-81)].
The REVIEW source, GEARS, FSM, linked runtime, declarations, and registry shall move atomically to artifact schema `3` under runtime ABI `1` [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)] while preserving their agreement under [[playbook-1](#playbook-1)].

#### playbook-36

Where DECIDE runs under artifact schema `3`, each delegated outcome shall declare and reconcile the exact authority, repository disposition, and accepted transition in this matrix under [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)]:

| Source state | Accepted outcome | Payload authority | Repository disposition | Target state |
| --- | --- | --- | --- | --- |
| `askCoderProposal` | `proposed` | presentation `coderProposal` | `unchanged` | `coderProposalComplete` when Coder finishes first; `commitCoderProposal` when Coder completes the pair |
| `askCoderProposal` | `needsBossReply` | presentation `question` | `unchanged` | `waitCoderProposalReply` |
| `askReviewerProposal` | `proposed` | presentation `reviewerProposal` | `unchanged` | `reviewerProposalComplete` when Reviewer finishes first; `commitCoderProposal` when Reviewer completes the pair |
| `askReviewerProposal` | `needsBossReply` | presentation `question` | `unchanged` | `waitReviewerProposalReply` |
| `commitCoderProposal` | `committed` | presentation `coderOutput`; effect `latestCommit` | `one-descendant-commit` | `reviewCommit` |
| `commitCoderProposal` | `needsBossReply` | presentation `question` | `deferred` | `awaitBossReply` |

The two proposal calls shall execute as one declared concurrent all-`unchanged` cohort under [[playbook-runtime-69](playbook-runtime.md#playbook-runtime-69)], while `commitCoderProposal` shall begin only after both cohort receipts complete and shall execute through the exclusive host transaction of [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)].
Each proposal `proposed` or `needsBossReply` arm shall require an exact matching `unchanged` receipt under [[playbook-runtime-77](playbook-runtime.md#playbook-runtime-77)] before staging its presentation or publishing its question.
Each proposal question's authored continuation shall run as a new separately governed `unchanged` boundary under [[playbook-runtime-73](playbook-runtime.md#playbook-runtime-73)].
The commit prompt shall continue to require one commit but shall prescribe no `Commit:` marker or other response formatting, while the reconciler shall treat `coderOutput` as opaque presentation and obtain `latestCommit` only from the matching receipt OID under [[playbook-runtime-77](playbook-runtime.md#playbook-runtime-77)].
Missing, incomplete, mismatched, concurrent, foreign, or ambiguous evidence shall remain unresolved under [[playbook-runtime-77](playbook-runtime.md#playbook-runtime-77)] without revealing a proposal early, starting REVIEW, or replaying either player.
Each accepted matrix arm shall execute one stable `playbook.acceptedOutcome` marker carrying its exact source, target, and accepted outcome under [[playbook-runtime-81](playbook-runtime.md#playbook-runtime-81)], and the deferred merge arm shall use the checkpoint-bound continuation of [[playbook-30](#playbook-30)].
The bespoke runtime's hidden adjudicator shall render each arm's judge-facing reply contract from this matrix through the shared renderer of [[playbook-runtime-34](playbook-runtime.md#playbook-runtime-34)] under [[playbook-runtime-10](playbook-runtime.md#playbook-runtime-10)], so every arm asks the judge for `guard` alone and names its presentation and effect fields as runtime-supplied.
The DECIDE source, GEARS, FSM, bespoke linked runtime, declarations, and registry shall move atomically to artifact schema `3` while preserving their agreement under [[playbook-1](#playbook-1)] and their declared parallel role set under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)].

#### playbook-39

Where DEV runs under artifact schema `3`, each delegated Analyst outcome shall declare and reconcile the exact authority, repository disposition, and accepted transition in this matrix under [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)]:

| Source state | Accepted outcome | Payload authority | Repository disposition | Target state |
| --- | --- | --- | --- | --- |
| `planAnalysis` | `code` | presentation `planningResult` | `unchanged` | `callCode` |
| `planAnalysis` | `decideThenCode` | presentation `planningResult` | `unchanged` | `callDecide` |
| `planAnalysis` | `codeViaPullRequest` | presentation `planningResult` | `unchanged` | `createBranch`, then `callCode` |
| `planAnalysis` | `decideThenCodeViaPullRequest` | presentation `planningResult` | `unchanged` | `createBranch`, then `callDecide` |
| `planAnalysis` | `discussionComplete` | none | `unchanged` | `discussionComplete` |
| `planAnalysis` | `needsBossReply` | presentation `question` | `unchanged` | `awaitBossReply` |

The reconciler shall treat `planningResult` and `question` as opaque presentation and shall require a matching `unchanged` receipt for every Analyst outcome, including each question and its separately governed authored continuation under [[playbook-12](#playbook-12)], so planning that mutates the repository remains unresolved; reading an issue during planning is not a repository effect.
The nested `branch`, `code`, `decide`, and `pr` calls declare no arm of their own: each child's terminal is its outcome, and `callCode` and `callDecide` keep their prompts and child inputs whether entered from `planAnalysis` or from `createBranch`.
Each accepted matrix arm shall execute one stable `playbook.acceptedOutcome` marker carrying its exact source, target, and accepted outcome under [[playbook-runtime-81](playbook-runtime.md#playbook-runtime-81)].
The DEV source, GEARS, FSM, linked runtime, declarations, and registry shall agree on artifact schema `3` under runtime ABI `1` [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)] while preserving their agreement under [[playbook-1](#playbook-1)].

#### playbook-49

Where BRANCH or PR runs under artifact schema `3`, each delegated Coder outcome shall declare and reconcile the exact authority, repository disposition, and accepted transition in this matrix under [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)]:

| Workflow | Source state | Accepted outcome | Payload authority | Repository disposition | Target state |
| --- | --- | --- | --- | --- | --- |
| BRANCH | `createBranch` | `branched` | semantic `branch`, `issueSummary`; effect `baseRevision` | `unchanged` | `branched` |
| BRANCH | `createBranch` | `refused` | presentation `coderOutput` | `unchanged` | `refused` |
| BRANCH | `createBranch` | `needsBossReply` | presentation `question` | `unchanged` | `awaitBossReply` |
| PR | `openPullRequest` | `opened` | semantic `pullRequest`, `pullRequestUrl` | `unchanged` | `waitForChecks` |
| PR | `openPullRequest` | `notPublished` | presentation `coderOutput` | `unchanged` | `notPublished` |
| PR | `openPullRequest` | `needsBossReply` | presentation `question` | `unchanged` | `awaitBossReply` |

The reconciler shall treat `coderOutput` and `question` as opaque presentation, retain `branch`, `issueSummary`, `pullRequest`, and `pullRequestUrl` as exact semantic evidence under [[playbook-runtime-77](playbook-runtime.md#playbook-runtime-77)], obtain `baseRevision` only from the matching `unchanged` receipt's observed HEAD per [DR-045](../decisions/045-unchanged-receipt-revision-authority.md), and require a matching `unchanged` receipt for every arm, including each question and its separately governed authored continuation under [[playbook-12](#playbook-12)] — a new branch at the current commit, a push, and an opened pull request change neither HEAD's commit nor the working tree, and byte-identical pre-existing dirt is no delta.
PR's script states and the nested `code` call hold no ledger boundary and declare no arm here: the merge is the one step that moves HEAD, to the default branch, outside governance by design.
Each accepted matrix arm shall execute one stable `playbook.acceptedOutcome` marker carrying its exact source, target, and accepted outcome under [[playbook-runtime-81](playbook-runtime.md#playbook-runtime-81)].
The BRANCH and PR sources, GEARS, FSMs, linked runtimes, declarations, and registries shall agree on artifact schema `3` under runtime ABI `1` [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)] while preserving their agreement under [[playbook-1](#playbook-1)].

### Boss-reply suspension

#### playbook-12

Where a delegated-role state can return `needsBossReply`, the FSM shall declare the result guard, record that local role in the pending question's discriminated asker, and declare a matching `BOSS_REPLY` resume arm that reenters that same state with the answer in context.

#### playbook-13

Where execution leaves a delegated-role state without suspending for its Boss question, or abandons a Boss-reply wait through another transition, the FSM shall clear the pending reply context.

#### playbook-30

Where a maintained workflow runs under artifact schema `3` and one governed delegated-role arm declares `needsBossReply` with repository disposition `deferred`, its compiled runtime shall apply the checkpoint-bound logical-operation continuation of [[playbook-runtime-73](playbook-runtime.md#playbook-runtime-73)] identically whether the workflow uses the shared flat runtime or DECIDE's bespoke parallel runtime.

## Verification

### Source and artifact coverage

#### playbook-7

When the workflow conformance suites run, they shall fail unless source and GEARS carry the same exact `Roles:` declaration with no Boss, Captain, alias, exact duplicate, or canonical-lowercase collision; the registry manifest declares exactly their canonical local ids; the FSM export and manifest agree on the ordered concurrent role sets derived from every GEARS parallel group; every protected source instruction, acting-result contract, and workflow outcome appears in at least one corresponding GEARS item in the required ordered set; no compiled item lacks source authority; and every GEARS-preserved workflow outcome is pinned at the compiled FSM and runtime boundary (verifying [[playbook-1](#playbook-1)]).
The suite shall also fail if any maintained artifact, registry, or authored or generated runtime sibling does not declare artifact schema `3`, if a registry and runtime compatibility schema disagree, or if a state, outcome, payload-field, authority, or repository-disposition declaration drifts from its FSM contract (verifying [[playbook-1](#playbook-1)]).

#### playbook-8

When the workflow conformance suites run, they shall fail if a delegated-role state's prompt body differs from its GEARS item, including any fenced instruction, quote marker, relayed blockquote, or placeholder (verifying [[playbook-2](#playbook-2)]).

#### playbook-9

When the workflow conformance suites run, they shall fail if any delegated-role state's `input.role` or `meta.playbook.role` differs from its GEARS role or if its compiled metadata declares a host-binding or player-id field (verifying [[playbook-3](#playbook-3)]).

#### playbook-10

When the workflow conformance suites run, they shall fail if an ordered FSM transition lacks an exercising fixture or a declared fixture is unused (verifying [[playbook-4](#playbook-4)]).

### Prompt coverage

#### playbook-11

When the workflow prompt-contract suites run, they shall fail if composition reorders an authored fragment, drops or dequotes a relayed value, loses a literal quote marker, or substitutes a placeholder from the wrong field (verifying [[playbook-5](#playbook-5)] and [[playbook-6](#playbook-6)]).

#### playbook-17

When the REVIEW prompt-contract suite runs, it shall fail if a Reviewer prompt permits editing or committing or omits its committed-work review posture (verifying [[playbook-16](#playbook-16)]).

#### playbook-19

When the REVIEW prompt-contract suite runs, it shall fail if an affected-spec review omits a required quality check or names the retired `specs/{user,dev,test}` layout (verifying [[playbook-18](#playbook-18)]).

#### playbook-53

When the DEV prompt-contract suite runs, it shall fail if a composed Analyst prompt omits the planning-note bound or its exclusions, permits a question to Boss beyond one whose answer would change which path runs or whether any work is wanted, or lets one reply both choose a path and ask Boss (verifying [[playbook-52](#playbook-52)]).

### Workflow coverage

#### playbook-23

When the CODE, REVIEW, and DECIDE workflow suites run, they shall fail unless CODE sequences each retained commit through nested REVIEW, REVIEW covers findings-fixed, findings-rebutted, and no-findings paths with the declared success result, DECIDE preserves blind parallel proposals until both are complete, each parent reports an authored child failure or invalid success with its exact last owned commit and without starting further work, each such authored failure or invalid success settles in a terminal state whose published description reports that REVIEW failure while the approval-backed terminal state is entered only by an exact approval, each terminal result carries the exact description of the final state reached, and each parent parks on a nested REVIEW control-plane failure without reporting an authored outcome (verifying [[playbook-20](#playbook-20)], [[playbook-21](#playbook-21)], [[playbook-22](#playbook-22)], [[playbook-24](#playbook-24)], [[playbook-25](#playbook-25)], [[playbook-26](#playbook-26)], and [[playbook-27](#playbook-27)]).

#### playbook-29

When maintained-workflow conformance drives equivalent artifact-schema-3 governed boundaries through the shared flat runtimes and DECIDE's bespoke parallel runtime, it shall fail unless both apply the same host-acknowledged `unchanged`-only gates to empty-`ok` correction and ordinary failure-state retry, both retain evidence and start no automatic player call for a missing, incomplete, or non-`unchanged` receipt, and DECIDE's authored and generated runtime siblings stay behaviorally identical (verifying [[playbook-28](#playbook-28)]).

#### playbook-33

When the CODE conformance suites drive its real artifact-schema-3 runtime, they shall fail unless the source, GEARS, and compiled prompts contain no `Commit:` response-format instruction; no presentation parser influences a transition; missing, glued, fenced, quoted, duplicated, or misleading `Commit:` prose leaves the accepted arm unchanged under equal semantic and effect evidence; each of the four commit outcomes accepts only a matching `one-descendant-commit` receipt and obtains `latestCommit` from its exact OID; for a commit candidate every unchanged, worktree-only, multiple-commit, rewritten or non-descendant, or observation-ambiguous receipt, including one caused by post-commit residual worktree state, remains unresolved; `irNumber`, `irTask`, and `moreTasks` versus `finalTask` come only from exact semantic candidates; a semantic `latestCommit` is rejected; both Coder states exercise deferred `needsBossReply` through an exact-checkpoint authored continuation and cumulative original-baseline receipt; every accepted arm publishes its exact confirmed marker and status while an unaccepted fallback publishes neither; and the source, GEARS, FSM, linked runtime, declarations, and registry agree on schema `3`, runtime ABI `1`, and the matrix of [[playbook-32](#playbook-32)] (verifying [[playbook-1](#playbook-1)], [[playbook-20](#playbook-20)], and [[playbook-30](#playbook-30)]).

#### playbook-35

When the REVIEW conformance suites drive its real artifact-schema-3 runtime, they shall fail unless every outcome from all three Reviewer states accepts only a matching `unchanged` receipt, including each question and separately governed answer continuation; Coder `committed` accepts only `one-descendant-commit`; Coder `rejectedAll` accepts only `unchanged`; `latestCommit` and `evaluatedRevision` come only from their matching receipts, with a judge-authored value for either rejected as a structural error; the post-commit round relays the exact receipt OID; mismatched or ambiguous evidence remains unresolved without replaying Coder; and Coder `needsBossReply` uses one exact-checkpoint cumulative deferred operation (verifying [[playbook-12](#playbook-12)], [[playbook-21](#playbook-21)], [[playbook-30](#playbook-30)], and [[playbook-34](#playbook-34)]).
The suites shall further fail unless every accepted matrix row publishes its exact confirmed marker and status while an unaccepted fallback publishes neither, and the source, GEARS, FSM, linked runtime, declarations, and registry agree on schema `3`, runtime ABI `1`, and the matrix of [[playbook-34](#playbook-34)] (verifying [[playbook-1](#playbook-1)]).

#### playbook-37

When the DECIDE conformance suites drive its real artifact-schema-3 runtime, they shall fail unless the source, GEARS, and compiled prompts contain no `Commit:` response-format instruction; no presentation parser influences a transition; missing, glued, fenced, quoted, duplicated, or misleading `Commit:` prose leaves the accepted arm unchanged under equal semantic and effect evidence; both proposal calls overlap from one common baseline without revealing either proposal early; every proposal `proposed` and `needsBossReply` outcome and every separately governed proposal answer continuation accepts only a matching `unchanged` receipt; the merge waits for both proposal receipts and then runs exclusively; `committed` accepts only a matching `one-descendant-commit` receipt and obtains `latestCommit` from its exact OID; every mismatched or ambiguous proposal or merge receipt remains unresolved without an unauthorized player call; and merge `needsBossReply` uses one exact-checkpoint cumulative deferred operation (verifying [[playbook-12](#playbook-12)], [[playbook-22](#playbook-22)], [[playbook-30](#playbook-30)], and [[playbook-36](#playbook-36)]).
The suites shall further fail unless each accepted matrix row publishes its exact confirmed marker and status, including the completion-order-specific proposal target, while an unaccepted fallback publishes neither, and the source, GEARS, FSM, bespoke linked runtime, declarations, and registry agree on schema `3` and the matrix of [[playbook-36](#playbook-36)] (verifying [[playbook-1](#playbook-1)]).
The suites shall further fail unless the proposal and merge adjudicator prompts carry no `Output shall include` clause, state each arm's exact reply JSON of `guard` alone, name `coderProposal`, `reviewerProposal`, `coderOutput`, and `question` as presentation-owned and `latestCommit` as effect-owned runtime-supplied fields to omit, and a guard-only reply resolves each arm with its correction budget unspent while the runtime supplies the omitted fields (verifying [[playbook-36](#playbook-36)]).

#### playbook-40

When the DEV conformance suites drive its real artifact-schema-3 runtime, they shall fail unless every Analyst outcome accepts only a matching `unchanged` receipt, including each question and separately governed answer continuation, with any repository mutation during planning remaining unresolved without a child call; discussion complete is accepted only after a Boss reply; the decide-then-code path starts `code` only after `decide`'s canonical success, relaying the exact `decide`-owned commit and evaluated revision from that structured result alone; each pull-request path starts `branch` first, enters `callCode` or `callDecide` with the same composed prompt and child input as its plain path, calls `pr` only after `code`'s canonical success relaying the branch, base revision, and issue summary from `branch`'s and the last commit and final evaluated revision from `code`'s structured result alone, and completes with `pr`'s result, while a plain request calls neither `branch` nor `pr` and compiles to the same prompts, transitions, and composed child inputs as before the pull-request paths; an authored child abort, failure, or insufficient terminal result — from `branch` or `pr` as from `code` or `decide` — settles in the failure-relay terminal without a later child while a control-plane child failure parks; each terminal state publishes its distinct truthful description; every accepted matrix row publishes its exact confirmed marker and status while an unaccepted fallback publishes neither; and the source, GEARS, FSM, linked runtime, declarations, and registry agree on schema `3`, runtime ABI `1`, and the matrix of [[playbook-39](#playbook-39)] (verifying [[playbook-1](#playbook-1)], [[playbook-12](#playbook-12)], [[playbook-38](#playbook-38)], and [[playbook-39](#playbook-39)]).

#### playbook-42

When the maintained conformance suites read each artifact's compiled final states, they shall fail unless every one of them declares exactly the terminal kind of [[playbook-41](#playbook-41)] and no other state declares one; and when the DEV coverage suite delivers a CODE, BRANCH, or PR result that does not prove success, it shall fail unless that result reaches DEV through its `invoke.onError` authored-outcome arm and DEV's failure-relay terminal with the child's own output relayed, while a resolved result that does not prove success still reaches that same terminal through the retained `onDone` field check (verifying [[playbook-41](#playbook-41)]).

#### playbook-50

When the BRANCH conformance suites drive its real artifact-schema-3 runtime, they shall fail unless every Coder outcome accepts only a matching `unchanged` receipt, including the question and its separately governed answer continuation, with a branch created at HEAD on a clean tree and on a tree whose pre-existing dirt is byte-identical before and after both classifying `unchanged`; `baseRevision` comes only from that receipt's observed HEAD, with a judge-authored value rejected as a structural error; `branch` and `issueSummary` come only from exact semantic candidates; refused settles in the failure terminal carrying Coder's complete report with no branch created and no later call; each terminal state publishes its distinct truthful description; every accepted matrix row publishes its exact confirmed marker and status while an unaccepted fallback publishes neither; and the source, GEARS, FSM, linked runtime, declarations, and registry agree on schema `3`, runtime ABI `1`, and the matrix of [[playbook-49](#playbook-49)] (verifying [[playbook-1](#playbook-1)], [[playbook-12](#playbook-12)], [[playbook-43](#playbook-43)], and [[playbook-49](#playbook-49)]).

#### playbook-51

When the PR conformance suites drive its real artifact-schema-3 runtime, they shall fail unless the Coder outcome accepts only a matching `unchanged` receipt, including the question and its separately governed answer continuation, with `pullRequest` and `pullRequestUrl` coming only from exact semantic candidates and not published settling in its failure terminal with Coder's complete report and no later step; the compiled GEARS `## Optimizations` section lists exactly `PR-2`, `PR-4`, `PR-5`, `PR-6`, and `PR-7` as `captain → script`, the FSM invokes only a `script` actor for each of them with no player, judge, adjudication, or governance boundary, each script's command preserves its source text except for binding the target placeholder under [[playbook-45](#playbook-45)], and each script state routes on exit status alone with a fixture for both exits; a failed first wait calls `code` exactly once with the composed coding request, a failed second wait reaches `checksStillFailing` with no `code` target, and a failed fix publication reaches `fixNotPublished`; a `code` result that does not prove success reaches `fixFailed` through PR's `invoke.onError` authored-outcome arm with the child's own output relayed, a resolved result that does not prove success reaches that same terminal through the retained `onDone` field check, and a control-plane `code` failure parks; a checkout that infers another pull request after the suspended `code` call reaches `fixNotPublished` with nothing pushed and, at the merge, `mergeRefused` with `gh pr merge` never invoked; a reported pull-request URL carrying shell syntax binds as a literal that neither executes nor satisfies either check; a pull request whose base is not the repository default branch reaches `mergeRefused` the same way, and a queued pull request whose `gh pr merge` exits zero, a failed post-merge state query, and a merged pull request whose checkout is still on the feature branch each reach it without local update; a nonzero merge script reaches `mergeRefused` carrying `status: 'merge-unconfirmed'` and no `reason`, while a zero merge script reaches `merged` or `mergedLocalBehind` by the local update's exit status alone, both carrying `localDefaultUpdated`, no merge-commit field, and no claim that either branch was deleted; each terminal state publishes its distinct truthful description; every accepted matrix row publishes its exact confirmed marker and status while an unaccepted fallback publishes neither; and the source, GEARS, FSM, linked runtime, declarations, and registry agree on schema `3`, runtime ABI `1`, and the matrix of [[playbook-49](#playbook-49)] (verifying [[playbook-1](#playbook-1)], [[playbook-12](#playbook-12)], [[playbook-44](#playbook-44)], [[playbook-45](#playbook-45)], [[playbook-46](#playbook-46)], [[playbook-47](#playbook-47)], [[playbook-48](#playbook-48)], and [[playbook-49](#playbook-49)]).

### Boss-reply suspension coverage

#### playbook-14

When a workflow FSM can receive a delegated-role question, its conformance suite shall fail unless the question parks execution, records that local role as its discriminated asker, and a matching Boss reply reenters only the originating state with the answer in context (verifying [[playbook-12](#playbook-12)]).

#### playbook-15

When a workflow FSM leaves or abandons a Boss-reply path, its conformance suite shall fail unless pending reply context is cleared on every non-resume transition (verifying [[playbook-13](#playbook-13)]).

#### playbook-31

When maintained-workflow conformance drives equivalent artifact-schema-3 deferred question chains through the shared flat runtimes and DECIDE's bespoke parallel runtime, it shall fail unless both withhold the question until its logical operation is durable, start one authored continuation only from a valid exact-checkpoint answer, preserve one original baseline and cumulative receipt across repeated questions, keep invalid answers waiting, park another exit or checkpoint mismatch without a player, and restore an eligible exact-checkpoint wait without a player or judge; authored and generated DECIDE runtime siblings shall remain behaviorally identical (verifying [[playbook-30](#playbook-30)]).
