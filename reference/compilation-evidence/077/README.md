<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Attachment and Inspect compilation evidence

These are the complete fresh SLC source, GEARS, FSM, linked module, and compiler-emitted verification bundles for DR-077. The manifest records their SHA-256 identities and the actual compiler and link target. They are repository evidence, not packed runtime modules.

Compilation used the configured Claude agent with explicit human approval. The initial full invocations accepted source-to-GEARS, optimization, and prefix phases. Captain's first FSM phase stopped on the configured inactivity timeout; an explicit gears2fsm phase then succeeded. Inspect's initial FSM phase produced the retained FSM but failed its TypeScript environment check because the isolated compile tree lacked xstate. After connecting the existing dependency tree, the unmodified FSM passed the compiler's TypeScript, GEARS conformance, continuation, and coverage checks. No failed invocation is represented as accepted.

Both retained FSMs then passed ordinary explicit SLC link phases. The compiler's own deterministic emission functions generated all four verification kinds, with no emission diagnostics; each complete fresh bundle passed eight tests. The original whole-pipeline attempts were not rerun or claimed successful.

The maintained Captain reconciles only the authored attachment prompt and optional result/type additions into its released topology and bridge. It is not a verbatim copy of this fresh Captain. Its own conformance suite and an authentic 17.3.0 persisted snapshot prove compatibility. Inspect adopts its complete generated workflow, with only local TypeScript import specifiers mechanically changed from `.ts` to `.js` for the package's NodeNext build. Its registry is the ordinary host-authored configuration wrapper.
