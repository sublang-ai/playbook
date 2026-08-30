<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook: Compiled Workflow Conformance

## Intent

This package specifies agreement among the maintained CODE, REVIEW, and DECIDE sources, their local roles, GEARS and FSM artifacts, and compiled workflow behavior.

## External Behavior

### Source and artifact agreement

#### playbook-1

Where a maintained workflow source declares an opening `Roles:` list, delegated-role instructions, nested playbook calls, acting-result contracts, or workflow outcomes, its compiled GEARS shall preserve the exact unique role list and every instruction, contract, and outcome in source order, may attach a workflow outcome to its corresponding item without creating a separate acting item, and shall assign the complete ordered item set `CODE-1` through `CODE-4`, `REVIEW-1` through `REVIEW-4`, or `DECIDE-1` through `DECIDE-4`, while the compiled FSM and runtime shall implement every preserved outcome.
Boss and Captain shall remain fixed actors outside `Roles:`, and the source and GEARS shall declare no role alias.
The registry manifest's `requiredRoleIds` under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)] shall equal the canonical lowercase local ids derived from that exact `Roles:` list, and source roles that collide after canonicalization shall reject.
The FSM artifact shall export and the registry manifest's `concurrentRoleSets` under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)] shall declare the same canonical role-id arrays derived in source order from the GEARS parallel groups: CODE and REVIEW shall declare none, and DECIDE shall declare exactly `[['coder', 'reviewer']]`.
Each maintained artifact shall keep its registry advertisement, compatibility declaration, delegated-player state/result topology, and schema-gated authority metadata mutually exact: schema `2` shall omit authority metadata, while a schema-3 migration shall atomically declare every delegated-player state, outcome payload field, and repository disposition under [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)].

#### playbook-2

Where a delegated-role FSM state references a GEARS item through `sourceItem`, its authored prompt body shall equal that item's blockquote body verbatim, including fenced instruction text, quoted relay fragments, and placeholder tokens.

#### playbook-3

Where a delegated-role FSM state references a GEARS item, its `input.role` and `meta.playbook.role` shall equal the canonical local id of the `Coder` or `Reviewer` role under which that item is declared, and the compiled state metadata shall define no host-binding or player-id field.

#### playbook-4

Where a workflow FSM declares an ordered transition arm, the arm shall be reachable by an input and context that satisfy its guard and falsify every earlier arm under XState first-match semantics.

### Prompt composition

#### playbook-5

Where a compiled prompt combines authored instruction blocks and relayed runtime values, the composer shall retain their source order, preserve each quoted relay value as a blockquote, and keep a literal quote marker that the source authors outside a substituted value.

#### playbook-6

Where a compiled prompt contains a placeholder token, the FSM shall supply its declared field and the composer shall substitute exactly that field, using the canonical kebab-token-to-camel-field mapping unless the compiler contract declares an explicit exception.

#### playbook-16

Every REVIEW prompt that invokes Reviewer shall forbid Reviewer from editing files or committing and shall instruct Reviewer to review committed work and report findings only.

#### playbook-18

Where a REVIEW prompt asks Reviewer to assess affected specs, the prompt shall require checks for correctness and coherence, appropriate behavioral scope, minimality, organization, `specs/map.md` accuracy, and `specs/meta.md` conformance without naming a retired spec layout.

### Workflow behavior

#### playbook-20

