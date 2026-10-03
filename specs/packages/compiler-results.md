<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-results: GEARS Result Preservation

## Intent

This package specifies the text-to-GEARS producer's existing acting-result boundary, preservation of source-authored terminal returns, and authored Boss-question field declarations without changing prompts, outcomes, or nested-call continuation.
The package also reserves output-clause backticks for unambiguous field declarations.
The Results-boundary guidance is retained after a matched phase comparison; it does not guarantee a compilation-time reduction.

## External Behavior

### compiler-results-1

When emitting an acting item's `Results:` contract, text2gears shall place the label immediately after the complete acting blockquote, emit only result bullets and blank lines until the next item or section heading, and place other item conditions or invariants before that blockquote rather than between the blockquote and label or after its result bullets.
Nested-playbook items shall remain without `Results:` and retain their child-continuation prose after the blockquote.

### compiler-results-3

When Source requires a terminal return to its caller, text2gears shall preserve every returned value or fact and its return condition as an explicit workflow output obligation in GEARS; merely naming a value in a completion predicate or acting result shall not substitute for that obligation.
The terminal-return requirement shall remain non-acting semantics outside prompt blockquotes, before the acting blockquote, in an explicit terminal-return clause of the relevant Results description, or in existing nested-call continuation, without a new Captain action solely to restate it.

### compiler-results-5

