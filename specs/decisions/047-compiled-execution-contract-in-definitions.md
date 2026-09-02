<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-047: Compiled-Execution Contract in the Shipped Definitions

## Status

Accepted

## Context

The four shipped compile definitions under `slc/` are both the normative rules a compiler follows and, for the SubLang Compiler's self-hosting meta pipeline, the Source from which each phase is compiled into a runnable phase bundle.
Because a definition states no acting prompt of its own, the meta compile treats the whole rule text as the implied acting behavior and transcribes it, rule by rule, into the bundle's prompt.
Every definition edit — including a one-paragraph rule hardening — therefore invalidates the bundle and cannot reach compiled runs until the bundle is rebuilt through a nondeterministic agent run and re-reviewed; the transcription itself is a drift surface.
The interpreted execution path already embeds the definition's exact text into its prompt at run time, so run-time relay of the definition is the established, more faithful form.

## Decision

Each phase definition — `text2gears.md`, `gears2fsm.md`, and `link.md` — declares its compiled-execution contract explicitly in one closing `## Compiled execution` section: a single direct-Captain acting prompt that relays the definition's own exact text at run time through a `<definition>` placeholder, together with the `Results:` contract the compiled phase reports (`compiled` and `rejected`, with the Boss-question outcome supplied by the compiler as usual).

- A Source that carries a `## Compiled execution` section is compiled from that section alone: it is the Source's complete behavior, and the remaining definition text is relayed content rather than behavior to transcribe; `text2gears.md` states this rule.
- The phase host supplies the placeholder's value as the exact bytes of the definition file the request names — the same content interpreted execution embeds — through the compiled phase's configured options as the single option `definition`, never through a Boss turn or a judge-copied field.
- A consumer verifying that a bundle preserves the section compares prompt lines after the documented Markdown unescaping, so a Source-escaped `\<definition\>` matches the compiled `<definition>`.
- The transformation rules remain normative in the definition body for both execution paths; nothing about compiling ordinary Sources changes.
- `optimize.md` gains no section: no compiled pass bundle exists.

## Consequences

- A compiled phase bundle becomes a stable control shell whose semantics are the current definition at run time; rule edits reach compiled runs without a rebuild.
- A rebuild is warranted only when the compiled-execution section itself changes, which a consumer can verify deterministically by comparing the section with the bundle's GEARS.
- Consumers adopt this generation of definitions with one final rebuild.
