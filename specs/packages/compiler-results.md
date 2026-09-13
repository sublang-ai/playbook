<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-results: GEARS Result Block Placement

## Intent

This package specifies the text-to-GEARS producer's existing result-block boundary without changing authored prompts, outcomes, or nested-call continuation.
Clearer producer guidance is retained after a matched phase comparison; it does not alter the result contract or guarantee a compilation-time reduction.

## External Behavior

### compiler-results-1

When emitting an acting item's `Results:` contract, text2gears shall place the label immediately after the complete acting blockquote, emit only result bullets and blank lines until the next item or section heading, and place other item conditions or invariants before that blockquote rather than between the blockquote and label or after its result bullets.
Nested-playbook items shall remain without `Results:` and retain their child-continuation prose after the blockquote.

## Verification

### compiler-results-2

When the integration suite checks candidate GEARS through the supplied SLC installation's actual result-contract parser, it shall verify these cases while preserving the same acting prompt and declared outcomes [[compiler-results-1](#compiler-results-1)]:

| Prose placement | Expected result |
| --- | --- |
| Item invariant before the acting blockquote | Accepted. |
| Item invariant between the acting blockquote and `Results:` | Rejected as misplaced results. |
| Item invariant after the result bullets, before the next heading | Rejected as a malformed result entry. |
| Child-continuation prose after a nested-call blockquote without `Results:` | Accepted. |
