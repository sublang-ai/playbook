<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-108: Compiled GEARS Is a Spec Package the Machine Cites

## Status

Accepted (2026-11-14).
Amends [DR-018](018-gears-grammar-provenance-from-spex.md) in one scope: compiled GEARS follow the cited definition's package form, not only its statement pattern.
Amends [DR-016](016-script-actors-and-optimize-pass.md), [DR-050](050-pull-request-delivery.md) and [DR-065](065-prompt-prefix-pass.md) in one scope: the optimize pass appends no `## Optimizations` section, and nothing requires or preserves one.
Amends [DR-068](068-labelled-section-placeholders.md) and [DR-082](082-retain-input-owned-boss-replies.md) in one scope: the defining sentence of a derived placeholder and the retention of an input-owned Boss reply are requirement items, not package introduction or item prose.
Amends [DR-102](102-code-reviews-the-intent-once.md)'s consequence that CODE's GEARS carry three items: they carry three action items.
Leaves [DR-039](039-cohesive-concern-spec-item-boundary.md) as it is: that record governs this repository's own `specs/`, not compiler output.

## Context

- A compiled `<name>.gears.md` is what a person reads to confirm what a workflow will do; it is also the input from which the state machine is built.
- The text2gears definition shaped it for the second use alone: one item per machine state, carrying that state's prompt, its result contract, and every invariant, continuation and terminal return as prose before the statement, after the blockquote, or inside result bullets.
- Read against the GEARS definition the compiler cites [[1]], the eight reference files broke its package rules throughout: several requirements per item, about eighty requirement sentences without `shall`, no `While`, invariants chained as `where` clauses, up to sixty percent of lines repeated within a file, no citations, uppercase IDs, none of the package sections.
- The dependency ran the wrong way: the shape of the requirements followed the shape of the machine, so a requirement could not be restated, split or cited without touching the item-to-state mapping, and two references hand-edited on 2026-11-08 left the compiler's grammar unnoticed.
- The mechanical binding is narrow: the compiler's conformance check binds an action item's acting clause, prompt and `Results:`, and its ID where a state cites one, to one state, and reads no requirement prose.
- The maintained machines are verified and are not to be recompiled for a change of form.
- Considered and declined:
  - recording that compiled GEARS is a compiler dialect exempt from the package rules: it keeps the file unreviewable;
  - one item per requirement with no action items, the machine reading prompts from a generated text module: it changes every machine;
  - a routing list per item checked against the machine's transitions: it states routing twice and still checks neither conditions nor bounds;
  - links from one playbook's package into another's: a package compiles without its peers' packages, and the interface of a call is already bound where the machine is built, by the workflow-contracts catalog for a builtin;
  - renaming `sourceItem` in the maintained machines to the lowercase IDs: it edits verified artifacts and the records of parked sessions for no behavior;
  - restating a called playbook's success contract in its caller, read from the workflow-contracts catalog: it repeats what the called playbook's own package states, goes stale when that contract changes, and names the builtin's contract for a call a Source or dependency binding gives another target; [DR-048](048-typed-terminal-outcomes.md) already takes a child's success from the outcome the child declares and has a caller enforce only what its own Source states.

## Decision

### 1. The package is for review; the machine implements and cites it

A compiled GEARS file shall be a spec package in the form of [[1]], with the one departure §2 states for peer playbooks: a person reviews and confirms it, the state machine implements it and cites it, and the package names no state, transition, guard, or other machine part.

### 2. Form

- Sections `Intent`, `External Behavior`, `Internal Behavior`, `Verification`, in that order and no other; `Roles:` stands under `Intent`.
- Item headings are lowercase `<pack>-<N>`; `<pack>` is derived from the Source's basename — ASCII letters lowercased, every other run of characters but digits made one hyphen, `pack` put first where nothing or a digit would lead — so a dotted or non-ASCII Source name such as `workflow.zh` yields a valid identifier, and no artifact name, playbook id or registry entry changes.
- Recompiling over a prior package keeps an item's number where its prior ID is `<pack>-<N>` in any letter case; an item with another prior prefix, or a number already held, takes the lowest unused number, so no legacy ID survives in another form and no two items share a heading; a machine built earlier keeps resolving an ID that changed only in case and is rebuilt when an ID a state cites changes otherwise, which conformance reports; an item no state cites, a requirement or test item or a call whose state carries no citation, leaves nothing in the machine to repair.
- IDs released before this record change once, the one exception this record makes to the permanence of a released ID; the IDs of this form are permanent. Every ID changes in letter case, which leaves its anchor as it was; an ID whose prefix is not the package identifier also changes in prefix and may change in number — the released `WORKFLOW-1` to `WORKFLOW-7` of `workflow.zh` become `workflow-zh-1` to `workflow-zh-7` — so a link to that earlier anchor breaks.
- Every item is exactly one GEARS statement followed only by the attachments its colon introduces.
- Three item kinds:

