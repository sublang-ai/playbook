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

When CODE receives a coding intent, CODE shall obtain and retain the exact Coder commit for each direct or IR phase, call REVIEW after each CODE-owned commit, start no later phase until REVIEW passes, and after REVIEW passes the direct phase or final IR task report the latest CODE-owned commit and terminate successfully.

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

### Boss-reply suspension

#### playbook-12

Where a delegated-role state can return `needsBossReply`, the FSM shall declare the result guard, record that local role in the pending question's discriminated asker, and declare a matching `BOSS_REPLY` resume arm that reenters that same state with the answer in context.

#### playbook-13

Where execution leaves a delegated-role state without suspending for its Boss question, or abandons a Boss-reply wait through another transition, the FSM shall clear the pending reply context.

## Verification

### Source and artifact coverage

#### playbook-7

When the workflow conformance suites run, they shall fail unless source and GEARS carry the same exact `Roles:` declaration with no Boss, Captain, alias, exact duplicate, or canonical-lowercase collision; the registry manifest declares exactly their canonical local ids; the FSM export and manifest agree on the ordered concurrent role sets derived from every GEARS parallel group; every protected source instruction, acting-result contract, and workflow outcome appears in at least one corresponding GEARS item in the required ordered set; no compiled item lacks source authority; and every GEARS-preserved workflow outcome is pinned at the compiled FSM and runtime boundary (verifying [[playbook-1](#playbook-1)]).

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

When the CODE, REVIEW, and DECIDE workflow suites run, they shall fail unless CODE sequences each retained commit through nested REVIEW, REVIEW covers findings-fixed, findings-rebutted, and no-findings paths with the declared success result, DECIDE preserves blind parallel proposals before its own commit, each parent reports an authored child failure or invalid success with its exact last owned commit and without starting further work, and each parent parks on a nested REVIEW control-plane failure without reporting an authored outcome (verifying [[playbook-20](#playbook-20)], [[playbook-21](#playbook-21)], [[playbook-22](#playbook-22)], [[playbook-24](#playbook-24)], [[playbook-25](#playbook-25)], and [[playbook-26](#playbook-26)]).

### Boss-reply suspension coverage

#### playbook-14

When a workflow FSM can receive a delegated-role question, its conformance suite shall fail unless the question parks execution, records that local role as its discriminated asker, and a matching Boss reply reenters only the originating state with the answer in context (verifying [[playbook-12](#playbook-12)]).

#### playbook-15

When a workflow FSM leaves or abandons a Boss-reply path, its conformance suite shall fail unless pending reply context is cleared on every non-resume transition (verifying [[playbook-13](#playbook-13)]).
