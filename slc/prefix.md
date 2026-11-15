<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# GEARS Prompt-Prefix Pass

Optional optimization pass of a playbook (a state-machine agent orchestrating
other agents).
Reorders each acting prompt so that its static instructions come first and the
runtime values relayed into it come last, giving every run of the same item an
identical prompt prefix that an LLM provider's prompt cache can serve.

- Source: a package of GEARS spec items produced by [text2gears](text2gears.md)
  and, when scheduled, already rewritten by [optimize](optimize.md).
- Target: the same package with eligible prompts laid out prefix-first.

The pass is format-preserving: source and target are both GEARS packages, and
the pass sits between [text2gears](text2gears.md) and
[gears2fsm](gears2fsm.md), after [optimize](optimize.md) by pass-name order.
A playbook compiled without this pass has identical observable behavior; the
pass trades a compile-time rewrite for cheaper prompt processing at run time.

Prompt caches are prefix caches: a provider serves the longest prefix it has
already seen and processes everything after the first differing token afresh
[[1]], [[2]], [[3]].
A prompt that opens with this run's relayed request therefore shares nothing
with the previous run's prompt for the same item, while one that opens with
the item's instructions shares them all.

## Formats

| Role   | Format | Extension |
| ------ | ------ | --------- |
| source | gears  | .md       |
| target | gears  | .md       |

## Prompt regions

Within an item's blockquote, each prompt line is one of:

