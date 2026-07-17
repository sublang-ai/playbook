<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# GEARS Optimization Pass

Optional optimization pass of a playbook (a state-machine agent orchestrating other agents).
Rewrites deterministic mechanical behaviors into
[script behaviors](text2gears.md#script-behaviors-optimizer-introduced) so the
compiled playbook performs them directly, without an agent call.

- Source: a package of GEARS spec items produced by [text2gears](text2gears.md).
- Target: the same package with eligible items rewritten as script items.

The pass is format-preserving: source and target are both GEARS packages, and
the pass sits between [text2gears](text2gears.md) and
[gears2fsm](gears2fsm.md) only when the compile requests optimization.
A playbook compiled without this pass has identical observable behavior; the
pass trades a compile-time rewrite for cheaper, deterministic runtime steps.

## Formats

| Role   | Format | Extension |
| ------ | ------ | --------- |
| source | gears  | .md       |
| target | gears  | .md       |

## Eligibility

The pass shall rewrite an item only when **all** of the following hold:

- The item's behavior is mechanical: a fixed shell command performs it
  completely, with no judgment, no natural-language generation, and no
  reading of conversational context.
- The command is static: it needs no `<placeholder>` and no runtime value
  beyond the working directory the runtime executes in.
- No other item's condition or prompt consumes prose this item's acting agent
  would have produced; the item's effect is entirely on the environment
  (files, repository state, directories) plus a success/failure signal.
- The item's outcome contract collapses to a two-way split decidable by the
  command's exit status. An item whose declared `Results:` distinguish more
  than success/failure, or whose outcomes require extracted output fields,
  is ineligible.

The canonical example is environment setup, such as ensuring the working
directory is a version-control repository before committing to it:
`git rev-parse --is-inside-work-tree 2>/dev/null || git init`.

Judgment stays conservative: when eligibility is uncertain, the pass shall
leave the item unchanged rather than guess.
The pass shall not invent items, commands stronger than the item's stated
behavior, or requirements the source does not state.

## Rewriting

For each eligible item, the pass shall:

- Keep the item's ID, heading form, and condition text unchanged.
- Replace the acting clause with the literal script form `Captain shall run:`.
  Like guard names, the script clause is fixed machine syntax and stays in
  this exact English form even when the surrounding item text is in another
  language.
- Replace the blockquoted prompt with the exact POSIX shell script that
  performs the behavior, static text only.
- Emit exactly two `Results:` bullets per
  [text2gears "Script behaviors"](text2gears.md#script-behaviors-optimizer-introduced):
  first the zero-exit guard, then the nonzero-exit guard. When the original
  item declared exactly two guards that align with success and failure, keep
  those guard names in that order; otherwise use `ok` and `failed`.
- Preserve every other item and every non-item section byte-for-byte.

Target shall be written in the same language as Source: rewritten conditions
and result descriptions stay in the source language; only guard names and the
shell script are language-independent.

## Provenance

The pass shall append one `## Optimizations` section at the end of the target
listing every rewritten item, one bullet per item:
`- <ITEM-ID>: <original behavior kind> → script`.
When no item is eligible, the target shall be the source content unchanged,
with no `## Optimizations` section.

## Out of scope

- Rewriting captain, player, or nested-playbook behaviors into one another.
- Reordering, merging, splitting, or deleting items.
- Any change to prompts, conditions, or result contracts of items the pass
  does not rewrite.
