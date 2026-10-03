<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-082: Retain Input-Owned Boss Replies

## Status

Accepted (2026-10-03).
Clarifies the input-owned retention boundary under [DR-005](005-boss-reply-suspension-path.md) and [DR-066](066-compiled-builtins-keep-their-public-interface.md), without changing the runtime contract.

## Context

A generated scope-approval workflow required the adjudicator to echo the complete Boss reply as an output property, then compared that echo with the canonical input.
The actual affirmative reply retained its trailing LF, while the accepted semantic output dropped that LF, so the workflow failed after a valid planning commit and before design.
Source required preservation of the received answer; it did not assign production of that input to the acting agent or adjudicator.

## Decision

GEARS preserves input-owned retention in non-acting prose and the semantic acceptance condition in the acting result contract, without an extracted echo field.
At that accepted boundary the generated FSM verifies current question authority, retains the exact canonical reply before clearing Q/A, and relays it where Source requires it.
Semantic approval is still judged; deterministic input retention does not infer approval from nonempty text.
An undeclared echo remains malformed under the unchanged closed result contract.

## Consequences

The compiler definitions guide new artifacts without repairing existing generated bundles automatically.
An affected bundle requires a separately verified recovery or regeneration; its old failed session remains evidence.
Model-free shared-factory fixtures prove byte preservation and fail-closed routing, not future compiler conformance or model approval accuracy.