- a **relay line** — prompt content that begins with the literal quote marker
  `>` (written `> > …` in the GEARS file), which is how
  [text2gears](text2gears.md#authored-prompt-fragments) relays a runtime value
  such as `> Original request: <caller-input>`;
- a **blank line** — an empty prompt line, written `>`;
- an **instruction line** — any other prompt line.

A **relay block** is a maximal run of consecutive relay lines bounded by blank
lines or the blockquote's edges, whether Source authored it as a separate
quoted relay or set it apart with blank lines inside a fenced instruction.
A relay line adjacent to an instruction line is authored content of that
instruction — a quoted example inside a fenced instruction, for instance — and
belongs to the instruction, not to a relay block.

An instruction line may carry an inline `<placeholder>`, such as a configured
model name; the pass never splits or rewrites an instruction line to isolate
it.

## Eligibility

The pass shall rewrite an item only when **all** of the following hold:

- The item is an acting item with a prompt: a direct-Captain, delegated-role,
  or nested-playbook-call blockquote.
  A script item (`Captain shall run:`) has no prompt and is never rewritten.
- At least one relay block precedes an instruction line.
  An item whose relay blocks already trail every instruction line is already
  prefix-first and stays unchanged.
- No instruction line depends on a relayed value standing before it — one
  that refers to the relayed text as above or preceding, or that continues a
  sentence the relay began.
  A reference to the relayed text as below or following stays true after the
  move.

Judgment stays conservative: when eligibility is uncertain, the pass shall
leave the item unchanged rather than guess.
The pass shall not invent prompt lines, labels, or separators, and shall not
rewrite, merge, split, or drop any line.

Source prose that places a relay after an instruction, or an instruction at
the end of the prompt, tells [text2gears](text2gears.md) how to compose the
prompt faithfully; it does not make the item ineligible.
This pass overrides that composition order by design, and `--no-optimize`
restores it.

## Rewriting

For each eligible item, the pass shall rewrite only the blockquote:

- Emit every line that is not part of a relay block, in its original order,
  keeping each line byte-for-byte, dropping leading and trailing blank lines,
  and replacing each run of removed relay blocks together with the blank lines
  bounding it by the first of those blank lines where it separated two
  remaining lines; every other blank line, such as one inside a fenced
  template, stays where it is.
- Emit one blank line.
- Emit the relay blocks in their original order, each byte-for-byte, with one
  blank line between consecutive blocks.
- Keep the item's ID, heading, condition, acting clause, `Results:`, and any
  other metadata unchanged.
- Preserve every other item — action, requirement, and test items alike —
  and every section heading byte-for-byte, except a legacy
  `## Prefixed prompts` section (see [Provenance](#provenance)).

Because no line changes, the target stays in the Source language and every
authored fragment remains intact; only the order of relay blocks relative to
instructions changes.

E.g., the source item

```markdown
### review-2

When Reviewer raises or keeps any finding, Captain shall relay the caller input and Reviewer's findings to Coder with the disposition prompt:

> > Original request: <caller-input>
> > Reviewer findings: <reviewer-output>
>
> For each review item, accept or reject it.
> Report every disposition, all relevant run results, and every rebuttal.

Results:
- `committed`: Coder accepted at least one item and added one new review-fix commit. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.
- `rejectedAll`: Coder rejected every item and made no commit. Output shall include `coderOutput: <verbatim final text>`.
```

becomes

```markdown
### review-2

When Reviewer raises or keeps any finding, Captain shall relay the caller input and Reviewer's findings to Coder with the disposition prompt:

> For each review item, accept or reject it.
> Report every disposition, all relevant run results, and every rebuttal.
>
> > Original request: <caller-input>
> > Reviewer findings: <reviewer-output>

Results:
- `committed`: Coder accepted at least one item and added one new review-fix commit. Output shall include `coderOutput: <verbatim final text>` and `latestCommit: <commit identity>`.
- `rejectedAll`: Coder rejected every item and made no commit. Output shall include `coderOutput: <verbatim final text>`.
```

## Provenance

The pass shall record nothing beside the rewritten prompts, whose layout
shows the rewrite.
A `## Prefixed prompts` section an earlier version of this pass appended shall
be removed — up to the next heading, and at the end of the file with the blank
lines before it; when no item is eligible and no such section is present, the
target shall be the source content unchanged.
Re-running the pass is a no-op by layout: an item whose relays already trail
is not eligible.

A Source-to-GEARS fidelity checker therefore reads the layout from each prompt:
it accepts an item either in Source order throughout or in the prefix-first
layout, which requires each instruction and relay block of the fragments the
item carries intact, blank lines inside a block included, and used exactly
once, the instruction blocks in Source order, the relay blocks in Source order,
and every relay after the last instruction, a relay Source joined directly to
an instruction staying beside it with its authored boundary, a bare relay the
prose authored free to trail, and one occurrence standing for one authored
fragment.

## Deterministic rewriting

The adjacent `prefix-prompts.mjs` tool performs this rewrite exactly:

```sh
node "<definition-directory>/prefix-prompts.mjs" --source "<source.gears.md>" --target "<target.gears.md>" [--keep <ITEM-ID>]...
```

It reads the source, rewrites every item eligible by the mechanical rules
above, removes a legacy `## Prefixed prompts` section, writes the target, and
prints the rewritten item IDs — or reports that no item was eligible.
`--keep` excludes an item the tool would otherwise rewrite.

The pass shall use the tool rather than rewrite by hand:

1. Read the source and decide, for each item with a relay block preceding an
   instruction line, whether an instruction depends on a relay standing before
   it; that judgment is the pass's only non-mechanical step.
2. Run the tool with `--keep` for each item so excluded.
3. Read the target and confirm that every rewritten item's instructions and
   relays are intact and that nothing changed beyond the rewritten items and
   the removal of a legacy `## Prefixed prompts` section.

The tool writes only the declared target and never modifies the source.

## Out of scope

- Any change to prompt wording, conditions, result contracts, or item order.
- Rewriting behaviors into one another; that is the [optimize](optimize.md)
  pass.
- Where a transport sends a prompt as one content block, the provider's cache
  boundary is the transport's concern; this pass only makes the shared prefix
  exist.

## References

[1]: https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching "Anthropic — Prompt caching: place static content at the beginning of the prompt"
[2]: https://developers.openai.com/api/docs/guides/prompt-caching "OpenAI — Prompt caching: put stable instructions first, dynamic content at the end"
[3]: https://ai.google.dev/gemini-api/docs/caching "Google — Gemini context caching: put large and common contents at the beginning of the prompt"