When CODE receives a coding intent, CODE shall obtain and retain from the qualifying repository receipt the exact Coder commit for each direct or IR phase under [[playbook-32](#playbook-32)], call REVIEW after each CODE-owned commit, start no later phase until REVIEW passes, and after REVIEW passes the direct phase or final IR task report the latest CODE-owned commit and terminate successfully.

#### playbook-24

When REVIEW returns an authored abort or failure, or a terminal result that does not prove exact approval, CODE shall start no later phase and shall terminate with the failure and the exact last CODE-owned commit.
When the nested REVIEW call fails outside that authored result contract, CODE shall park as failed and retain the control-plane error.

#### playbook-21

When REVIEW receives its initial request, REVIEW shall ask Reviewer to inspect the latest commit, ask Coder to address or rebut every finding, and begin a new Reviewer round after each review-fix commit or all-rejected rebuttal until Reviewer reports no unsettled findings.

#### playbook-26

When Reviewer reports no unsettled findings, REVIEW shall terminate successfully with `{ approvedCommit: 'latest', noUnsettledFindings: true }`, where `latest` denotes the commit most recently reviewed in that workflow.

#### playbook-22

When DECIDE receives a topic, DECIDE shall request independent Coder and Reviewer proposals concurrently, reveal neither proposal before both finish and Coder commits Coder's own proposal, and then call REVIEW with the initial intent and both proposal contexts available through the authored prompt and shared Reviewer conversation.

#### playbook-25

When REVIEW returns an authored abort or failure, or a terminal result that does not prove exact approval, DECIDE shall terminate with the failure and the exact last DECIDE-owned commit.
When the nested REVIEW call fails outside that authored result contract, DECIDE shall park as failed and retain the control-plane error.

#### playbook-27

Where a workflow declares more than one authored terminal outcome, its compiled FSM shall declare one `type: 'final'` state per outcome, each carrying a state description true of every arm that enters it and of no other terminal outcome, so a host that can quote only that published description [[playbook-captain-20](playbook-captain.md#playbook-captain-20)] never announces an outcome the run did not reach:

| Workflow | Approval-backed terminal state | Review-failure terminal state |
| --- | --- | --- |
| CODE | entered only after REVIEW approves the direct phase or the final IR task [[playbook-20](#playbook-20)] | entered on an authored REVIEW abort or failure, or on a terminal REVIEW result that does not prove exact approval [[playbook-24](#playbook-24)] |
| DECIDE | entered only with an approved commit [[playbook-22](#playbook-22)] | entered on those same authored REVIEW outcomes [[playbook-25](#playbook-25)] |

- The recoverable parked `failed` state is not a terminal outcome: a nested REVIEW control-plane failure parks there instead [[playbook-24](#playbook-24)], [[playbook-25](#playbook-25)].
- The declared machine output is unchanged, still deriving its status and fields from typed context.
- Each maintained runtime's terminal result carries the reached final state's exact description under [[playbook-runtime-41](playbook-runtime.md#playbook-runtime-41)], independently of whether that runtime implements optional control actions.

#### playbook-28

Where a maintained workflow runs under artifact schema `3`, its compiled runtime shall apply the automatic-replay fence of [[playbook-runtime-71](playbook-runtime.md#playbook-runtime-71)] at every governed delegated-player state regardless of whether linking emits the shared flat runtime or DECIDE's bespoke parallel runtime.
While that workflow remains under artifact schema `2`, its delegated-player correction [[playbook-runtime-9](playbook-runtime.md#playbook-runtime-9)] and failure-state retry [[playbook-runtime-1](playbook-runtime.md#playbook-runtime-1)] and [[playbook-runtime-52](playbook-runtime.md#playbook-runtime-52)] shall retain their legacy behavior until the workflow's atomic schema-3 migration under [[playbook-1](#playbook-1)].

#### playbook-32

Where CODE runs under artifact schema `3`, each delegated Coder outcome shall declare and reconcile the exact authority, repository disposition, and accepted transition in this matrix under [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)]:

| Source state | Accepted outcome | Payload authority | Repository disposition | Target state |
| --- | --- | --- | --- | --- |
| `runFirstPhase` | `directCommit` | presentation `coderOutput`; effect `latestCommit` | `one-descendant-commit` | `reviewFirstCommit` |
| `runFirstPhase` | `irCommit` | presentation `coderOutput`; semantic `irNumber`, `irTask`; effect `latestCommit` | `one-descendant-commit` | `reviewFirstCommit` |
| `runFirstPhase` | `needsBossReply` | presentation `question` | `deferred` | `awaitBossReply` |
| `runIrTask` | `moreTasks` | presentation `coderOutput`; semantic `irTask`; effect `latestCommit` | `one-descendant-commit` | `reviewIrTask` |
| `runIrTask` | `finalTask` | presentation `coderOutput`; effect `latestCommit` | `one-descendant-commit` | `reviewIrTask` |
| `runIrTask` | `needsBossReply` | presentation `question` | `deferred` | `awaitBossReply` |

The Coder prompts shall continue to require the phase's one commit but shall prescribe no `Commit:` marker or other response formatting, while the reconciler shall treat `coderOutput` as opaque presentation, obtain `latestCommit` only from the matching receipt OID, and retain `irNumber`, `irTask`, and the `moreTasks` versus `finalTask` choice as exact semantic evidence under [[playbook-runtime-77](playbook-runtime.md#playbook-runtime-77)].
Each accepted matrix arm shall execute one stable `playbook.acceptedOutcome` marker carrying its exact source, target, and accepted outcome under [[playbook-runtime-81](playbook-runtime.md#playbook-runtime-81)], and each deferred arm shall use the checkpoint-bound continuation of [[playbook-30](#playbook-30)].
The CODE source, GEARS, FSM, linked runtime, declarations, and registry shall move atomically to artifact schema `3` under runtime ABI `1` [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)] while preserving their agreement under [[playbook-1](#playbook-1)].

### Boss-reply suspension

#### playbook-12

Where a delegated-role state can return `needsBossReply`, the FSM shall declare the result guard, record that local role in the pending question's discriminated asker, and declare a matching `BOSS_REPLY` resume arm that reenters that same state with the answer in context.

#### playbook-13

Where execution leaves a delegated-role state without suspending for its Boss question, or abandons a Boss-reply wait through another transition, the FSM shall clear the pending reply context.

#### playbook-30

Where a maintained workflow runs under artifact schema `3` and one governed delegated-role arm declares `needsBossReply` with repository disposition `deferred`, its compiled runtime shall apply the checkpoint-bound logical-operation continuation of [[playbook-runtime-73](playbook-runtime.md#playbook-runtime-73)] identically whether the workflow uses the shared flat runtime or DECIDE's bespoke parallel runtime.
While CODE, REVIEW, or DECIDE remains under artifact schema `2`, its authored Boss-question suspension and continuation shall retain the legacy behavior of [[playbook-12](#playbook-12)] and [[playbook-13](#playbook-13)] until that workflow's atomic schema-3 migration under [[playbook-1](#playbook-1)].

## Verification

### Source and artifact coverage

#### playbook-7

When the workflow conformance suites run, they shall fail unless source and GEARS carry the same exact `Roles:` declaration with no Boss, Captain, alias, exact duplicate, or canonical-lowercase collision; the registry manifest declares exactly their canonical local ids; the FSM export and manifest agree on the ordered concurrent role sets derived from every GEARS parallel group; every protected source instruction, acting-result contract, and workflow outcome appears in at least one corresponding GEARS item in the required ordered set; no compiled item lacks source authority; and every GEARS-preserved workflow outcome is pinned at the compiled FSM and runtime boundary (verifying [[playbook-1](#playbook-1)]).
The suite shall also fail if a maintained registry and runtime compatibility schema disagree, a schema-2 artifact carries authority metadata, or a schema-3 fixture's state, outcome, payload-field, authority, or repository-disposition declarations drift from its FSM contract (verifying [[playbook-1](#playbook-1)]).

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

### Workflow coverage

#### playbook-23

When the CODE, REVIEW, and DECIDE workflow suites run, they shall fail unless CODE sequences each retained commit through nested REVIEW, REVIEW covers findings-fixed, findings-rebutted, and no-findings paths with the declared success result, DECIDE preserves blind parallel proposals before its own commit, each parent reports an authored child failure or invalid success with its exact last owned commit and without starting further work, each such authored failure or invalid success settles in a terminal state whose published description reports that REVIEW failure while the approval-backed terminal state is entered only by an exact approval, each terminal result carries the exact description of the final state reached, and each parent parks on a nested REVIEW control-plane failure without reporting an authored outcome (verifying [[playbook-20](#playbook-20)], [[playbook-21](#playbook-21)], [[playbook-22](#playbook-22)], [[playbook-24](#playbook-24)], [[playbook-25](#playbook-25)], [[playbook-26](#playbook-26)], and [[playbook-27](#playbook-27)]).

#### playbook-29

When maintained-workflow conformance drives equivalent staged artifact-schema-3 governed boundaries through the shared flat runtime and DECIDE's bespoke parallel runtime, it shall fail unless both apply the same host-acknowledged `unchanged`-only gates to empty-`ok` correction and ordinary failure-state retry, both retain evidence and start no automatic player call for a missing, incomplete, or non-`unchanged` receipt, and DECIDE's authored and generated runtime siblings stay behaviorally identical.
The suite shall further fail unless the shipped artifact-schema-2 REVIEW and DECIDE profiles retain their existing correction and retry behavior (verifying [[playbook-28](#playbook-28)]).

#### playbook-33

When the CODE conformance suites drive its real artifact-schema-3 runtime, they shall fail unless the source, GEARS, and compiled prompts contain no `Commit:` response-format instruction; no presentation parser influences a transition; missing, glued, fenced, quoted, duplicated, or misleading `Commit:` prose leaves the accepted arm unchanged under equal semantic and effect evidence; each of the four commit outcomes accepts only a matching `one-descendant-commit` receipt and obtains `latestCommit` from its exact OID; for a commit candidate every unchanged, worktree-only, multiple-commit, rewritten or non-descendant, or observation-ambiguous receipt, including one caused by post-commit residual worktree state, remains unresolved; `irNumber`, `irTask`, and `moreTasks` versus `finalTask` come only from exact semantic candidates; a semantic `latestCommit` is rejected; both Coder states exercise deferred `needsBossReply` through an exact-checkpoint authored continuation and cumulative original-baseline receipt; every accepted arm publishes its exact confirmed marker and status while an unaccepted fallback publishes neither; and the source, GEARS, FSM, linked runtime, declarations, and registry agree on schema `3`, runtime ABI `1`, and the matrix of [[playbook-32](#playbook-32)] (verifying [[playbook-1](#playbook-1)], [[playbook-20](#playbook-20)], and [[playbook-30](#playbook-30)]).

### Boss-reply suspension coverage

#### playbook-14

When a workflow FSM can receive a delegated-role question, its conformance suite shall fail unless the question parks execution, records that local role as its discriminated asker, and a matching Boss reply reenters only the originating state with the answer in context (verifying [[playbook-12](#playbook-12)]).

#### playbook-15

When a workflow FSM leaves or abandons a Boss-reply path, its conformance suite shall fail unless pending reply context is cleared on every non-resume transition (verifying [[playbook-13](#playbook-13)]).

#### playbook-31

When maintained-workflow conformance drives equivalent staged artifact-schema-3 deferred question chains through the shared flat runtime and DECIDE's bespoke parallel runtime, it shall fail unless both withhold the question until its logical operation is durable, start one authored continuation only from a valid exact-checkpoint answer, preserve one original baseline and cumulative receipt across repeated questions, keep invalid answers waiting, park another exit or checkpoint mismatch without a player, and restore an eligible exact-checkpoint wait without a player or judge; authored and generated DECIDE runtime siblings shall remain behaviorally identical (verifying [[playbook-30](#playbook-30)]).
The suite shall further fail unless the shipped artifact-schema-2 REVIEW and DECIDE profiles retain their existing Boss-question behavior (verifying [[playbook-30](#playbook-30)]).