| Kind | Statement | Attachments | Machine |
| --- | --- | --- | --- |
| Action | `Captain shall` with one of the fixed acting clauses | the prompt blockquote, then `Results:` | implemented by exactly one state |
| Requirement | any other subject | optional plain list or table | implemented, never cited |
| Test | any other subject, under `Verification` | optional plain list or table | none |

- `Captain shall` appears only in an action item's statement, so an item's kind is read from its statement, and an action that lost its prompt is not mistaken for a requirement.
- Every invariant, terminal return, bound, child-return rule and Boss-answer resumption is a requirement item, stated once; an action item carries nothing but its statement, its prompt and its result contract.
- Reliance of one item on another is an inline citation within the package.
- Departure from [[1]]: a peer playbook is named by its backticked id, not bound by a citation of its External Behavior, because a package compiles without its peers' packages and cannot know their item IDs; the relying item states what it takes from that playbook's result, and where the Source requires that playbook's result to prove its success, states anything else the caller requires of the result, or has the caller take a value from it, one requirement item states what the caller requires of the result and the items that speak of that success cite it: the playbook succeeds when it returns a result it declares successful itself, whichever playbook the call is bound to, the result carries each value the caller takes, and the item restates nothing else of the called playbook's result contract; where the Source does none of these, the items say only that the playbook succeeds.
- A package names what its workflow operates on as its Source does — the `code` package names the intent records Coder creates and works through — because that is the workflow's behavior; the compiler adds no reference to a particular intent record of its own, and keeps a record identifier the Source supplies, such as a decision an authored prompt names, as written, in a prompt or in a requirement alike: a record the Source names is what the workflow acts on, so dropping it would change the workflow, and the rule against naming an intent record concerns the records of a package's own specs tree, of which a compiled package has none.
- Test items cite every action and requirement item and describe flows a run shows from outside.
- A test item maps its scenario as Given-When-Then — what has already happened is `While` or `Where`, the one event under test is `When` — and its assertions cite the action that delivers a prompt instead of restating the prompt.

### 3. What the package keeps from the machine side

- A prompt and a `Results:` block are payloads delivered to the acting agent and the adjudicator; each action item carries them whole, so prompt lines repeat across actions and follow the Source's line structure.
- An outcome's evidence qualification stays in its result description, the only text the adjudicator reads, and is also stated once as a requirement item.
- The file keeps its name `<name>.gears.md`.
- A transformation-spec Source, such as a compiler phase definition, keeps its Captain-acting items alone.

### 4. Binding

- A state cites its action item through `sourceItem`, which a nested-call state may omit, being matched by its target and input text; the citation matches the item ID without regard to ASCII letter case, so a machine compiled before this record keeps its uppercase citations.
- A requirement item maps to no state; the compiler realizes it in transitions, guards, context, final states and outputs.
- A test item adds no behavior.

### 5. Migration without recompiling

The eight reference GEARS are rewritten in place: each action item keeps its number, acting clause, prompt and `Results:` byte for byte, and no machine file changes.
Two defects of the 2026-11-08 edit are repaired on the way: CODE-3's acting clause returns to the exact nested-call form, and the sentence after the `Results:` of REVIEW-3 and REVIEW-4 becomes a requirement item.

### 6. No `## Optimizations` section

A script item is its own provenance, because text2gears never emits one; the optimize pass appends nothing, and the PR reference carries no such section.

## Consequences

- A reference GEARS file grows, since requirements that were clauses and prose are now items and the package gains test items.
- Conformance between a package and its machine says nothing about whether the machine meets a requirement item; scenario tests on the machine are what show a requirement is met, and the test items state which flows those are.
- Test items are reviewed text: no phase generates a test from them yet.
- No citation breaks in a caller when a child's external behavior changes: the interface a call is bound to is checked where the machine is built, and the caller's own statement of what it relies on is what a reviewer compares.
- The definitions change, so the compiler's pins regenerate when it adopts this release; its compiled phase bundles are retained, because each definition's `## Compiled execution` section is unchanged.
- The prefix tool prints and accepts the lowercase IDs of the packages it rewrites.
- The experiment builders and their environment-gated tests, which compare against earlier definition text, describe the definitions as they were.

## References

[1]: https://sublang.ai/ref/gears-ai-ready-spec-syntax "GEARS: AI-Ready Spec Syntax"
