<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# FSM-to-Runtime Linking

Compile the named XState v5 FSM into one thin `PlaybookRuntime` factory module.
Read the actual source FSM, including its erased TypeScript declarations and source-derived prompts/results; never modify the FSM or re-derive its prompts, result keys, roles, or guards.
The [complete link contract](references/link-contract.md) remains normative for every emitted artifact.
For the bounded profile below, this recipe states the agent's remaining semantic authoring work; the adjacent deterministic helper supplies the existing shared-factory implementation.

## Formats

| Role | Format | Extension |
| --- | --- | --- |
| source | fsm | .ts |
| target | playbook | .ts |

## Supported recipe

Use this recipe only for a flat, single-region machine with ordinary `player` and/or `script` actors, at most one invocation per state, shared default strategies, and unconstrained string, boolean or finite-number configured options.
The machine must have exactly one ordinary textual entry event where ready, recoverable-failure or reconstructed-terminal entry awaits fresh intent, with exact-text ownership expressible by `entryEvent` below.
Result payloads must use the standard explicit `Output shall include` convention (backticked property names or annotated fields), or have no payload fields.
Use the helper for this profile; do not regenerate its types, option validator, compatibility declaration, factory wiring or verification wrappers.
No fresh audit of shared engine or host implementation is required to materialize this profile.

For parallel/compound states, Captain or nested-playbook actors, custom classification/composition/extraction/status requirements, session-derived machine input, structured/constrained options, or a contract this recipe cannot express exactly, read the [full contract](references/link-contract.md) and perform ordinary linking.
A quoted relay `> <placeholder>` requiring line-by-line quoting or empty-line omission, or special identity/prompt formatting not satisfied by shared defaults, also requires that fallback.
Do not widen a type, discard an annotation, invent a source behavior, or select an empty metadata collection to force eligibility.
A source ambiguity that prevents exact linking must leave the target unwritten and report the concrete unresolved requirement.

## Author exact metadata

Supply every member below explicitly; unknown members are errors, and arrays are duplicate-free.
The examples illustrate shapes, not default workflow semantics.
Read the FSM's real declarations and invocation source; never call an invocation with invented context to guess its result contract.

