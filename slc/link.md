<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# FSM-to-Runtime Linking

Third phase of a playbook (a state-machine agent orchestrating other agents).
Compiles the [gears2fsm](gears2fsm.md) artifact into a **`PlaybookRuntime`**: a host-agnostic runner that:

- Drives the FSM.
- Classifies Boss input into typed events.
- Runs direct-Captain, delegated-player, and nested-playbook actors.
- Executes deterministic script actors locally, without any agent.
- Adjudicates Captain and player output into FSM guards.
- Surfaces transitions as status/telemetry.

The runtime is invoked through the stable `PlaybookPorts` contract.
Presentation layers (tmux-play, web, CLI, tests) implement the six ports once
and inherit every playbook.

- Source: an XState v5 machine artifact (`.fsm.ts`) produced by gears2fsm.
- Target: a `PlaybookRuntime` factory module — TypeScript, host-agnostic.

Hosts are out of scope for this phase.
Each host has an adapter that loads a `PlaybookRuntime` module and supplies the host's primitives as `PlaybookPorts`.
The adapter shall speak only `PlaybookPorts` to the runtime and shall not leak host types back into it.

The link compiler shall not modify the FSM artifact and shall not re-derive Captain prompts, result keys, or guard semantics — those are fixed by the FSM.

## Formats

| Role   | Format   | Extension |
| ------ | -------- | --------- |
| source | fsm      | .ts       |
| target | playbook | .ts       |

## Shared-factory authoring

The normative definition consists of this file and its [runtime contract dependency](link-runtime.md).
A phase host that snapshots or pins this definition shall retain both files and their relative layout; a changed runtime contract is a changed definition even when this entry file is unchanged.
The dependency is reference content, not an additional compiler phase or an additional agent call.
The runtime sections retain their original headings below as links so existing citations still resolve.

For an ordinary flat single-region workflow, the linker shall use the shared factory and author only the per-workflow declarations required by §Output.
The runtime reference specifies the factory's obligations; the linker does not need to reread or regenerate its implementation of actors, traces, lifecycle, effects, suspension, adoption, or abort settlement to select those existing services.
This authoring path does not waive any runtime requirement or any existing conformance test.
Read the relevant linked runtime sections when the Source or selected strategy requires behavior beyond a conforming shared default, and read the complete runtime contract before emitting a bespoke parallel runtime.
Controller decision states require the specialized controller classifier, Captain strategy, and construction contract in the reference; ordinary direct-Captain prose states do not.

### Inspect the immutable Source

Read the complete FSM TypeScript Source, including its types, state metadata, invocation contracts, input initialization, transition actions, and final states.
Do not infer erased input or event contracts from a runtime-only import.
Do not change the FSM, reinterpret prompts or outcome meanings, or introduce host role bindings.
When a required semantic fact is missing or contradictory, report the concrete link error and leave the Target unwritten.

### Declare the options and construction boundary

Derive `PlaybookRuntimeOptions` from every required machine-input field not supplied by `PlaybookSession` or another explicit linker-owned source, retaining the exact requiredness and shape; no CLI link options does not imply an empty runtime option interface.
Add optional `cwd` when the FSM invokes `script`.
Validate configured options as detached immutable plain JSON, reject undeclared keys and nonconforming values, and derive machine input only from that validated record and explicit session-owned sources.
Preserve required catalog data rather than inventing an empty catalog.
Host role bindings, player prompt identities, and live capabilities are not configured options or FSM input.

For a Captain-hosted schema-3 workflow, the factory's argument is exactly `{ configuredOptions, hostCapabilities }`.
The live capability object contains exactly `authority`, `repository`, and `effectLedger`; use the installed shared contract types for the repository and ledger and retain the artifact's exact authority shape defined in [PlaybookRuntime contract](link-runtime.md#playbookruntime-contract).
Do not substitute an options-only wrapper, fabricate host capabilities, or persist them.
The roleless session-Captain wrapper is the sole signature exception and requires that reference's specialized contract.

### Preserve event ownership

Where ready, recoverable-failure, or reconstructed-terminal entry accepts exactly one ordinary textual event with no pending question, declare deterministic `entryEvent` with its exact event type and textual field.
Read that event's actual transition action to identify any context member receiving the exact Boss text, and include it as `contextField` so retry remains valid after restore.
Do not infer the context member from a coincident name.

