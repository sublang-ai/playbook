<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-065: The Prompt-Prefix Pass

## Status

Accepted.
Amended by [DR-108](108-compiled-gears-is-a-spec-package.md) in one scope: the pass preserves every other item and every section heading, and no `## Optimizations` section exists to leave untouched.

## Context

Every acting prompt a compiled playbook sends is one string composed from the item's authored instructions and the runtime values relayed into it as quoted lines.
The maintained sources put the relayed values first — the caller's request, then the instruction that acts on it — because that is how a person writes a delegation, and [DR-029 in slc](https://github.com/sublang-ai/slc/blob/main/specs/decisions/029-source-fidelity-gate.md) [[1]] and [[playbook-1](../packages/playbook.md#playbook-1)] rightly forbid `text2gears` from regrouping authored fragments.

LLM providers cache prompts by prefix: OpenAI, Anthropic, and Google each serve the longest already-seen prefix and process the rest afresh, and each documents the same rule — static instructions first, variable content last [[2]], [[3]], [[4]].
A prompt that opens with this run's request shares no prefix with the previous run's prompt for the same item, so the shared instructions — often the larger part — are processed on every fresh call.

slc's pass architecture ([slc DR-013](https://github.com/sublang-ai/slc/blob/main/specs/decisions/013-normalize-and-pass-phases.md) [[5]]) already places format-preserving, Playbook-owned definitions between `text2gears` and `gears2fsm`, after the Source-fidelity gate has accepted the raw GEARS; `optimize.md` ([DR-016](016-script-actors-and-optimize-pass.md)) is the first such pass.
A second pass is the natural home for the reorder: the compiled artifact shows the prompt a player actually receives, `gears2fsm` and the emitted suites already hold the FSM to the canonical GEARS, and the runtime composer needs no change.

## Decision

### 1. A second pass: `slc/prefix.md`

- The definition rewrites each eligible acting prompt so that every standalone relay block — a maximal run of quoted relay lines bounded by blank lines, whether Source authored it as a separate quoted relay or set it apart inside a fenced instruction — follows the last instruction line, keeping each line byte-for-byte except the blank lines bounding a moved block, which collapse to one, the instruction lines in their order, and the relay blocks in theirs.
  A GEARS file cannot tell those two authored forms apart, so the unit the pass moves and the unit the checker accepts are defined identically over blank-bounded quoted runs.
- Eligibility is conservative: script items, items whose relays already trail, and items where an instruction depends on a relay standing before it are left unchanged; the pass invents no line, label, or separator.
- Source prose that orders a prompt's composition — a relay "after the instruction", an instruction "at the end of the prompt" — binds `text2gears`, not this pass: the pass overrides that order by design, and `--no-optimize` restores it.
- The layout is its own provenance: a GEARS blockquote is the composed prompt verbatim, so a list of rewritten items would only repeat what each prompt shows, and the pass records nothing beside the rewritten prompts.
  It removes a `## Prefixed prompts` section an earlier revision of the pass appended, and re-running it is a no-op because an item whose relays already trail is not eligible.
- The pass name sorts after `optimize`, so a default compile runs `text2gears → optimize → prefix → gears2fsm`, and the pass leaves an `## Optimizations` section untouched.
- The definition ships beside the other definitions through `./slc/*`, compilable by `slc slc` like any phase, with no `## Compiled execution` section and no compiled bundle, as for `optimize.md` ([DR-047](047-compiled-execution-contract-in-definitions.md)).

### 2. A deterministic tool: `slc/prefix-prompts.mjs`

- The rewrite is mechanical, so the definition directs the pass to the adjacent tool, which performs it exactly and prints the rewritten item IDs; the pass's only judgment is which items to exclude with `--keep`.
- The tool is the definition's realization, not a second contract: the definition remains normative, and the tool is a declared local semantic input of the pass.

### 3. Fidelity checking reads the layout from each prompt

- The Source-to-GEARS checker accepts every item either in Source order, which every authored fragment occurrence it carries must keep, or in the prefix-first layout: instruction units in Source order, relay units in Source order, and every relay after the last instruction, with every unit the item carries intact and used once.
  A script item, which the pass never rewrites, is held to Source order.
- Conservation stays counted by fragment text across the package: each item supplies the fragments of one layout it is accepted in, so one occurrence never stands for two authored fragments.
- slc keeps its own copy of the checker and also runs it over the installed maintained bundles, so that copy carries the same acceptance rule, rule for rule.

## Consequences

- A fresh player call for the same item shares its whole instruction block with every earlier call as a prompt prefix; a provider that matches token prefixes serves it from cache.
  The gain lands on fresh calls: a resumed call already shares its conversation as a prefix, and a runtime-appended block such as the pre-existing-changes list ([DR-062](062-pre-existing-changes-are-context.md)) follows the body and changes nothing before it.
- Where a transport sends the composed prompt as one content block whose boundary is the only cache checkpoint, the prefix exists but is not yet cached; splitting the static region from the trailing relay region at the blank line between them is that transport's follow-up, which this layout makes deterministic.
- The maintained artifacts take the new layout when they are recompiled; their GEARS carry no provenance section, and their conformance suites assert the layout itself.
  A `## Prefixed prompts` section left in an artifact compiled by the earlier revision is ignored by both checkers and removed by the next pass run.
- The slc gate checks raw `text2gears` output before any pass runs, so it now also accepts a raw prefix-first layout; that layout conserves the Source by construction and leaves the pass nothing to do, so nothing is lost, and `text2gears.md` still directs Source order.
- slc adopts the pass with the next Playbook release like any definition: its vendored set, definition gate, and semantic-input sidecar gain `prefix.md` and `prefix-prompts.mjs`, and no host code changes.

## References

[1]: https://github.com/sublang-ai/slc/blob/main/specs/decisions/029-source-fidelity-gate.md "slc DR-029 — Source-fidelity gate"
[2]: https://developers.openai.com/api/docs/guides/prompt-caching "OpenAI — Prompt caching"
[3]: https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching "Anthropic — Prompt caching"
[4]: https://ai.google.dev/gemini-api/docs/caching "Google — Gemini context caching"
[5]: https://github.com/sublang-ai/slc/blob/main/specs/decisions/013-normalize-and-pass-phases.md "slc DR-013 — Generic input normalization and optimization pass phases"
