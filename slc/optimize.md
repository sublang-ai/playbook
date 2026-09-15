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
- The command is static apart from naming its target: it needs no runtime
  value beyond the working directory the runtime executes in, except a
  `<placeholder>` the source already established for a target the command
  cannot otherwise identify, which binds as a shell literal
  ([text2gears "Script behaviors"](text2gears.md#script-behaviors-optimizer-introduced)).
- No other item's condition or prompt consumes prose this item's acting agent
  would have produced; the item's effect is entirely on the environment
  (files, repository state, directories) plus a success/failure signal.
- The item's outcome contract collapses to a two-way split decidable by the
  command's exit status. An item whose declared `Results:` distinguish more
  than success/failure, or whose outcomes require extracted output fields,
  is ineligible.

The command shall preserve the exact environmental predicate and effect of
the source behavior, including its location and scope; a weaker success
condition or an operation on a different resource is not an optimization.

For example, these repository requirements have different predicates.
When the source only requires being inside a Git working tree, an ancestor
repository may satisfy it:

Captain shall run:

> test "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true || git init

Results:

- `ok`: The command exits zero.
- `failed`: The command exits nonzero.

When the source requires the current directory to be the root of its own Git
repository and says to initialize there if `.git` is absent, membership in an
ancestor repository does not satisfy it:

Captain shall run:

> if [ ! -e .git ]; then git init || exit; fi
> test "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)"

Results:

- `ok`: The command exits zero.
- `failed`: The command exits nonzero.

The `.git` existence check accepts a linked worktree's `.git` file as well as
a repository's `.git` directory; the final check verifies the required root.
Neither example authorizes adding repository setup where the source does not
require it, and the linker shall not have to repair a weakened optimized
behavior later.

Judgment stays conservative: when eligibility is uncertain, the pass shall
leave the item unchanged rather than guess.
The pass shall not invent items, commands stronger than the item's stated
behavior, or requirements the source does not state.

## Rewriting

For each eligible item, the pass shall:

- Keep the item's ID, heading form, and condition text unchanged.
- Replace the acting clause with the literal script form `Captain shall run:`.
  Like guard names, the script clause is fixed machine syntax [[1]] and
  stays in this exact English form even when the surrounding item text is
  in another language.
- Replace the blockquoted prompt with the exact POSIX shell script that
  performs the behavior: static text, apart from the eligible target
  `<placeholder>`, written as a single-quoted shell word
  ([text2gears "Script behaviors"](text2gears.md#script-behaviors-optimizer-introduced)),
  retaining a `>` blockquote on every script line; a fenced code block is not
  a GEARS acting body.
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

## References

[1]: GEARS definition shipped by the installed `@sublang/spex` package: `@sublang/spex/scaffold/specs/meta.md` (English) and `@sublang/spex/scaffold/i18n/zh/specs/meta.md` (Chinese); canonical renditions [GEARS: AI-Ready Spec Syntax](https://sublang.ai/ref/gears-ai-ready-spec-syntax) (en) and [GEARS：面向 AI 的规约语法](https://sublang.ai/zh/ref/gears-ai-ready-spec-syntax) (zh)
