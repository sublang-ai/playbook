<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# recovery: Prepare and resume interrupted work

## Intent

Save work before execution, restore interrupted runs without repeating work, and let Boss choose a bounded preparation or continuation ([DR-069](../decisions/069-captain-prepares-step-recovery.md)).

## External Behavior

### recovery-1

Before starting a player, direct-Captain or script invocation, the shared runtime shall capture a detached checkpoint containing its source state, complete composed prompt or command, persisted invocation machine including accepted Boss input, and current effect-ledger boundary prefix.
The runtime's `PlaybookStepRecord` shall contain `id`, `kind:'player'|'captain'|'script'`, `stateId` and optional JSON `result`.
The optional `recordStep(step, position?)` port shall receive a fresh UUID start and a runtime-owned restorable failed position before execution, then the same start with its JSON actor result before the next transition.
A failed start save shall start no work; a failed result save shall stop further work while retaining the known output for drained settlement.
While failed or waiting for Boss, the runtime shall export its checkpoint as optional `recoveryCheckpoint` and restore without execution [[playbook-runtime-45](playbook-runtime.md#playbook-runtime-45)].
A non-JSON context or invocation inside a parallel region shall remain executable with an explicit unavailable position; no single-invocation checkpoint shall be invented for a group.
After a parallel group joins, ordinary sequential invocations shall capture checkpoints under the same rule.
The checkpoint shall be replaced by the next invocation and omitted in other states.
When the invocation's output returns to the machine — a fresh actor result, with or without a step record, or a consumed saved result — the runtime shall retain the start checkpoint without its result and with `delivered: true`, preserved through export and restore, so a later authored failure or question keeps its ordinary controls while that output is never offered for assessment again [[recovery-10](#recovery-10)].
Only the internal step-start capture shall synthesize an interrupted position; public `exportSnapshot({child?})` shall export the actual position.

### recovery-2

When validating a checkpoint, the runtime shall require `stateId`, `prompt`, `machine`, and `boundaryPrefix`, with nonempty strings, a JSON machine active at that source state, and a nonnegative prefix not exceeding the ledger; optional members shall be UUID `id`, JSON `result`, and `delivered` accepting only literal `true`, each carried into the frozen checkpoint.
Restoration shall require exactly one current player, direct-Captain or script invocation with the declared actor and matching `input.stateId`.
A saved result shall name a declared guard and supply its required fields; a script result shall contain exactly `guard` and integer `exitStatus` consistent with its declared exit mapping.
Invalid checkpoints shall reject before execution.

### recovery-3

While failed with a valid checkpoint and no unresolved-effect fence, the runtime shall advertise retry only when every later boundary belongs to that runtime and is unchanged or has verified read-only restoration [[recovery-12](#recovery-12)], or when a saved result exists and every later boundary belongs to that runtime and source state.
The action shall retain `retry:<ENTRY_EVENT>` when the entry targets that source, otherwise use `retry:step`, and label the source description, explicitly naming a saved result when present.
Applying it shall rebuild only that invocation, preserving session identity, counters, player continuity, original input and completed predecessor context, consuming a saved output without repeating work [[playbook-runtime-52](playbook-runtime.md#playbook-runtime-52)].
New Boss text shall use the full causal-attempt checks for live failures [[playbook-runtime-71](playbook-runtime.md#playbook-runtime-71)], not the narrower invocation-retry suffix.
Step-start capture shall retain that attempt’s boundary prefix; restoration shall derive its single attempt identity from the current ledger, leaving mixed or unknown ownership unable to accept a new entry.
A missing or unsafe checkpoint, including an old failed snapshot or a failed nested call, shall authorize no retry; the runtime shall not fall back to restarting the playbook.

### recovery-5

While a leaf has an invocation checkpoint and either a pending Boss question or a ready step retry, verified-restoration retry, or saved-result assessment, its control view shall offer `recovery` containing the captured `prompt`, optional source-state `description`, optional `preparation` text stating the conditions the runtime will verify, optional JSON `evidence` containing saved player text, declared result choices and repository receipts, and a runtime-owned `continuation` of exactly `{kind:'reply'}` or `{kind:'runtime',actionId}`.

### recovery-6

When the default Captain selects preparation under [[captain-playbook-4](captain-playbook.md#captain-playbook-4)], its selection shall be the payload-free `{action:'recover'}` through the ordinary controller port [[captain-playbook-9](captain-playbook.md#captain-playbook-9)].
An ordinary answer shall select `deliver`; a requested advertised retry needing no preparation shall select `runtime`; a request to repair prerequisites and continue shall select `recover` only when preparation is available.

### recovery-7

Where the host supplies cancellation of admitted calls, when executing `recover`, the shell shall hold the worktree's exclusive claim and make exactly one fresh, hidden Captain preparation call on its existing serialized queue, using configured permissions and tools, the exact current Boss text, the offered step prompt, pending question, and structured failure:

- inspect and repair only prerequisites necessary for that continuation;
- decide first whether every required Boss choice is already supplied; if any is missing, report blocked before tools, even when no preparation or repair is otherwise needed;
- preserve a waiting player's tracked and non-ignored repository checkpoint; report blocked when preparation requires changing it;
- preserve a recoverable copy before removing or replacing unexpected files;
- preserve Boss's work and constraints; do not discard changes or rewrite history without explicit Boss authorization;
- establish that replay cannot duplicate an external effect before declaring ready; repository receipts alone do not establish this;
- do not perform remaining specialist steps, invent outcomes, change session records or effect evidence, or choose another machine state;
- return exactly `{status:'ready'|'blocked',summary:<nonempty text>}` describing the preparation or remaining blocker.

A host without cancellation shall not offer or start preparation.
The shell shall read the reply's one recoverable JSON object as the compiled Captain reads a decision [[captain-playbook-18](captain-playbook.md#captain-playbook-18)], so prose or a code fence around it is ignored, and shall treat a reply without one as a failed preparation.
The call shall use no durable Captain or player conversation token, publish no returned token, make no corrective or transport retry, and receive a cancellation signal with a 150-second preparation limit starting after the working stack is saved; expiry shall cancel and drain the host turn and its admitted calls, while removing the deadline before the subsequent specialist step.
A failed, aborted, malformed, or blocked result shall leave the leaf parked and attribute its outcome to recovery, preserving earlier action outcomes and accumulated counts [[playbook-captain-20](playbook-captain.md#playbook-captain-20)] [[playbook-captain-35](playbook-captain.md#playbook-captain-35)].

### recovery-8

After a successful preparation, the shell shall release its repository claim, re-read the same leaf's recovery offer, and continue exactly once only if its continuation still matches: deliver the original Boss text for `reply`, or apply the currently advertised runtime action through its ordinary receipt path [[playbook-captain-8](playbook-captain.md#playbook-captain-8)].
Preparation shall grant no bypass of unresolved-effect reconciliation [[playbook-runtime-79](playbook-runtime.md#playbook-runtime-79)].
The preparation and continuation shall settle as one `recover` turn through the durable uncertainty boundary [[playbook-cli-23](playbook-cli.md#playbook-cli-23)]; process loss shall require reporting before Boss chooses further work [[recovery-27](#recovery-27)].

### recovery-10

While the failed invocation checkpoint has no saved actor result, has not delivered its output [[recovery-1](#recovery-1)], and identifies exactly one owned standalone boundary with a complete single-commit receipt, saved nonempty player text, no spent correction budget, and either no semantic candidate or an already resolved one, the runtime shall advertise `retry:adjudication` as `Retry assessment of the saved result`, provided no other unresolved boundary or retained or deferred fence exists.
The action shall adjudicate the saved text once through the ordinary tool-free judge only when its semantic candidate is missing, require that candidate to reconcile as resolved against the existing receipt, and durably append every valid candidate without replacing physical evidence, including a candidate that remains unresolved.
A blocked candidate shall replace the old failure explanation, remain unresolved and remove the saved-assessment retry; it shall authorize no invented transition [[playbook-runtime-10](playbook-runtime.md#playbook-runtime-10)].
It shall then deliver the acknowledged result to the checkpoint's invocation through ordinary reconstruction, without calling the player or creating another physical boundary; a failed judgment shall leave the invocation parked, and restoration after acknowledgement shall consume the saved resolved candidate without another judge call.

### recovery-12

While a failed invocation has exactly one owned standalone read-only boundary after its checkpoint, with a complete receipt and unchanged HEAD, the runtime shall offer preparation to restore the original repository and retry that invocation, provided repository observation and exclusive acquisition are available and no other unresolved, deferred, or retained work exists.
The action shall be `retry:restored-step`, labeled `Restore the repository and retry the read-only step`.
When that action runs, the runtime shall hold the repository claim, verify that the current observation equals the boundary's original baseline exactly, and append immutable optional `restored` evidence equal to that baseline before replay and recheck that baseline under the next player call’s claim; a mismatch shall start no player and preserve the paused step.
The recheck shall be confined to that attempt; after a successful check, the runtime shall capture a fresh invocation checkpoint before calling the player [[recovery-1](#recovery-1)].
The boundary's original receipt and semantic evidence shall remain unchanged; restoration shall exclude that boundary from unresolved-work blocking and authorize replay only, never acceptance of its old result.
The effect-ledger validators shall reject restoration on a writable, cohort, deferred, incomplete, or commit-moving boundary, and reject replacement or removal of existing restoration evidence [[playbook-runtime-69](playbook-runtime.md#playbook-runtime-69)].

### recovery-14

When an operation of this turn returns `failed` or `quiescent`, the shell shall record that frame's stop and consume it before automatic preparation and continuation, at most twice per turn.
The operations are input delivery, return to a parent, and an accepted runtime action's recorded `run` result, including a failed receipt with that result; a thrown operation without a result authorizes no automatic recovery.
A resumed or adopted old stop, refused input, blocked preparation, cancellation, unavailable offer, or unsuccessful continuation shall trigger no further automatic recovery; a conversation-only request or explicit stop shall trigger none.
For a pending question, the host shall first make one fresh tool-free check on the same serialized Captain queue, without a repository claim or step record, using the hidden-control envelope of [[playbook-captain-31](playbook-captain.md#playbook-captain-31)].
The root frame shall retain its exact handed-off request as optional nonempty `request`, through capture, restore and adoption; the root shall also retain optional `inputs`, an array of nonempty exact texts subsequently delivered to this engagement, while a child shall carry neither member; older snapshots omitting them remain valid.
The check shall receive only that request as `{label:"Current engagement request",instruction:<exact request>}`, or an empty list when no request was saved or that exact request has already been delivered again.
Later delivered Boss input and the current turn instruction, excluding the entire turn that started that task even after automatic preparation, shall be provided as context that cannot be selected; when any bears on the question, the check shall return null rather than override it with the original request.
It shall return exactly `{instructionIndex:null}` for missing input, or `{instructionIndex:N}` selecting an in-range integer index, read as the reply's one recoverable JSON object; an absent, out-of-range, malformed, or failed selection shall preserve the original question and outcome without claiming blocked preparation.
A previous answer or another engagement's task shall not be a candidate.
A selected instruction shall be delivered exactly; the live outcome and Captain's closing reply shall record the asker, question and instruction reused, and record the selected questions and exact instruction before delivery; interrupted reporting derives those facts [[recovery-18](#recovery-18)].
A selected existing instruction may be delivered once under the same continuation checks [[recovery-8](#recovery-8)]; a missing product decision, new authority, or contradictory or missing workflow transition shall be explained to Boss without inventing an answer, transition, or completion.

### recovery-16

When an unexpected child-runtime exception or cancellation after the runtime accepts its initial request leaves an exportable parked leaf, the host shall preserve that leaf and its suspended parents for a later valid reply or recovery instead of treating the exception as an authored completed child result; initialization, visibility and pre-acceptance failures shall retain ordinary child disposal [[playbook-runtime-45](playbook-runtime.md#playbook-runtime-45)].

### recovery-29

When a runtime calls `handleBossInput.onAccepted` [[playbook-runtime-34](playbook-runtime.md#playbook-runtime-34)], the shell shall record the frame's start, its delivery facts and the root's delivered `inputs` [[recovery-14](#recovery-14)] at that callback and shall pause parent cancellation only for a child that accepted:

- the shared runtime calls it for ordinary and deferred answers, a bound deferred continuation included;
- for a runtime that does not call it, an outcome other than `no-action` or `aborted` counts as acceptance.

### recovery-18

Before external work, a durable host shall atomically save the uncertain attempt's progress as `{snapshot,steps,positionStepId}` ([DR-073](../decisions/073-durable-step-progress.md)):

- `snapshot` is the runtime-owned full working stack, or `null` when a frame cannot represent its position; the shell joins parent/child identities without interpreting machine context;
- the snapshot retains the preceding settled Captain, journal and sequences, the current ledger, player ledger, issued identities, and accepted runtime input;
- `positionStepId` names the new unfinished step saved with a non-null snapshot, or is null for every other snapshot write; result-only writes preserve it; older omission means null, and a non-null value must name an existing step;
- `steps` contains unique UUID starts with exactly `id`, `kind:'player'|'captain'|'script'|'preparation'|'completion'|'answer'`, `stateId`, `runtimeSessionId`, `playbookId`, and optional JSON `result` and host-owned `workerEvidence:{boundaryId,playerId}`; the evidence reference may appear only with an accepted player result, shall name that step’s exact acknowledged producing boundary and configured player, and shall become immutable with the result; external work requires a start before its result, identities never change, and an acknowledged result is immutable;
- `completion` stores the final root state, optional authored description and terminal outcome, and the runtime's retention decision (`clear` or `keep`, with older omission meaning `clear`); `answer` stores the pending asker/question objects and exact selected instruction; these known facts are written once with their results;
- preparation saves its parked position before tools; custom runtime calls without a supplied position record starts and returned status with an unavailable position;
- a result save does not move the saved position; after work drains, an optional save advances to the actual stopped stack or completed root without changing the action result on failure;
- progress changes no durable retained generations, unresolved effects or presented prefix; a progress write applies only already-decided retention updates — pending updates and decided root clears, never a capture of the live root — to the in-memory offer catalog, and settlement alone captures the live root; the record remains token-free [[session-storage-7](session-storage.md#session-storage-7)]; all lease writes serialize;
- required save failure stops further work; atomic write loss preserves either the previous complete record or the next complete record;
- the shared exported `isUncertainTurnDiscardable(record)` shall allow an uncertain turn only with no abandonment, no recorded steps and a ledger equal to its pre-turn snapshot; store discard, CLI/SDK guidance and no-work restoration shall use it; retry never chooses discard automatically, and a stopped snapshot alone does not forbid discard.

The shell shall export `ProgressChange` for `recordProgress`, containing optional `snapshot` and `step`, with the same shapes defined above; `abortPreparation(reason?)` shall cancel the active turn on a preparation deadline or required save failure.

The host shall store no continuation selection or copied report.

### recovery-20

When a turn throws or its signal is aborted while progress exists, including cancellation after reply emission followed by a normal shell return, after admitted calls drain the shared host shall settle its current exportable stack and acknowledged evidence before disposal, preserving completed results and preparation edits and allowing a new Boss instruction [[playbook-cli-23](playbook-cli.md#playbook-cli-23)].
Settlement failure shall preserve the original failure, attempt safe disposal, and retain uncertainty; process loss shall retain acknowledged progress [[recovery-18](#recovery-18)].

### recovery-21

When a stopped turn settles under [[recovery-20](#recovery-20)], the interactive pane shall remain open, headless failure shall explain that work is saved, and SDK disposal shall await settlement and its reporting.
The notice and callbacks shall identify only the current admitted attempt, never a prior settlement or a turn that was not admitted.

### recovery-22

When an application opens a controller with `mode:'recover'`, its asynchronous `recover()` shall restore and report the uncertain attempt without new input or execution [[recovery-27](#recovery-27)]; `recover(input)` for a settled pause shall require nonempty Boss text and route it through an ordinary Captain turn.
Busy or closing controllers shall reject with that state first.
A live controller newly left uncertain shall require disposal and explicit reopening with `mode:'recover'` before further input or recovery.

### recovery-27

When explicit uncertain retry opens an interrupted attempt, the shared host shall restore and report only, never automatically repeat work or run preparation, even when receipts show no repository change ([DR-073](../decisions/073-durable-step-progress.md)):

- reconstruct incomplete receipts and require monotonic ledger evidence before restoration; a failed check retains uncertainty [[playbook-cli-23](playbook-cli.md#playbook-cli-23)];
- when no step is recorded and the ledger is unchanged, restore the exact pre-turn stack and pending questions, explaining that the last message was not processed;
- otherwise restore a saved supported stack with the current ledger, attaching a completed result and rebuilding the causal attempt only for the checkpoint named by `positionStepId`, with matching step, runtime, playbook and source identity; every other frame keeps its position unchanged;
- absent a supported position, restore Captain conversation in chat, preserve files and repository evidence, and clear only retained generations containing current or adopted-source identities owning the attempt's changed evidence or steps;
- derive retained-root clears from completion records that decided `clear` and from the lost-position owner rule above, applying them only in the report settlement; an unfinished final state that decided `keep` preserves its preceding generation;
- admit the recorded attempt and report through the shell without a Captain decision, player, script or preparation call, and without writing progress; the Captain conversation shall catch up on its next ordinary turn;
- report changed boundaries and logical operations in ledger order, counting logical chains once, through the bounded evidence projection [[playbook-captain-58](playbook-captain.md#playbook-captain-58)];
- derive carried Boss edits from the ledger and completed roots, unfinished calls, preparation and selected answers from the journal; preserve complete pending questions and validate no host-written evidence as model prose;
- record a truthful report outcome through the ordinary single-reply failure path;
- explain the restored position or lost-position limit, publish available controls, and require Boss to check outside actions and stop any surviving worker before repeating unfinished work;
- only a later explicit Boss input or action may continue; a second crash follows the same rule.

The shell shall export `InterruptedReport` for `selectInterruptedReport(input, report)`, containing `text`, ordered `effects`, and optional `retentionUpdates` and `unresolvedEffects`; the host selects it before admitting the exact recorded input.
A missing result shall mean unfinished work, never evidence of no effect; a repository observation shall not prove that an outside action did not occur or that a worker has stopped.

## Verification

### recovery-19

When integration tests interrupt preparation, they shall reopen the store and report without rerunning tools, preserve the exact leaf and parents, refuse discard, strip provider hints, and block tools after a refused start save [[recovery-18](#recovery-18)] [[recovery-27](#recovery-27)].

### recovery-23

When integration tests cancel or fail a turn with saved progress, they shall verify drained settlement through CLI, interactive and SDK, including immediate disposal, completed results and retained-root changes surviving closing cancellation, cancellation after reply emission even when the shell returns normally, settlement failure preserving both errors, and no report of an earlier attempt [[recovery-20](#recovery-20)] [[recovery-21](#recovery-21)].

### recovery-24

When system tests kill real hosts during ordinary and nested player or script work, before receipts, before and after atomic publication, during preparation, after completion, at a clearing completion's write after an answered question, before the first step from a pending question, and during a second recovery, they shall verify no calls on reopen or reporting, accepted input preservation, reuse of saved outputs without duplicated effects, no automatic recovery from an old stop [[recovery-14](#recovery-14)], reserved words in questions, completed-root reporting, configured command names, exact untrimmed answer and completion text in the saved records and the report, unchanged-attempt input acceptance, the exact consumed-result control list without saved-result assessment [[recovery-10](#recovery-10)], report loss at settlement, owned and adopted-source clears, the clearing completion's retained generation absent after the report settlement, byte-exact discard after give-up, and mandatory change reports [[recovery-1](#recovery-1)] [[recovery-18](#recovery-18)] [[recovery-27](#recovery-27)].

### recovery-28

When system tests kill root and nested DECIDE runs during parallel proposals without a supported position, they shall verify preserved commits and evidence, no stale runtime or player execution, and an explained safe exit to Captain [[recovery-27](#recovery-27)].
When loss instead occurs in the sequential step after the join, they shall verify restoration of that step without repeating its proposals [[recovery-1](#recovery-1)] [[recovery-27](#recovery-27)].

### recovery-25

When integration tests validate progress, they shall isolate controller, journal, identity, current-ledger, monotonic extension, step kind, playbook id, completion and answer shape, position-step identity, exact current-turn worker-evidence references, duplicate-reference rejection and immutable-result checks with otherwise-valid snapshots and verify that failed optional stopped-position saves preserve the action result [[recovery-18](#recovery-18)].

### recovery-26

When integration tests use SDK recovery, they shall verify rejection of new input before uncertain recovery, ordinary routing of a settled pause's answer and a busy-controller rejection before uncertainty guidance and an explicit reopen instruction for any live controller newly left uncertain [[recovery-22](#recovery-22)].

### recovery-30

When the bounded policy model explores starts, results, positions, reporting and Boss choices, it shall reject each deliberate violation below, with the corresponding implementation covered by integration or system tests [[recovery-1](#recovery-1)] [[recovery-18](#recovery-18)] [[recovery-27](#recovery-27)]:

| Explored rule | Deliberate violation | Executable evidence |
| --- | --- | --- |
| Starts and results survive atomic loss; completed work makes durable progress | `never-save-result`, `skip-final-result` | `durable-progress.integration.test.ts`: player-before-change, script-before-rename, script-after-rename |
| Reporting writes no progress and starts no work | `report-writes-progress` | `durable-progress.integration.test.ts`: second-crash, lost-position-second-crash |
| Reopening restores the saved position or exits safely | `lose-base`, `wrong-position`, `stale-unsupported` | `durable-progress.integration.test.ts`: player-before-change, later-step; `captain-process-loss.integration.test.ts`: root and nested DECIDE |
| Boss chooses before a saved result is accepted or unfinished work repeats | `auto-accept`, `auto-retry` | `durable-progress.integration.test.ts`: player-result, preparation, second-crash |

The same-turn stop rule, input acceptance and consumed results lie outside the model and rest on the named integration tests: `durable-progress.integration.test.ts` cancelled-stop, old-stop, resume-stop and consumed-result; `captain-recovery-progress.integration.test.ts` answer-failure and child-cancel; `playbook-captain.test.ts` input-abort and input-abort-describe; and `role-runtime-transition.test.ts` 'traces a continued transition before the player and nested calls it causes'.

### recovery-31

When an integration test drives a live SDK session whose root's player asks a question the automatic check answers from the task, commits, and reaches an unfinished final state in the same turn, it shall verify that the settled record retains no generation for that root, that resuming that root in the same live session is rejected without adoption, and that an earlier dismissed generation of the same root is instead adopted and remains stored [[recovery-18](#recovery-18)].

### recovery-4

When integration tests fail a later invocation after an earlier one succeeds, they shall verify that a live and a JSON-round-tripped restored runtime advertise and retry only the failed invocation with its original context [[recovery-1](#recovery-1)] [[recovery-3](#recovery-3)], that restoring makes no calls, and that malformed or incompatible checkpoints fail before execution, including a `delivered` member other than literal `true` [[recovery-2](#recovery-2)].
Tests shall verify that a completed earlier commit does not block an unchanged failed invocation's retry, while a changed, incomplete, foreign, or unresolved boundary after its checkpoint does [[recovery-3](#recovery-3)].

### recovery-9

When integration tests recover an interrupted real leaf through the Captain session host, they shall verify that only an advertised offer exposes preparation context [[recovery-5](#recovery-5)], explicit repair intent selects recovery while ordinary answers retain exact delivery [[recovery-6](#recovery-6)], and one isolated preparation call repairs an actual prerequisite under the worktree claim without changing routing-call permissions [[recovery-7](#recovery-7)].
The tests shall verify that model-selected ready preparation continues the same restored leaf once, its prompt requires missing Boss choices to block before tools, while blocked, malformed, aborted, stale, and unresolved cases remain parked with a truthful settlement [[recovery-8](#recovery-8)].

### recovery-11

When integration tests interrupt adjudication after a real commit, they shall verify that live and restored runtimes recover the saved result with one judge call, preserve the commit and receipt, run no duplicate player call, retain valid unresolved candidates without continuing, reject malformed candidates, and continue from an acknowledged candidate after interrupted delivery [[recovery-10](#recovery-10)].
The suite shall verify that a live and a restored runtime, with and without a step record and after consuming a saved result, offer no assessment of an output the machine already received while preserving the checkpoint's `delivered` fact [[recovery-10](#recovery-10)] [[recovery-1](#recovery-1)].

### recovery-13

When a real read-only invocation creates an unexpected file after an earlier committed step, the integration suite shall verify that live and restored sessions reject retry before exact restoration, then append restoration evidence and rerun only the interrupted invocation, preserve the earlier commit and original receipt, and never accept the old failed result [[recovery-12](#recovery-12)].
Otherwise-valid commit-moving, writable changed and unchanged, incomplete, ambiguous, two-member cohort and logical-operation ledgers shall fail only after restoration evidence is added; a successful restoration shall refresh the checkpoint [[recovery-12](#recovery-12)].

### recovery-15

When the real Captain host encounters an interrupted step or pending question, the integration suite shall verify bounded automatic repair, exact task-input reuse from the current root after restore or adoption, truthful automatic-answer reporting, rejected malformed, out-of-range and failed question checks, the two-attempt bound, no repeated automatic delivery of the root request, later Boss input as nonselectable context, quoted-question protection, empty candidates for old snapshots, invalid root and child request/input fields, exact action attribution, no recovery on chat or cancellation, no automatic preparation or player work after a cancelled stop, an old stop resumed in a later turn, or an adopted stop, and a specific blocked explanation for missing Boss input or an unavailable transition [[recovery-14](#recovery-14)]; preparation timeout shall leave the step paused without timing out later specialist work [[recovery-7](#recovery-7)].

### recovery-17

When a nested runtime throws while preserving an exportable parked state, the integration suite shall verify that its caller remains suspended and the same leaf can continue after repair, while an ordinary pre-acceptance error disposes even an otherwise exportable child [[recovery-16](#recovery-16)].
The suite shall verify that cancellation before the child accepts its initial input disposes the child, while cancellation during a shared-runtime child's initial and later real player calls preserves that child under its suspended parent with an available recovery action [[recovery-16](#recovery-16)].
Cancelling the real DECIDE runtime's first proposal call after it accepted the input shall preserve the child under its suspended parent and record delivery rather than refusal in the outcome facts [[recovery-16](#recovery-16)] [[recovery-29](#recovery-29)].
The suite shall verify that a shared-runtime bound deferred continuation calls `onAccepted` exactly once, before its player call [[recovery-29](#recovery-29)].
