<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-104: Compiled GEARS Is a Spec Package the Machine Cites

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
- The mechanical binding is narrow: the compiler's conformance check compares an item's ID, acting clause, prompt and `Results:` with one state, and reads nothing else in the file.
- The maintained machines are verified and are not to be recompiled for a change of form.
- Considered and declined:
  - recording that compiled GEARS is a compiler dialect exempt from the package rules: it keeps the file unreviewable;
  - one item per requirement with no action items, the machine reading prompts from a generated text module: it changes every machine;
  - a routing list per item checked against the machine's transitions: it states routing twice and still checks neither conditions nor bounds;
  - links from one playbook's package into another's: a package compiles without its peers' packages, and the workflow-contracts catalog already binds the interface by id;
  - renaming `sourceItem` in the maintained machines to the lowercase IDs: it edits verified artifacts and the records of parked sessions for no behavior.

## Decision

### 1. The package is for review; the machine implements and cites it

A compiled GEARS file shall be a spec package in the form of [[1]], with the one departure §2 states for peer playbooks: a person reviews and confirms it, the state machine implements it and cites it, and the package names no state, transition, guard, or other machine part.

### 2. Form

- Sections `Intent`, `External Behavior`, `Internal Behavior`, `Verification`, in that order and no other; `Roles:` stands under `Intent`.
- Item headings are lowercase `<pack>-<N>`; `<pack>` is derived from the Source's basename — ASCII letters lowercased, every other run of characters but digits made one hyphen, `pack` put first where nothing or a digit would lead — so a dotted or non-ASCII Source name such as `workflow.zh` yields a valid identifier, and no artifact name, playbook id or registry entry changes.
- Every item is exactly one GEARS statement followed only by the attachments its colon introduces.
- Three item kinds:

| Kind | Statement | Attachments | Machine |
| --- | --- | --- | --- |
| Action | `Captain shall` with one of the fixed acting clauses | the prompt blockquote, then `Results:` | cited by exactly one state |
| Requirement | any other subject | optional plain list or table | implemented, never cited |
| Test | any other subject, under `Verification` | optional plain list or table | none |

- `Captain shall` appears only in an action item's statement, so an item's kind is read from its statement, and an action that lost its prompt is not mistaken for a requirement.
- Every invariant, terminal return, bound, child-return rule and Boss-answer resumption is a requirement item, stated once; an action item carries nothing but its statement, its prompt and its result contract.
- Reliance of one item on another is an inline citation within the package.
- Departure from [[1]]: a peer playbook is named by its backticked id, not bound by a citation of its External Behavior, because a package compiles without its peers' packages and cannot know their item IDs; the relying item states in its own statement the behavior it relies on.
- A package names what its workflow operates on as its Source does — the `code` package names the intent records Coder creates and works through — because that is the workflow's behavior; it cites or names no particular record of any specs tree.
- Test items cite every action and requirement item and describe flows a run shows from outside.
- A test item maps its scenario as Given-When-Then — what has already happened is `While` or `Where`, the one event under test is `When` — and its assertions cite the action that delivers a prompt instead of restating the prompt.

### 3. What the package keeps from the machine side

- A prompt and a `Results:` block are payloads delivered to the acting agent and the adjudicator; each action item carries them whole, so prompt lines repeat across actions and follow the Source's line structure.
- An outcome's evidence qualification stays in its result description, the only text the adjudicator reads, and is also stated once as a requirement item.
- The file keeps its name `<name>.gears.md`.
- A transformation-spec Source, such as a compiler phase definition, keeps its Captain-acting items alone.

### 4. Binding

- A state cites its action item through `sourceItem`; the citation matches the item ID without regard to ASCII letter case, so a machine compiled before this record keeps its uppercase citations.
- A requirement item maps to no state; the compiler realizes it in transitions, guards, context, final states and outputs.
- A test item adds no behavior.

### 5. Migration without recompiling

The eight reference GEARS are rewritten in place: each action item keeps its number, acting clause, prompt and `Results:` byte for byte, and no machine file changes.
Two defects of the 2026-11-08 edit are repaired on the way: CODE-3's acting clause returns to the exact nested-call form, and the sentence after the `Results:` of REVIEW-3 and REVIEW-4 becomes a requirement item.

### 6. No `## Optimizations` section

A script item is its own provenance, because text2gears never emits one; the optimize pass appends nothing, and the PR reference carries no such section.

## Consequences

- A reference GEARS file grows, since requirements that were clauses and prose are now items and the package gains test items.
- Conformance between a package and its machine says nothing about requirement items; scenario tests on the machine are what show a requirement is met, and the test items state which flows those are.
- Test items are reviewed text: no phase generates a test from them yet.
- No citation breaks in a caller when a child's external behavior changes: the workflow-contracts catalog checks the interface, and the caller's own statement of what it relies on is what a reviewer compares.
- The definitions change, so the compiler's pins regenerate when it adopts this release; its compiled phase bundles are retained, because each definition's `## Compiled execution` section is unchanged.
- The prefix tool prints and accepts the lowercase IDs of the packages it rewrites.
- The experiment builders and their environment-gated tests, which compare against earlier definition text, describe the definitions as they were.

## References

[1]: https://sublang.ai/ref/gears-ai-ready-spec-syntax "GEARS: AI-Ready Spec Syntax"
