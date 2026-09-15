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

When Source gives a direct-Captain or delegated-player acting result that asks Boss a question and waits for the answer before the same behavior resumes, text2gears shall preserve the authored prompt, guard name, wait, and answer-dependent continuation while declaring the result's `question` output property in the annotated `question: <verbatim final text>` form.
The result name or prose alone shall not satisfy the field declaration, and text2gears shall not emit the framework-owned `needsBossReply` result.

### compiler-results-7

When emitting a result description with an `Output shall include` clause, text2gears shall reserve complete backticked spans after that marker for output-field declarations outside plain-text parentheses, placing explanatory symbols in plain guidance text or inside the declaration's complete annotation rather than in separate backticks within parenthetical guidance, while retaining bare declarations with plain parenthetical guidance and parentheses inside a complete backticked annotation.

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

When the integration suite parses an authored Boss-wait result through the supplied SLC installation, it shall verify that the annotated `question: <verbatim final text>` field is represented as runtime-supplied whole-final-text metadata when the runtime contract is given an explicit `question` presentation-owned outcome-authority mapping, while the prompt, guard name, and wait semantics remain unchanged [[compiler-results-5](#compiler-results-5)].
It shall also verify that a separate unannotated typed extracted field remains judge-owned through the explicit semantic outcome-authority mapping, and shall not claim that representation proves automatic inference from annotation, detection of semantic omissions, or model success [[compiler-results-5](#compiler-results-5)].
