<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-019: Shared Linked-Runtime Factory

## Status

Accepted.

## Context

- Every linked `<name>.playbook.ts` artifact regenerated the full FSM-interpreter machinery.
  The newest linker output (the slc demo workflow runtime) measures ~1664 lines, of which only ~16 are workflow-specific — the FSM import, an options interface and validator, and the factory instantiation with a few strings.
  The other ~1600 lines are generic: actor wiring, port boundary tracing, `sh -c` script execution, Boss-reply suspension and resume, snapshot/park handling, and judge classifier/adjudicator prompt plumbing.
- That machinery is an interpreter of data the FSM artifact already carries — states, prompts, `result` contracts, player names in state metadata — yet each artifact owned a private copy, so a runtime bugfix required re-linking every artifact with a real agent.
- The repo's own reference artifacts confirm the duplication: `code.playbook.ts` (2364 lines) and the slc demo runtime share their machinery nearly verbatim, differing only in the per-workflow spots.
- The public runtime package surface already carved out the contract *types*; the interpreter *machinery* was the remaining per-artifact copy.

## Decision

### 1. The shared factory owns the machinery

- `createXStatePlaybookRuntime(machine, spec)` lives in `src/xstate-playbook-runtime.ts` and is re-exported from `@sublang/playbook/xstate-runtime`, so linked artifacts keep one shared engine import surface.
- The machinery is hoisted from the reference CODE artifact verbatim where possible; the CODE behavior suites are the equivalence proof, and observable behavior shall not change under the move.
- The factory provides every actor kind the machine declares — `player`, `script` ([DR-016](016-script-actors-and-optimize-pass.md)), direct `captain`, and nested `playbook` (literal and dynamic) via the shared bridge — and always implements the [DR-014](014-durable-one-shot-run-sessions.md) parked-session snapshot capability.
- Scope: FSMs that declare no parallel state (each snapshot exposes exactly one playbook state id).
  Parallel FSMs require bespoke linked machinery.

### 2. The `spec` parameter surface

- Required: `snapshotOptions` — validate and JSON-snapshot the caller's per-run options.
- Optional strategy members, each with a generic default derived from the FSM artifact's own data per `slc/link.md`: `label`, `machineInput`, `entryEvent` (deterministic textual entry), `bossEvents` (the exact judge-vs-runtime field metadata erased with the FSM's TypeScript event union), `classifyBossText`, `classificationStatus`, `resolvePlayerId` (default: lowercased player name), `composePlayerPrompt` / `composeCaptainPrompt` (default: continuation blocks plus canonical kebab-token-to-camel-field placeholder substitution), `placeholderFields` (linker-known exceptions such as an authored alias), `buildJudgePrompt`, `extractRequiredFields` (default: bilingual `Output shall include` clause scan), `verbatimPayloadFields`, `resumableStateIds` (default: the FSM's `awaitBossReply` BOSS_REPLY targets), `statusesForState`, `normalizeTransitionEvent` / `transitionEventFields`, and `scriptCwd` (default: the validated options' `cwd`).
- A linker-emitted thin module therefore normally supplies only `snapshotOptions`, `entryEvent`, any additional `bossEvents` contracts and `placeholderFields` exceptions that cannot survive TypeScript erasure, and `transitionEventFields`; hand-maintained artifacts override members to preserve their existing observable behavior exactly. The shared classifier always uses the flat exact `{ type, ...declaredFields }` wire shape, keeps textual fields runtime-owned, and permits applicable entry/interrupt directives while parked. Supplied metadata may extend a runtime-derived contract but shall not replace or weaken an entry text field or derived closed interrupt target; conflicting duplicates fail factory construction.

### 3. The linker emits thin modules for factory-backed FSMs

- For an FSM in the shared factory's single-region domain, `slc/link.md` §Output specifies the thin artifact: the relative FSM import, the derived `PlaybookRuntimeOptions` interface (plus `cwd` when a script state exists), the shared-contract type re-exports, the `_internal` composer surface, and the default-exported factory call.
- Emitted output stays erasable TypeScript with a source-only relative FSM import and bare package specifiers for the shared engine and contract modules.

### 4. Additive compatibility

- Every pre-existing export of `@sublang/playbook/runtime` and `@sublang/playbook/xstate-runtime` keeps working unchanged, so previously linked fat artifacts continue to run against this package.
- The reference CODE artifact is ported to the thin form under its unchanged test suites.
  The DISCUSS runtime keeps its own machinery: it interprets a parallel-region FSM with observably different boundary tracking, failure aggregation, and status scheduling that its suites pin.
  Converging DISCUSS onto the shared factory is future work under its own record.

## Consequences

- A shared-factory runtime fix ships by releasing `@sublang/playbook`; consumers adopt through their normal atomic version-bump cycle without re-linking any factory-backed artifact.
- A factory-backed linked artifact collapses to its per-workflow spec — roughly two orders of magnitude fewer generated lines — and the expensive agent link step no longer re-derives interpreter machinery it can get wrong.
- The generic strategy defaults are directly unit-tested in `src/xstate-playbook-runtime.test.ts` over synthetic FSMs covering all four actor kinds.
- Parallel-region FSMs still require their own linked machinery until the shared factory grows a parallel profile.