| Descriptor member | Authoring obligation |
| --- | --- |
| `schema`, `profile` | Exactly `"sublang.playbook.link.v1"`, `"flat-defaults"`. |
| `machineExport`, `label` | Exact exported machine identifier and nonblank authored playbook label. |
| `options` | Map every configured option to `{ "type": "string" \| "boolean" \| "number", "required": boolean }`, preserving the FSM input type and requiredness. Absence of CLI link options does not erase runtime options. Do not put concrete player bindings, model identities or host capabilities here. |
| `inputMapping` | Map each option-supplied FSM input member to its declared option name; every non-`cwd` option must be mapped. Script-bearing workflows gain optional string `cwd` automatically; map it into FSM input only if the FSM actually declares that input. Session-derived or other input sources require fallback. |
| `entryEvent` | `{ "type": "BOSS_TASK", "textField": "bossIntent", "contextField": "bossIntent" }`, using the actual entry event, exact-text payload member and, where present, the exact FSM context member its transition action stores that text into. The latter preserves failure retry after restore; never infer it merely from matching names. This recipe requires deterministic textual entry; use full-contract fallback for explicit `null` or a different entry strategy. |
| `bossEvents` | Exact additional erased Boss-union contracts: `[{ "type": "EVENT", "fields": { "field": { "source": "judge" \| "text", "required": boolean, "values": ["closed", "values"] } } }]`. Omit `values` only for an unconstrained string. Preserve optionality and every closed value. Judge owns routing fields; runtime owns exact original text. Standard `BOSS_INTENT`/`BOSS_INTERRUPT` text is `bossIntent`; `BOSS_REPLY` text is `answer`. Factory-derived entry text and closed interrupt targets already exist: additional declarations merge without replacing or weakening them; omit redundant entries, retain additional fields. Never declare runtime-owned `NO_ACTION` or `BOSS_REPLY` here. An erased contract incompatible with those runtime arms is a link error. |
| `outcomeAuthority` | `{ "governedPlayerStates": { "stateId": { "outcomeKey": { "fields": {}, "repositoryDisposition": "unchanged" } } } }` with exactly every player state and every result outcome, using the authority/effect rules below. Empty governed map only when there are no players. |
| `placeholderFields` | Only authored token-to-input-field exceptions. Shared defaults already map kebab tokens to camel-case fields and `<#>` to `irNumber`; preserve source placeholders and literal replacement values, including placeholder-looking text and JavaScript replacement tokens. |
| `transitionEventFields` | Every payload field declared across the FSM's Boss-event union, excluding discriminator `type`, including optional fields such as `targetId`, `answer` and `questionId` where declared. |
| `verbatimPayloadFields` | Complete set from result annotations exactly of the form `` `field: <verbatim final text>` ``. An annotated field in one result map and unannotated use in another is a link error. `question` is presentation-owned independently of this set. |
| `resumableStateIds` | Exact delegated-player states permitted to suspend for a Boss reply and resume through the FSM's `BOSS_REPLY` branches, using its explicit resumption registry where declared (including root-level routing), or the targets of `awaitBossReply.on.BOSS_REPLY`. This registry is independent of interrupt/jump targets; advertised jumps additionally require an accepted interrupt event. No script, final or other non-player state. |
| `unfinishedFinalStateIds` | Exact mechanically declared root-final ids whose terminal outcomes leave the procedure unfinished; explicit `[]` when none. Never infer this set from descriptions, opaque output or prose. Missing authoritative terminal metadata is an error, not permission to guess. |
| `controlContextFields` | Authored safe FSM context projection in display order; `[]` when no view exposes context. Never export all context by default, pending-question/last-error first-class members, resolved player rosters, option values or player-authored text. |

Each outcome's `fields` keys must equal exactly the additional payload properties its explicit result contract names; `guard` is the outcome discriminator and never a field.
Assign each field exactly one authority: `presentation`, `semantic`, `effect` or `runtime`.
Every verbatim field and `question` is `presentation`; `latestCommit` is `effect`; `irNumber` and `irTask` are `semantic`; other fields retain their actual source-declared ownership.
If ownership cannot be established from the source and full contract, report the gap.

Repository dispositions are exactly `unchanged`, `one-descendant-commit` or `deferred`.
Derive each from the source-required operation and that outcome's required repository effect, independently of payload field presence.
A completion requiring a Git commit is `one-descendant-commit` even for `done` with `fields: {}`; no `latestCommit` field does not mean `unchanged`.
`deferred` is allowed only for `needsBossReply` with presentation-owned `question` and another outcome in that state requiring `one-descendant-commit`.
An effect-owned field is allowed on `unchanged` or `one-descendant-commit`, never `deferred`.
For a commit-required player with a payload-free completion and an eligible question arm, the exact shape is:

```json
"outcomeAuthority": {
  "governedPlayerStates": {
    "actualPlayerStateId": {
      "done": { "fields": {}, "repositoryDisposition": "one-descendant-commit" },
      "needsBossReply": { "fields": { "question": "presentation" }, "repositoryDisposition": "deferred" }
    }
  }
}
```

## Materialize and verify

Invoke using the actual definition directory and only the declared target; pass the complete descriptor on standard input:

```sh
node "<definition-directory>/materialize-link.mjs" --fsm "<source.fsm.ts>" --out "<target.playbook.ts>" <<'JSON'
<complete descriptor JSON>
JSON
```

