<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook-runtime: Linked Playbook Runtime

## Intent

This package specifies the host-facing and internal contracts of linked playbook runtimes, including Boss turns, players, Captain calls, composition, tracing, persistence, control, and integration verification.

## External Behavior

### Turn input

#### playbook-runtime-1

Where a fresh nonempty Boss turn reaches CODE, REVIEW, or DECIDE while the runtime is ready, failed, or terminal and has no pending Boss question, the runtime shall send the artifact's deterministic initial event with the exact Boss text in its declared input field: `START_CODE.callerInput`, `START_REVIEW.callerInput`, or `START_DECIDE.callerTopic`, except that a governed artifact-schema-3 failure-state retry shall remain unmapped when the automatic-replay fence of [[playbook-runtime-71](#playbook-runtime-71)] does not authorize it.
The runtime shall make no judge call for that entry and shall treat slash-prefixed text that reaches it as ordinary Boss text.

#### playbook-runtime-2

Where a nonempty Boss turn reaches a runtime with one or more pending Boss questions, the runtime shall ask the judge to select `BOSS_REPLY` for one identified question, an artifact-declared interrupt for a fresh directive, or no action, while the runtime itself supplies the Boss text verbatim as the answer or replacement intent.
When the text is empty or whitespace-only, the runtime shall take no FSM action and make no judge call.
When the judge returns no valid event and payload, the runtime shall report the reason and take no FSM action.

### Turn progress

#### playbook-runtime-3

Where a factory-backed artifact supplies linker-emitted `roleStates` and no artifact-specific status override, while a Boss turn is in progress, the runtime shall surface the canonical human-readable status stream below without exposing judge JSON, raw state-id fallbacks, or the Boss text already visible at the prompt:

- Before sending a selected Boss event, emit its bare type such as `START_CODE` as Captain speech.
- For artifact schema `2`, whenever a settling actor output carries a guard, emit exactly `→ <guard>` with no payload tally, rider, or leading whitespace; for artifact schema `3`, emit that line only from the confirmed accepted-outcome evidence of [[playbook-runtime-81](#playbook-runtime-81)].
- On entry to a state named by `roleStates`, emit `⤷ <Role>: <label>` from that metadata with no source-item or context rider.
- On entry to a Boss-reply wait, emit the untruncated `<asker> asks: <question>` as Captain speech followed by `◆ awaiting Boss reply · <resumeStateId> · <asker> · <sourceItem>` with no question excerpt, rendering the Captain asker as `Captain` and a role asker by its local role id.
- On entry to failure, emit `◆ workflow failed; awaiting Boss recovery.` with the compact normalized error as status data.
- Emit no canonical status on entry to an idle, terminal, or other unlisted state.

The runtime shall compose only each line's meaningful content, while the host owns speaker chrome, wrapping, and visual nesting and keeps judge calls hidden per [[playbook-runtime-15](#playbook-runtime-15)].

### Host configuration

#### playbook-runtime-4

Where CODE, REVIEW, or DECIDE runs through the Playbook Captain shell, the shell shall bind each local role through that frame's explicit player id and route each player call to the resulting host player per [[playbook-captain-10](playbook-captain.md#playbook-captain-10)].
The CODE registry shall require `coder`, and the REVIEW and DECIDE registries shall require `coder` and `reviewer`.

#### playbook-runtime-29

The current CODE, REVIEW, and DECIDE registries accept no workflow-specific options and shall reject every nonempty option slice.
Host-observable agent, layout, notification, permission, and presentation settings shall remain host configuration rather than workflow options.
Every configured option slice shall be plain JSON and shall reject the reserved own key `hostCapabilities` before and after registry option validation under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)]; live host construction capabilities are not workflow options.

### Module boundary

#### playbook-runtime-5