Derive the full `transitionEventFields` from the typed Boss-event union.
Declare `bossEvents` for additional arms whose judge fields, optionality, runtime-owned text fields, or closed string values disappear under type erasure.
Preserve required versus optional fields and exact closed routing values.
The judge selects routing data; the runtime attaches the exact Boss text: `bossIntent` for `BOSS_INTENT` and `BOSS_INTERRUPT`, and `answer` for `BOSS_REPLY`.
Do not request or accept judge-authored copies of runtime-owned text.
Do not emit `bossEvents` entries for `NO_ACTION` or `BOSS_REPLY`, which the factory owns, or weaken the factory-derived entry and interrupt contracts.
A controller's multiple deterministic entry arms require the specialized classifier described in [Boss-event mapping](link-runtime.md#boss-event-mapping).

### Preserve role and outcome authority

Emit the complete `roleStates` map for typed `player` states, with each exact local role and description from FSM metadata, or an explicit empty map for a roleless workflow.
Emit `outcomeAuthority.governedPlayerStates` for every and only those states and every and only each state's `invoke.input.result` outcome.
Each outcome contains exactly `fields` and `repositoryDisposition`.
`fields` names every additional required payload field and excludes the `guard` discriminator.
Required payload fields come from the explicit `Output shall include` clause or equivalent typed output metadata, not arbitrary backticked prose elsewhere.

Every field has exactly one authority: `presentation`, `semantic`, `effect`, or `runtime`.
`question` and annotated verbatim fields are presentation-owned, `latestCommit` is effect-owned, and `irNumber` and `irTask` are semantic-owned.
Derive `verbatimPayloadFields` from all `<verbatim final text>` field annotations; a field annotated in one result and unannotated in another is a link error.
Do not infer repository dispositions from a role name or default every state to the same disposition.
Determine each arm's authored repository obligation: `unchanged`, `one-descendant-commit`, or `deferred`.
An effect field is allowed on the first two dispositions, never on `deferred`.
`deferred` is allowed only for `needsBossReply` with presentation-owned `question` in a state with another `one-descendant-commit` outcome.
When that obligation is not determined by the Source, report the missing fact instead of guessing.

Use the default per-state LLM judge unless an explicitly selected compatible strategy requires an override.
The shared engine owns evidence collection, semantic reconciliation, durable receipts, correction limits, and effect settlement.
A helper, single ordinary result, or one-role workflow does not authorize bypassing adjudication or repository authority.

### Preserve prompts and controller metadata

Use the shared composers only where their behavior satisfies the Source's typed prompt contract and §Output's literal one-pass and quoted-relay rules.
The canonical placeholder mapping is kebab-token to camel-field plus `<#>` to `irNumber`; declare `placeholderFields` only for authored exceptions.
When the template requires a narrow composer override, retain source text exactly, keep replacement values literal, handle every typed field independently of state discriminators, quote multiline relays line by line, and omit empty quoted relays.
Player continuation uses the shared continuation helper where applicable; framework continuation text never enters the FSM domain prompt.
Do not introduce player-visible Boss-question or hidden-judge instructions.
Direct-Captain structured fields require validated deterministic JSON rendering, and visible `question` or `response` prose remains owned by the visible call.

Author `controlContextFields` as the exact ordered safe controller-view projection, with no roster, option value, player-authored text, pending question, or last error; omit it or use an empty array when nothing should be exposed.
Declare `unfinishedFinalStateIds` explicitly, including an empty set when appropriate, from the Source's declared terminal outcome contract; do not infer unfinished work from state descriptions or opaque output.
Every listed id must name a root final state.

### Emit and verify

Read the installed shared engine's `RUNTIME_ABI` and `SUPPORTED_ARTIFACT_SCHEMAS`, require support for artifact schema `3`, and emit its ABI as a link-time numeric literal rather than importing the loading engine's value into `spec.compat`.
Emit exactly the thin module required by §Output, with source-relative FSM import, installed shared-engine imports, shared type re-exports, typed options and validation, the per-workflow spec, the typed default factory, and only the `_internal` composers the FSM uses.
A bare shared-factory import is not itself proof that authored metadata or a custom composer conforms.
Check the generated artifact against the Source and run any co-located linked-runtime integration suite before reporting success.
Do not remove or weaken conformance checks, add speculative actor machinery, or treat a missing required semantic declaration as permission to choose one.

## PlaybookRuntime contract