When Source gives a direct-Captain or delegated-player behavior a Boss question that waits for the answer before the same behavior resumes, text2gears shall preserve the authored prompt, the wait, and the answer-dependent continuation on the originating item [[playbook-runtime-11](playbook-runtime.md#playbook-runtime-11)] and shall declare no result for that question outside the decide-call-observe routing contract: the question is the framework-owned `needsBossReply` outcome that [gears2fsm's Boss-reply suspension](../../slc/gears2fsm.md#boss-reply-suspension) adds to every such state [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)], and a second guard for the same wait would give the adjudicator two equivalent outcomes.
Where the behavior is Captain's routing decision under that contract, whose `question` and `followUpQuestion` results are fixed compiler vocabulary, text2gears shall declare the routing question's `question` output property in the annotated `question: <verbatim final text>` form [[playbook-runtime-10](playbook-runtime.md#playbook-runtime-10)], and the result name or prose alone shall not satisfy that declaration.

### compiler-results-9

When declaring a result's output properties, text2gears shall declare a property only where a consumer requires its value — a later item's placeholder, the workflow's terminal return [[compiler-results-3](#compiler-results-3)], or the workflow's declared public interface [[compiler-workflow-contracts-6](compiler-workflow-contracts.md#compiler-workflow-contracts-6)] — and shall carry a detail the acting agent reports only within its final text, such as a reason, a summary, or a list, in that result's verbatim final-text property rather than as a separate judge-authored property ([DR-066](../decisions/066-compiled-builtins-keep-their-public-interface.md)).

### compiler-results-11

Where a later prompt reads the commit an earlier call itself created through a Source-named placeholder, text2gears shall declare that producer's property as `latestCommit`, the effect-owned name every linked runtime fills from the repository receipt [[playbook-runtime-50](playbook-runtime.md#playbook-runtime-50)], and gears2fsm shall bind the placeholder to a typed context field assigned from that accepted `latestCommit`, so the Source keeps its own placeholder while one effect-owned name serves every workflow ([DR-066](../decisions/066-compiled-builtins-keep-their-public-interface.md)).

### compiler-results-13

When Source qualifies an outcome's evidence — what affirmatively supports it, or what supports no outcome — text2gears shall carry that qualification in the outcome's result description, which the hidden adjudicator reads when it selects the guard [[playbook-runtime-10](playbook-runtime.md#playbook-runtime-10)], rather than in the item's prose, which reaches no judge; a behavior with one qualified outcome therefore carries exactly one `Results:` bullet naming it, with an output property only where a consumer requires one.

### compiler-results-15

When gears2fsm compiles an accepted `onDone` arm of an artifact-schema-3 governed delegated-player state, it shall place first among the arm's actions the root-machine `playbook.acceptedOutcome` action with exact plain params `{ source, target, acceptedOutcome }` naming that state, the state the next public snapshot shows for the arm — the arm's own target, or the parallel parent's `onDone` target where the arm's target is a region's final leaf that completes that parent, an arm that completes the join only when every sibling region is already final being split into two arms guarded on that condition — and the accepted guard, and shall declare the action in the machine setup as a no-op typing those params, so the linked runtime confirms and publishes the accepted outcome [[playbook-runtime-81](playbook-runtime.md#playbook-runtime-81)]; the malformed-output fallback carries none.

### compiler-results-7

When emitting a result description with an `Output shall include` clause, text2gears shall reserve complete backticked spans after that marker for output-field declarations [[playbook-runtime-10](playbook-runtime.md#playbook-runtime-10)] outside plain-text parentheses, placing explanatory symbols in plain guidance text or inside the declaration's complete annotation rather than in separate backticks within parenthetical guidance, while retaining bare declarations with plain parenthetical guidance and parentheses inside a complete backticked annotation.

### compiler-results-17

Where Source requires the complete received Boss input or reply retained for a later call, when text2gears emits GEARS, it shall preserve that input-owned retention and its Source-authored acceptance condition in non-acting prose, without declaring a Judge-extracted echo property; the acting result contract retains the semantic approval or refusal ([DR-082](../decisions/082-retain-input-owned-boss-replies.md)).

## Verification

### compiler-results-8

When the integration suite gives annotated and bare output declarations with plain parenthetical guidance to the supplied SLC parser and the real runtime field extractor, it shall verify identical intended field sets and unchanged result descriptions while rejecting separate backticked explanatory symbols nested in output-clause parentheses without changing field extraction [[compiler-results-7](#compiler-results-7)].

### compiler-results-2

When the integration suite checks candidate GEARS through the supplied SLC installation's actual result-contract parser, it shall verify these cases while preserving the same acting prompt and declared outcomes [[compiler-results-1](#compiler-results-1)]:

| Prose placement | Expected result |
| --- | --- |
| Item invariant before the acting blockquote | Accepted. |
| Item invariant between the acting blockquote and `Results:` | Rejected as misplaced results. |
| Item invariant after the result bullets, before the next heading | Rejected as a malformed result entry. |
| Child-continuation prose after a nested-call blockquote without `Results:` | Accepted. |

### compiler-results-4

When the integration suite parses terminal-return fixtures through the supplied SLC installation, it shall verify that explicit return prose before a delegated prompt or in nested-call continuation leaves the authored prompt, acting-item count, and acting result contract unchanged [[compiler-results-3](#compiler-results-3)].
It shall also verify that an explicit return clause in a complete Results description preserves the existing prompt, actor count and guard while retaining the clause [[compiler-results-3](#compiler-results-3)].
This representation check shall not claim to detect a model's omission of a terminal-return requirement.

### compiler-results-6

When the integration suite parses an authored routing-question result through the supplied SLC installation, it shall verify that the annotated `question: <verbatim final text>` field is represented as runtime-supplied whole-final-text metadata when the runtime contract is given an explicit `question` presentation-owned outcome-authority mapping, while the prompt, guard name, and wait semantics remain unchanged, and when it reads the shipped text2gears definition, it shall verify that a delegated player's authored Boss question declares no result beside the framework-owned `needsBossReply` [[compiler-results-5](#compiler-results-5)].
It shall also verify that a separate unannotated typed extracted field remains judge-owned through the explicit semantic outcome-authority mapping, and shall not claim that representation proves automatic inference from annotation, detection of semantic omissions, or model success [[compiler-results-5](#compiler-results-5)].

### compiler-results-10

When the integration suite reads the shipped text2gears definition, it shall verify that its result-contract rules confine output properties to consumed values — a later placeholder, the terminal return, or the declared public interface — and name the verbatim final-text property as the carrier of detail the acting agent reports only in its final text [[compiler-results-9](#compiler-results-9)].

### compiler-results-12

When the integration suite reads the shipped definitions and the maintained CODE and DECIDE GEARS, it shall verify that text2gears states the `latestCommit` exception with gears2fsm's binding, that gears2fsm states the binding, and that each committing result of CODE and DECIDE declares `latestCommit` while the review call relays `<code-commit>` or `<decide-commit>` [[compiler-results-11](#compiler-results-11)].

### compiler-results-14

When the integration suite reads the shipped text2gears definition, it shall verify that it directs an outcome's evidence qualification into the result description and names item prose as text the adjudicator never reads [[compiler-results-13](#compiler-results-13)].

### compiler-results-16

When the integration suite reads the shipped gears2fsm definition and each maintained workflow FSM, it shall verify that the definition requires the accepted-outcome marker on every accepted governed arm and that each maintained FSM with a governed delegated-player state declares the `playbook.acceptedOutcome` action and carries it on its accepted arms, an arm that completes a parallel parent naming the join's target [[compiler-results-15](#compiler-results-15)].

### compiler-results-18

When the integration suite drives a question/reply workflow through the shared factory's closed acting-result contract, it shall verify that the semantic approval remains a guard-only result, a refusal remains distinct, and an added echo field is rejected rather than substituted for the canonical input [[compiler-results-17](#compiler-results-17)].
The suite shall also verify that the shipped text2gears guidance preserves input-owned retention without an echo declaration [[compiler-results-17](#compiler-results-17)]; scripted judgments shall not claim model approval accuracy.
