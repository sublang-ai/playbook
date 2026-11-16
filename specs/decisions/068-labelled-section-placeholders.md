<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-068: Placeholders Derived from a Labelled Section

## Status

Accepted (2026-09-25).
Amended by [DR-108](108-compiled-gears-is-a-spec-package.md) in one scope: the derived placeholder's defining sentence is a requirement item keeping the Source's defining words, not package introduction or item prose.

## Context

- A nested playbook's caller composes the child's input as labelled quoted lines: CODE and DECIDE give REVIEW `> Original intent: …`, `> Review scope: …`, and `> Coder output: …`, DECIDE also gives it `> Coder's independent proposal: …`, and each line carries the literal `>` of its quoted relay.
- REVIEW relays that whole request to Reviewer and Coder in every round, so each later prompt repeats the review scope and first-round context that its conversation already holds.
  A REVIEW Source that defines the original intent as the `Original intent:` section of the caller's request, running to the `Review scope:` line or to the end of the request, or as the whole request where that label is absent, could relay only that section to a conversation that already holds the request.
- The definitions give such a placeholder no path: [text2gears](../../slc/text2gears.md) requires a producer for every consumed placeholder, and [gears2fsm](../../slc/gears2fsm.md) binds each placeholder to a value the machine receives — from its caller, its host, a player's result, or the invocation's identity — and to none it computes.
  A compile would stop with a question, invent a judge-authored field, or improvise a parse.

## Decision

- A Source may define a placeholder as a labelled section of another relayed text, naming the label that opens the section and the labels that end it.
  `text2gears` keeps the defining sentence verbatim — in the package introduction, or in the item's prose where the Source states it — names the placeholder as the Source does, and declares no result property for it: the value is derived, not produced.
- `gears2fsm` binds the placeholder to a typed context field that the compiled FSM derives deterministically in the entry action or transition that stores the text, and again wherever that text is replaced:
  - the text as read is the text itself, except that where every non-blank line begins with `>`, each line is read without that marker and one optional space, the quote layer the caller's relay adds;
  - the section is the lines of the text as read from the first line that begins with the opening label, the label removed, through the line before the first later line that begins with an ending label, or through the last line, trimmed; a line that merely looks labelled, such as `Note:`, stays in it;
  - where no line begins with the opening label, or the section is empty once trimmed — its label directly followed by an ending label or by the end of the text — the field is the whole text as read, trimmed, so a request is never lost.
- The derived field is ordinary context that actor inputs relay; no player or judge authors it.
  The derivation lives in each compiled FSM; the runtime gains no helper.

## Consequences

- A child reads the labelled lines its caller writes, so a prompt to a conversation that already holds the request can relay one section instead of the whole request; the unlabelled request of a Boss or a dynamic call remains the original intent as a whole.
- A relayed section is safe only where the conversation holds the whole text: a later call may start a fresh conversation after a missing or rejected provider hint [[session-storage-8](../packages/session-storage.md#session-storage-8)], and a portable checkpoint carries no provider tokens at all, so trimming by round would leave such a conversation without the scope and context it never saw.
  A compact relay therefore needs a paired full form for fresh conversations, as a Boss-reply continuation carries its full prompt as `freshPrompt` [[playbook-runtime-92](../packages/playbook-runtime.md#playbook-runtime-92)]; no definition compiles that pairing yet, so the maintained REVIEW relays the complete request in every prompt and no maintained Source uses this derivation.
- The field is exact and repeatable: a fresh directive derives it again from the new text, restoration brings back the stored field rather than deriving it again, and no model call can drift it.
- Only the labels the Source names bound a section, so a multi-line original intent keeps its own `Note:` or `Constraints:` lines, and an empty section falls back to the whole request rather than relaying an empty intent.