Each linked workflow runtime shall import its FSM and the shared runtime contract types from `@sublang/playbook/runtime`, hold no host-specific type, and interact with its host only through `PlaybookPorts`.
Each public workflow module shall default-export a `createPlaybookRuntime(options)` factory and shall re-export rather than redefine the shared runtime types.
A flat single-region artifact shall use `createXStatePlaybookRuntime` from `@sublang/playbook/xstate-runtime`, while a parallel artifact may emit bespoke linked machinery that implements the same public contract per [DR-019](../decisions/019-shared-linked-runtime-factory.md).
Schema `2` shall retain its existing typed factory-options contract; for schema `3`, the registry shall receive configured options and the artifact-bound current-host capability of [[playbook-runtime-50](#playbook-runtime-50)] separately under [[playbook-captain-5](playbook-captain.md#playbook-captain-5)] and shall compose them into the shared factory's exact disjoint construction object only when constructing a fresh, restored, or adopted runtime; neither form shall widen `PlaybookPorts` or `handleBossInput`.

#### playbook-runtime-34

The package shall provide a type-only module resolvable as
`@sublang/playbook/runtime` that is the single authored source of the
runtime contract types `PlayerResult`, `PlayerCallOptions`,
`PlaybookRoleBinding`, `PlayerSessionStore`, `CaptainResult`, `CaptainCallOptions`,
`JsonValue`, `NormalizedError`,
`PlaybookCallRequest`, `PlaybookCallResult`, `PlaybookCallStart`,
`PlaybookStateValue`, `PlaybookState`, `PlaybookPendingCall`,
`PlaybookRunResult`, `PlaybookPendingBossQuestion`, `PlaybookRepositoryDisposition`, `PlaybookRepositoryObservation`, `PlaybookRepositoryReceipt`,
`PlaybookEffectBoundary`, `PlaybookEffectBoundaryStart`, `PlaybookEffectLogicalOperation`, `PlaybookEffectLedger`, `PlaybookEffectLedgerCommand`, `PlaybookEffectLedgerCommandBatch`, `PlaybookEffectLedgerCapability`, `PlaybookControlAction`, `PlaybookControlView`,
`PlaybookControlReceipt`, `PlaybookRetainedGenerationMetadata`, `PlaybookAdoptionContext`, `PlaybookPorts`, `PlaybookSession`,
`PlaybookTraceType`, `PlaybookTraceEvent`,
`PlaybookRuntime`, and `PlaybookRuntimeFactory<Options = unknown>`, as
the TypeScript projection of
[slc/link.md](../../slc/link.md#playbookruntime-contract).
The executable `@sublang/playbook/xstate-runtime` module shall export `assertPlaybookEffectLedger`, `emptyPlaybookEffectLedger`, and `isPlaybookEffectLedgerMonotonicExtension` over those shared contract types, plus `PlaybookSemanticFieldAuthority`, `PlaybookSemanticOutcomeSpec`, `PlaybookSemanticEvidenceInput`, `PlaybookReconciledSemanticOutput`, `PlaybookRetainedSemanticEvidence`, `PlaybookSemanticReconciliationReason`, `PlaybookSemanticReconciliation`, `PlaybookSemanticCandidateStructureError`, and `reconcilePlaybookSemanticEvidence` as the centralized semantic-reconciliation surface of [[playbook-runtime-77](#playbook-runtime-77)].
`PlaybookPendingBossQuestion` shall carry `questionId`, exact `question`, optional `sourceItem`, and an `asker` discriminated as `{ kind: 'captain' }` or `{ kind: 'role', roleId: string }`; it shall expose no overloaded player field.
`PlayerResult.status` shall be the union `'ok' | 'aborted' | 'error'`,
`PlayerResult` shall expose optional `resumeToken`, `PlayerCallOptions`
shall require `resume: string | false`, `CaptainResult.status` shall be the
same union without a resume token, `CaptainCallOptions` shall require
`visibility: 'visible' | 'hidden'` and `resume: string | false`, and shall
expose optional `allowedTools?: readonly string[]` so an explicit empty list
requests tool isolation while omission preserves the host Captain's configured
tools. `PlaybookRuntime.init` shall
accept a `PlaybookSession` whose optional `roleBindings` maps each local role to exact `playerId` and `promptIdentity` strings and whose optional `playerSessions` implements the exact synchronous store contract in [[playbook-runtime-58](#playbook-runtime-58)], and `PlaybookPorts` shall declare exactly
the members `callPlayer`,
`callCaptain`, `callJudge`, `callPlaybook`, `emitStatus`, and
`emitTelemetry`.
`PlaybookRuntime.handleBossInput` shall accept exactly `{ text, signal }`:
no FSM event, parsed decision, or other host-decided input shall enter a
runtime through it, so a host's per-turn resolution of a Boss turn reaches a
compiled runtime only as a linker-exposed option member whose type the
artifact itself declares
([slc/link.md](../../slc/link.md#playbookruntime-contract)), which that
runtime's own classification maps to an FSM entry event
([[playbook-runtime-7](#playbook-runtime-7)], [[captain-playbook-9](captain-playbook.md#captain-playbook-9)]).
That keeps the shared contract module free of host and playbook types while
leaving the injection path typed end to end at the artifact.
`PlaybookRunResult` shall include the exact state-only variant `{ outcome: 'unresolved-effect', state: PlaybookState }` governed by [[playbook-runtime-79](#playbook-runtime-79)], with no optional member or bounded repository evidence.
`PlaybookRuntime` shall declare the optional host-only method `unresolvedEffectEnvelopes?(): readonly ({ readonly kind: 'boundary'; readonly boundaryId: string } | { readonly kind: 'logical-operation'; readonly operationId: string })[]`, whose exact nonblank durable identities shall name every effect-possible, outcome-unresolved envelope the runtime currently retains so the host can project its own authoritative ledger, and the method shall expose no receipt, repository observation, semantic evidence, prose, or live authority and shall add no member to `PlaybookRunResult`.
`PlaybookRuntime` shall declare the optional read-only retention-classification marker `retainedGenerationMetadata?: PlaybookRetainedGenerationMetadata`, whose value contains exactly the read-only string array `unfinishedFinalStateIds`; absence means the runtime contributes no retained generation, while presence supplies only terminal classification metadata and does not itself supply the independently feature-detected adoption capability.
`PlaybookAdoptionContext` shall contain exactly the nonempty string `sourceSessionId`, the nonempty string `sourceGenerationId` naming the retained stack root frame's `rootSessionId` from [[playbook-captain-41](playbook-captain.md#playbook-captain-41)], and the optional nonempty string `targetChildSessionId`.
`PlaybookRuntime` shall declare the adoption capability as the optional member `adopt?(session: PlaybookSession, snapshot: PlaybookRuntimeSnapshot, context: PlaybookAdoptionContext): Promise<void>`.
`PlaybookRuntime` shall declare the optional control-surface pair —
`describe?(): PlaybookControlView` and
`apply?(input: { actionId: string; key: string; signal: AbortSignal }):
Promise<PlaybookControlReceipt>` — implemented both or neither
([slc/link.md](../../slc/link.md#control-surface-optional));
`PlaybookControlView` shall carry `state`, the optional
runtime-published `stateDescription` naming what that state means
([[playbook-runtime-52](#playbook-runtime-52)]), the optional JSON-safe
`context` projection its runtime authors ([[playbook-runtime-52](#playbook-runtime-52)]),
`pendingQuestions`, optional `lastError`, and `actions` of
`PlaybookControlAction` (`id`, `label`), and `PlaybookControlReceipt`
shall discriminate exactly `rejected` (with `reason`, before any
effect), `executed` (with the `run` result), and `failed` (with the
normalized `error`, after effects may exist).
`PlaybookTraceType` shall include the paired `apply.started` and
`apply.finished` members alongside the existing boundary pairs.
The module shall import no CODE or FSM types, directly or
transitively, so it carries no dependency on any specific playbook;
the dependency runs one way, from `code.playbook` to this module
([[playbook-runtime-5](#playbook-runtime-5)]).
The module shall carry only type declarations and shall add no runtime
engine, linker, or host primitives.

#### playbook-runtime-58

Where `PlaybookSession.playerSessions` is supplied, the `PlayerSessionStore` shall expose exactly four synchronous operations keyed by the runtime-resolved frame-local role id:

| Operation | Contract |
| --- | --- |
| `select(roleId: string): string \| false` | Return the current nonempty resume token for that local role or `false` when none exists. |
| `update(roleId: string, resumeToken?: string): void` | Replace that local role's token with the supplied nonempty token, or clear it when the validated `ok` result authorizes an omitted token; aborted/error omission does not call `update`. |
| `snapshot(): Readonly<Record<string, string>>` | Return the complete current view as local-role keys mapped to nonempty tokens. |
| `restore(tokens: Readonly<Record<string, string>>): void` | Replace the complete current view by clearing every binding visible to the frame and then installing exactly the supplied local-role entries. |
| Host-provided frame view | Reject an unknown local role, map every accepted local role through the frame's explicit player binding before accessing the Captain-session ledger of [[playbook-captain-26](playbook-captain.md#playbook-captain-26)], reject inconsistent restored tokens when two local roles map to one player, and leave players outside that frame view unchanged during `restore`. |

### Runtime compatibility

#### playbook-runtime-50

The shared `@sublang/playbook/xstate-runtime` engine surface shall
export its compatibility self-report
([DR-022](../decisions/022-runtime-compatibility-contract.md)): the
integer `RUNTIME_ABI` it implements and the read-only integer array
`SUPPORTED_ARTIFACT_SCHEMAS` it accepts.
The supported set shall be exactly `[2, 3]` under runtime ABI `1` and shall exclude schema `1`.
Each successfully constructed shared factory shall expose the exact validated `{ artifactSchema, runtimeAbi }` pair as an immutable own `compat` data property, captured before later mutation of the supplied spec, so a containing registry can declare the factory profile without duplicating or re-reading link-time compatibility.
Schema `2` shall require the canonical `role` field, shall supply no concrete host binding, shall forbid `outcomeAuthority`, and shall otherwise preserve its present factory and runtime behavior.
Schema `3` shall require `outcomeAuthority` as an own exact plain-JSON data property whose `governedPlayerStates` keys exactly cover `roleStates`, or are explicitly empty for a roleless artifact; each governed state shall exactly cover its invoked result outcomes, each outcome shall carry only `fields` and `repositoryDisposition`, and its field keys shall exactly cover the non-`guard` payload fields named by that outcome's result description.
Each schema-3 payload field shall declare exactly one of `presentation`, `semantic`, `effect`, or `runtime` authority: `question` and every linker-declared verbatim field shall be presentation-owned, `latestCommit` shall be effect-owned, and `irNumber` and `irTask` shall be semantic-owned, while the outcome key owns the semantic discriminator.
Each schema-3 outcome shall declare exactly one repository disposition from `unchanged`, `one-descendant-commit`, or `deferred`; effect-owned fields shall occur only on `one-descendant-commit`, and `deferred` shall occur only on `needsBossReply` with a presentation-owned question and a sibling `one-descendant-commit` outcome.
For a Captain-hosted schema-3 artifact, the host capability shall contain exactly `{ authority, repository, effectLedger }`: `authority` shall contain the artifact id and schema `3`, current working directory, logical Captain-session id, current lease-owner token, canonical `{ worktree, gitDir }` identity, and detached exact required-role and concurrent-role-set declarations; `repository` shall contain that identical canonical identity plus the observation operation of [[playbook-runtime-67](#playbook-runtime-67)] and the host-bound claim-acquisition, exclusive-call, declared-cohort, and deferred-operation transaction of [[playbook-runtime-73](#playbook-runtime-73)] assembled under [[playbook-cli-20](playbook-cli.md#playbook-cli-20)], each bound against caller replacement of host-owned worktree, cohort, or deferred-operation authority; and `effectLedger` shall contain the synchronous detached current mirror and current host's atomic `writeAhead(commands)` operation of [[playbook-runtime-69](#playbook-runtime-69)].
The schema-3 shared factory shall accept one exact construction object `{ configuredOptions, hostCapabilities }`, snapshot and pass only the configured options to FSM input, require the capability member to be a non-null live object, and exclude that member, every nested callback, lease token, and live claim or store handle from `PlaybookPorts`, machine input and context, runtime snapshots, launch projections, and continuation equality.
Only the detached ledger data and canonical identities acknowledged by the ledger channel may enter the versioned snapshot mirror of [[playbook-runtime-45](#playbook-runtime-45)].
When `createXStatePlaybookRuntime(machine, spec)` is called with a
`spec.compat` declaration `{ artifactSchema, runtimeAbi }`, the factory
shall check that declaration against the self-report of the engine
instance actually loaded, before any machine interpretation: when
`artifactSchema` is not a member of `SUPPORTED_ARTIFACT_SCHEMAS`,
construction shall throw a `TypeError` naming the declared schema and
the supported set, also when `runtimeAbi` simultaneously disagrees;
when the schema is supported but `runtimeAbi` differs from
`RUNTIME_ABI`, construction shall throw a `TypeError` naming the
declared and the implemented value; when `compat` is present but not an
object carrying integer `artifactSchema` and `runtimeAbi` members,
construction shall throw a `TypeError` naming the offending member.
When `spec.compat` is absent, the factory shall reject the declaration-free
artifact because its legacy player metadata has no safe session-player
interpretation.

### Repository effect observation

#### playbook-runtime-67

Where a current host observes a Git worktree for a governed delegated-player boundary, the repository observer shall resolve the canonical real worktree root and capture the exact detached immutable `{ worktree, gitDir, head, projection, projectionDigest }`, where `head` is a canonical 40- or 64-lowercase-hex Git OID, `projection` is the path-keyed content-addressed projection relative to that HEAD, and `projectionDigest` is exactly `sha256:` plus the lowercase SHA-256 identity of the canonical JSON projection ([DR-040](../decisions/040-outcome-authority-effect-reconciliation.md) §2).
The projection shall contain index entries that differ from the HEAD tree with their modes and blob identities, tracked worktree entries that differ from the index with their modes and content identities, and every non-ignored untracked path with its mode and content identity; it shall recursively content-address a reported nested Git worktree and shall exclude ignored-only paths, Git administrative data, and timestamps.
An observation that changes while it is sampled, encounters an index flag suppressing tracked-worktree inspection, or cannot represent a reported path and its content identity losslessly shall fail closed as ambiguous rather than publish a mixed or lossy projection.
For receipt classification, a call is effect-authorized exactly when at least one declared outcome carries `one-descendant-commit`, and it is declared exclusively `unchanged` exactly when every declared outcome carries `unchanged`, using the repository-disposition contract under [[playbook-runtime-50](#playbook-runtime-50)].
When a complete after observation is reconciled with a baseline, the observer shall classify exactly:

- `unchanged` only when HEAD and the complete projection are byte-equal;
- `one-descendant-commit`, carrying the after OID, only when after HEAD is exactly one commit descended from baseline HEAD and the complete projection is byte-equal;
- `multiple-commits` for more than one descendant commit;
- `rewritten-or-non-descendant` for ancestry loss;
- `worktree-only-change` for a same-HEAD projection delta from an effect-authorized call only when every pre-existing projection entry remains byte-equal;
- `concurrent-or-foreign-change` for any delta from a call declared exclusively `unchanged`; and
- `observation-ambiguous` for an unstable or lossy observation, an effect-authorized changed pre-existing overlay, post-commit residual, cohort overlap, or other delta that cannot be attributed uniquely.

Receipt classification shall compare the complete projections and ancestry without a post-hoc path filter, shall treat byte- and mode-identical pre-existing dirt as zero delta, and shall not claim that cooperative observation excludes or identifies every foreign writer.

### Durable effect ledger

#### playbook-runtime-69

Where a schema-3 delegated-player boundary is governed by [[playbook-runtime-50](#playbook-runtime-50)], the current host's effect ledger shall be an exact detached plain-JSON value `{ schemaVersion: 1, revision, boundaries, logicalOperations }` whose nonnegative `revision` is zero if and only if both ordered ledgers are empty and otherwise advances once for each accepted non-idempotent batch, whose `boundaries` have contiguous positive `sequence` in physical order from one, and whose `logicalOperations` have their own contiguous positive `sequence` from one in first-physical-boundary order ([DR-040](../decisions/040-outcome-authority-effect-reconciliation.md) §2-§4).
Each physical boundary shall contain exactly `sequence`, UUID `boundaryId`, UUID `attemptId`, positive `attemptNumber`, `playbookId`, UUID `runtimeSessionId`, positive `turnId`, nonempty `callId`, `roleId`, and `sourceStateId`, exact detached plain-JSON `sourceOutcomeSchema`, the nonempty deduplicated ordered `dispositions` supplied from the schema-3 authority already validated under [[playbook-runtime-50](#playbook-runtime-50)], canonical `{ worktree, gitDir }`, detached `baseline`, optional detached `after`, optional `physicalReceipt`, optional opaque `finalText`, optional plain-JSON `semanticCandidate`, optional plain-JSON `initialSemanticCandidate`, exact `correctionBudget: { limit: 1, spent: boolean }`, optional host-owned UUID `cohortId`, and optional UUID `logicalOperationId`; `initialSemanticCandidate` shall occur only after one spent correction replaces `semanticCandidate`, shall equal that prior candidate, and shall then remain immutable with the replacement.
A `cohortId` shall occur on every and only member of one contiguous all-`unchanged` group, shall be unique to that group, and shall bind distinct roles whose order is one artifact-declared concurrent role set; every member shall share attempt, playbook, runtime-session, turn, canonical-worktree, and baseline identity and shall be uniformly started or uniformly complete, complete members shall carry the identical after observation and receipt, and no later boundary may reuse the id.
A complete physical receipt shall contain exactly `classification` from [[playbook-runtime-67](#playbook-runtime-67)], the exact `baseline`, optional complete `after`, and optional `commitOid`; its observations shall equal the enclosing boundary members, a boundary `after` shall occur only with that receipt in the same atomic update, `after` shall be absent only for `observation-ambiguous`, `commitOid` shall occur if and only if it proves `one-descendant-commit` and shall equal `after.head`, and a started boundary with no after and receipt is effect-possible and shall never be represented as completed.
Each logical operation shall contain exactly `sequence`, UUID `operationId`, `playbookId`, UUID `runtimeSessionId`, a nonempty physical-order unique `boundaryIds` list, `originalBaseline`, optional latest `checkpoint`, optional exact pending question with nonempty exact identity and nonblank content, optional opaque detached JSON `playerContinuation`, boolean `checkpointRestorationEligible`, and optional cumulative `logicalReceipt`; its first boundary, original baseline, prior boundary-id prefix, and completed receipt shall remain fixed; every named boundary shall exist, reciprocally name that operation, share its playbook and runtime-session identity, use the first boundary's exact baseline as the operation's original baseline and its canonical worktree, and after the first start from the preceding boundary's complete after checkpoint; its checkpoint shall equal its latest boundary's after observation; the checkpoint, pending question, and player continuation shall occur together or all be absent; and eligibility shall require that bound group.
A replacement may append physical-order boundary ids and replace or clear the complete current bound group together with eligibility, while an existing logical receipt remains immutable. The optional receipt shall require every physical receipt and reconcile the original baseline with the final after observation rather than replace any physical receipt ([DR-040](../decisions/040-outcome-authority-effect-reconciliation.md) §4).
No boundary or logical operation shall carry a capability function, abort signal, lease-owner token, repository-claim handle, session-store handle, or other live object.
The capability shall expose its complete current mirror synchronously and one atomic `writeAhead` accepting a nonempty ordered batch drawn from exactly four nonempty command variants: `start-boundaries`, whose `PlaybookEffectBoundaryStart` inputs omit store-owned `sequence`, `attemptId`, and `attemptNumber` plus completion-only `after`, `physicalReceipt`, `finalText`, `semanticCandidate`, and `initialSemanticCandidate`; `replace-boundaries`, whose `replacements` entries carry an exact expected and next boundary under one identity; `append-logical-operations`, whose `operations` inputs omit store-owned `sequence`; and `replace-logical-operations`, whose `replacements` entries carry an exact expected and next operation under one identity.
The host shall apply the batch's commands in order as one ledger transition, validate the final cross-reference graph after the complete batch, and acknowledge only one atomic persistence and revision increment; an exact start or append replay under the same boundary or operation identities and payload shall return the same detached frozen acknowledgement without advancing revision, while conflicting identity reuse, a stale replace `expected` value, a changed immutable member, non-prefix start, nonmonotonic replacement, or final cross-reference violation shall reject the complete batch without mutation. A spent correction may replace `semanticCandidate` exactly once only while adding `initialSemanticCandidate` equal to the prior candidate; neither candidate may then change.
The runtime shall replace its synchronous mirror only with the detached frozen ledger acknowledged after the host's atomic durable write, and schema-3 runtime construction, restore, and adoption shall require that full mirror to equal the current host mirror; schema-2 runtimes and the internal compiled Captain runtime shall instead use the canonical empty version-1 ledger at revision zero.
Before a player begins, the coordinator shall persist one started boundary containing the captured baseline; a declared cohort shall assign one fresh shared `cohortId` and persist every member's start in one batch before any member begins.
After the operation settles and while the cooperative claim remains held, the coordinator shall persist the complete after observation, physical receipt, available envelope evidence, and any logical-operation update; an optional live completion mapper may supply only `finalText`, `semanticCandidate`, `logicalOperationId`, additional typed ledger commands for that same atomic completion, one `deferred` binding carrying optional UUID `operationId` plus exact `pendingQuestion` and `playerContinuation`, or literal `unresolved: true`, where `deferred` shall be mutually exclusive with `unresolved`, `logicalOperationId`, and commands under [[playbook-runtime-73](#playbook-runtime-73)]; the mapper shall never itself enter persisted data, and a cohort shall persist all member receipts in one batch before release.
Every successfully completed governed-call transaction—an exclusive call, deferred continuation, or cohort—shall return the acknowledged ledger and its exact completed-boundary `physicalReceipt` values, and a completed deferred chain shall additionally return its acknowledged logical operation's exact `logicalReceipt`; no pre-persistence capture or divergent receipt shall become runtime reconciliation evidence.
Where that post-operation persistence fails or is indeterminate, the current host shall quarantine the repository claim together with the exact proposed completion batch, and authoritative same-process recovery shall retry that batch or retire an already acknowledged claim. Where the operation has started but receipt capture, completion mapping, or detached-batch construction fails before an exact batch exists, the live claim shall remain quarantined and same-process recovery shall neither synthesize evidence nor release it; only process death shall permit a successor to reconstruct missing evidence from the persisted baseline, and no path shall release the claim around an unrecorded effect.

### Automatic replay fence

#### playbook-runtime-71

Where a delegated-player boundary is governed by an artifact-schema-3 outcome contract [[playbook-runtime-50](#playbook-runtime-50)], the runtime shall authorize either of the following forms of runtime-local automatic replay only from the current host-acknowledged durable effect ledger of [[playbook-runtime-69](#playbook-runtime-69)] under [DR-040](../decisions/040-outcome-authority-effect-reconciliation.md) §4:

- The empty-`ok` corrective re-ask of [[playbook-runtime-9](#playbook-runtime-9)] may start only after its preceding physical boundary occurs in the acknowledged mirror with a complete `physicalReceipt` whose `classification` is exactly `unchanged`.
- The failure-state entry-event retry of [[playbook-runtime-1](#playbook-runtime-1)] and [[playbook-runtime-52](#playbook-runtime-52)] may be mapped, advertised, or accepted only when every governed physical boundary in the failed host attempt's `attemptId` group occurs in that mirror with a complete `physicalReceipt` whose `classification` is exactly `unchanged`.

A missing boundary, missing receipt, incomplete boundary, or any other classification shall start no corrective player call, shall suppress every ordinary failure-state retry derived from that attempt, and shall retain the acknowledged ledger evidence unchanged for later reconciliation.
When a governed runtime enters its failure state, it shall bind the retry decision to every effect-ledger boundary appended since the causal public boundary began, including a nested or sibling runtime's boundary: an exportable failed snapshot shall carry `failedEffectAttempt` with the exact pre-boundary `boundaryPrefix` and the one causal host-attempt UUID as `attemptId`, use `null` as that attempt id only when the ledger suffix after the prefix is empty, or omit the member when the causal attempt is unknown; restore shall preserve those three meanings, and an unknown or multi-attempt causal set shall authorize no replay.
Where that public boundary suspends a nested playbook call before it can fail, the suspended-call snapshot shall preserve the same prefix as nonnegative `effectBoundaryPrefixSequence`, use explicit `null` when the prefix observation is unknown, and restore it for the eventual child-result boundary; a legacy snapshot that omits it shall conservatively use the complete ledger.
The fence shall not alter artifact-schema-2 or nongoverned delegated calls, authored Boss-reply continuations, or direct-Captain corrective re-asks.

### Deferred Boss continuation

#### playbook-runtime-73

Where an artifact-schema-3 delegated-player candidate selects a `deferred` `needsBossReply` arm under [[playbook-runtime-50](#playbook-runtime-50)], the runtime and current host shall maintain one logical operation under [[playbook-runtime-69](#playbook-runtime-69)] for the complete authored question chain ([DR-040](../decisions/040-outcome-authority-effect-reconciliation.md) §4).
The first or a repeated question shall become pending, emit status, or enter an exportable wait only after its physical boundary has a complete same-HEAD after observation with neither rewritten or multiple-commit history nor concurrent, foreign, or ambiguous evidence, and while the same-worktree claim remains held the host has atomically bound that boundary to the operation's stable UUID, immutable original baseline, full physical-order boundary chain, latest after checkpoint, exact pending question, and exact detached session-player continuation selection, using explicit `false` where no resume token exists.
Where a later nonblank Boss turn classifies as a valid reply to that exact pending question, the host shall reacquire the exclusive same-worktree claim, compare one current observation with the complete saved checkpoint, and start exactly one authored question-and-answer player continuation only when they are equal; before the player begins, one acknowledged atomic ledger update shall append and reciprocally link its new physical boundary and clear the consumed checkpoint, question, continuation, and restoration eligibility without persisting the Boss answer.
Where that continuation produces another admissible `deferred` candidate, the host shall replace the bound checkpoint, question, and continuation before claim release or publication while preserving the operation id, original baseline, and every physical receipt; where it produces a final semantic candidate, only the complete cumulative `logicalReceipt` from the original baseline through the final after observation shall reconcile that arm, and the last physical receipt shall remain checkpoint evidence rather than outcome authority.
An empty, malformed, unknown-question, guard-rejected, or otherwise invalid reply shall leave the exact wait and logical operation unchanged and start no player.
A valid reply whose current observation differs from the checkpoint shall start no player, persist neither the answer nor a new boundary, preserve the exact bound wait, and atomically set only that operation's `checkpointRestorationEligible` to true before entering unresolved reconciliation; any fresh directive or other exit from the wait shall likewise start no player but shall clear the bound checkpoint, question, and continuation with eligibility false before entering unresolved reconciliation.
Where an explicit reconciliation retry addresses a still-bound eligible operation, the host shall reacquire the exclusive claim and compare the current observation with its checkpoint; equality shall atomically consume eligibility and republish the identical stable pending question without a player call, judge call, or semantic-candidate delivery, while inequality or any other retry shall leave the operation unresolved and unchanged and start no call.
The open logical-operation states shall therefore remain distinguishable after restore: a complete bound triple with eligibility false is the ordinary wait, that same triple with eligibility true is a checkpoint-restorable unresolved wait, an absent triple with eligibility false is a nonrestorable unresolved exit, and a `logicalReceipt` is a completed chain.
Where an artifact-schema-3 governed `needsBossReply` arm instead declares `unchanged`, the runtime shall publish the question only after its exact matching physical receipt is acknowledged under [[playbook-runtime-77](#playbook-runtime-77)], shall create no logical operation and therefore no operation-owned checkpoint, pending-question copy, player-continuation copy, or restoration eligibility, and shall route a later valid answer under [[playbook-runtime-7](#playbook-runtime-7)] through the ordinary authored Boss-reply continuation as a new separately governed physical boundary.
Artifact-schema-2 and nongoverned Boss-question paths shall retain their existing continuation behavior.

### Session lifecycle

#### playbook-runtime-6

When `init({ sessionId, playbookId, rootSessionId, parentSessionId,
parentCallId, depth, roleBindings, playerSessions, ports })` is called with valid identity fields, the
runtime shall bind that identity and detached optional binding metadata immutably for its lifetime, validate an exact local-role key set with nonempty player and prompt identities when supplied, construct the FSM actor from options that contain no host identity, and start it,
leaving the FSM in its idle
state. When `dispose()` is called, the runtime shall stop the
actor, abort a pending nested call, and drain any pending port
emissions; stopping the actor shall emit no status, no FSM-state
telemetry, and no state-transition trace, so the only boundary
disposal reports for a runtime parked outside a final state is its
own session disposal. Root sessions shall require
`rootSessionId === sessionId`,
no parent fields, and depth zero; child sessions shall require matching
parent session/call fields, positive depth, and a session id distinct from
both the root and immediate parent ids. When `handleBossInput`
or `resumePlaybookCall` is called before `init`, the runtime shall throw.

### Boss-event classification

#### playbook-runtime-7

When a runtime receives empty or whitespace-only Boss text, it shall record and settle the input trace but shall produce no event, judge call, player call, status emission, or FSM transition.
When no Boss question is pending, the current CODE, REVIEW, and DECIDE runtimes shall use their deterministic initial event under [[playbook-runtime-1](#playbook-runtime-1)].
When no Boss question is pending and the machine is parked outside [[playbook-runtime-1](#playbook-runtime-1)]'s deterministic entries — an authored mid-workflow checkpoint — the runtime shall classify nonempty ordinary and slash-prefixed text alike against that state's configured Boss-event contracts: through the artifact's own declared deterministic classifier where it supplies one, as the compiled Captain's parked mapping does ([[captain-playbook-9](captain-playbook.md#captain-playbook-9)]), and otherwise through `callJudge` with the exact, unmodified Boss message in a clearly labelled block of the classifier prompt.
While one or more Boss questions are pending, the runtime shall call `callJudge` with the current structured state, every pending question and stable id, and the artifact-declared reply, interrupt, and no-action contracts.
A question is pending here on the reply-wait terms of [[playbook-runtime-45](#playbook-runtime-45)]: outside an authored reply-wait state the classifier prompt shall carry no question context and offer no reply contract, however long the machine's context retains the answered question.
The runtime shall accept an omitted `questionId` only when exactly one question is pending, attach the Boss text verbatim to the selected event, and clear pending context abandoned by an interrupt.
The runtime shall parse the judge reply with the tolerance of [[playbook-runtime-10](#playbook-runtime-10)] and shall emit one status with no FSM event when the reply is malformed or invalid for the live state.

### Player binding

#### playbook-runtime-8

When resolving a compiled workflow's player invocation, the runtime shall use the invocation's compiler-supplied canonical local role id unchanged — `coder` for Coder and `reviewer` for Reviewer in the current workflows — while leaving the host to resolve that local role to the frame's effective binding per [[playbook-captain-10](playbook-captain.md#playbook-captain-10)].

### Captain bridge

#### playbook-runtime-9

While driving a Boss turn, for each FSM player invocation the
runtime shall consume the canonical local role id unchanged ([[playbook-runtime-8](#playbook-runtime-8)]), compose
the player prompt ([[playbook-5](playbook.md#playbook-5)] and
[[playbook-6](playbook.md#playbook-6)]), and call
`callPlayer(roleId, prompt, signal, options)` with the explicit
resume selection required by [[playbook-runtime-38](#playbook-runtime-38)]. When the result status is
`ok` with a non-empty, non-whitespace-only `finalText`, the
runtime shall adjudicate that text
([[playbook-runtime-10](#playbook-runtime-10)]) and return the adjudicated `CaptainOutput`
so the FSM advances. When the result status is `ok` but
`finalText` is missing, empty, or whitespace-only, the runtime
shall issue exactly one corrective re-ask, subject for a governed artifact-schema-3 boundary to the automatic-replay fence of [[playbook-runtime-71](#playbook-runtime-71)]
([DR-028](../decisions/028-empty-ok-result-re-ask.md)): the same
composed call repeated through the same boundary, with resume
selection again per [[playbook-runtime-38](#playbook-runtime-38)] — continuing the player
session when the first result carried a resume token, fresh when
it cleared one — traced as its own
player-call pair, and its result interpreted under these same
rules — except that a second missing, empty, or whitespace-only
`ok` `finalText` shall make the runtime throw with no further
re-ask. When the result status is not `ok`, the runtime shall
throw with no corrective re-ask. Either throw routes the FSM
through its error path to the failure state. A rejecting
player-call trace emission shall trigger no corrective re-ask; it
remains a control-plane error for the turn's drain, as at the
direct-Captain boundary ([[playbook-runtime-47](#playbook-runtime-47)]).

#### playbook-runtime-47

While driving a Boss turn, for each FSM direct-Captain invocation, when
`callCaptain` returns a host result whose status is not `ok` or whose
`finalText` is missing, empty, or whitespace-only — the same empty
predicate the delegated-player bridge applies ([[playbook-runtime-9](#playbook-runtime-9)]) — the
runtime shall record that failure on that call's single
`captain.call.finished` trace.
For the not-`ok` status the runtime shall then throw the failure from the
invoked actor with no corrective re-ask.
For the empty `ok` result the runtime shall first issue exactly one
corrective re-ask
([DR-028](../decisions/028-empty-ok-result-re-ask.md)) — the same
direct-Captain call repeated through the same boundary with the
originating call's continuity policy unchanged (DR-028's retry-continuity
bullet), traced as its own
`captain.call.started` / `captain.call.finished` pair — and interpret the
second result under these same rules, except that a second missing, empty,
or whitespace-only `ok` `finalText` shall throw with no further re-ask.
Either throw shall route the FSM through its error path to the failure
state and shall not be treated as a control-plane error.
`handleBossInput` shall therefore resolve the structured `failed` outcome
carrying that failure as the state's error, exactly as it does for the
equivalent delegated-player result ([[playbook-runtime-9](#playbook-runtime-9)]), rather than reject
([[playbook-runtime-41](#playbook-runtime-41)]).
A non-abort thrown `callCaptain` port, a malformed host result, and a rejecting
trace sink remain control-plane errors ([[playbook-runtime-41](#playbook-runtime-41)]) and shall trigger
no corrective re-ask; a transport or trace-sink
failure causally identical to the active signal's reason remains ordinary abort
settlement ([[playbook-runtime-13](#playbook-runtime-13)]).

Where the required `captain.call.finished` emission itself rejects, the
runtime shall issue no corrective re-ask and shall keep the host-result
failure as the invoked actor's error so
the failure state records it, while the non-abort emission failure remains the
control-plane error the turn's drain surfaces ([[playbook-runtime-41](#playbook-runtime-41)]).

### Adjudication

#### playbook-runtime-10

When adjudicating a player's `finalText`, the runtime shall call
`callJudge` with a prompt that names the invoked player, includes
the player's output verbatim, and lists every guard key of the
FSM state's `result` map with its description verbatim. It shall
require a JSON object reply carrying a `guard` field equal to one
of those keys.
For artifact schema `2` and a nongoverned delegated-player call, the reply shall carry a string value for every payload field the
chosen guard's description marks as required, except for each field
marked `<verbatim final text>` — for such a field the runtime shall carry
`finalText.trim()` into the resulting `CaptainOutput` regardless of any
judge-supplied value, so player prose is not round-tripped through judge JSON.
For those calls, other declared fields shall stay judge-extracted and type-validated.
The judge prompt shall direct the judge not to populate verbatim fields. It shall identify the call as
hidden control work, prohibit tool use, file inspection, and external evidence,
direct the judge to decide only from the supplied player output and declared
outcomes, and require exactly one JSON object with no prose.
An artifact-schema-3 governed delegated-player call shall instead validate and assemble that reply under [[playbook-runtime-77](#playbook-runtime-77)].
The runtime shall parse the judge reply tolerantly before
validating it: it shall recover the intended JSON object even when
that object is wrapped in surrounding prose or a Markdown code
fence — including when the surrounding prose contains other
bracketed fragments (an aside such as `see [1]` shall not mask the
real object) — carries a trailing comma before a closing brace or
bracket, or is truncated with an unterminated string or an unclosed
object/array (completing the unclosed structures). When the reply
contains more than one recoverable JSON object, the runtime shall
return the first in document order, preferring a strict parse at
each candidate position and only then a repaired one, so an earlier
intended object that needs repair is not overridden by a later,
cleanly-formed object. A reply is malformed only when no JSON value
can be recovered from it.
For artifact schema `2` and a nongoverned delegated-player call, a reply that is malformed, names an undeclared guard, or omits a required extracted non-verbatim field shall cause the runtime to throw; an artifact-schema-3 governed call shall follow the bounded correction and parking contract of [[playbook-runtime-77](#playbook-runtime-77)].

#### playbook-runtime-77

Where an artifact-schema-3 delegated-player boundary is governed by [[playbook-runtime-50](#playbook-runtime-50)], the shared engine shall apply the hidden adjudication and JSON-recovery boundary of [[playbook-runtime-10](#playbook-runtime-10)] through one semantic reconciler that accepts only a detached plain-JSON candidate containing exactly one declared `guard` plus every and only semantic-owned string field required by that outcome, rejects a missing, extra, wrongly owned, invalid, or mutually inconsistent field before FSM delivery, preserves the exact nonempty `finalText` as opaque presentation evidence, supplies each presentation-owned field only from its canonical trimmed value, supplies effect-owned `latestCommit` only from a matching `one-descendant-commit` receipt's exact OID under [[playbook-runtime-67](#playbook-runtime-67)], and supplies any runtime-owned field only from explicit runtime evidence ([DR-040](../decisions/040-outcome-authority-effect-reconciliation.md) §1 and §3).
For `unchanged` and `one-descendant-commit`, the reconciler shall resolve only when the complete physical receipt, or a deferred chain's cumulative logical receipt, exactly matches the selected outcome's declared repository disposition; for `deferred`, it shall admit only the already-valid effect-authorized `needsBossReply` arm from a complete `unchanged` or `worktree-only-change` receipt whose after HEAD equals its baseline HEAD, and the actor output shall become deliverable only after the host durably binds the checkpoint and continuation under [[playbook-runtime-73](#playbook-runtime-73)].
After a first structurally invalid semantic reply, the runtime shall make at most one corrective hidden judge call over the identical retained presentation evidence and outcome schema with the validation error restated, and shall start that call only after it has awaited an exact durable compare-and-swap acknowledgement changing that physical boundary's correction budget from unspent to spent while retaining its physical receipt, opaque presentation, and recoverable invalid candidate through [[playbook-runtime-69](#playbook-runtime-69)] and has rechecked the live abort signal under [[playbook-runtime-13](#playbook-runtime-13)].
A failed, indeterminate, stale, or mismatched spend, a previously spent budget, or an abort before the corrective call begins shall start no corrective judge and shall never replenish the budget across restart; a second structurally invalid reply shall receive no further correction; an initial or corrective judge transport or result-shape failure shall trigger no corrective or third call respectively; and a player abort, error, non-`ok` result, or missing nonempty `finalText` shall trigger no adjudication under [[playbook-runtime-9](#playbook-runtime-9)].
Only a complete authority-consistent envelope shall deliver its exact frozen reconciled output once to the FSM after the applicable evidence update is durably acknowledged; completion shall retain the opaque presentation and the latest recoverable detached plain-JSON semantic candidate, including a structurally invalid candidate, without parsing either for a repository fact, and when correction replaces that candidate it shall preserve the first candidate immutably as `initialSemanticCandidate`, while a malformed reply from which no JSON value can be recovered may omit both candidates, effect-possible missing, incomplete, invalid, or inconsistent evidence shall deliver no output and remain parked for reconciliation, and retained evidence shall start no replacement player or judge after restart.
A complete retained envelope may reconcile and deliver once without another player or judge only after restoration reaches its exact matching source state; until then it shall remain parked.

### Drive to quiescence

#### playbook-runtime-11

When `handleBossInput` sends a classified event to the FSM, the
runtime shall use XState `waitFor` to drive the actor until no state
tagged `playbook.busy` is active — the idle state, the failure state,
the terminal state, a nested-call suspension, or the
`awaitBossReply` Boss-reply suspension state (per
[slc/gears2fsm.md "Boss-reply suspension"](../../slc/gears2fsm.md#boss-reply-suspension))
— and only then return. Before returning it shall drain pending
port emissions and return the matching `PlaybookRunResult`.

#### playbook-runtime-12

When `handleBossInput` is called while the actor is in the
terminal state, the runtime shall leave the actor untouched for empty input and shall
dispose and reconstruct it only after a nonempty input produces the artifact's valid
initial event, so that event starts from the idle state.
Under the Playbook Captain shell, final root engagements are
disposed per [[playbook-captain-11](playbook-captain.md#playbook-captain-11)], so this
item remains the direct-runtime behavior.

### Abort

#### playbook-runtime-13

The runtime shall forward `handleBossInput`'s `signal` to every
`callPlayer`, `callCaptain`, and `callJudge` call by combining it with each
XState invocation-lifetime signal. On abort the runtime shall
take no synthetic FSM action: a cancelled player or direct-Captain call's
failure propagates through its invoked actor and the FSM's error path to the
failure state, whose `lastError` the runtime surfaces per
[[playbook-runtime-14](#playbook-runtime-14)].
A player, direct-Captain, or judge host call shall not start once its
combined signal has aborted — including an abort that lands while that
call's own started-trace emission drains: the already-started pair
finishes `aborted` with no host call made.
The runtime shall forward the XState playbook invocation's lifetime
signal to `callPlaybook`; after a later child return it shall forward
`resumePlaybookCall.signal` to any newly resumed player, Captain, or judge work.
The runtime shall classify a rejection as cancellation only by exact identity with the applicable signal's reason — the invocation-lifetime combined signal, and during a resume that boundary's own signal; an `AbortError`-named failure that is not that exact reason, and any distinct failure observed while the signal is aborted, remains a non-abort control error under [[playbook-runtime-41](#playbook-runtime-41)]'s precedence.
Classification shall live at each latch or report site, so a failure causally identical to the applicable reason is handled there under the phase rules below — never mislabeled as a distinct failure and never carried to an unrelated later boundary ([DR-036](../decisions/036-coherent-abort-settlement.md)).
The runtime shall classify a root-actor error and a latched emission failure by that same exact identity: one causally identical to the boundary signal's reason settles as the abort it evidences; any other shall reject the boundary and shall never escape it as an unobserved actor error.
A public boundary shall settle on the machine's state at its quiescence point, in this precedence: a suspended pending call, then a distinct actor error, then terminal completion, then a coincident abort, then the recoverable failure state; an abort observed after the outcome is computed shall not rewrite it, and a settlement-channel rejection causally identical to the abort reason is forgiven ([DR-036](../decisions/036-coherent-abort-settlement.md)).
An already-aborted resume is the entry-refusal exception defined by [[playbook-runtime-42](#playbook-runtime-42)]: it reports `aborted` while preserving its suspended pending call, and the suspended-call precedence above applies only after delivery begins.
A `handleBossInput` boundary entered with an already-aborted signal shall record only its received/settled boundary, classify no text, start no host call or script, leave the machine state unchanged, and report `aborted`.
A start-channel rejection causally identical to the applicable abort reason shall start no host call or effect and shall latch no control error; when the start was recorded, it shall receive one best-effort `aborted` finish. A `handleBossInput` or `resumePlaybookCall` boundary shall then settle through the precedence above, while a pre-acceptance `apply` shall reject with that exact reason, record no receipt, and leave its key reusable.
After a host call or effect starts but before its finish or outcome is recorded, a host, abort-cleanup, observer, or in-flight-emission rejection causally identical to an applicable abort reason shall remain cancellation evidence: invocation-owned cleanup completes, a started trace pair receives one `aborted` finish, and the ordinary boundary settles through the precedence above. Every distinct rejection in that phase shall remain a control failure, produce the applicable error finish, and take distinct-error precedence.
When a call finish has already been recorded but the enclosing non-apply outcome has not been computed, an identical finish-sink or drain rejection shall leave that finish unchanged, emit no corrective second finish, latch nothing, and let the enclosing boundary settle through the precedence above.
After apply acceptance but before receipt publication, every settlement failure — including the exact apply abort reason — shall fold into the current `failed` receipt instead of throwing or becoming a later delivery failure, as [[playbook-runtime-52](#playbook-runtime-52)] specifies.
After a non-apply outcome is computed or an apply receipt is published, an identical rejection shall be dropped without rewriting the outcome or receipt and without poisoning a later boundary. A distinct non-apply settlement rejection shall retain current-boundary control-error precedence; a distinct post-publication apply rejection shall retain the published receipt and travel on the delivery-failure channel to the next boundary that drains.
When a script actor's invocation aborts — whenever the abort lands before the invocation settles, an abort observed only after the shell's own exit included — the runtime shall terminate the detached shell's entire process group, SIGTERM then SIGKILL after a bounded grace, and the actor shall reject with the exact signal reason only after the shell has exited and an `ESRCH` liveness probe confirms that the group stopped being signalable; the enclosing public run boundary shall then settle through the precedence above. The same bounded grace caps the post-SIGKILL teardown wait, and abort ownership spans the whole invocation rather than the spawn-to-exit window. If the bound expires while the group remains signalable, or the probe fails without `ESRCH`, the boundary shall reject with a distinct teardown control error rather than report a clean abort over unconfirmed cleanup.
An abort observed only after the shell's exit shall additionally reject before guard resolution and before starting any script emission not already in flight; an emission already started when the abort lands completes through the ordinary serialized channel; a descendant that has left the process group is beyond the kill scope.
The public boundary shall not resolve while its invocation is still running:
it shall await the natural error transition, quiescence, all paired finish
traces, and all ordered emissions so no work from the turn mutates state after
return.

### Status and telemetry

#### playbook-runtime-14

On every FSM transition the runtime shall call `emitTelemetry`
with topic `playbook.fsm.state` and a payload carrying structured
`from`, `to`, `event`, `previousState`, and `state` fields per
[[playbook-runtime-41](#playbook-runtime-41)].
Before that state telemetry, the runtime shall emit the corresponding
`playbook.trace` `fsm.transition` event per [[playbook-runtime-37](#playbook-runtime-37)].
Where the transition is a failed-transition event carrying an
`error` field (e.g., `xstate.error.actor.*`), the runtime shall
normalize that `event.error` to a full `{ name, message, stack }`
shape; on entry to the failure state it shall additionally
include the context-level `lastError` in the telemetry payload
in the same full `{ name, message, stack }` shape, so observers
can debug fail-stop paths without losing the original stack.
`context.lastError` itself stays unchanged as the original Error
instance for downstream FSM consumers; normalization happens only
at emission boundaries.

Where a factory-backed artifact supplies linker-emitted `roleStates` and no artifact-specific status override, the runtime shall emit the canonical stream of [[playbook-runtime-3](#playbook-runtime-3)]: the selected event type before dispatch, exact `→ <guard>` from a schema-2 settling output or exact `→ <acceptedOutcome>` from schema-3 confirmed evidence, metadata-derived role entry, failure, and two-line Boss-wait statuses, with no payload tally or raw state-id fallback.
The canonical failure status shall carry `lastError` as compact `{ name, message }` data rather than a raw Error.
The corresponding Boss-wait telemetry shall carry the selected pending question verbatim alongside the other transition fields so a non-tmux host can render it.

All trace, status, and state-telemetry emissions shall use one runtime-owned
concurrency-one queue, be issued in order, each awaited before the next, and
never dropped. Sequence allocation and enqueueing shall be atomic; every public
runtime method shall drain the queue before resolving or rejecting.

#### playbook-runtime-81

Where an artifact supplies schema `3`, the shared and bespoke linked runtimes shall recognize only a root-machine XState action whose type is exactly `playbook.acceptedOutcome` and whose exact plain-data params are `{ source, target, acceptedOutcome }`, require `source` and `acceptedOutcome` to name a declared governed outcome of [[playbook-runtime-50](#playbook-runtime-50)], and retain it privately until the corresponding next public root snapshot confirms `source` in the prior snapshot and `target` in the new snapshot under [DR-040](../decisions/040-outcome-authority-effect-reconciliation.md) §6.
Each confirmed marker shall produce one trace-schema-4 `outcome.accepted` event carrying those exact three fields per [[playbook-runtime-37](#playbook-runtime-37)] and, where the canonical status profile applies, one exact `→ <acceptedOutcome>` status per [[playbook-runtime-3](#playbook-runtime-3)]; markers confirmed together shall retain their XState execution order, and all such emissions shall drain before the public boundary settles.
A valid unmarked transition, including an unexecuted guarded arm or rejected-guard fallback, shall settle normally without accepted-outcome evidence or claimed-outcome status.
An executed marker that is malformed, undeclared, or unconfirmed by those adjacent snapshots, or a batch that instruments one governed source more than once regardless of target or outcome, shall clear that entire pending marker batch and fail the current public boundary after retaining the ordinary transitioned state but before public settlement, accepted-outcome evidence, or claimed-outcome status; the runtime shall use only public XState inspection events and root snapshots rather than underscore-prefixed inspection fields.
Artifact schema `2` shall ignore the marker contract and retain its legacy settling-output guard status path until the schema cutover.

#### playbook-runtime-57

Where a factory-backed artifact supplies artifact schema `2`, the runtime shall require complete local-role `roleStates` metadata even when an artifact-specific status override exists; missing metadata shall reject at construction instead of selecting metadata-absent legacy status defaults.

### Host adapter and registry

#### playbook-runtime-15

Where the shell constructs CODE, REVIEW, or DECIDE, the initialized runtime shall receive each local role's resolved player id and prompt identity only through the host-supplied `PlaybookSession.roleBindings` of [[playbook-captain-10](playbook-captain.md#playbook-captain-10)]; the runtime and registry shall neither derive nor override those host identities and shall not copy model or player identity into runtime options, machine input, or persisted FSM context.
Prompt composition shall read the current role binding at invocation time, so restoring an opaque machine snapshot under compatible changed model tuning cannot retain the earlier model identity in a player prompt.
For a factory-backed artifact, `composePlayerPrompt` shall receive only an invocation-scoped `promptIdentity(roleId)` lookup as its second argument; that lookup shall resolve the current detached binding, fall back to the canonical local role id when bindings are absent, reject undeclared roles, expose no player id or binding map, and remain absent from runtime options, machine input, FSM context, and snapshots.
Each registry shall publish only the summary labels and handoff guards its current FSM owns, with CODE excluding REVIEW's child rounds, REVIEW labeling its review and rebuttal rounds, and DECIDE labeling its independent-proposal round.

#### playbook-runtime-16

Where CODE, REVIEW, or DECIDE runs through composed config, the host Captain module shall be `@sublang/playbook/playbook-captain` and the enabled entry shall use the matching public `@sublang/playbook/<id>/registry` module per [[playbook-captain-16](playbook-captain.md#playbook-captain-16)] and [[playbook-captain-17](playbook-captain.md#playbook-captain-17)].
Each registry shall map a dispatched Boss turn to `runtime.handleBossInput({ text, signal })` and shall expose no direct tmux-play adapter.

#### playbook-runtime-30

During shell initialization, each CODE, REVIEW, and DECIDE registry shall accept an absent or empty object as its option slice and shall reject a non-object or any unknown key with a diagnostic naming `captain.options.playbooks.<id>.options` and the offending key when present.
The registry shall validate only the option slice the shell passes it and shall retain the validated value for later runtime construction.

### Session trace and player continuation

#### playbook-runtime-37

Where a host initializes a linked playbook runtime with a
`PlaybookSession`, the runtime shall emit telemetry topic
`playbook.trace` carrying the immutable session and playbook ids and
trace schema version `4` defined by [slc/link.md](../../slc/link.md#playbook-trace), retaining the session causality introduced by [DR-011](../decisions/011-composable-playbook-execution.md) §5, the trace-schema-3 player identity split from [DR-010](../decisions/010-playbook-session-tracing-and-resume.md) §2, and the accepted-outcome evidence of [[playbook-runtime-81](#playbook-runtime-81)].
The trace sequence shall be contiguous and one-based for that session;
Boss turns and player/Captain/judge calls shall receive one-based ids, and a
call's started and finished events shall share its call id.
When a `*.call.started` sink records the event and then rejects with a
failure that is not causally identical to the applicable signal's
reason, no host
call shall begin and the runtime shall make one best-effort paired error
finish preserving the start's call id and prompt metadata before
rejecting with the original sink error, latched as the control-plane
error ([slc/link.md](../../slc/link.md#playbook-trace)).
A start-sink rejection causally identical to that reason is the
cancellation itself: no host call begins, the best-effort paired finish
carries `status: 'aborted'`, nothing is latched, and the turn settles as
an abort ([[playbook-runtime-13](#playbook-runtime-13)], [DR-036](../decisions/036-coherent-abort-settlement.md)).
The runtime shall trace session start/disposal, exact Boss input and
settlement, exact player, Captain, and judge prompts and results, normalized
errors, every FSM transition, every confirmed accepted outcome, and every status emission.
No trace event with schema version below `4` shall be accepted as authority-bearing accepted-outcome evidence.
Where a runtime starts through retained-snapshot adoption, its trace shall begin with the ordinary `session.started` boundary under the fresh target causality and the adoption-lineage payload of [[playbook-runtime-65](#playbook-runtime-65)], rather than continue the source trace sequence or introduce a second session-start type.
Each player-call trace pair shall carry the local `roleId` and, where the host supplied binding metadata, the resolved `playerId`; its start and finish shall retain the same values.
Direct Captain calls shall use paired `captain.call.started` and
`captain.call.finished` events carrying state identity, exact prompt,
visibility, status, final text, and normalized error without player identity or
resume selection.
Trace emissions shall be awaited and shall precede the boundary call,
status, or state telemetry they describe; trace payloads shall never be
copied into Boss-visible status text.
Absent optional trace fields shall be omitted rather than stored as own
properties with value `undefined`, and one session shall never have two host
emissions in flight concurrently.
Empty Boss input shall still produce its received and settled trace
events while producing no judge call, player call, status emission, or
FSM action.
If initialization fails after binding the session and attempting
`session.started`, the runtime shall stop the actor, drain owned work, make one
best-effort `session.disposed` attempt, preserve the original initialization
error, clear the failed binding, and permit a fresh `init` attempt.
A root-actor error observed during startup — an initial entry action or a
synchronously failing initial invocation — is part of `init` and `restore`:
the boundary shall reject with that original error after the failed-start
cleanup, never resolving over an errored actor
([DR-036](../decisions/036-coherent-abort-settlement.md)).

#### playbook-runtime-38

Where a standalone linked runtime invokes a local role within one playbook
session, when no resume token is recorded for that role, the runtime
shall call `PlaybookPorts.callPlayer` with `{ resume: false }`; when a
token is recorded, it shall pass that exact token.
After every resolved call, before interpreting its status, the runtime
shall replace the role's token with a non-empty `PlayerResult.resumeToken`, clear it only when an `ok` result omits one, and preserve it when an `aborted` or `error` result omits one.
A rejected call carrying no result shall likewise preserve the prior token and shall not trigger a silent fresh retry.
Before any of those reads or mutations, the runtime shall validate the host
result as the exact declared JSON-safe shape, detach it from caller mutation,
and freeze the accepted snapshot. After the host promise resolves, it shall
re-check the combined invocation/public signal before validation or token
adoption, so a late result from a port that ignored abort cannot mutate
continuity or be traced as success.
The standalone runtime shall key its private fallback tokens by resolved player id when binding metadata is supplied and by local role id otherwise, so equal bound ids share sequential continuity while distinct keys remain independent; it shall preserve the map across parked turns and actor reconstruction within that runtime session and discard it on dispose, while a supplied store shall override that lifetime under [[playbook-runtime-55](#playbook-runtime-55)].

#### playbook-runtime-55

Where `PlaybookSession.playerSessions` is supplied, when a linked runtime invokes a role, the runtime shall call the synchronous store with that frame-local role id, select continuity before the player-start trace and host call, then replace from a validated returned token or clear only for a validated `ok` omission before the player-finish trace and result interpretation; an aborted/error omission shall leave the store untouched.
Where the runtime exports or restores its parked snapshot with that store supplied, it shall use the store's snapshot and restore operations instead of a private token map.
Where no store is supplied, the runtime shall retain the private per-runtime-session continuity of [[playbook-runtime-38](#playbook-runtime-38)].

### Structured and composed execution

#### playbook-runtime-40

Where an FSM contains a fixed set of independent player tasks whose
results join before later work, when the linked runtime drives that
state, the FSM shall represent the tasks as XState parallel regions
whose working leaves invoke their declared `player` actor and whose local final states join
through the parallel parent's `onDone` transition, per
[DR-011](../decisions/011-composable-playbook-execution.md) §1.
The runtime shall key in-flight delegated calls by resolved player id when explicit binding metadata is supplied and by local role id otherwise, permit calls to distinct keys to overlap, reject a second concurrent call to the same key before crossing the host port, and
shall serialize its concurrent hidden `callJudge` operations through one local
abort-aware FIFO with concurrency one. The host shall additionally serialize
all direct `callCaptain` and hidden `callJudge` port operations together
through its one Captain-session FIFO.
DECIDE's independent-proposal state shall invoke Coder and Reviewer in parallel, stage their results separately, and join only after both finish so neither prompt receives the other's proposal.
When a Boss interrupt replaces the topic during that state, DECIDE shall restart the complete parallel pair with the new topic and shall retain neither prior branch result.
Where one parallel branch needs a Boss reply, that branch shall park independently while its sibling continues, and a reply shall resume only the identified branch.

#### playbook-runtime-41

Where a linked runtime observes an XState snapshot, the runtime shall
normalize it as a JSON-safe descriptor carrying the structured state
value, active stable state ids, tags, actor status, and quiescence.
Working states shall carry `playbook.busy`, Boss-waiting states shall
carry `playbook.parked`, and nested-call states shall carry
`playbook.suspended`.
The runtime shall use XState `waitFor` to settle its imperative drive
boundary only when no busy state remains or the actor is terminal or in
error; it shall not model workflow waiting with a polling loop, async
action, or runtime-owned join.
FSM telemetry and the matching `fsm.transition` trace shall carry
structured `from` and `to` values plus previous/current descriptors.
The described FSM telemetry payload shall be detached and recursively frozen
before delivery and shall not share its state object with the runtime's
authoritative previous-state record.
Session, status, and Boss-settlement trace payloads shall include the
current descriptor and may include `stateId` only when one
Boss-relevant state id is active.
`PlaybookRunResult` shall use its discriminated outcome exactly as defined in [slc/link.md](../../slc/link.md#playbookruntime-contract): only `suspended` shall carry a required pending call, only `terminal` may carry output or `stateDescription`, only `failed` or `aborted` may carry an error, `unresolved-effect` shall carry only the current state, `failed` shall mean a recoverable FSM failure state, and control-plane errors shall reject the runtime method.
Where the reached final state declares a nonempty description, a terminal result shall carry that exact authored text as `stateDescription`; the runtime shall omit the field when none is declared and shall never substitute a state id or derive prose from opaque output ([DR-037](../decisions/037-terminal-result-meaning.md)).
Every JSON boundary shall reject cycles, non-plain instances, accessors, symbol
keys, undefined or sparse values, and non-finite numbers instead of accepting a
value that serialization would change. The linked runtime shall use the shared
`@sublang/playbook/xstate-runtime` normalization helpers rather than weaker
per-artifact copies.
`handleBossInput` and `resumePlaybookCall` shall share one active-boundary
sentinel and drain and clear their error latches on every exit. Disposal shall
reject without starting while that sentinel is active, shall coalesce idle
concurrent requests onto one teardown promise, and shall prevent later public
work once teardown begins. A first non-abort control error shall take
precedence over a coincident abort or later emission failure while the runtime
still attempts the required finish and settlement boundaries exactly once.
Disposal requested during initialization shall wait for that initialization's
success or failure cleanup and emit at most one session-disposal trace;
disposal before initialization shall be terminal and retain the same teardown
promise for every later call.

#### playbook-runtime-42

Where an FSM invokes its provided `playbook` actor with a registered
child playbook id and JSON-safe input, when the child call starts, the
linked runtime shall allocate one stable call id, emit
`playbook.call.started`, and call `PlaybookPorts.callPlaybook` with that
id, target, input, and the invocation's abort signal.
When the port returns a settled successful call, the invoked actor shall
complete through `invoke.onDone`; when it returns or is resumed with an
aborted or error result, the actor shall reject through `invoke.onError`.
When the port returns a suspended child session, the runtime shall keep
the actor pending and return a `PlaybookRunResult` with outcome
`suspended` and the matching pending-call identity instead of holding
the Boss turn open.
Where a host later calls `resumePlaybookCall` with the pending call id,
the runtime shall validate the pending target and child session, bind the new
turn signal, emit and drain the paired `playbook.call.finished`, settle that
invocation, and drive the parent until it
is quiescent, suspended, failed, aborted, or terminal.
A resume whose signal is already aborted after identity and result validation
shall deliver nothing: no resume signal is bound, no deferred settles, no call
finish is emitted, and the pending call survives — the boundary settles
`{ outcome: 'aborted' }` with the signal's reason while the suspended state
and pending identity remain, so a later resume with the same call id and a
fresh signal still delivers ([DR-036](../decisions/036-coherent-abort-settlement.md)).
That resume boundary shall not allocate a new Boss-input turn id; the matching
finish and parent continuation shall retain the call-start turn id.
The runtime shall reject an unknown, stale, or already settled call id,
a result whose playbook id differs from the pending target, or a result
whose child session id differs from the suspended child session;
shall preserve the parent's local-role resume-token projection while suspended;
and shall finish an outstanding call as aborted before parent session
disposal.
It shall use the shared nested bridge to validate the start discriminant,
target and child-session identity, state and normalized error shapes, and
JSON-safe output. Every path after `playbook.call.started` — including a thrown
port, malformed start/result, invocation abort, and disposal while opening —
shall drain exactly one matching finish event; validation failures shall reject
as control-plane errors without creating pending state or ordinary child
evidence.
Before starting an actor reconstructed from a runtime snapshot, the restore path shall arm the shared nested bridge with `prepareRestore`, supplying either the snapshot's complete suspended-call descriptor or no descriptor when the snapshot owns no suspended child.
While restore remains prepared, the bridge shall not allocate a call id, drain start emissions, emit `playbook.call.started`, invoke `callPlaybook`, publish pending identity, or attach ordinary child-abort settlement.
Where a suspended-call descriptor was supplied, exactly one reconstructed `playbook` actor shall claim its call id, source state, target playbook, exact handed-off text, child session id, and optional positive turn id; a mismatched or second claim shall reject as a control-plane error.
Where no suspended-call descriptor was supplied, any reconstructed `playbook` actor invocation shall reject rather than opening a child.
Only `confirmRestore` after complete actor validation shall publish the claimed pending identity and arm its ordinary resume and abort behavior; it shall reject an unclaimed descriptor or a prior failed claim, while a prepared zero-call restore shall confirm only when no nested actor appeared.
Before confirmation, `abortPending`, disposal, or an aborted reconstructed invocation shall roll back a provisional claim locally, reject its actor logic, and release its provisional used call id without emitting a finish boundary or aborting the authoritative child.
After confirmation, the eventual exact child result shall use the ordinary resume path, emit the one matching `playbook.call.finished` under the original call and turn ownership, and settle the reconstructed actor exactly once.
If child abort cleanup rejects while the call is suspended, the bridge shall
drop each rejection exactly identical to an applicable abort reason; if any
distinct rejection remains, it shall emit the paired error finish and reject
parent disposal with the original distinct cleanup error, or the aggregate of
multiple distinct failures, rather than swallowing it as an ordinary
nested-call rejection.

### Parked-session snapshot

#### playbook-runtime-45

Where a linked runtime implements the optional durable-session
capability of `@sublang/playbook/runtime`
([DR-014](../decisions/014-durable-one-shot-run-sessions.md) §1),
the runtime shall implement `exportSnapshot` and `restore` together.
When `exportSnapshot` is called at a safe capture point — initialized,
not disposing or disposed, no active public boundary, and the root actor
quiescent with actor status `active` — it shall return a JSON-safe
`PlaybookRuntimeSnapshot` carrying schema version `4`, the session's playbook
id, the persisted machine snapshot
with any raw `Error` context value normalized to `{ name, message,
stack? }`, the exact effect-ledger mirror of [[playbook-runtime-69](#playbook-runtime-69)], the `roleResumeTokens` local-role resume-token projection, the trace/turn/judge-call/
player-call/playbook-call sequence counters, the direct-Captain-call
counter when the runtime supports direct Captain calls, the current normalized
state descriptor, the governed failure-attempt member of [[playbook-runtime-71](#playbook-runtime-71)] when applicable, and the pending Boss questions as `{ questionId, asker, question, sourceItem? }` entries whose `asker` is exactly `{ kind: 'captain' }` or `{ kind: 'role', roleId }`.
A question shall count as pending only while the machine awaits its reply in an authored reply-wait state, under one pendingness shared with the state telemetry a host ledger mirrors, so the ledger and this snapshot cannot disagree about the same fact: for a runtime the shared factory constructs that wait is the singular canonical `awaitBossReply` state, and a context question a later state retains — the recoverable failure a resumed player reached included — shall export as no pending question, while a bespoke runtime counts the questions awaiting replies in its own authored wait states, DECIDE's parallel branch waits included.
Where exactly one nested playbook call is suspended, that snapshot shall also carry its bridge-owned `callId`, `stateId`, `playbookId`, exact `text`, and `childSessionId`, enriched with the matching call-to-turn owner when present and the governed replay prefix of [[playbook-runtime-71](#playbook-runtime-71)] when applicable; export shall return `undefined` if the pending bridge identity, complete descriptor, or recorded call-to-turn ownership is absent or inconsistent.
Where no nested playbook call is suspended, the schema-version-4 snapshot shall omit `suspendedCall`; at any other unsafe capture point `exportSnapshot` shall return `undefined`.
A direct-Captain-capable runtime shall persist the `captainCall` member of `sequences` in every exported schema-version-4 snapshot.
The public `PlaybookRuntimeSnapshot` contract shall admit only schema version `4`, shall require `effectLedger`, shall name its token member `roleResumeTokens`, shall permit `failedEffectAttempt` only on the failed state as an exact `{ boundaryPrefix, attemptId }` object whose nonnegative prefix does not exceed the ledger and whose suffix is either nonempty and wholly owned by its canonical UUID attempt id or empty for an explicit `null`, shall permit `retainedEffectSourceSessionId` only as the canonical UUID of the original adopted source runtime, shall permit `retainedEffectReconciliation` only as an exact `{ sourceSessionId, checkpoint }` object whose source identity equals that separately retained lineage and whose valid checkpoint is a monotonic baseline of `effectLedger`, and shall permit an optional `suspendedCall` descriptor carrying `callId`, `stateId`, `playbookId`, exact `text`, `childSessionId`, optional positive `turnId`, and optional nonnegative-or-null `effectBoundaryPrefixSequence` that does not exceed the ledger; schemas `1` and `2` shall reject before binding because their token and pending-question identities are ambiguous under [DR-032](../decisions/032-explicit-roles-session-players.md), while schema `3` shall reject because it cannot prove effect-ledger authority.
The shared snapshot validator shall capture the complete supplied value once as detached frozen JSON and reject accessors and undeclared snapshot, sequence, pending-question, asker, or suspended-call fields.
The validator shall apply [[playbook-runtime-69](#playbook-runtime-69)] to the ledger and shall reject a schema-version-4 suspended call unless its caller explicitly opts into handling it, its playbook-call counter is positive, its optional turn id does not exceed the turn counter, and its normalized state is active, quiescent, tagged `playbook.suspended`, and contains the descriptor's source state among its active state ids.
Conversely, the validator shall reject any snapshot whose normalized state is tagged `playbook.suspended` without a schema-version-4 suspended-call descriptor.
When `restore` is called on an unused runtime instance with the same
immutable session identity the snapshot was exported under, the runtime
shall validate the snapshot's schema version and that its playbook id
equals `session.playbookId` — module identity stays a host check
([[playbook-cli-23](playbook-cli.md#playbook-cli-23)]) — bind the session, restore the
current detached `session.roleBindings`, require the snapshot's complete effect ledger to equal the current capability mirror for schema `3` or the canonical empty ledger for schema `2`, restore the local-role token projection and the failure-attempt meaning of [[playbook-runtime-71](#playbook-runtime-71)],
sequence counters, and prior-state descriptor, reconstruct the actor
from the persisted machine snapshot, and start it without emitting
`session.started`, transition traces, or human status, so the next
public boundary continues the session's contiguous trace sequence.
Before actor construction, `restore` shall prepare the shared nested bridge with the snapshot's suspended-call descriptor or an explicit absence and shall restore any descriptor's call-to-turn ownership before actor startup.
After actor startup, `restore` shall normalize the actual actor state using the prepared descriptor as pending identity, require it to equal the detached persisted state exactly, drain all suppressed startup work, and call `confirmRestore` as its final fallible step.
`restore` shall reject a schema or playbook-id mismatch, a snapshot
whose restored actor is not `active`, a persisted/actual state mismatch, an unclaimed or mismatched suspended call, an opaque nested invocation without a descriptor, and reuse of an initialized,
disposing, or disposed runtime, following the same failed-start cleanup
as `init` so provisional nested ownership rolls back without a duplicate start or finish and `dispose` remains callable.
The compiled default Captain runtime shall expose the shared factory's snapshot methods, while the Playbook Captain shell shall embed and restore that runtime snapshot only as part of its complete logical-session snapshot ([[playbook-captain-41](playbook-captain.md#playbook-captain-41)], [[playbook-captain-42](playbook-captain.md#playbook-captain-42)], [DR-031](../decisions/031-shared-captain-session-front-ends.md)).

### Retained-snapshot adoption

#### playbook-runtime-61

Where a linked runtime implements the optional adoption capability of `@sublang/playbook/runtime`, `adopt(session, snapshot, context)` shall be a third initialization path, distinct from `init` and same-engagement `restore`, that may bind a valid fresh `PlaybookSession` identity to the retained machine generation.
Every runtime the shared `createXStatePlaybookRuntime` factory constructs shall expose `adopt`, regardless of whether that artifact supplies retained-generation classification metadata; a bespoke runtime may omit it, and member absence shall be the capability boundary.
Before actor construction or any player-session-store, port, trace, status, or telemetry effect, adoption shall validate and detach the target session, the exact `PlaybookAdoptionContext` of [[playbook-runtime-65](#playbook-runtime-65)], and the runtime-visible portion of the structural envelope: a supported schema-version-4 snapshot satisfying the retained-ledger fence of [[playbook-runtime-75](#playbook-runtime-75)] for schema `3` or the canonical-empty equality rule of [[playbook-runtime-69](#playbook-runtime-69)] for schema `2`, the target session's exact playbook id, the factory's already-validated artifact contract, and any supplied local-role binding set against the artifact's declared roles.
The host remains responsible for the generation envelope it alone owns — working directory, complete catalog-entry structure, and every retained frame's artifact schema — before it calls the runtime capability ([DR-038](../decisions/038-universal-run-resumption.md) §3).
After preflight, adoption shall reconstruct the actor from the persisted machine snapshot with inspection effects suppressed and shall rebuild a suspended nested call through the same prepared bridge transaction as live restore, except that [[playbook-runtime-65](#playbook-runtime-65)] supplies fresh target call and child identity instead of restoring source call-to-turn ownership: prepare and claim the rebased descriptor during actor startup, require an active normalized actor state equal to the retained state under that rebase, drain suppressed work, and confirm the bridge only as the final fallible step.
Adoption shall treat the retained snapshot's `roleResumeTokens` as inert during initialization: it shall neither pass them to a supplied `PlayerSessionStore.restore` nor seed runtime-private continuation from them ([[playbook-runtime-58](#playbook-runtime-58)], [DR-038](../decisions/038-universal-run-resumption.md) §4).
Any envelope, actor-state, or bridge mismatch on an otherwise unused runtime shall reject without a child-host call or playbook-call start/finish boundary, roll provisional ownership back through failed-start cleanup, and leave that runtime reusable after successful cleanup.
A successful adoption shall close `init`, `restore`, and `adopt` under the ordinary one-start runtime lifecycle.
Fresh adoption identity, counters, and trace lineage shall follow [[playbook-runtime-65](#playbook-runtime-65)].

#### playbook-runtime-63

Where an adopted runtime whose target session supplies `roleBindings` and a `PlayerSessionStore` frame-local view of the target Captain-session player ledger later invokes a local role, it shall derive the player id and prompt identity exclusively from those detached target bindings and shall select continuation from that target ledger view at the invocation boundary, immediately before the player start trace and host call ([[playbook-runtime-15](#playbook-runtime-15)], [[playbook-runtime-55](#playbook-runtime-55)], and [[playbook-captain-26](playbook-captain.md#playbook-captain-26)]).
The selected current token shall be passed through exactly, while `false` shall start a fresh conversation; the adopted snapshot's inert `roleResumeTokens` shall never be a fallback for either result ([[playbook-runtime-61](#playbook-runtime-61)] and [DR-038](../decisions/038-universal-run-resumption.md) §4).
The player-start trace shall carry the target binding's player id and the selected continuation ([[playbook-runtime-37](#playbook-runtime-37)]).
Where that post-adoption call returns a validated nonempty replacement token, the runtime shall update the same target ledger view ([[playbook-runtime-58](#playbook-runtime-58)]).
Thus a shared player that advanced after retention shall continue from its newer ledger token, while a replacement player whose current ledger selection is `false` shall use its new player and prompt identities and start fresh.
Where the target session supplies no `PlayerSessionStore`, adoption shall leave runtime-private continuation empty, so the first post-adoption call starts fresh ([[playbook-runtime-38](#playbook-runtime-38)]).

#### playbook-runtime-65

Where a runtime adopts a retained snapshot under [[playbook-runtime-61](#playbook-runtime-61)], the required `PlaybookAdoptionContext` shall be a detached closed-schema value whose `sourceSessionId` names that retained frame's source runtime session, whose `sourceGenerationId` names the retained stack root frame's source `rootSessionId` from [[playbook-captain-41](playbook-captain.md#playbook-captain-41)], and whose `targetChildSessionId` is present exactly when the snapshot carries a suspended call.
The target `sessionId` and `rootSessionId` shall differ respectively from those source identities, `sourceSessionId` shall equal `sourceGenerationId` exactly when the target session is a root frame, and a supplied target child identity shall differ from every source and target identity visible to that frame; an empty, accessor-backed, unknown, missing, extra, or inconsistent adoption-context member shall reject during [[playbook-runtime-61](#playbook-runtime-61)] preflight.
Adoption shall not restore any source sequence counter: the fresh target trace, turn, judge-call, player-call, supported direct-Captain-call, playbook-call, and apply-call counter spaces shall start at zero.
Before its session-start trace, a retained snapshot with no suspended call shall leave the target playbook-call counter at zero; where it has one, adoption shall consume the fresh `playbook-1` target call id, replace the descriptor's source child id with `targetChildSessionId`, omit the source `turnId`, and set the target playbook-call counter to one, without changing the opaque persisted machine state or invoking the child host.
The target runtime shall emit exactly one `session.started` trace as sequence `1` before actor startup, carrying its adopted normalized `state` and optional `stateId` plus the exact nested `adoption` object below, with no `turnId`; a suspended adoption shall additionally carry target call id `playbook-1` as the event's top-level `callId`:

| Adoption shape | Exact `adoption` payload |
| --- | --- |
| No suspended call | `{ sourceSessionId, sourceGenerationId }` |
| Suspended call | `{ sourceSessionId, sourceGenerationId, sourceCallId, sourceChildSessionId, targetCallId: 'playbook-1', targetChildSessionId }` |

Only after that start trace shall actor startup and bridge confirmation commit the adopted state; a later reconstruction mismatch shall perform failed-start cleanup with one best-effort target `session.disposed`, while a preflight rejection shall emit no target trace.
After successful adoption, the immediate export shall therefore carry trace sequence `1`, zero fresh turn, judge, and player counters, zero direct-Captain counter when supported, and playbook-call sequence zero or one according to the table; every later target boundary shall allocate from those fresh counters rather than continue any source id or sequence ([DR-038](../decisions/038-universal-run-resumption.md) §5).
Same-engagement `restore` shall remain trace-silent and shall preserve the snapshot's exact identities and counters under [[playbook-runtime-45](#playbook-runtime-45)].

#### playbook-runtime-75

Where a schema-3 runtime adopts a retained generation, the retained runtime snapshot's `effectLedger` shall be its detached capture-time checkpoint and the current host mirror shall be either exact or a monotonic extension under [[playbook-runtime-69](#playbook-runtime-69)]; a malformed checkpoint, a checkpoint containing an incomplete physical boundary, changed durable fact, nonmonotonic ledger, or current mirror that precedes the checkpoint shall reject before actor, player-session-store, port, trace, status, telemetry, or repository work ([DR-040](../decisions/040-outcome-authority-effect-reconciliation.md) §4).
The runtime shall bind `retainedEffectSourceSessionId` to the snapshot's existing original source lineage or otherwise to the adoption context's source session id of [[playbook-runtime-65](#playbook-runtime-65)], preserve that value through every safe and fenced export, restore, and later adoption, stamp each later governed physical boundary with that durable original source identity while falling back to the current session before any adoption, and use both its fresh target identity and that original source identity when resolving a deferred logical operation of [[playbook-runtime-73](#playbook-runtime-73)]; a conflicting saved lineage shall reject during preflight.
Exact equality shall preserve ordinary adoption, while a strict extension shall authorize a detached in-memory rebase and ordinary work only when the physical-boundary prefix through the checkpoint length and the complete `logicalOperations` list remain deep-equal and every appended physical boundary carries a complete receipt classified exactly `unchanged`.
An incomplete boundary, any other classification, deferred logical-operation progress, or inconsistent extension shall instead bind `retainedEffectReconciliation` to the original source runtime identity and checkpoint, use the current authoritative ledger only as the live and exported mirror, and reenter effect-possible unresolved reconciliation without replaying the retained input, player, adjudicator, Captain, nested-call result, or FSM event.
While that fence remains, the runtime shall publish no ordinary pending Boss question or state description, shall map, advertise, or accept no ordinary action, and shall expose only the exact reconciliation and abandonment controls of [[playbook-runtime-79](#playbook-runtime-79)]; completing later receipt reconstruction shall not by itself deliver retained semantic evidence or clear a non-`unchanged` fence.
Every fenced export, same-engagement restore, and later adoption shall preserve and revalidate the reconciliation marker's exact source identity and original checkpoint until reconciliation proves the complete suffix safe or a later reconciliation task disposes or resolves it; a safe all-`unchanged` suffix shall clear the process-local fence and omit only that marker without truncating the separately durable source lineage, checkpoint evidence, or current ledger.
Artifact-schema-2 adoption shall retain its canonical-empty ledger rule, shall omit both retained-effect members, and shall never infer effect safety from a schema-3 ledger it cannot own.

### Control surface

#### playbook-runtime-52

Where a linked runtime implements the optional control-surface
capability of `@sublang/playbook/runtime` —
[DR-029](../decisions/029-session-scoped-conversational-captain.md)
and [slc/link.md](../../slc/link.md#control-surface-optional) — it
shall implement `describe` and `apply` together, and every runtime the
shared `createXStatePlaybookRuntime` factory constructs shall implement
the pair. The capability shall be feature-detected by member presence
like the parked-session snapshot capability, changing no runtime ABI
and no artifact or snapshot schema ([[playbook-runtime-50](#playbook-runtime-50)]); a runtime
without the pair advertises no actions and plain text delivery is the
only verb against it.
Per [DR-019](../decisions/019-shared-linked-runtime-factory.md), the
shared factory supports only flat single-region FSMs: it shall reject at
construction any machine that declares no root states, any machine that
declares a `type: 'parallel'` state, any
machine whose non-root state declares child states, and any root state
whose `meta.playbook.stateId` is not a string equal to its state key —
a missing identity included — so every
snapshot exposes exactly one playbook state id under the one identity
the factory's state lookups index by.
The shared factory shall also reject at construction any supplied `unfinishedFinalStateIds` member containing an id that does not name a root `type: 'final'` state, without inferring which final outcomes leave the procedure unfinished ([slc/link.md](../../slc/link.md#output)).
When that member is supplied, every runtime the shared factory constructs shall expose `retainedGenerationMetadata` ([[playbook-runtime-34](#playbook-runtime-34)]) as an immutable copy whose `unfinishedFinalStateIds` preserve the declaration exactly, including an explicitly empty set; when the member is omitted, the marker shall be absent, so the link declaration by itself grants no runtime capability.
A state whose source declares no description remains fully usable: the
runtime shall normalize, enter, and settle it like any described state,
merely carrying no `stateDescription` downstream.
`describe()` shall be side-effect free — no trace, status, telemetry,
or machine movement — and shall throw before `init`, while another
public boundary is active, and once disposal begins. It shall return a
detached view carrying the current normalized state descriptor, the
state description defined below, the
runtime-authored context projection defined below, the pending Boss
questions with their stable ids — pending on the same Boss-reply-wait
terms as the exported snapshot ([[playbook-runtime-45](#playbook-runtime-45)]), so a failure
reached after an answered question describes none — the last recorded
error in normalized
`{ name, message, stack? }` form, and the currently valid actions.
The view's `stateDescription` shall be the runtime's own Boss-facing
statement of what its current state means, written from the same source
state descriptions the action labels are written from, so a controller
host has grounding it can speak from without reading an internal
identifier ([[captain-playbook-5](captain-playbook.md#captain-playbook-5)],
[[playbook-captain-9](playbook-captain.md#playbook-captain-9)]). A state whose source
declares no description shall carry no `stateDescription`: the runtime
shall not promote a state id into a description, so a host is never
handed an identifier dressed as meaning.
The view's `context` shall be an explicit projection the linked
runtime authors — the FSM context members it names, in the order it
names them — and shall never be an allow-by-default serialization of
the FSM context. Only the runtime knows which of its context members
are safe and relevant for a controller prompt, while the host that
receives the view cannot inspect an opaque blob for the player
rosters, option values, and raw player output its own prompts must
exclude ([[playbook-captain-9](playbook-captain.md#playbook-captain-9)]); exporting by
default therefore makes the two obligations unsatisfiable together,
and every member added to an FSM later inherits the wrong default. A
runtime that names no member shall carry no `context`, so a member is
private until an artifact names it. A named member shall still be
sanitized — raw `Error` values normalized, a value that cannot be made
JSON-safe dropped rather than thrown — and the two members the view
surfaces first-class, the pending Boss question and the last error,
shall not be nameable; a projection naming either shall fail runtime
construction rather than be silently ignored.
Actions shall derive from the live snapshot only at the safe capture
point of [[playbook-runtime-45](#playbook-runtime-45)] (actor status `active`, quiescent, no
pending nested call) and shall be empty anywhere else. While the
singular state id is the recoverable failure state and the live
snapshot accepts the retry event sourced below, the runtime shall
advertise the `retry:<EVENT_TYPE>` action replaying exactly that event, subject for a governed artifact-schema-3 failed host attempt to the automatic-replay fence of [[playbook-runtime-71](#playbook-runtime-71)];
for each registered resumable
state id whose explicit-state-jump event (`BOSS_INTERRUPT` with that
`targetId` and optional textual fields omitted) the live snapshot
accepts, guards included, it shall advertise `jump:<stateId>`.
The retry event shall come from the artifact's entry-event declaration
where that declaration names the FSM context member the machine's entry
action copies the exact Boss text into: the runtime shall build the
deterministic entry event from that member of the live snapshot,
excluding the candidate when the member is absent, not a string, or
blank, and shall not fall back to the recorded event
([DR-034](../decisions/034-durable-failure-retry-continuity.md)).
Where the declaration names no such member, the retry event shall be
the recorded last classified event — the event a public Boss boundary
sent, kept with its recorded payload — and shall be absent when the
runtime holds none.
The declared source is what the persisted machine snapshot already
carries, so a runtime restored from that snapshot shall advertise the
same retry as the process that exported it, including a failure the
machine reached after a Boss reply resumed the work; an artifact naming
no member shall keep the process-local behavior of its recorded event.
The runtime shall not treat a context member that merely matches the
entry event's text field as that declaration.
Each action shall carry a stable id and a label written from the source
state descriptions; a retry whose event carries its own
`targetId` (the explicit-state-jump shape) shall be labeled from that
recorded target's description — the state its replay re-enters — never
from another configured arm of a guarded transition list; a candidate
whose event requires a payload the
runtime can source from neither its recorded event nor the persisted
state above shall be excluded — `apply`
shall never invent free text and shall never enter Boss-input
classification.
A label shall never fall back to an identifier, and a candidate whose
label could only be one shall be excluded on the same terms as one whose
payload cannot be sourced. The label is the only Boss-facing name the
action has: a controller host is required to name an executed or refused
action by it and never by the action id
([[playbook-captain-34](playbook-captain.md#playbook-captain-34)]), so a label that
*is* the target id or the replayed event type makes that substitution a
no-op and puts a machine identifier into Boss-facing text
([[captain-playbook-5](captain-playbook.md#captain-playbook-5)]). A jump whose
target publishes no description shall therefore not be advertised —
borrowing another state's description would name the wrong state — and a
retry shall fall back from its target's description to its own source
state's, and shall not be advertised when neither exists.
`apply({ actionId, key, signal })` shall revalidate against the live
state and settle `{ disposition: 'rejected', reason }` with no effect
when the action is not currently advertised; an accepted action shall
execute at most once per idempotency `key`, driving the validated event
through the same actor drive, boundaries, and emissions as a Boss turn,
and settle `executed` with the projected run result or `failed` with
the normalized error when the run parks in the failure state, aborts,
or a post-acceptance control-plane error lands (effects may exist).
The receipt shall be recorded under its key at acceptance, before the
settlement emissions, and a repeated key shall return the recorded
receipt verbatim with no revalidation, no execution, and no new trace
pair.
Acceptance is also the line past which `apply` shall not throw: the
action may have run, and a caller handed an exception instead of a
receipt is left with an effect it cannot record and a key it will not
reuse. Publication — the `apply.finished` emission — is the second such
line, and it is what decides which post-acceptance settlement failures
may change the receipt. A settlement failure after acceptance and
*before* publication — a rejecting emission drain — is one of the
post-acceptance control-plane errors above and shall settle the
`failed` receipt carrying its normalized error, replacing the receipt
recorded at acceptance, so that the finish trace, the returned receipt,
and any later replay of the key all report the same settlement.
A settlement failure at or after publication — a rejecting
`apply.finished` sink, or a drain that rejects after it — shall not
change the receipt: the disposition is already emitted, so no rewrite
can make the trace and the return agree, and a receipt is a statement
about the effect rather than about its telemetry. Such a failure is a
delivery failure, the run having succeeded and the ledger not having
heard of it — unless it is causally identical to the apply signal's own
abort reason, in which case it evidences the cancellation and is
dropped, not latched ([DR-036](../decisions/036-coherent-abort-settlement.md)); otherwise the runtime shall keep the published receipt, shall
return and replay exactly that receipt, and shall carry the delivery
failure on its emission-failure channel so it surfaces from the next
public boundary that drains rather than being discarded. Only
failures before acceptance surface by throwing, where no effect exists
and no receipt is owed. Only accepted receipts (`executed` or
`failed`) shall be recorded
and final for their key: a `rejected` receipt settles before acceptance
and shall record nothing, so a later call with that key revalidates
against the live state, traces its own pair, and may execute once the
action is advertised — while a call that threw before acceptance
(lifecycle misuse, invalid input, a pre-acceptance abort, or a rejected
start sink) shall likewise record nothing, so a later call with that
key may execute.
An abort that lands while the `apply.started` emission drains shall
settle before acceptance — no execution, no receipt, the machine
unmoved — with the pair finished `aborted` carrying the abort's
normalized error together with the canonical
rejected-before-any-effect receipt disposition and its reason, since
every apply finish adds the receipt disposition
([slc/link.md](../../slc/link.md#playbook-trace)).
A rejected `apply.started` sink shall likewise finish the pair
canonically: the best-effort `apply.finished` shall carry that same
rejected-before-any-effect disposition with its reason alongside the
transport error, and no apply finish shall carry a start-only field
such as `stateId`.
When the trace sink rejects that abort finish, the sink failure shall
surface from the boundary in place of the abort reason — matching the
settlement-drain precedence of the other public boundaries — while
the call still settles pre-acceptance: no receipt recorded, the key
free to execute later. `apply`
shall share the single active-boundary sentinel with `handleBossInput`
and `resumePlaybookCall`, shall honor its `AbortSignal` exactly as a
Boss-turn signal, and shall trace as the paired `apply.started` /
`apply.finished` events of
[slc/link.md](../../slc/link.md#playbook-trace) carrying the action id,
idempotency key, and — on finish — the receipt disposition with its
reason, normalized error, or projected run result, under a
session-unique `apply-<n>` call id whose counter restores from the
persisted trace floor. Recorded receipts and the recorded last
classified event shall stay process-local: the durable runtime snapshot
persists neither.

#### playbook-runtime-79

At the safe control-capture point of [[playbook-runtime-52](#playbook-runtime-52)], while a schema-3 runtime has effect-possible outcome evidence unresolved under [[playbook-runtime-73](#playbook-runtime-73)], [[playbook-runtime-75](#playbook-runtime-75)], or [[playbook-runtime-77](#playbook-runtime-77)], its control view shall omit every pending Boss question and state description and shall advertise exactly `reconcile:unresolved-effect` labeled `Retry unresolved effect reconciliation` and `abandon:unresolved-effect` labeled `Abandon unresolved workflow attempt`, with no ordinary retry, jump, or other action ([DR-040](../decisions/040-outcome-authority-effect-reconciliation.md) §4).
Applying `reconcile:unresolved-effect` shall use only the current host's authoritative effect ledger under [[playbook-runtime-69](#playbook-runtime-69)] for any reconciliation refresh and shall start no player; where the unresolved episode is a checkpoint-restoration-eligible open deferred operation, it shall perform the exclusive exact-checkpoint restoration of [[playbook-runtime-73](#playbook-runtime-73)] without a player, judge, or semantic-candidate delivery.
An exact deferred restoration shall return the operation to its identical bound wait and republish its stable pending question through an ordinary nonterminal run result, while an unequal checkpoint or other still-unresolved evidence shall remain parked and return `no-action` without consuming the unresolved episode.
Applying `abandon:unresolved-effect` shall move no FSM state, start no player, judge, Captain, script, or child call, and settle the accepted control action with exactly `{ outcome: 'unresolved-effect', state }`, where `state` is the current normalized nonfinal state.
The `unresolved-effect` arm shall carry no `stateDescription`, output, pending call, error, repository receipt, effect ledger, semantic evidence, or other bounded effect fact, shall not represent an authored final state, and shall claim neither workflow outcome nor completion.

## Verification

### Runtime

#### playbook-runtime-17


When a fresh nonempty turn is driven through CODE, REVIEW, or DECIDE with fake ports, the test suite shall fail unless the runtime sends its deterministic initial event with the exact Boss text, makes no classifier call, and drives to a quiescent, suspended, failed, aborted, or terminal result (verifying [[playbook-runtime-1](#playbook-runtime-1)] and [[playbook-runtime-11](#playbook-runtime-11)]).

#### playbook-runtime-18


When the per-turn `signal` aborts mid-`callPlayer`, the test suite
shall fail unless the runtime drives the FSM to the failure state
with `lastError` populated, the port-observed combined signal aborts, and the
method waits for quiescence and paired emissions before returning. A deferred
Captain call and deferred child opening shall prove that no later state,
status, or trace mutation occurs after return.
When the abort lands while a classifier judge call's own
`judge.call.started` emission drains (fired from the trace sink), the
suite shall fail unless no host judge call starts, the pair finishes
`aborted`, the FSM stays unmoved, and the turn settles as an abort (verifying [[playbook-runtime-13](#playbook-runtime-13)]).
When the aborted turn's player port rejects with a fresh error that is not the exact signal reason — `AbortError`-named or not — the suite shall fail unless the public method rejects with that error and the call pair finishes `error`; when the rejection is the exact signal reason, the suite shall fail unless the turn settles as an abort (verifying [[playbook-runtime-13](#playbook-runtime-13)]).
Before a turn's outcome is computed, when its trace sink rejects with the exact signal reason, the suite shall fail unless the turn settles as an abort; when the sink rejects with a distinct failure, the suite shall fail unless the public method rejects with that failure (verifying [[playbook-runtime-13](#playbook-runtime-13)]).
When an FSM action throws a distinct error synchronously — abort coincident or not — the suite shall fail unless the public method rejects with that error and no unhandled actor error escapes after the method returns (verifying [[playbook-runtime-13](#playbook-runtime-13)]).
When a turn aborts while a script actor's command runs, the suite shall fail unless the turn settles as an abort only after the detached shell has exited, every process-group member is dead at settlement, and no script-executed status was emitted — both when the shell itself traps `SIGTERM` so only the escalated group `SIGKILL` ends it, and when the shell exits cooperatively on the group `SIGTERM` while a backgrounded descendant ignores it; when the abort lands only after the shell's exit — a `TERM`-immune same-group descendant having outlived that exit — the suite shall fail unless the public turn resolves with the structured `aborted` outcome only after every group member is dead, the machine does not reach its terminal state, and no script telemetry is emitted; the suite shall not require suppression of a script emission already in flight when the abort landed. The suite shall further fail unless only `ESRCH` confirms disappearance and a persistent signalable group, `EPERM`, or another liveness-probe failure produces a distinct bounded teardown control error instead of the exact abort reason (verifying [[playbook-runtime-13](#playbook-runtime-13)]).
When a started-trace sink cancels the turn and rejects with the exact signal reason at the player, judge, Captain, or nested-playbook boundary, the suite shall fail unless no host call begins, the pair finishes `aborted`, and the turn settles as an abort rather than rejecting (verifying [[playbook-runtime-13](#playbook-runtime-13)] and [[playbook-runtime-37](#playbook-runtime-37)]).
When a call's `ok` finish was recorded before its sink cancelled the turn and rejected with the exact applicable reason, the suite shall fail unless that recorded `ok` finish remains the pair's only finish and the enclosing turn settles through ordinary abort precedence rather than latching the sink rejection (verifying [[playbook-runtime-13](#playbook-runtime-13)]).
When a nested invocation starts under signal A and later settles under resume signal B, the suite shall fail unless its immutable classifier recognizes either signal's exact reason at every finish, drain, control, background, and actor-settlement latch; it shall further fail unless an exact-reason abort-cleanup rejection is filtered before distinct cleanup failures are preserved or aggregated (verifying [[playbook-runtime-13](#playbook-runtime-13)] and [[playbook-runtime-42](#playbook-runtime-42)]).
When an invocation-owned background transition emission rejects, the suite shall fail unless an exact invocation reason is dropped and the next unrelated boundary settles cleanly, while a distinct stored rejection surfaces from the next drain even if that later boundary uses the same object as its abort reason (verifying [[playbook-runtime-13](#playbook-runtime-13)]).
When a machine completes to its terminal state while the turn or resume signal also aborts, the suite shall fail unless the boundary settles `terminal` with the machine's output rather than `aborted` (verifying [[playbook-runtime-13](#playbook-runtime-13)]).
When the `boss.input.settled` sink aborts the boundary and rejects with that exact reason after the outcome is computed, the suite shall fail unless the computed outcome is returned unchanged and the next unrelated boundary settles cleanly (verifying [[playbook-runtime-13](#playbook-runtime-13)]).
When `resumePlaybookCall` is invoked with an already-aborted signal, the suite shall fail unless the child result is not delivered, the pending call survives, the boundary settles `aborted`, and a later resume with the same call id and a fresh signal delivers to terminal (verifying [[playbook-runtime-42](#playbook-runtime-42)]).
When `handleBossInput` is invoked with an already-aborted signal, the suite shall fail unless only the received/settled Boss boundary is recorded, no text is classified, no host call or script starts, the machine stays unchanged, and the boundary settles `aborted` (verifying [[playbook-runtime-13](#playbook-runtime-13)]).
When an apply has been accepted but a settlement sink rejects before receipt publication, the suite shall fail unless the exact apply abort reason and a distinct rejection alike fold into the current `failed` receipt, which is published, returned, and replayed without carrying either failure to a later boundary (verifying [[playbook-runtime-52](#playbook-runtime-52)]).
When an `apply.finished` delivery rejection is causally identical to the apply signal's abort reason, the suite shall fail unless the published receipt stands and the next unrelated public boundary settles cleanly; a distinct delivery failure shall still surface from that next boundary's drain (verifying [[playbook-runtime-52](#playbook-runtime-52)]).
When a machine's initial state entry action throws during `init`, the suite shall fail unless `init` rejects with that error, one best-effort `session.disposed` boundary follows the attempted `session.started`, and a subsequent `init` whose start does not throw succeeds (verifying [[playbook-runtime-37](#playbook-runtime-37)]).
Where a linked runtime builds its own actor rather than using the shared factory — DECIDE today — when the abort-settlement verification runs, the suite shall drive that runtime's applicable exact-identity classification, ordinary settlement precedence, immutable invocation-and-resume provenance, pre-aborted entry refusal, active-boundary lifetime, and emission-ownership cases and shall fail unless each satisfies [[playbook-runtime-13](#playbook-runtime-13)], [[playbook-runtime-37](#playbook-runtime-37)], [[playbook-runtime-41](#playbook-runtime-41)], and [[playbook-runtime-42](#playbook-runtime-42)].

#### playbook-runtime-19


When a Boss turn is classified as `BOSS_INTERRUPT` with a valid
`targetId`, the test suite shall fail unless the FSM is redirected
to the named state and `handleBossInput` returns (verifying [[playbook-runtime-11](#playbook-runtime-11)]).

#### playbook-runtime-20


When the integration suite drives transition and status profiles, it shall fail unless every case in this matrix holds:

- Every runtime emits `playbook.fsm.state` telemetry for each transition, normalizes transition and failure errors, and preserves enqueue order, single-flight emission, contiguous trace sequence, and trace-before-actor-call ordering (verifying [[playbook-runtime-14](#playbook-runtime-14)]).
- A factory-backed fixture with complete `roleStates` and no status override emits the bare classification before dispatch, only metadata-backed `⤷ <Role>: <label>` entries, exact `→ <guard>` for schema-2 settling output or exact `→ <acceptedOutcome>` for schema-3 confirmed evidence with no tally, rider, or leading whitespace, the compact-data failure marker, and both exact Boss-wait lines, while idle, terminal, and unlisted states produce no canonical fallback (verifying [[playbook-runtime-3](#playbook-runtime-3)] and [[playbook-runtime-14](#playbook-runtime-14)]).
- A schema-2 factory-backed fixture with missing or incomplete `roleStates` rejects during construction even when a status override exists, before machine interpretation or a host call (verifying [[playbook-runtime-57](#playbook-runtime-57)]).

#### playbook-runtime-68

When the repository-observation integration suite drives real temporary Git worktrees, it shall fail unless staged, tracked-worktree, mode-only, non-ignored-untracked, and nested-worktree dirty-content changes alter the detached content-addressed projection while ignored-only and timestamp-only changes do not; unchanged pre-existing dirt proves `unchanged`; exactly one call-created descendant commit that preserves the complete baseline projection proves `one-descendant-commit` with the exact OID; and consumed or altered pre-existing overlays, residual changes, multiple commits, rewritten or non-descendant history, declared-zero deltas, inspection-suppressing index flags, unreadable reported content, non-lossless path data, and mutation during observation receive their exact fail-closed classifications without a path-attribution filter (verifying [[playbook-runtime-67](#playbook-runtime-67)]).

#### playbook-runtime-70

When the effect-ledger integration suite drives a synthetic schema-3 runtime through real observation, coordination, and a durable host writer, it shall fail unless one exclusive call persists its detached baseline and started envelope before the player begins, persists its after observation and exact receipt before releasing the claim, advances revision once per accepted batch, and exports one schema-version-4 snapshot carrying the complete acknowledged ledger mirror (verifying [[playbook-runtime-69](#playbook-runtime-69)]).
The suite shall fail unless every successfully completed exclusive call, deferred continuation, and cohort returns the exact acknowledged physical receipt values from its returned ledger and a completed deferred chain returns that ledger's exact logical receipt (verifying [[playbook-runtime-69](#playbook-runtime-69)]).
The suite shall fail unless one declared cohort persists every start before either member begins, persists every receipt in one batch before release, and gives each member the same complete acknowledged mirror (verifying [[playbook-runtime-69](#playbook-runtime-69)]).
The validator matrix shall reject missing, extra, accessor-backed, non-JSON, duplicate, out-of-order, cross-reference-inconsistent, invalid-receipt, projection-digest-mismatched, partial-cohort, replenished-budget, invalid candidate-correction provenance, and live-authority values; exact start and append identity-and-payload replay shall return the prior acknowledgement without another revision, an indeterminate same-lease completion retry shall recognize its acknowledgement, and conflicting identity reuse, a stale replace `expected` value, or an unlawful replacement shall leave the ledger unchanged (verifying [[playbook-runtime-69](#playbook-runtime-69)]).
The snapshot matrix shall prove that every schema-3 runtime frame receives and exports the complete current-host mirror, while schema-2 and internal Captain runtimes receive and export the canonical empty ledger; restore shall reject a mirror mismatch and adoption shall reject any mismatch not admitted by the retained-ledger fence before actor, store, port, trace, status, or telemetry work (verifying [[playbook-runtime-45](#playbook-runtime-45)] and [[playbook-runtime-69](#playbook-runtime-69)]).
The recovery matrix shall fail unless a completion write that rejects before or after acknowledgement preserves available envelope evidence, retries or recognizes the exact proposed batch under the still-owned live claim, retires that claim only after the durable receipt is complete, and starts no player during recovery (verifying [[playbook-runtime-69](#playbook-runtime-69)]).

#### playbook-runtime-72

When the automatic-replay integration matrix drives governed artifact-schema-3 calls through the shared factory and a current-host effect-ledger capability, it shall fail unless an intentionally blocked start acknowledgement prevents the first player call, a blocked completion acknowledgement after an empty first result prevents a second call, an acknowledged complete `unchanged` receipt then permits exactly one corrective call and records that correction as its own physical boundary, and an absent or incomplete receipt plus each non-`unchanged` classification permits no corrective player call.
The matrix shall fail unless a failure reached through a player error, a second empty-`ok` result, or adjudication failure maps no deterministic retry and exposes no retry from either `describe` or `apply` whenever any governed boundary in its host attempt is missing, incomplete, or non-`unchanged`, including an earlier nonzero boundary followed by a complete `unchanged` boundary; unless all-complete-`unchanged` attempts map, advertise, and accept that retry; unless a parent failure binds a foreign-runtime boundary in the same attempt while a proven pre-effect failure remains retryable; and unless failure snapshots and nested-call suspension across export and restore preserve each decision without a restore-time player call.
The matrix shall further fail unless artifact-schema-2 and nongoverned delegated-player correction, direct-Captain correction, and authored Boss-reply continuation fixtures retain their existing behavior (verifying [[playbook-runtime-71](#playbook-runtime-71)]).

#### playbook-runtime-74

When the deferred-continuation integration matrix drives a governed artifact-schema-3 question chain through real observation, coordination, and an acknowledged effect-ledger capability, it shall fail unless the initial question remains unpublished until its boundary receipt and bound logical operation are durable; the operation carries the exact original baseline, first checkpoint, pending question, explicit token-or-false player continuation, and reciprocal physical link; and an exact-checkpoint valid answer atomically consumes that wait and persists its next started boundary before exactly one player call (verifying [[playbook-runtime-73](#playbook-runtime-73)]).
The matrix shall fail unless repeated questions replace only the latest bound triple while preserving the operation identity, original baseline, ordered physical receipts, and bound continuation; a final arm consumes only the cumulative logical receipt; an invalid answer leaves the bytes and call count unchanged; another exit clears the bound triple and parks without a call; and a valid-answer checkpoint mismatch preserves the exact wait, marks it eligible, stores no answer, and starts no player (verifying [[playbook-runtime-73](#playbook-runtime-73)]).
Across live execution and export-and-restore, an unequal reconciliation retry shall preserve eligibility and make no call, while restoration of the exact checkpoint shall durably consume eligibility and republish the same question id and content without a player, judge, or semantic-candidate delivery, after which only a later valid answer may start one continuation; rejected or indeterminate start, completion, bind, eligibility, or restoration writes shall publish no unsafe state and shall retain the applicable claim-recovery evidence (verifying [[playbook-runtime-73](#playbook-runtime-73)] and [[playbook-runtime-69](#playbook-runtime-69)]).
The matrix shall further fail unless an artifact-schema-3 governed `needsBossReply` arm declared `unchanged` publishes only after a matching complete physical receipt, creates no logical operation or restoration state, and routes one valid answer through the ordinary authored continuation as a second separately governed `unchanged` boundary while a nonmatching initial receipt publishes no question and starts no continuation; artifact-schema-2 and nongoverned Boss-question fixtures shall retain their existing behavior (verifying [[playbook-runtime-73](#playbook-runtime-73)] and [[playbook-runtime-77](#playbook-runtime-77)]).

#### playbook-runtime-76

When the retained-adoption integration matrix supplies a schema-3 runtime snapshot and current host ledger, it shall fail unless exact equality adopts normally and a monotonic extension whose boundary prefix and logical operations remain exact and whose appended boundaries all carry complete `unchanged` receipts rebases only the detached restore view, resumes ordinary work once, and preserves the complete current ledger and original source-session lineage without a reconciliation marker (verifying [[playbook-runtime-75](#playbook-runtime-75)]).
The matrix shall exercise an incomplete appended boundary, one completed `observation-ambiguous` appended boundary, and an earlier incomplete boundary followed by a later complete `unchanged` boundary; it shall fail unless each unsafe valid extension installs one durable `retainedEffectReconciliation` fence, while an incomplete capture checkpoint and retained-snapshot values with conflicting source lineage, nonmonotonic checkpoint evidence, or undeclared fields reject before runtime work (verifying [[playbook-runtime-75](#playbook-runtime-75)]).
Across immediate export, same-engagement restore, and a later retained adoption, the suite shall fail unless the current ledger stays authoritative, the original source identity and checkpoint remain exact, ordinary descriptions, actions, Boss input, and nested results remain fenced, and only an applicable reconciliation action can be exposed; a later all-`unchanged` reconstruction may clear the fence marker without truncating evidence or source lineage, while a separately unresolved deferred operation remains parked (verifying [[playbook-runtime-75](#playbook-runtime-75)]).
The matrix shall prove that an original-source deferred logical operation remains discoverable after a safe export, restore, and second adoption under fresh target identities, and shall further fail unless schema-2 and exact pre-effect adoption fixtures retain their existing behavior while schema-2 snapshots omit both retained-effect members (verifying [[playbook-runtime-75](#playbook-runtime-75)]).

#### playbook-runtime-78

When the semantic-reconciliation integration matrix drives the exported shared surface of [[playbook-runtime-34](#playbook-runtime-34)] and a synthetic governed artifact-schema-3 runtime, it shall fail unless every declared guard accepts exactly its semantic-owned string fields, presentation fields contain only canonical trimmed `finalText`, an exact matching `one-descendant-commit` receipt alone supplies `latestCommit`, explicit exact runtime evidence alone supplies runtime-owned fields, and the retained evidence preserves the original opaque presentation and detached semantic candidate without deriving repository facts (verifying [[playbook-runtime-77](#playbook-runtime-77)]).
The matrix shall exercise malformed or unknown candidates, missing semantic fields, extra and wrongly owned fields, non-string values, and accessor-backed evidence; it shall fail unless each raises the distinct structural error before actor delivery, the first such live reply starts one corrective judge only after the exact unspent-to-spent ledger update is acknowledged, a valid correction may then reconcile, and a second invalid reply parks with no third call while retaining its recoverable detached candidate (verifying [[playbook-runtime-77](#playbook-runtime-77)] and [[playbook-runtime-69](#playbook-runtime-69)]).
The live matrix shall fail unless a rejected or indeterminate correction-budget write starts no corrective judge, abort after an acknowledged spend preserves the spent budget and recoverable first candidate while starting no corrective judge, successful correction preserves that first candidate immutably beside the latest candidate, initial and corrective judge transport or result-shape failures park without an unauthorized later call and retain the latest recoverable candidate when one exists, malformed no-value replies may omit one, player abort, error, non-`ok`, and missing-final-text paths start no semantic adjudication, and export and restart preserve the one-way spend and start neither a replacement player nor judge (verifying [[playbook-runtime-77](#playbook-runtime-77)] and [[playbook-runtime-69](#playbook-runtime-69)]).
The evidence matrix shall fail unless exact matching receipts resolve, missing or malformed presentation, semantic, effect, or runtime evidence and a mismatched nonzero receipt remain unresolved without semantic correction, a host acknowledgement cannot change the receipt used for reconciliation or omit proposed retained evidence from either a resolved or unresolved envelope, a deferred `needsBossReply` is eligible only for a complete same-HEAD `unchanged` or `worktree-only-change` receipt and publishes nothing before its durable binding, and a semantic candidate can never establish or alter the repository result (verifying [[playbook-runtime-77](#playbook-runtime-77)] and [[playbook-runtime-73](#playbook-runtime-73)]).
Across live completion and reconstruction at the matching persisted source state, the suite shall fail unless one complete consistent envelope delivers one frozen output exactly once after acknowledgement and starts no replacement player or judge, while incomplete evidence delivers no output and remains parked; it shall further fail unless artifact-schema-2 adjudication retains [[playbook-runtime-10](#playbook-runtime-10)] (verifying [[playbook-runtime-77](#playbook-runtime-77)]).

#### playbook-runtime-80

When the unresolved-effect control matrix drives live, restored, and retained-adopted schema-3 runtimes at the safe control-capture point of [[playbook-runtime-52](#playbook-runtime-52)], it shall fail unless every unresolved view omits its pending questions and state description and advertises exactly `reconcile:unresolved-effect` and `abandon:unresolved-effect`, with no ordinary retry or jump, while a resolved runtime advertises neither action (verifying [[playbook-runtime-79](#playbook-runtime-79)]).
The matrix shall fail unless an unequal deferred-checkpoint reconciliation retains the unresolved operation and starts no player or judge, while exact checkpoint restoration consumes eligibility, republishes the identical stable question and bound wait, returns an ordinary nonterminal run result, and likewise starts no player, judge, or semantic-candidate delivery (verifying [[playbook-runtime-79](#playbook-runtime-79)] and [[playbook-runtime-73](#playbook-runtime-73)]).
The matrix shall fail unless abandonment moves no actor state and returns one accepted control receipt whose run is exactly `{ outcome: 'unresolved-effect', state }`, whose state remains active, quiescent, and nonfinal, and whose run carries no state description, output, pending call, error, repository receipt, effect ledger, semantic evidence, or unresolved-effects projection; replaying its idempotency key shall return that receipt without another action boundary (verifying [[playbook-runtime-79](#playbook-runtime-79)] and [[playbook-runtime-52](#playbook-runtime-52)]).
The public-contract matrix shall fail unless the SLC, authored runtime source, committed declaration, and packaged declaration all expose that exact state-only arm while preserving the distinct terminal, suspended, failure, abort, quiescent, and no-action shapes (verifying [[playbook-runtime-34](#playbook-runtime-34)], [[playbook-runtime-41](#playbook-runtime-41)], and [[playbook-runtime-79](#playbook-runtime-79)]).

#### playbook-runtime-82

When the accepted-outcome integration matrix drives the shared flat runtime and the bespoke parallel DECIDE runtime with staged schema-3 markers, it shall fail unless an executed declared marker produces exactly one `outcome.accepted` trace and one canonical accepted-outcome status only after adjacent public root snapshots confirm its source and target, every such emission drains before settlement, and multiple simultaneously confirmed parallel markers retain their exact source, target, outcome, and execution order (verifying [[playbook-runtime-81](#playbook-runtime-81)]).
The matrix shall fail unless a stricter guard's valid unmarked fallback settles without accepted evidence, an initial-entry marker with no prior root snapshot, an unconfirmed source or target, malformed or undeclared marker data, a malformed-then-valid action batch, and duplicate instrumentation fail the boundary without evidence, no stale marker can attach to a later snapshot, a rejected accepted-outcome trace sink emits no claimed status, and artifact schema `2` retains its raw settling-output guard status without publishing an accepted-outcome trace (verifying [[playbook-runtime-3](#playbook-runtime-3)] and [[playbook-runtime-81](#playbook-runtime-81)]).

### Host adapter

#### playbook-runtime-21


When CODE, REVIEW, and DECIDE are driven through the shell from their real registry modules, the test suite shall fail unless each registry declares its current required roles, player calls reach the frame's effective host bindings, host-supplied prompt identities reach the compiled placeholders unchanged, hidden adjudication reaches the shared Captain queue, and each registry exposes only its own current summary labels and handoff guards (verifying [[playbook-runtime-4](#playbook-runtime-4)], [[playbook-runtime-15](#playbook-runtime-15)], and [[playbook-runtime-16](#playbook-runtime-16)]).

#### playbook-runtime-32


When the Playbook Captain shell adapter is driven end to end
against a real `createTmuxPlayRuntime` instance — over fake player
and captain adapters with a `RecordObserver` capturing the full
record trace — through a workflow turn that triggers adjudication,
the test suite shall fail unless every judge Captain-call record (`captain_prompt`,
`captain_event`, `captain_finished`) carries `visibility: 'hidden'`
and no Boss-pane-visible record carries a raw judge reply.
Hidden-tagged records are exactly the ones the tmux pane presenter
skips, so this is the standing proof that the judge's JSON never
reaches the Boss pane — only the runtime-composed status lines do
([[playbook-runtime-3](playbook-runtime.md#playbook-runtime-3)]) (verifying [[playbook-runtime-15](#playbook-runtime-15)]).

### Lifecycle and captain bridge

#### playbook-runtime-22


When the runtime is constructed by `createPlaybookRuntime`, `init`
is awaited, `handleBossInput` is invoked before `init` on a
separate runtime instance, and `dispose` is called on a started
runtime, the test suite shall fail unless `init` starts the actor
at the idle state, the pre-`init` `handleBossInput` call rejects,
`dispose` stops the actor, and `dispose` awaits any pending port
emissions before resolving (verifying [[playbook-runtime-6](#playbook-runtime-6)]).

When `dispose` is called on a runtime parked outside a final
state, the test suite shall fail unless the disposal emits no
status and no `playbook.fsm.state` telemetry, and the only trace it
appends is `session.disposed`. When a host disposes such a runtime
through a real Playbook Captain shell — the dismiss and switch
paths both do — the test suite shall fail unless the runtime emits
no further status for that disposal, so the parked state's line
reaches the host exactly once for that engagement.
The rule binds every linked runtime, not the shared factory alone, so
the suite shall drive the same disposal against each runtime that
builds its own actor — DECIDE today — and shall fail unless that
disposal likewise appends only `session.disposed`. Because the
omission is a per-runtime convention rather than a shared code path,
the suite shall additionally discover, rather than enumerate, every
runtime source that constructs an actor and shall fail unless each
stops its actor at exactly one site that suppresses inspection
emissions first, so a later fat artifact is covered without amending
the check.

#### playbook-runtime-23


When the runtime's captain bridge is driven as an xstate actor
under fake ports, the test suite shall fail unless (verifying [[playbook-runtime-9](#playbook-runtime-9)], [[playbook-runtime-10](#playbook-runtime-10)]):

- the adjudicator prompt identifies hidden control work, prohibits tool use,
  file inspection, and external evidence, and requires exactly one JSON object
  with no prose;
- `PlayerResult` `status='ok'` with non-empty `finalText` advances
  the FSM through `onDone`;
- `status='aborted'` and `status='error'` each route the FSM to
  the failure state through `onError` with no repeated
  `callPlayer` call;
- `status='ok'` without non-empty `finalText` routes the FSM to
  the failure state through `onError` only after the single
  corrective re-ask of
  [[playbook-runtime-9](playbook-runtime.md#playbook-runtime-9)] returns a second
  such result;
- a `callJudge` reply that is malformed JSON, names an undeclared
  guard, or omits a required extracted non-verbatim payload field
  lets XState route internally to the
  failure state for cleanup but then rejects the public runtime method with
  the original adjudicator control error;
- a `callJudge` reply that omits a field marked `<verbatim final text>` does _not_ throw: the runtime
  substitutes the player's `finalText.trim()` into that field
  and the FSM advances; any judge-supplied value for those
  fields is overwritten by the verbatim text.

#### playbook-runtime-51


When the delegated-player bridge and the direct-Captain actor are
each driven under fake ports whose scripted first result is an
`ok` result with missing, `''`, or whitespace-only `finalText` —
or, for the final bullet, an `aborted` or `error` result — the
test suite shall fail unless (verifying [[playbook-runtime-9](#playbook-runtime-9)], [[playbook-runtime-47](#playbook-runtime-47)]):

- a second scripted `ok` result with non-empty `finalText` lets
  the turn recover after exactly two host calls — the player path
  adjudicates the second text and advances through `onDone`, and
  the direct-Captain path resolves the second result — with each
  call traced as its own started/finished pair;
- a second scripted empty result routes the FSM to the failure
  state through `onError` after exactly two host calls, and
  `handleBossInput` resolves the structured `failed` outcome
  rather than rejecting;
- both boundaries treat `''` and whitespace-only `finalText`
  exactly like a missing `finalText`;
- a first `status='aborted'` or `status='error'` result triggers
  no second host call;
- an abort that lands while the corrective call's own started emission
  drains (fired from the trace sink) triggers no second host call at
  either boundary: the corrective pair finishes `aborted` and the turn
  settles as an abort;
- the corrective call's prompt is byte-equal to the first call's
  prompt, at both boundaries;
- the corrective player call's resume selection follows
  [[playbook-runtime-38](playbook-runtime.md#playbook-runtime-38)]: it resumes the
  token the empty result carried and starts fresh when that result
  cleared the stored token.

#### playbook-runtime-33


When the runtime is driven through a Boss turn whose `callJudge`
reply carries a valid JSON object that is wrapped in surrounding
prose (including prose containing other bracketed fragments),
wrapped in a Markdown code fence amid prose, carries a trailing
comma before a closing brace or bracket, or is truncated with an
unclosed object or an unterminated string, the test suite shall
fail unless the runtime recovers the intended object and advances:
a messy adjudication reply driven through the captain bridge advances
the FSM under the named guard, and a messy pending-question classifier
reply maps to the named reply or interrupt event. When a reply carries no
recoverable JSON value, the test suite shall fail unless
adjudication driven through the captain bridge lets the FSM settle at the
failure state and then rejects the public runtime method, while pending-question classification produces exactly one `emitStatus` call, makes no
player call, sends no event, and leaves the actor unmoved (verifying [[playbook-runtime-7](#playbook-runtime-7)], [[playbook-runtime-10](#playbook-runtime-10)]).

### Classification and flow

#### playbook-runtime-24


When the integration suite drives a fresh nonempty Boss turn through CODE, REVIEW, and DECIDE, it shall fail unless each runtime sends its declared deterministic initial event with the exact Boss text and no judge call (verifying [[playbook-runtime-1](#playbook-runtime-1)]).

#### playbook-runtime-25


When a runtime is driven at its idle entry, its recoverable failure state, and its reconstructed terminal with nonempty ordinary or slash-prefixed text and with empty or whitespace-only text, the test suite shall fail unless every nonempty input enters through the artifact's deterministic event with no classifier call and every empty input produces only the received and settled trace pair (verifying [[playbook-runtime-1](#playbook-runtime-1)] and [[playbook-runtime-7](#playbook-runtime-7)]).
The suite shall further fail unless an authored mid-workflow checkpoint — parked, no pending question, not one of the three entries, like the acceptance notes fixture's `outline` — classifies its nonempty ordinary and slash-prefixed text alike under its own Boss-event contracts, the classifier prompt carrying no pending-question context and offering no reply contract even while the machine's context retains an answered question, while empty or whitespace-only input there produces the same trace-only no-action as every state: no event, judge call, player call, status emission, or FSM transition (verifying [[playbook-runtime-7](#playbook-runtime-7)]).
The suite shall further fail unless text delivered at the recoverable failure state a resumed player reached after an answered Boss question enters through the deterministic entry event with no classifier call — the retained question steering nothing — and replays the player under the delivered text (verifying [[playbook-runtime-1](#playbook-runtime-1)] and [[playbook-runtime-7](#playbook-runtime-7)]).

#### playbook-runtime-26


When the CODE, REVIEW, and DECIDE suites drive every delegated-role state, they shall fail unless each player invocation reaches `callPlayer` with the compiler-supplied canonical local role id unchanged — `coder` for every Coder invocation and `reviewer` for every Reviewer invocation (verifying [[playbook-runtime-8](#playbook-runtime-8)]).

#### playbook-runtime-27


When the runtime is driven to the FSM's terminal state and a
further Boss turn is submitted, the test suite shall fail unless
the runtime leaves the terminal actor unchanged for empty input and disposes and reconstructs it only for the artifact's valid initial event so the new nonempty turn is processed from idle.
The direct runtime test verifies [[playbook-runtime-12](#playbook-runtime-12)].

#### playbook-runtime-28


When the runtime is driven through `handleBossInput` while the actor
has one scalar or one or more branch-local pending Boss questions, with
text that the classifier names
as `BOSS_REPLY`, with text that the classifier names as a fresh
directive event, with a classifier reply that is invalid for the
current state, with text beginning with `/`, and with empty or
whitespace-only text, the test suite shall fail unless every
non-empty text routes through `callJudge`, `BOSS_REPLY` carries the
verbatim answer and resumes only the identified pending task, a sole
pending question permits an omitted id, multiple questions require a
known id, a fresh directive exits the wait and clears its relevant
pending reply context, text beginning with `/` receives no special parsing,
invalid replies surface one `emitStatus` call and leave the FSM
unmoved, and empty text makes no judge call, player call, status
emission, or FSM transition while still emitting the received/settled
session trace.
The classifier prompt shall carry the exact pending question ids, questions,
and discriminated Captain-or-role askers; an initial or post-child answer shall resume the matching
task with the same original intent, plan, completed results, and exactly ordered
Q+A continuation blocks (verifying [[playbook-runtime-2](#playbook-runtime-2)], [[playbook-runtime-7](#playbook-runtime-7)]).

### Options validation

#### playbook-runtime-31


When the shell initializes each real CODE, REVIEW, and DECIDE registry with an absent slice, `{}`, a non-object, and an object carrying an unknown key, the test suite shall fail unless only the absent and empty slices pass and every rejection names that playbook's option path and offending key when present (verifying [[playbook-runtime-29](#playbook-runtime-29)] and [[playbook-runtime-30](#playbook-runtime-30)]).

### Runtime contract module

#### playbook-runtime-35


The test suite shall fail unless the `@sublang/playbook/runtime`
contract agrees with
[slc/link.md](../../slc/link.md#playbookruntime-contract):
`PlayerResult.status` admits exactly the members `ok`, `aborted`, and
`error`, and `PlaybookPorts` declares exactly the members `callPlayer`,
`callCaptain`, `callJudge`, `callPlaybook`, `emitStatus`, and
`emitTelemetry`.
The test suite shall additionally fail unless the module exports
the role-binding, player-call, pending-question, player-session-store, adoption-context, Captain-call, nested-call, repository-observation, effect-receipt, effect-ledger, JSON value/error, structured-state,
session, trace, run-result, runtime, and runtime-factory contract types,
unless `PlayerResult`
exposes optional `resumeToken`, unless `callPlayer` requires explicit
resume options, unless `CaptainResult.status` admits `ok`, `aborted`, and
`error` without exposing a player resume token, unless `CaptainCallOptions`
requires visible-or-hidden visibility plus explicit resume selection and
exposes an optional tool allowlist whose omission is distinct from an explicit
empty list,
unless `PlaybookRuntime.init` accepts a causal
`PlaybookSession` with optional exact `PlaybookRoleBinding` metadata and the optional `PlayerSessionStore` whose four methods have the exact synchronous signatures and local-role snapshot shape of [[playbook-runtime-58](#playbook-runtime-58)], unless pending Boss questions use the exact asker union without a player field, and unless `handleBossInput` and
`resumePlaybookCall` return `PlaybookRunResult` whose terminal variant alone exposes optional `stateDescription` and whose `unresolved-effect` variant is exactly state-only, and unless `PlaybookAdoptionContext` and `adopt` have the exact source, target-child, session, snapshot, and context shapes; its import graph
includes no CODE or FSM module (verifying [[playbook-runtime-34](#playbook-runtime-34)], [[playbook-runtime-41](#playbook-runtime-41)], [[playbook-runtime-58](#playbook-runtime-58)], and [[playbook-runtime-61](#playbook-runtime-61)]).
The contract suite shall fail unless `PlaybookRuntime.unresolvedEffectEnvelopes` is optional and returns only the exact read-only boundary-or-logical-operation identity union, malformed or evidence-bearing identities are rejected at the host boundary, and the state-only `unresolved-effect` run-result arm remains free of that identity list and every bounded repository fact (verifying [[playbook-runtime-34](#playbook-runtime-34)]).
The test suite shall additionally fail unless the linker contract
itself still states the clauses the shipped artifacts depend on, since
that contract is the source they are generated from and a rule stated
only in an artifact is one the next re-link can undo: its control
surface section shall state that the view's `context` is a projection
the linked runtime authors, shall name the `controlContextFields` spec
member that carries it, shall state that a runtime naming no member
carries no `context`, and shall no longer describe the view as a
sanitized serialization of the FSM context; and its output section
shall list `controlContextFields` and complete `roleStates` among the members an emitted module
supplies, shall state that the context projection's default is nothing rather than
everything, and shall require the `_internal` composers the artifact's
own machine uses rather than a fixed player-and-Captain pair.
Matching type shapes shall not satisfy this: the retired text declared
the same optional `context` while describing the behavior the
projection replaced (verifying [[playbook-runtime-34](#playbook-runtime-34)] and [[playbook-runtime-58](#playbook-runtime-58)]).

#### playbook-runtime-36


The test suite shall fail unless each public CODE, REVIEW, and DECIDE playbook module obtains and re-exports its shared player, player-session-store, Captain-call, nested-call, state, session, trace, result, and runtime contract types from `@sublang/playbook/runtime` rather than declaring its own.
The check shall rest on observable declaration evidence in each shipped `*.playbook.d.ts` and not on mutual assignability alone.
A
mutual-assignability check alone shall not satisfy this item, because
TypeScript's structural typing makes a same-shaped local redefinition
assignable to the shared types and would therefore pass while an artifact still violated [[playbook-runtime-5](#playbook-runtime-5)] (verifying [[playbook-runtime-5](#playbook-runtime-5)]).

### Session Trace and Player Continuation Coverage

#### playbook-runtime-39


Where the integration suite drives CODE, REVIEW, DECIDE, and a direct-Captain runtime through complete sessions, it shall fail unless every emitted trace event has schema version `4`, session identity is immutable, causality is validated, trace sequences are contiguous and boundary-complete, initialization and disposal faults preserve their first causal error, and every started call has exactly one finish — a started-boundary sink that records and then rejects with a distinct error included: the pair finishes `error` with no host call begun and the public method rejects with the original sink error, while a sink that cancels the turn and rejects with the exact signal reason instead finishes the pair `aborted` with no host call and the turn settles as an abort (verifying [[playbook-runtime-37](#playbook-runtime-37)]).
When a maintained shared-factory runtime or DECIDE reaches a final state, the integration suite shall fail unless its terminal result carries that state's exact authored description and never a state-id or output-derived fallback (verifying [[playbook-runtime-41](#playbook-runtime-41)]).
The suite shall fail unless every shell-hosted player-call pair retains both its semantic `roleId` and resolved `playerId`, while a standalone call retains its role without inventing a host player id; restoring under compatible changed model tuning shall also make the next composed prompt use the current `promptIdentity` rather than a value persisted in machine context (verifying [[playbook-runtime-15](#playbook-runtime-15)] and [[playbook-runtime-37](#playbook-runtime-37)]).
The suite shall fail unless a standalone runtime without bindings starts each local role fresh, resumes and rotates that role's validated token in `roleResumeTokens`, clears an omitted token only on `ok`, preserves the prior token when `aborted` or `error` omits one, keeps different roles independent, preserves continuity across parked turns, and discards it on disposal; with bindings but no external store, two sequential roles mapped to one player id shall select and rotate one shared private token while the snapshot projects that token back to both local-role keys (verifying [[playbook-runtime-38](#playbook-runtime-38)] and [[playbook-runtime-45](#playbook-runtime-45)]).
Host results shall fail unless they are validated, detached, and frozen before any final text, error, or resume token is consumed, and a late result after abort shall not mutate continuity or trace success (verifying [[playbook-runtime-37](#playbook-runtime-37)] and [[playbook-runtime-38](#playbook-runtime-38)]).

#### playbook-runtime-60

When the integration suite initializes a runtime with valid and malformed `PlaybookSession.roleBindings`, it shall fail unless the valid exact local-role map is detached for the runtime lifetime; empty identities, missing or extra local roles, and later caller mutation reject or cannot alter targeting; the invocation-scoped prompt-identity lookup returns the detached current identity or standalone role fallback, rejects undeclared roles, and exposes no player id or binding map; and the FSM options, input, context, and snapshot contain no host player id or prompt identity (verifying [[playbook-runtime-6](#playbook-runtime-6)] and [[playbook-runtime-15](#playbook-runtime-15)]).

#### playbook-runtime-56

Where the integration suite initializes a runtime with a fake `PlayerSessionStore` and drives a host-mapped nested frame, it shall fail unless the declared store methods have the exact synchronous signatures of [[playbook-runtime-58](#playbook-runtime-58)], every call uses the frame-local role key, the host view maps that key to the Captain-session player ledger, selection occurs before the player-start trace and call, replacement or authorized `ok` clearing occurs before the player-finish trace and adjudication, aborted/error omission performs no update, snapshot returns local-role keys, aliased roles cannot restore conflicting tokens, restore replaces exactly the frame view without clearing another player, and a rejected host call preserves the prior selection (verifying [[playbook-runtime-55](#playbook-runtime-55)] and [[playbook-runtime-58](#playbook-runtime-58)]).

### Structured and Composed Execution Coverage

#### playbook-runtime-43


Where the integration suite drives DECIDE through its real linked
runtime with gated Coder and Reviewer ports, the test suite shall
fail unless both independent proposals start before either result is required, both completion orders yield the same joined inputs, neither proposal prompt contains the other's output, and the Coder commit starts only after both finish.
The test suite shall fail unless one or two branch-local Boss questions
park and resume independently without restarting a completed or still
waiting sibling, a branch failure stops its sibling and reaches
`failed`, roles bound to distinct player ids overlap, roles bound to the same player id reject overlap, and distinct local roles overlap when binding metadata is omitted (verifying [[playbook-runtime-40](#playbook-runtime-40)]), and
direct Captain and hidden judge calls never overlap.
It shall fail unless a Boss interrupt restarts both proposal branches with the replacement topic, clears both prior branch results and questions, and does not target an individual branch or wait state.
Structured state telemetry and trace shall remain JSON-safe, identify
all active leaves and tags, contain no `[object Object]` classifier
state, use contiguous trace sequence numbers, and settle only after all
in-flight calls and emissions from the turn drain.
Mutating or attempting to mutate described state telemetry shall not alter a
later transition's authoritative `from` state.
Strict JSON cases shall reject dates, maps, class/accessor/symbol objects,
undefined or sparse values, non-finite numbers, and cycles across options,
child output, trace payload, and terminal output rather than silently changing
them.
Disposal shall fail rather than race an active turn, concurrent idle disposal
shall share one teardown, and a canceled branch whose host ignores abort shall
finish draining before the turn settles without mutating its player token (verifying [[playbook-runtime-40](#playbook-runtime-40)], [[playbook-runtime-41](#playbook-runtime-41)]).

#### playbook-runtime-44


Where the integration suite drives a test linked parent and child
through the real Playbook Captain shell and the parent's XState machine
invokes the `playbook` actor, the test suite shall fail unless
an immediately completed child reaches parent `onDone`, a parked child
returns parent outcome `suspended` without holding the Boss turn open,
and a later matching resume drives the parent from the child output.
The test suite shall fail unless child aborted/error results reach
parent `onError`, unknown or duplicate call ids reject, parent disposal
aborts a pending call, the parent's local-role token projection survives
suspension, and `playbook.call.started` / `playbook.call.finished` form
one causally ordered trace pair around the child session, with the finish
event preceding the parent transition caused by that return and retaining the
start event's turn id across a later resume.
Wrong immediate targets, empty suspended session ids, unknown start states,
malformed normalized errors, non-JSON output, and thrown ports shall each
reject as control-plane errors, create no stale pending identity, and still
pair every emitted call start exactly once. Disposal during a deferred opening
or suspended child shall order child disposal before parent call finish before
parent session disposal.
An exceptional resume shall drain its emissions, preserve the call-start turn
id, surface the first current-boundary control error, and clear its latches so
the next Boss turn cannot inherit that failure. Concurrent idle disposal shall
share one outcome, while disposal requested during a live public boundary
shall reject without starting teardown.
Suspended-child abort cleanup shall filter every rejection exactly identical
to an applicable abort reason; any remaining distinct failure shall still
emit the matching error finish and reject disposal as the original failure or
distinct-failure aggregate (verifying [[playbook-runtime-42](#playbook-runtime-42)]).

#### playbook-runtime-46


Where the integration suite drives the real CODE linked runtime through
scripted ports to `awaitBossReply` and calls `exportSnapshot`, the test
suite shall fail unless the snapshot is JSON-round-trip safe and carries
schema version `4` without a suspended-call descriptor, the playbook id, the parked state descriptor, the exact canonical empty effect ledger, the
recorded local-role resume token, the live sequence counters, and one
pending Boss question with a discriminated role asker and verbatim question
text (verifying [[playbook-runtime-45](#playbook-runtime-45)]).
The test suite shall fail unless a fresh runtime instance created by
the same factory `restore`s that snapshot under the original session
identity without emitting `session.started`, and a following Boss reply
re-enters the recorded resume state, passes the pre-park resume token
to the resumed player call, and continues the trace with contiguous
sequence numbers across the export/restore boundary (verifying [[playbook-runtime-45](#playbook-runtime-45)]).
Where the integration suite exports a shared-factory runtime suspended behind a nested playbook and restores it in a fresh instance, the suite shall fail unless the schema-version-4 descriptor and ledger preserve the original call, child, input, turn, and effect ownership; restore reattaches the reconstructed promise actor without another host call or start trace; exact resume emits one finish under the original call and turn before continuing the parent; and a failed pre-confirm state comparison rolls back without a finish and permits exact retry (verifying [[playbook-runtime-42](#playbook-runtime-42)] and [[playbook-runtime-45](#playbook-runtime-45)]).
Where a schema-1, schema-2, or schema-3 snapshot is supplied directly, the suite shall fail unless restore rejects before actor construction, host child invocation, or another start or finish (verifying [[playbook-runtime-42](#playbook-runtime-42)] and [[playbook-runtime-45](#playbook-runtime-45)]).
It shall fail unless `exportSnapshot` returns `undefined` during an
active turn and after disposal; unless `restore` rejects a
schema-version mismatch, a playbook-id mismatch, and an already
initialized instance; and unless the DECIDE linked runtime round-trips
a parked branch question through the same export/restore surface (verifying [[playbook-runtime-45](#playbook-runtime-45)]).
It shall fail unless a failure reached after a Boss reply resumed the
work exports and describes no pending question, while the Boss-reply
wait itself exports and describes it (verifying [[playbook-runtime-45](#playbook-runtime-45)] and [[playbook-runtime-52](#playbook-runtime-52)]).
It shall fail unless DECIDE's telemetry and snapshot count a question
by its own active authored wait across all three reply paths — an
answered branch or commit question disappearing from every transition
of the resumed turn while an unanswered sibling branch question
remains reported (verifying [[playbook-runtime-45](#playbook-runtime-45)]).
The suite shall also fail unless the compiled default Captain exposes both snapshot methods and the real Playbook Captain shell embeds its exported runtime snapshot in, and restores it from, one complete shell snapshot without calling `init` on the restored runtime (verifying [[playbook-runtime-45](#playbook-runtime-45)]).

#### playbook-runtime-62

Where the integration suite exercises retained-snapshot adoption, it shall fail unless every shared-factory runtime exposes `adopt` even without retained-generation metadata, a fresh runtime adopts a parked schema-version-4 snapshot with the exact current effect-ledger mirror under a distinct valid engagement identity and continues from the persisted state without initial classification, that successful adoption closes all three initialization paths, and a bespoke capability-less runtime remains valid with the member absent (verifying [[playbook-runtime-61](#playbook-runtime-61)] and [[playbook-runtime-65](#playbook-runtime-65)]).
It shall fail unless adopting a suspended nested snapshot reconstructs the exact persisted invocation under fresh target call, child, and counter ownership without another host child call or `playbook.call.started` trace, then resumes the parent exactly once; unless schema, playbook-id, local-role binding, and adoption-context preflight mismatches reject before any player-session-store or host effect; unless successful adoption leaves retained role-token projections unapplied through both a supplied store whose `restore` rejects and the runtime-private fallback; unless, in that suspended case, persisted-state and bridge mismatches produce no child-host call or playbook-call boundary and clean up the attempted target session; and unless failed reconstruction rolls provisional bridge ownership back so the same unused runtime accepts an exact retry (verifying [[playbook-runtime-61](#playbook-runtime-61)], [[playbook-runtime-65](#playbook-runtime-65)], and [[playbook-runtime-42](#playbook-runtime-42)]).

#### playbook-runtime-64

Where the integration suite adopts one parked snapshot into fresh target sessions, it shall fail unless an unchanged player's current ledger token is selected exactly, a shared player's newer ledger token after adoption wins over the retained projection, and a replacement player with a `false` current selection starts fresh under the target binding's player and prompt identities (verifying [[playbook-runtime-63](#playbook-runtime-63)]).
For every supplied-store case, it shall fail unless adoption itself performs no selection, restore, or update (verifying [[playbook-runtime-61](#playbook-runtime-61)] and [[playbook-runtime-63](#playbook-runtime-63)]).
It shall fail unless the first resumed player invocation selects exactly once before its start trace and host call, the start trace names the target player and selected continuation, and a validated result carrying a replacement token updates that same target store (verifying [[playbook-runtime-55](#playbook-runtime-55)] and [[playbook-runtime-63](#playbook-runtime-63)]).
It shall also fail unless the storeless adoption path starts fresh rather than seeding private continuation from the retained projection (verifying [[playbook-runtime-61](#playbook-runtime-61)] and [[playbook-runtime-63](#playbook-runtime-63)]).

#### playbook-runtime-66

Where the integration suite adopts parked snapshots that collectively carry nonzero source trace, turn, judge, player, playbook, and supported direct-Captain counters, it shall fail unless every target session and generation identity differs from its source context, the only adoption-time telemetry for each is one target `session.started` at sequence `1` carrying the exact state and lineage payload of [[playbook-runtime-65](#playbook-runtime-65)], every immediate target snapshot carries fresh counters, and the next target turn plus every applicable judge, player, direct-Captain, and apply call allocate id `1` with a contiguous target trace rather than a source continuation (verifying [[playbook-runtime-65](#playbook-runtime-65)]).
Where the source snapshot is suspended behind a child, the suite shall fail unless adoption requires a fresh target child identity, exposes target `playbook-1` with no source turn id in both its session-start lineage and exported descriptor, resumes that edge once with its finish at target sequence `2` without another host child call or `playbook.call.started`, and allocates a later target nested call as `playbook-2` rather than colliding with the adopted edge (verifying [[playbook-runtime-65](#playbook-runtime-65)]).
The suite shall fail unless absent, extra, empty, accessor-backed, source-equal, frame-depth-inconsistent, target-child-aliasing, or suspended-shape-inconsistent adoption context rejects before actor, store, port, status, or telemetry effects; and unless a reconstruction failure after the target start trace emits one best-effort target disposal, releases provisional call ownership, and permits an exact snapshot-and-context retry under a fresh target identity whose trace begins at sequence `1` (verifying [[playbook-runtime-61](#playbook-runtime-61)] and [[playbook-runtime-65](#playbook-runtime-65)]).
It shall also fail unless same-engagement restore of those snapshots remains trace-silent and preserves their exact source counters, suspended call, child, and turn ownership (verifying [[playbook-runtime-45](#playbook-runtime-45)] and [[playbook-runtime-65](#playbook-runtime-65)]).

#### playbook-runtime-59


Where the integration suite arms the shared nested bridge and starts a real XState parent in its nested promise actor's invoking state, the test suite shall fail unless an exact descriptor remains unpublished before confirmation, confirms without allocating or emitting a second start or invoking the host port, preserves its detached full identity, and eventually emits one finish before the parent's `onDone` transition.
The suite shall fail unless mismatched state, target, or text, a second claim, an invoke without a descriptor, and an unclaimed descriptor each reject; unless a failed or aborted pre-confirmation attempt emits no finish and leaves its call id reusable; and unless a confirmed call id remains spent after exact resume (verifying [[playbook-runtime-42](#playbook-runtime-42)]).
Where the suite validates public runtime snapshots, it shall fail unless schemas `1` through `3` reject before binding, schema version `4` requires a valid effect ledger and explicit suspended-call support on the handling path, Captain and role question askers are discriminated exactly, the returned snapshot, ledger, and descriptor are detached and frozen, and malformed ownership, impossible state/counter combinations, undeclared fields, accessors, and current-host mirror mismatches are rejected (verifying [[playbook-runtime-45](#playbook-runtime-45)] and [[playbook-runtime-69](#playbook-runtime-69)]).

### Control Surface Coverage

#### playbook-runtime-53


Where the integration suite drives shared-factory runtimes — synthetic
workflow machines plus the real linked CODE runtime, under fake ports
with scripted per-call results — the test suite shall fail unless every
factory-built runtime exposes `describe` and `apply` together, and
unless both members throw before `init`, during an active boundary,
and after disposal.
The suite shall also fail unless factory construction rejects the real
DECIDE FSM because it declares parallel states, a synthetic non-parallel
machine that declares a compound state, a synthetic flat machine
whose `meta.playbook.stateId` differs from its state key, a synthetic
flat machine with a root state declaring no string
`meta.playbook.stateId`, and a machine declaring no root states.
The suite shall also fail unless factory construction accepts `unfinishedFinalStateIds` naming a root final state, exposes it on each constructed runtime as an exact frozen retention descriptor, leaves that descriptor absent when the declaration is absent, and rejects the declaration when it names an existing non-final root state or an unknown state (verifying [[playbook-runtime-52](#playbook-runtime-52)]).
The suite shall fail unless a state whose source declares no
description can become active — an `init` whose initial state declares
none and a turn entering such a state both succeed — with the turn
settling normally, the runtime remaining usable, and `describe()` and
the exported state carrying no `stateDescription`.
The suite shall fail unless `describe()` is side-effect free (no
trace, status, or telemetry; back-to-back views deep-equal; the
machine snapshot unmoved) and its view carries the normalized state,
the state description its source publishes for that state — verbatim,
on synthetic machines and on the real CODE runtime parked at `failed`
alike — the runtime-authored context projection, the pending Boss
question with its stable id, and the last error as
`{ name, message }`-bearing normalized form.
The suite shall discover every linked playbook artifact in the
repository rather than listing them, and shall fail unless each
artifact built on the shared factory declares a `controlContextFields`
projection, each artifact declaring a deterministic entry event whose
machine has a recoverable failure state also names that event's
persisted retry source [[playbook-runtime-52](#playbook-runtime-52)], and each
artifact's `_internal` exposes the prompt composers
its own machine uses — the player composer where and only where that
playbook calls players — so a re-link or a newly linked artifact cannot
ship without the declarations the privacy and cross-process recovery
contracts rest on
([slc/link.md](../../slc/link.md#output)).
The projection shall fail unless a factory runtime that declares no
context members carries no `context` at all while its FSM context is
populated; unless a runtime that declares members exports exactly
those, in declaration order, with a declared member that is absent or
not JSON-safe dropped and a declared raw `Error` normalized; unless
the real CODE runtime parked at `failed` exports only its declared
`phase` when present and no `context` when `phase` is absent, without
exposing the resolved player roster, option value, or player-authored
members its live context holds; and unless naming a first-class-surfaced
member fails runtime construction.
Action derivation shall fail unless: the real CODE runtime parked in
`failed` advertises only the `retry:START_CODE` action for its recorded
entry event with a label written from the source state description;
a synthetic guarded multi-arm `BOSS_INTERRUPT` matrix exercises a
non-first `targetId` and labels its retry from the recorded target's
description, never from the first configured arm; a recorded event the current state does not accept produces no
retry entry; outside the failure state no retry entry appears; the
synthetic context-conditional target flips from excluded to included
once the live context gains its required input; and jump events are
sent with textual fields omitted, never with invented text (an applied
retry replays the recorded payload with no classification call).
It shall further fail unless the declared retry source of
[[playbook-runtime-52](#playbook-runtime-52)] survives a process boundary on a
synthetic machine whose entry action copies the entry text into the
declared member: the runtime parked in `failed` advertises the same
action id and label before export and after restoring that snapshot
into a fresh instance, the applied action replays the original player
prompt, and the exported snapshot's members are exactly those of
[[playbook-runtime-45](#playbook-runtime-45)]; a failure reached after a Boss
reply resumed the work — which the same machine's undeclared twin
cannot retry in its own live process — advertises and applies that
retry in both processes; a declared member the machine never populates
excludes the candidate rather than falling back to the recorded event;
and the undeclared twin still advertises its recorded retry live and
none after restore.
It shall further fail unless no advertised label is ever an identifier:
a registered resumable target whose source publishes no description
shall not be advertised at all — not advertised under its own target id
— while a described sibling target the same snapshot accepts still is;
and a retry whose transition target publishes no description shall be
labeled from its own source state's description, with neither the target
id nor the replayed event type appearing in the label.
Receipts shall fail unless the A29-17 engine-level twins hold against
real `apply()`: an advertised retry from `failed` settles
`executed` with the run result; the same `actionId` re-applied after
the state moved on settles `rejected` with a reason before any effect
— snapshot unchanged, zero player calls; a scripted player `error`
mid-action settles `failed` with the normalized error while its
effects stay visible in traces; and a repeated idempotency key returns
the recorded receipt with exactly one execution in total.
The suite shall also fail unless a key whose call threw before
acceptance (a pre-aborted signal, or an abort landing while the
`apply.started` emission drains — the machine unmoved, no host call,
the pair finished `aborted` with the canonical `rejected` disposition
and its reason) records no receipt and may execute later; unless a
finish sink rejecting that abort finish surfaces its failure from the
boundary in place of the abort reason, the call still recording no
receipt and its key still executing later; unless a key first settled
`rejected` while its action was not
advertised records no receipt and executes when re-applied after the
action becomes advertisable, each of the two calls tracing its own
pair; unless a settlement failure after acceptance settles rather than
throws, discriminated by whether the receipt was already published: both a
distinct rejecting emission drain over an otherwise clean run and its twin
that aborts the apply signal and rejects with that exact reason, landing before
the finish emission, shall resolve with a `failed` receipt carrying the
sink's normalized error while the effects stay visible, each
`apply.finished` pair shall carry that same `failed` disposition rather
than the pre-fold one, and the replayed key shall return that receipt
verbatim with no re-execution and no new pair — while a rejecting
`apply.finished` sink over an executed action shall leave the receipt
`executed`, the emitted disposition and the returned one shall be the
same value, the replayed key shall return that same `executed` receipt,
and the sink failure shall surface from the next public boundary that
drains rather than being discarded or recorded as the effect's
settlement; unless an abort mid-execution settles
a `failed` receipt whose error reflects the abort while the boundary
drains cleanly; and unless every executed or rejected `apply` traces
as one paired `apply.started`/`apply.finished` carrying the action id,
idempotency key, and receipt disposition under a session-unique
`apply-<n>` call id, with no new pair on a replayed key.
The suite shall assert those payloads over every `apply.finished` the
trace holds, never over a disposition-filtered subset: the executed
and rejected settlements, the pre-acceptance abort finish, and the
best-effort finish a rejected `apply.started` sink emits shall each
carry the receipt disposition with its reason, normalized error, or
projected run result and no start-only field, `stateId` appearing on
`apply.started` alone
([slc/link.md](../../slc/link.md#playbook-trace)) (verifying [[playbook-runtime-52](#playbook-runtime-52)]).

#### playbook-runtime-54

Where the integration suite constructs a linked artifact against the real shared engine, when its shared-factory declaration is absent, malformed, schema `1`, or disagrees with the loaded engine, the suite shall fail unless runtime construction rejects before any machine interpretation or agent call with a diagnostic naming the offending declaration and supported value; compatible schema-2 `{ role, label }` metadata and the bespoke DECIDE profile shall preserve local roles without creating a host binding (verifying [[playbook-runtime-50](#playbook-runtime-50)]).
The suite shall also fail unless the engine exports the frozen supported set `[2, 3]`; exposes each successfully constructed schema-2 and schema-3 shared factory's exact validated `{ artifactSchema, runtimeAbi }` pair as an immutable own `compat` data property whose frozen value remains identical after later mutation of the supplied spec; accepts valid governed and explicit roleless-empty schema-3 metadata; rejects schema-2 metadata and schema-3 missing, extra, accessor, unknown, wrongly owned, inconsistent, or FSM-mismatched state, outcome, payload-field, authority, and disposition declarations before a player call; requires an exact accessor-free schema-3 construction object with a live capability object; and proves configured option snapshotting, FSM context, runtime snapshots, launch projections, and continuation identity contain no capability member or nested authority value (verifying [[playbook-runtime-29](#playbook-runtime-29)] and [[playbook-runtime-50](#playbook-runtime-50)]).
