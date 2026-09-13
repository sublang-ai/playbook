<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

## Optional FSM authoring initializer (unmeasured experiment)

For an LF English GEARS artifact with ordinary Captain/player items and static nested calls, you may initialize a **new** target with the adjacent [scaffold-fsm.mjs](../scaffold-fsm.mjs):

```sh
node <definition-directory>/scaffold-fsm.mjs --source <source> --out <target.fsm.ts>
```

Resolve the helper from the actual definition directory supplied with the phase invocation.
The target must resolve XState with `setup.extend` and `createStateConfig`; otherwise initialization refuses.
It copies exact prompt/result constants and emits an **incomplete** XState setup scaffold.
Script, dynamic-call, parallel, malformed or ambiguous layouts refuse without modifying Source or replacing the target; continue ordinary authoring on refusal.
The output intentionally contains unresolved `__AUTHOR_*` markers, so successful initialization is not successful compilation.

Read the full Source and this phase's normative rules, then complete the target directly:

- Keep acting `GEARS_ITEMS[id].prompt` literal and carry every Source-owned runtime value in typed `invoke.input` fields beside it. Nested constants are templates; compose child text as the nested-call contract requires.
- Exact `GEARS_ITEMS[id].result` values contain only authored outcomes. Apply the existing phase's single-outcome, universal question and controller rules where appropriate. Derive required payloads from Source and actual public child interfaces.
- Replace all type/code markers with the real context, events, inputs, outputs, field relays, assignments, routing, guards, public state metadata, continuation and failure behavior. Rename or remove the example assignment as appropriate.
- Register reusable assignments with `actorSetup.extend({ actions: { name: assign(...) } })` and reference their registered names. Narrow heterogeneous actor output from `unknown`; do not erase actor/event types with casts to reuse a standalone assignment on `onDone`.
- Shared configuration fragments may use `machineSetup.createStateConfig(...)` to preserve their literal transition types.

Emit one self-contained `.fsm.ts`, with no imports from the initializer or auxiliary semantic files.
All ordinary strict, Source, GEARS/FSM and later runtime checks remain authoritative.
No workflow route, child acceptance predicate or default context value is supplied by this helper.
This technique has no accepted performance result yet.
