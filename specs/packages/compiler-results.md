<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-results: GEARS Result Preservation

## Intent

This package specifies the text-to-GEARS producer's existing acting-result boundary and preservation of source-authored terminal returns without changing prompts, outcomes, or nested-call continuation.
The Results-boundary guidance is retained after a matched phase comparison; it does not alter the result contract or guarantee a compilation-time reduction.

## External Behavior

### compiler-results-1

When emitting an acting item's `Results:` contract, text2gears shall place the label immediately after the complete acting blockquote, emit only result bullets and blank lines until the next item or section heading, and place other item conditions or invariants before that blockquote rather than between the blockquote and label or after its result bullets.
Nested-playbook items shall remain without `Results:` and retain their child-continuation prose after the blockquote.

### compiler-results-3

When Source requires a terminal return to its caller, text2gears shall preserve every returned value or fact and its return condition as an explicit workflow output obligation in GEARS; merely naming a value in a completion predicate or acting result shall not substitute for that obligation.
The terminal-return requirement shall remain non-acting prose outside prompt blockquotes, before the acting blockquote or in existing nested-call continuation, without a new Captain action solely to restate it.

## Verification

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
This representation check shall not claim to detect a model's omission of a terminal-return requirement.