Normative runtime behavior: [PlaybookRuntime contract](link-runtime.md#playbookruntime-contract).

## PlaybookPorts contract

Normative runtime behavior: [PlaybookPorts contract](link-runtime.md#playbookports-contract).

## Playbook trace

Normative runtime behavior: [Playbook trace](link-runtime.md#playbook-trace).

## Linker inputs

The link compiler shall accept:

- The FSM artifact (path to a `.fsm.ts`).
- An **adjudication strategy** (default: LLM-judge per state) and a
  **Boss-event mapping** (default: free-text judge classification).
  Both strategies are host-agnostic.

The host's identity does not enter compilation; the linked module runs unchanged under any host that implements `PlaybookPorts`.

## Role identity

Each delegated GEARS state names exactly one canonical local role id (`player` actor `invoke.input.role`).
The linker shall retain that id in `PlaybookPorts.callPlayer(roleId, …)` without selecting a concrete player.
The host shall bind that local role id explicitly when it constructs the runtime.
Every direct-Captain and delegated-player invocation shall also carry its
working leaf's explicit
`stateId`; a linked runtime shall use that field for call identity and shall
not infer one leaf from a structured root snapshot.
Direct `captain` actor states call `PlaybookPorts.callCaptain`; the linker shall not synthesize a local role or concrete player id named `captain` for them.
The linker shall reject an alias-shaped role declaration rather than choose a runtime identity.

## Player prompt composition

Normative runtime behavior: [Player prompt composition](link-runtime.md#player-prompt-composition).

## Captain prompt composition

Normative runtime behavior: [Captain prompt composition](link-runtime.md#captain-prompt-composition).

## Boss-event mapping

Normative runtime behavior: [Boss-event mapping](link-runtime.md#boss-event-mapping).

## Captain adjudication

Normative runtime behavior: [Captain adjudication](link-runtime.md#captain-adjudication).

## Script execution

Normative runtime behavior: [Script execution](link-runtime.md#script-execution).

## Nested playbook bridge

Normative runtime behavior: [Nested playbook bridge](link-runtime.md#nested-playbook-bridge).

## Session lifecycle

Normative runtime behavior: [Session lifecycle](link-runtime.md#session-lifecycle).

## Parked-session snapshot (optional)

Normative runtime behavior: [Parked-session snapshot (optional)](link-runtime.md#parked-session-snapshot-optional).

## Retained-snapshot adoption (optional)

Normative runtime behavior: [Retained-snapshot adoption (optional)](link-runtime.md#retained-snapshot-adoption-optional).

## Retained-generation classification (optional)

Normative runtime behavior: [Retained-generation classification (optional)](link-runtime.md#retained-generation-classification-optional).

## Control surface (optional)

Normative runtime behavior: [Control surface (optional)](link-runtime.md#control-surface-optional).

## Abort

Normative runtime behavior: [Abort](link-runtime.md#abort).

## Status and telemetry

Normative runtime behavior: [Status and telemetry](link-runtime.md#status-and-telemetry).

## Output

The link compiler emits one TypeScript module per playbook.
Every linked artifact shall emit an `unfinishedFinalStateIds` set beside its resumable-state registry as mechanical link-time metadata.
The set shall contain exactly the stable ids of root `type: 'final'` states whose terminal outcomes leave the procedure unfinished, and shall be explicitly empty when no terminal outcome does.
The linker shall not infer the set from a state description, opaque output, or procedure prose.
The linker shall reject a declared id that does not name a root final state, and the shared factory shall independently reject it at construction before runtime effects.
For a factory-backed artifact the set is a `spec` member; a bespoke artifact shall retain equivalent linked metadata, and the artifact declaration is not itself the public runtime retention marker or an adoption capability.
For an FSM that declares no `type: 'parallel'` state — necessarily flat
under [gears2fsm.md](gears2fsm.md)'s one-state-per-item mapping — it shall
emit the thin shared-factory module defined below.
For an FSM that declares a parallel state, it shall emit bespoke linked
machinery satisfying this document's runtime contract and shall not invoke
`createXStatePlaybookRuntime`, whose supported domain is flat single-region
FSMs under [DR-019](../specs/decisions/019-shared-linked-runtime-factory.md).
The FSM-interpreter machinery — actor wiring, boundary tracing, Boss-event
mapping, adjudication, script execution, nested-playbook bridging, session
lifecycle, abort handling, and the optional parked-session snapshot and
retained-snapshot adoption capabilities — is not regenerated for a
factory-backed artifact: it ships once
as the shared `createXStatePlaybookRuntime(machine, spec)` factory exported by
`@sublang/playbook/xstate-runtime`, and the emitted module hands its FSM and
a small per-playbook `spec` to that factory. Every behavioral section of
this definition still binds the emitted module's runtime; the shared factory
is how the emitted module satisfies them, so a runtime fix ships as a
package release instead of a re-link of every artifact.

The thin emitted module:

- Imports the FSM artifact by relative path with an extension-bearing
  runtime specifier. When the linked TypeScript is part of a package that
  compiles and ships JavaScript siblings, the source shall use the
  NodeNext-compatible `.js` specifier (for example `./code.fsm.js`), never a
  `.ts` specifier that the package's supported Node versions cannot load.
  An explicitly source-only host may instead retain `.ts` only when that
  host supports direct TypeScript loading and no JavaScript build is shipped.
- Restricts itself to erasable TypeScript syntax — type annotations
  that strip cleanly, no constructor parameter properties, `enum`s, or
  namespaces — so a host running under type stripping loads it
  directly.
- Imports `createXStatePlaybookRuntime` (plus any shared strategy defaults
  its `_internal` surface re-exports) from the shared engine module through
  its bare package specifier `@sublang/playbook/xstate-runtime`, and the
  contract types through `@sublang/playbook/runtime`. It shall not copy,
  inline, or re-derive interpreter machinery — actor bridges, trace
  emission, judge-JSON recovery, lifecycle guards — beside the factory
  call, and shall not import `xstate`, `p-queue`, or `node:child_process`
  itself; those are the shared engine's dependencies.
- Declares and exports the typed `PlaybookRuntimeOptions` interface for that
  playbook, derived from every required FSM input field that is not supplied
  by `PlaybookSession` or another linker-owned source (§PlaybookRuntime
  contract), plus the optional `cwd` option whenever the FSM contains a
  `script` state (§Script execution).
- Supplies the spec's `snapshotOptions` with the same options-validation
  semantics previously generated inline: validate and JSON-snapshot the
  caller's options, rejecting undeclared keys and non-conforming values, so
  the factory binds an immutable options record before constructing any
  actor.
- Supplies in `spec` only what the factory cannot read from the FSM
  artifact's own data: the deterministic textual entry event where
  §Boss-event mapping prescribes deterministic entry, naming with it the FSM
  context member that event's own transition action copies the exact Boss
  text into wherever the machine keeps one, so the failure-state retry of
  §Control surface survives a restore; compact `bossEvents`
  metadata for each additional Boss-union arm whose exact required/optional
  judge fields, runtime-owned text fields, or closed string values disappear
  under TypeScript erasure; `placeholderFields` only for authored token/field
  exceptions not covered by the canonical kebab-token-to-camel-field mapping
  and the canonical `<#>` → `irNumber` special case; the
  transition-event payload fields the FSM's Boss union declares; the
  complete `roleStates` status map derived from every FSM state that invokes
  the typed `player` actor, with each `role` copied from that state's
  source-derived `meta.playbook.role` (an empty map when there is no such
  state); the exact schema-3 `outcomeAuthority` map derived
  from every such state's `invoke.input.result` contract and its linked field
  authorities and repository dispositions (an explicit empty governed map
  when there is no such state); the
  `verbatimPayloadFields` set derived from annotated result fields above; the
  explicitly empty or populated `unfinishedFinalStateIds` set declared above;
  the `controlContextFields` projection of §Control surface; and any
  per-playbook strategy override (classifier, prompt composers,
  required-field extraction, status formatting) an earlier section of this
  definition requires for that playbook.
  `controlContextFields` is authored, not derived: the linker names the FSM
  context members the playbook's controller view exposes and no others, in the
  order the view should render them, omitting the member entirely where the
  playbook exposes no context. It is the one spec member whose default is
  *nothing* rather than everything — the factory exports no context for a
  module that supplies none — so a module emitted without it advertises a
  playbook with no Boss-visible context rather than one whose whole FSM
  context is Boss-visible. The linker shall not name a member the view
  surfaces first-class (the pending Boss question, the last error), which is a
  construction error, and shall not name a member carrying a resolved player
  roster, an option value, or player-authored text, which a controller host's
  prompts are required to exclude or to fence. The metadata shall keep the shared
  classifier's reply contract exactly flat `{ type, ...declaredFields }` and
  distinguish judge-authored routing fields from exact-text fields the
  runtime attaches itself. Everything else — player/script/captain/nested actor
  provisioning, prompt composition, classification, adjudication, statuses,
  resumable-state derivation — comes from the factory's generic defaults,
  which implement the behavioral sections of this definition.

  ```ts
  interface XStateBossEventFieldSpec {
    source: 'judge' | 'text';
    required?: boolean;
    values?: readonly string[];
  }

  interface XStateBossEventSpec {
    type: string;
    fields?: Readonly<Record<string, XStateBossEventFieldSpec>>;
  }

  interface XStateRoleStateStatus {
    role: string;
    label: string;
  }

  bossEvents?: readonly XStateBossEventSpec[];
  roleStates?: Readonly<Record<string, XStateRoleStateStatus>>;
  placeholderFields?: Readonly<Record<string, string>>;
  ```

  Supplied `bossEvents` metadata shall merge with, and shall not replace or
  weaken, runtime-derived entry text ownership or closed interrupt targets.
  A conflicting duplicate field contract is a linker/runtime construction
  error.
  `NO_ACTION` and `BOSS_REPLY` are runtime-owned event types the factory
  supplies itself — `NO_ACTION` as exactly `{ type: 'NO_ACTION' }`, and
  `BOSS_REPLY` as an optional judge-selected `questionId` plus the exact-text
  `answer` the runtime attaches. `bossEvents` shall carry no entry for either
  type; supplying one is a construction error, so a linker that judges a
  runtime-owned arm to have lost payload detail under erasure shall report
  that gap rather than emit the entry.
- Supplies `spec.compat` with the compatibility values current at link time:
  `{ artifactSchema: 3, runtimeAbi }`, where `runtimeAbi` is the installed shared engine's
  `RUNTIME_ABI` self-report.
  The linker shall verify that the installed engine lists the emitted
  schema in `SUPPORTED_ARTIFACT_SCHEMAS` and treat its absence as a
  link-time error; it shall not stamp a different member (such as the
  highest) merely because that engine also supports a newer artifact
  format — the declaration names the format of the emitted module, not
  the capability of the emitting engine. The factory checks the
  declaration against the engine instance that actually loads the emitted
  module and fails construction on a mismatch, so an artifact linked under
  one engine cannot run silently skewed under another. Modules emitted
  before this contract carry no `compat` member and shall reject before interpretation.
- Requires the containing public registry manifest to advertise the identical
  `artifactSchema` and an exact implementation `runtimeProfile`. A shared
  factory profile is `{ kind: 'shared-factory', compat }`, where `compat` is
  the immutable compatibility record captured by that actual factory from
  its validated `spec.compat`; a bespoke profile is
  `{ kind: 'bespoke', artifactSchema }`, with schema `3` declared directly by
  that implementation and no `runtimeAbi` claim. A registry factory accepts configured options and current
  host capabilities separately and composes the linked runtime's exact
  `{ configuredOptions, hostCapabilities }` input. The Captain host shall
  capture the imported manifest fields once, require capabilities for every
  and only enabled artifact id, validate each capability's artifact, role,
  cohort, and canonical-worktree authority, and reject a missing, extra,
  malformed, or mismatched capability before runtime construction.
- Default-exports the factory call as `createPlaybookRuntime`, typed as
  `XStatePlaybookRuntimeFactory<XStatePlaybookRuntimeConstruction<PlaybookRuntimeOptions, HostCapabilities>, 3>`
  with the artifact's declared live capability type. A registry module loads
  dynamically inside the host's caught boundary, so its eager module-scope
  factory call fails fast there. The compiled session Captain module is the
  exception: the shell and both CLI front ends import it statically, so it
  shall defer its factory call to the first runtime request — an eager call
  would turn a future `spec.compat` rejection into an uncaught module-load
  error that takes even `--help` down, instead of the caught
  host-construction boundary's setup diagnostic.
- Exposes, under an `_internal` export, the pure helpers verification
  needs — at least the prompt composers its own machine uses, which may
  re-export the shared defaults when the spec does not override composition —
  so compilation-correctness tests can exercise composition without a host.
  A playbook that calls players exposes `composePlayerPrompt`; a playbook
  whose states make direct-Captain calls exposes `composeCaptainPrompt`. A
  controller playbook that calls no players exposes no player composer:
  there is no composition to verify, and a stub under that name would
  describe work the module cannot do. `_internal` is not a public API — the
  leading underscore says so — and nothing in it is semver-stable; a helper
  a host is meant to call is a top-level export and is governed as one.
- Holds no host-specific types and no host primitive calls. The runtime
  speaks only `PlaybookPorts` for every agent and host concern; the
  `node:child_process` dependency of §Script execution lives in the shared
  factory, not in the emitted module.
- Records the linker inputs (FSM path and strategies) in a
  top-of-file header comment so the file is reproducible from the same
  inputs.
- Sources the contract types (`PlayerResult`, `PlayerCallOptions`,
  `PlayerSessionStore`,
  `CaptainResult`, `CaptainCallOptions`, `PlaybookPorts`, `PlaybookSession`,
  `PlaybookTraceEvent`,
  `PlaybookCallRequest`, `PlaybookCallResult`, `PlaybookCallStart`,
  `PlaybookStateValue`, `PlaybookState`, `PlaybookRunResult`,
  `PlaybookRuntime`, `PlaybookRuntimeFactory`) from the single shared
  type-only module instead of redefining them, and re-exports the names
  its consumers import, so every linked playbook shares one contract
  definition. The shared modules import no FSM or host types, so the
  dependency runs one way — from each linked module to the shared
  engine and contract, never the reverse.

Both output profiles remain subject to the behavioral sections above and the
verification requirements below.

When a co-located integration test for the linked runtime already exists, the
link compiler shall run it before reporting success and treat any failure as a
generation failure. It shall not delete, skip, or weaken that suite to make a
new artifact pass; the suite is executable evidence for lifecycle, ordering,
error-propagation, and host-boundary requirements that static artifact checks
cannot establish.

Internal trace/status helpers may accept `unknown`, validate it with the same
JSON-safety rules as the public boundary, and only then emit a `JsonValue`.
They shall not require nominally typed public interfaces such as
`NormalizedError`, `PlaybookState`, `PlaybookCallRequest`, or
`PlaybookCallResult` to satisfy a `JsonValue` index signature at compile time,
and they shall not silence that mismatch with an unchecked cast.
Prompt placeholder substitution shall make one callback-based pass over the
original template. Replacement strings are literal: placeholder-looking text
inside Boss/catalog/plan/result values and JavaScript replacement tokens such
as `$&`, `$$`, dollar-backtick, and `$'` shall not be interpreted or
substituted again.
A quoted relay line `> <placeholder>` whose value is empty shall be omitted
from the composed text rather than left as an empty quoted line, a multi-line
value shall be quoted line by line so every continuation line keeps its `>`
marker, and the composer shall insert no empty quoted line of its own.

## Host adaptation (informative, not normative)

Normative runtime behavior: [Host adaptation (informative, not normative)](link-runtime.md#host-adaptation-informative-not-normative).

## Out of scope

Normative runtime behavior: [Out of scope](link-runtime.md#out-of-scope).

## Compiled execution

This section governs compiled execution of this phase; the rules above remain the transformation's normative content for both execution paths.

Where the phase host supplies `<definition>` as the exact bytes of the definition file the request names, when a transformation request names an `fsm` Source (`.ts`) and a `playbook` Target (`.ts`), Captain shall carry out the FSM-to-runtime linking as specified:

> Follow the definition relayed between the `--- DEFINITION ---` and `--- END DEFINITION ---` lines exactly, adding no rules of your own: read the named Source and write the named Target as the definition specifies.
> If the Source cannot be transformed under the definition, do not guess: leave the Target unwritten and report the concrete reason.
> --- DEFINITION ---
> \<definition\>
> --- END DEFINITION ---

Results:
- `compiled`: Captain wrote the named Target as the relayed definition specifies.
- `rejected`: Captain reported that the Source cannot be transformed under the relayed definition and left the Target unwritten.

## References

[1]: text2gears.md "First phase: text → GEARS spec items."
[2]: gears2fsm.md "Second phase: GEARS items → FSM artifact."
[3]: https://stately.ai/docs/actors "XState actors — `createActor`, snapshots, abort signal handling."
[4]: https://github.com/sindresorhus/p-queue#readme "p-queue concurrency and AbortSignal support."