The helper resolves the installed engine from both artifact locations, requires equality and schema-3 support, and preflights the actual shared factory before atomic target replacement.
It mechanically copies every player role and state label from the FSM, emits the installed compatibility literal, typed immutable options, input mapping, shared factory and applicable `_internal` default-composer wrappers.
The emitted module depends only on its FSM and the installed runtime/engine; no runtime helper dependency or host primitive belongs in it.
The Captain host owns registry-manifest and live authority-envelope validation at its construction boundary; the emitted factory requires supplied opaque authority, repository and ledger capabilities and does not synthesize them.
Do not mistake the bare factory for that host boundary.
JavaScript FSMs load on supported Node versions; TypeScript requires native type stripping (Node 23.6+, or Node 22.18+).
This direct-source recipe retains the source extension; a package shipping JavaScript siblings requires full-contract import-path handling.

Exit 0 reports the written target; exit 2 reports unsupported input without changing the target and requires full-contract fallback; exit 1 reports invalid metadata/loading/preflight/output and requires correction before success.
Correct descriptor mistakes from the source and rerun the helper; do not patch generated boilerplate to conceal a failed check.
Existing compiler source/FSM/link conformance checks remain mandatory, including exact prompt-body preservation, continuation composition and state labels.
Run an existing co-located runtime integration suite before success without deleting, skipping or weakening tests.
The generated module must type-check with its actual installed engine and satisfy the complete runtime contract; do not replace semantic checks with the helper's structural preflight.

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

## Full contract references

<a id="optional-deterministic-materialization"></a>
[Full contract: optional-deterministic-materialization](references/link-contract.md#optional-deterministic-materialization)

<a id="playbookruntime-contract"></a>
[Full contract: playbookruntime-contract](references/link-contract.md#playbookruntime-contract)

<a id="playbookports-contract"></a>
[Full contract: playbookports-contract](references/link-contract.md#playbookports-contract)

<a id="playbook-trace"></a>
[Full contract: playbook-trace](references/link-contract.md#playbook-trace)

<a id="linker-inputs"></a>
[Full contract: linker-inputs](references/link-contract.md#linker-inputs)

<a id="role-identity"></a>
[Full contract: role-identity](references/link-contract.md#role-identity)

<a id="player-prompt-composition"></a>
[Full contract: player-prompt-composition](references/link-contract.md#player-prompt-composition)

<a id="captain-prompt-composition"></a>
[Full contract: captain-prompt-composition](references/link-contract.md#captain-prompt-composition)

<a id="boss-event-mapping"></a>
[Full contract: boss-event-mapping](references/link-contract.md#boss-event-mapping)

<a id="captain-adjudication"></a>
[Full contract: captain-adjudication](references/link-contract.md#captain-adjudication)

<a id="script-execution"></a>
[Full contract: script-execution](references/link-contract.md#script-execution)

<a id="nested-playbook-bridge"></a>
[Full contract: nested-playbook-bridge](references/link-contract.md#nested-playbook-bridge)

<a id="session-lifecycle"></a>
[Full contract: session-lifecycle](references/link-contract.md#session-lifecycle)

<a id="parked-session-snapshot-optional"></a>
[Full contract: parked-session-snapshot-optional](references/link-contract.md#parked-session-snapshot-optional)

<a id="retained-snapshot-adoption-optional"></a>
[Full contract: retained-snapshot-adoption-optional](references/link-contract.md#retained-snapshot-adoption-optional)

<a id="retained-generation-classification-optional"></a>
[Full contract: retained-generation-classification-optional](references/link-contract.md#retained-generation-classification-optional)

<a id="control-surface-optional"></a>
[Full contract: control-surface-optional](references/link-contract.md#control-surface-optional)

<a id="abort"></a>
[Full contract: abort](references/link-contract.md#abort)

<a id="status-and-telemetry"></a>
[Full contract: status-and-telemetry](references/link-contract.md#status-and-telemetry)

<a id="output"></a>
[Full contract: output](references/link-contract.md#output)

<a id="host-adaptation-informative-not-normative"></a>
[Full contract: host-adaptation-informative-not-normative](references/link-contract.md#host-adaptation-informative-not-normative)

<a id="out-of-scope"></a>
[Full contract: out-of-scope](references/link-contract.md#out-of-scope)

<a id="references"></a>
[Full contract: references](references/link-contract.md#references)
