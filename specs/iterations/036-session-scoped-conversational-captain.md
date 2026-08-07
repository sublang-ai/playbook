<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-036: Session-Scoped Conversational Captain

## Goal

Implement [DR-029](../decisions/029-session-scoped-conversational-captain.md): the default Captain playbook becomes an always-present controller outside the engagement stack, running one durable journal-reseeded conversation that drives an observe–act–result loop of validated `respond` / `start` / `switch` / `dismiss` / `deliver` / `runtime` actions over a runtime-owned `describe` / `apply` control surface, with turn summaries kept, outcome-grounded, and gated to nonzero counted activity.
The iteration also lands the DR-028/DR-029 acceptance plan in three tiers: hermetic A-28/A-29 rows as verification gates on the implementation tasks, a fifth conversational scenario in the live acceptance suite, and a model-free `smoke:release` gate.

## Deliverables

- [x] Engine control surface: `describe`/`apply` on every `createXStatePlaybookRuntime` runtime, the ControlView/receipt types on `@sublang/playbook/runtime`, apply trace boundaries, the `slc/link.md` control-surface contract, amended PBRT items including the [PBRT-51](../test/playbook-runtime.md#pbrt-51) fidelity fold, and integration tests.
- [x] Rewritten CAPTAIN and CAPPLAY spec packages, Status annotations on DR-004/008/009/011/012/013/025, and the map package-summary rows.
- [ ] Rewritten `reference/sdlc/captain.md` source and recompiled `captain.playbook/` GEARS, FSM, runtime, and verification artifacts, with the six CAPPLAY-20 prompt-contract re-pins and the two SLC contract amendments the compile needs (`slc/gears2fsm.md` decision-state class, `slc/link.md` controller Captain-call presentation — task 3).
- [ ] Playbook Captain shell on the controller model: durable conversation with continuity detection and journal reseed, deterministic command parse table, controller port, captain speech via cligent `captain_reply`, gated grounded summaries, and the CAPTAIN-37…-40 hermetic suites over real compiled CODE/DISCUSS entries.
- [ ] cligent dependency bump admitting `CaptainRunResult.resumeToken` and `CaptainContext.emitReply`, plus `[Unreleased]` CHANGELOG entries per [RELEASE-4](../dev/release.md#release-4).
- [ ] Tier B: the fifth conversational scenario appended to `acceptance/playbook-live.acceptance.test.ts`, with [RELEASE-24](../dev/release.md#release-24)/[RELEASE-25](../test/release.md#release-25) amended to five scenarios.
- [ ] Tier C: `scripts/release-smoke.mjs` behind `pnpm smoke:release`, the new RELEASE-28/RELEASE-29 items, and the amended RELEASE-10 pre-release ordering.
- [ ] This record and its map row (this commit; IR-035 landed with `9e55bde`, so the rebase caveat is closed and PBRT-52/PBRT-53 are confirmed the next free ids).

## Touched items

Dispositions: **supersede** = pinned behavior replaced, item rewritten in place under its released ID; **amend** = named clauses change, rest stands; **stands** = verified untouched.
Grep of `specs/`, `slc/`, and `reference/` found no conflicting pins beyond the rows below (PBCLI, PLAYBOOK, GIT, LIC, SKETCH are clean).

### Decision records (Status annotations)

| Record / section | Disposition | Change |
| --- | --- | --- |
| DR-004 §3 Boss-event mapping | amend | The `BOSS_INTERRUPT` is-reached-only-when-the-judge-picks-it sentence is scoped to `handleBossInput` classification; `apply()` of a runtime-advertised action is a second, runtime-validated path to the same events (§Contracts 1) and still involves no host-fabricated event. |
| DR-008 §3 Turn routing, §9 Out of scope | supersede (interactive shell) | Residual prohibitions on pre-classified events and action surfaces are superseded by runtime-advertised actions through `describe`/`apply`; the shell still fabricates no FSM event itself. |
| DR-008 §4 Shared Captain session | amend (intent restored) | One durable Captain conversation returns; sub-runtime judge calls now stay fresh and isolated instead of sharing it. |
| DR-008 §5 Telemetry mirroring | amend | The deferred `getSnapshot()` arrives as `describe()`; telemetry mirroring stays for the shell ledger. |
| DR-009 §1 Registry manifest | stands | `summaryPolicy` remains a consumed registry surface. |
| DR-009 §5 Summary policy | amend | Wording stays registry-owned; composition becomes outcome-grounded and the saved-counts line is gated to nonzero counted activity. |
| DR-009 §7 Preserved DR-008 constraints | supersede in part | Different-command ask-first is replaced by validated `switch`; telemetry-only state observation is joined by `describe()`. |
| DR-011 §4 Captain call stack | amend | The Captain is placed outside the engagement stack; the manual-slash-selection sentence is superseded by the absent-from-path `switch`; leaf-only Boss input is recast as leaf-only *delivery* (the Captain receives every turn). |
| DR-012 Compiled orchestration policy; Sequential decide-call-observe loop; Deterministic stack ownership; Internal root presentation | supersede | Lazy internal root, intra-turn `remainingPlan` multi-child plans, and the hidden lifecycle classifier are retired; reserved `captain` id, status filtering, and no-visibility posture restate in the rewritten items. |
| DR-012 Captain first-class runtime actor; Catalog and dynamic child target | stands / amend | `callCaptain` port, queue, and `captain.call.*` traces stay; the visible-workflow-call sentence is scoped to non-Captain compiled playbooks — the rewritten Captain's own calls are hidden per DR-013 §Control-and-presentation as amended, with prose resurfaced via `captain_reply`; the sanitized catalog stays; the compiler's dynamic-call support stays for other playbooks while the Captain policy stops using `callPlaybook`. |
| DR-013 §Initial Captain is a router | amend | Routing-only, no-investigation posture stays; the two-outcome menu is superseded by the closed action set. |
| DR-013 §Exact input provenance | stands | Exact Boss text enters the decision call; digests never rewrite it. |
| DR-013 §Control and presentation separation | amend | Hidden control vs human prose stays; prose is now surfaced through host-validated captain speech (`captain_reply`) instead of visible Captain calls. |
| DR-013 §Isolated control calls + A1 | supersede (interactive shell) | Captain-root calls resume the durable conversation; the A1 tool posture (empty allowlist or adapter-aware omission) is retained on every such call; sub-runtime judge isolation is unchanged. |
| DR-025 §Adjudication reply contract; §One corrective re-ask | stands / amend | `defaultBuildCaptainJudgePrompt` stays exported and reused; the single corrective re-ask pattern extends to the decision call. |
| DR-025 §Internal-root failure resets the shell | supersede | Disposal-on-failure is replaced by the conversation reseed: the stack and completed work survive, only the model-side conversation is replaced. |

### CAPTAIN package

| Items | Disposition | Change |
| --- | --- | --- |
| CAPTAIN-1, -2, -7 | supersede | Rewritten to the deterministic command parse table and the session Captain receiving every Boss turn — a parse-resolved turn entering the controller loop with its injected decision object, the rest decided by the hidden decision call; the hidden lifecycle-only classifier is retired. |
| CAPTAIN-31 | supersede | Fresh `resume: false` Captain-root calls become durable pinned-token calls; DR-013 A1 tool posture and exact-text entry stay. |
| CAPTAIN-34, -35 | supersede | Internal-root discard-and-reset is replaced by the continuity/reseed contract (§Contracts 6). |
| CAPTAIN-12, -13, -32, -36 | supersede | Test counterparts rewritten: parse table, closed decision set with corrective re-ask, durable-call posture, reseed acceptance. |
| CAPTAIN-3, -4, -25, -28 | amend | External `◇` lifecycle lines, park/dispose, and visibility stand; internal-root clauses retire (the Captain is never an engagement); `switch` emits both the stop and start facts; internal-parent `called by Captain` forms retire. |
| CAPTAIN-19, -20, -21 | amend | Summaries kept: the acting turn's closing reply is the summary, composed from the outcome report; counting per CAPTAIN-20 stays; the saved-counts line appears verbatim only when the turn's counted activity is nonzero (gate row A29-8). |
| CAPTAIN-5, -6, -26 | amend | Ledger gains the pinned conversation token, journal handle, and the session Captain's own session identity created at `init`; shell FSM modes and telemetry topics stand. |
| CAPTAIN-8 | amend | `deliver` keeps text-only `handleBossInput`; `runtime` actions flow only through `apply()` of runtime-advertised action ids; the shell still never chooses FSM events. |
| CAPTAIN-9, -10 | amend | One Captain agent and concurrency-one queue stand; the Captain-root `callJudge`/`callCaptain` bridge runs hidden on the durable conversation, rotating the pinned token and reporting continuity failures; sub-runtime judge bridging is unchanged. |
| CAPTAIN-11, -16, -22, -29 | amend | Lazy internal-root construction retires; `init` starts the session Captain and journal; teardown disposes it last; stack, cycle, and visibility rules stand for working playbooks; `callPlaybook` is no longer reachable from the Captain. |
| CAPTAIN-14, -15, -23, -24, -27, -30, -33 | amend | Test counterparts follow their amended items; CAPTAIN-24 covers `switch`; CAPTAIN-27 adds durable-token rotation proof; CAPTAIN-30 drops internal-parent rows; CAPTAIN-33 targets durable calls. |
| CAPTAIN-17, -18 | stands | `@sublang/playbook/playbook-captain` module surface unchanged. |
| New CAPTAIN-37, -38, -39, -40 (next free after CAPTAIN-36; re-check at land time) | new | Tier A-29 test items landed by task 4: observe–act–result loop, validated actions and command table, durable continuity, injection and prose validation (row assignments in task 4). |

### CAPPLAY package (rewritten to the controller policy, not retired)

| Items | Disposition | Change |
| --- | --- | --- |
| CAPPLAY-1, -2, -3, -4, -5 | supersede | Boss surface rewritten: per-turn decision over the closed action set; intra-turn plans retired in favor of conversational multi-turn planning; `respond` settles in one call; grounded closing reply; privacy rules restate. |
| CAPPLAY-6, -9, -10 | supersede | Machine becomes a session loop with a parked hub and no terminal `{ response }` output; it keeps one reachable `type: 'final'` shutdown state entered only by the shell's teardown event, so `slc/gears2fsm.md`'s completion rule (every machine declares a reachable final state; its output clause applies only where Source declares a terminal result, which the session loop does not) stands unamended; hosting becomes session-scoped with the controller port; child-call result reduction is replaced by settlement evidence; status suppression stays. |
| CAPPLAY-7, -8, -16, -18 | amend | Catalog stays and gains the digest rules; captain actor, queue, and paired traces stay with durable hidden calls; result contracts stay source metadata with prose preserved via validated captain speech; the corrective re-ask covers the decision call. |
| CAPPLAY-11, -12, -13 | supersede | Compile and behavior tests rewritten to the session-loop machine and action set. |
| CAPPLAY-14, -17, -19 | amend | Queue/trace/privacy and exact-text/no-investigation coverage stay; the two-outcome assertions move to the closed set; re-ask coverage retargets the decision call. |
| New CAPPLAY-20 (next free after CAPPLAY-19) | new | Rewritten-source prompt-contract conformance: the six re-pins landed by task 3. |

### PBRT, RELEASE, and slc

| Item / section | Disposition | Change |
| --- | --- | --- |
| PBRT-5, PBRT-34 | amend | Runtime shape and type-only contract gain the optional control-surface pair and its types (§Contracts 1), including the `apply.started` / `apply.finished` extension of the `PlaybookTraceType` union in `src/runtime.ts`. |
| New PBRT-52 (dev) + PBRT-53 (test) | new | Control-surface behavior and its integration tests; PBRT-53's scenario list names the A29-17 engine-level twins (§Acceptance plan). Ids confirmed free after IR-035 landed. |
| PBRT-51 | amend (append-only) | The A28-6 residue: two bullets pinning what the landed suites already assert — the corrective call's prompt is byte-equal to the first, and its resume selection follows [PBRT-38](../dev/playbook-runtime.md#pbrt-38) (resume the carried token; fresh when the empty result cleared it). |
| PBRT-1, PBRT-2, PBRT-7 | stands | `apply()` never enters `handleBossInput`, so the classification contracts' scope guards already exclude it; judge calls stay fresh. |
| PBRT-15 | stands | `summaryPolicy` labels, guard names, and line template are consumed unchanged. |
| PBRT-50 | stands | No ABI or schema bump: the pair ships with the engine and is feature-detected like the snapshot capability. |
| RELEASE-15, -18, -20, -21 | stands (verified) | All named exports, packed files, and subpaths persist; `captain/playbook` and `defaultBuildCaptainJudgePrompt` stay maintained; engine additions are additive semver-minor. |
| RELEASE-10 | amend | Pre-release ordering becomes `pnpm test` → `pnpm smoke:release` → `pnpm test:acceptance` → conditional RELEASE-26 manual UX smoke. |
| RELEASE-24, RELEASE-25 | amend | The opt-in live acceptance flow grows from four to five scenarios (the appended conversational scenario, task 6); prerequisites and the no-automatic-retries rule are unchanged. |
| New RELEASE-28 (dev) + RELEASE-29 (test) | new | The local `smoke:release` entry point and its eight gate steps (task 7); RELEASE-29 `Verifies:` RELEASE-28, RELEASE-12, RELEASE-24 §hermetic. |
| `slc/link.md` §PlaybookRuntime contract | amend | Optional control-surface section mirroring §Parked-session snapshot; the `PlaybookRuntimeOptions` host-agnostic/per-run-knobs sentence gains a clause admitting host-supplied port-shaped callbacks among linker-exposed option members (typed artifact-side), so the six-member `PlaybookPorts` pin and the never-touches-host-types sentence stay coherent with the §Contracts 2 controller port. |
| `slc/link.md` §Boss-event mapping | amend | The default-Captain ready-entry sentence updates to the rewritten machine's entry contract; the judge-only `BOSS_INTERRUPT` sentence is scoped to `handleBossInput` classification, naming `apply()` of a runtime-advertised action as the second, runtime-validated path to the same events; the deterministic-entry rule itself stands. |
| `slc/link.md` §Playbook trace | amend | The closed `PlaybookTraceType` union and its prose type list gain the paired apply members (`apply.started` / `apply.finished`) with §Contracts 1 payload rules; still schema 2, following the DR-012 `captain.call.*` precedent. |
| `slc/gears2fsm.md` §Setup result contracts | amend (additive, task 3) | A decision-state class for controller playbooks joins the stable compiler contract: closed-action-set guard discriminants with per-guard required payload fields (task 3's sketch); the existing `question`/`delegation`/`final`/`followUpQuestion`/`continuing` vocabulary and the universal `needsBossReply` stay for the artifacts that consume them. |
| `slc/link.md` §Captain adjudication | amend (task 3) | The Captain-call presentation admits the controller form: hidden decision and closing-reply calls whose replies are runtime-validated `{ action, … }` control JSON, prose surfaced only as host-validated captain speech via cligent `CaptainContext.emitReply`; the visible-call `question`/`response` injection rule stays scoped to visible-presentation playbooks. |

## Contracts

### 1. Control surface (engine-owned)

```typescript
interface PlaybookControlAction {
  id: string;      // stable within the returned view
  label: string;   // runtime-written, Boss-appropriate
}

interface PlaybookControlView {
  state: PlaybookState;
  context?: JsonValue;   // sanitized, JSON-safe relevant context
  pendingQuestions: readonly PlaybookPendingBossQuestion[];
  lastError?: NormalizedError;
  actions: readonly PlaybookControlAction[];
}

type PlaybookControlReceipt =
  | { disposition: 'rejected'; reason: string }          // before any effect
  | { disposition: 'executed'; run: PlaybookRunResult }
  | { disposition: 'failed'; error: NormalizedError };   // effects may exist

// Optional PlaybookRuntime members — both or neither:
describe?(): PlaybookControlView;
apply?(input: { actionId: string; key: string; signal: AbortSignal }): Promise<PlaybookControlReceipt>;
```

- Every `createXStatePlaybookRuntime` runtime implements both; a runtime lacking the pair advertises no actions and plain text delivery is the only verb against it.
- `describe()` is side-effect free, valid at parked quiescence outside an active boundary, and derives actions from the live snapshot: currently valid recovery and jump entries (failure-state retry events, `resumableStateIdsFromMachine` targets) labeled from source state descriptions.
- Payload sourcing: a retry action replays the recorded last classified event with its recorded payload (the event that drove the run into the failed state, kept in the runtime's typed context); a jump action sends the FSM's explicit-state-jump event with the advertised target id and its optional textual fields omitted. A candidate whose event requires a payload the runtime cannot source from recorded state is excluded from `actions` — `apply` never invents free text.
- `apply` revalidates the action against the live state and rejects with no effect when it is no longer advertised; it executes at most once per idempotency `key` — a repeated key returns the recorded receipt without re-execution.
- Apply boundaries trace as paired schema-2 events carrying action id, key, and receipt disposition; payloads are JSON-safe.

### 2. Controller–shell port

- The Captain runtime's options carry a host-supplied controller port; public `PlaybookPorts` stays six members.
- The port takes one validated selection per turn and returns its settlement:
  `{ action: 'respond', text } | { action: 'start' | 'switch', playbookId, input } | { action: 'dismiss' } | { action: 'deliver' } | { action: 'runtime', actionId }`
  → `{ status: 'ok' | 'rejected' | 'failed', facts: readonly string[], receipt?, leafState?, counts }`.
- `respond` carries its prose: the validated selection's `text` is the turn's captain speech (DR-029 §4), so a chat turn settles in the one decision call. Settlements carry no prose field — presentation is shell-owned at the port boundary (§Contracts 7).
- `deliver` carries no text payload: the shell is authoritative for the delivered text — the exact Boss text of the decided turn, or the parsed remainder of a same-command turn — and any text carried on a deliver selection is ignored and never delivered.
- Shell validation before effects: registry membership; `start` needs an idle shell; `switch` needs an active root and a target absent from the active path; `dismiss` / `deliver` / `runtime` need an active leaf; `runtime` needs the leaf's current `describe()` to advertise `actionId`; an invalid selection settles `rejected` with a reason.
- `switch` = dismiss the stack, then start the target; no rollback; a failing start settles with both facts.
- A failing dispose during dismissal does not resurrect the engagement: the entry leaves the stack with its dispose failure recorded as a normalized error, dismissal continues down the stack, and a `switch` still proceeds to start; the settlement names each dispose failure and whether the target started, and the shell lands idle or newly engaged so the next Boss turn settles normally.
- `facts` are the outcome report: what was dismissed, started, delivered, applied, or rejected, plus the resulting leaf state summary; `counts` is the turn's counted activity for gating.
- Retries are phase-local; a settlement with `status: 'ok'` is final for that turn — the executed action is never re-executed.

### 3. Decision call and correction

- Deterministic command parse runs first (table below); a parse-resolved turn skips only the decision model call — the parsed decision object is injected into the controller FSM as that turn's decision, and validation, execution, outcome report, and closing reply flow through the controller loop (§Contracts 2) identically to a model-decided turn.
- Otherwise one hidden durable call decides: exact Boss text in a labeled block, the ControlView digest, the catalog digest, and an explicit `{ action, … }` JSON reply contract over the closed set, built in the `defaultBuildCaptainJudgePrompt` style, with the instruction that the digest outranks conversation memory.
- Digest carrier: both digests are shell-composed (per §Contracts 5, from the leaf's `describe()` and the registry) and the shell appends them as labeled blocks inside the CAPTAIN-9 hidden-control envelope of the Captain-root decision call; the compiled Captain's prompt references those blocks and never composes digests itself — this is the task 3 / task 4 seam.
- A malformed reply (unrecoverable JSON, unknown action, missing payload, invalid target) gets exactly one corrective re-ask appending the rejection reason and restated contract; a second malformed reply settles the turn as a Boss-appropriate failure reply with no action executed and the stack untouched.

### 4. Command parse table

| Input | Shell state | Resolution |
| --- | --- | --- |
| `/cmd text`, enabled command | idle | `start` that playbook with `text` |
| `/cmd text`, command names the active leaf | engaged | `deliver` `text` to the leaf |
| `/cmd text`, enabled command absent from the active path | engaged | `switch` to that playbook with `text` |
| `/cmd text`, command names an active non-leaf ancestor | engaged | `respond` only |
| bare `/cmd`, enabled command | any | `respond` only — status or clarification, never a restart |
| unregistered `/x` or ordinary text | any | decision call |

Empty or whitespace-only input still allocates no call, session, or telemetry.

### 5. Digest content rules

- ControlView digest: active path as commands root→leaf, leaf state (`stateId`, tags, quiescence, status), the sanitized JSON-safe relevant context fields of the leaf's ControlView (DR-029 §3), pending questions verbatim with question ids, last error `{ name, message }`, advertised actions as id + label.
  While the leaf machine occupies a `type: 'parallel'` state, the digest carries the full multi-region state value with every active region readable, not a single `stateId`.
- Catalog digest: each enabled playbook's id, command, and intent.
- Excluded everywhere: session/call UUIDs, resume tokens, trace payloads, module specifiers, options, player rosters, journal text, ledger JSON.
- Player output enters the conversation only as fenced quotes; the prompt forbids treating quoted content as instructions (residual injection risk accepted per DR-029).

### 6. Journal, continuity, and reseed

- Journal: host-kept, per-shell-session, append-only, JSON-safe records `{ seq, turnId, kind: 'boss' | 'reply' | 'action' | 'outcome', payload }` — Boss text, validated Captain replies, validated actions with targets, and settlement facts; never Boss-visible; exists only for reseed.
- The journal is complete for the session lifetime — G1 forbids dropping records. The only bounding is the deterministic per-record truncation of long player output quoted inside a payload: a content rule, never record dropping.
- After every durable call the shell pins the returned `resumeToken`, replacing the prior pin.
- Unsynchronized when a durable call throws, returns non-`ok`, or returns `ok` without a token: clear the pin, re-issue that call once on a fresh conversation (`resume: false`) seeded with a journal digest plus the current ControlView digest; the new token becomes the pin.
- Only the conversation is replaced: the engagement stack, player sessions, journal, and the turn's completed work survive; a second consecutive continuity failure fails the phase without touching the stack.

### 7. Speech and summary gating

- All durable calls are hidden; the shell-side captain-port plumbing validates every durable call's returned prose and surfaces it through cligent `CaptainContext.emitReply` (`captain_reply` records) as the explicit presentation channel; `emitStatus` never carries Captain prose.
- The channel carries exactly two kinds of validated prose: a `respond` selection's `text` (one model call settles the turn, §Contracts 2) and an acting turn's closing-reply call, surfaced the same way.
- Prose validation: DR-028's missing-or-empty predicate with its single re-ask; no control JSON or internal vocabulary.
- The acting turn's closing reply is the turn summary, composed only from the outcome-report facts.
- The `summaryPolicy` saved-counts line is appended verbatim only when the turn's counted activity (interruptions + copy-pastes + summary-visible rounds per CAPTAIN-20) is nonzero; a do-nothing or `respond` turn never carries it; entries without a `summaryPolicy` get no line.

## Acceptance plan

Three tiers: Tier A hermetic rows run inside `pnpm test` and gate the implementation tasks below; Tier B is the fifth live scenario in `pnpm test:acceptance` (task 6); Tier C is the model-free `pnpm smoke:release` gate (task 7).
A scripted-model seam can never assert model prose: wherever a row's value is "the model says the right thing", the hermetic tier asserts the prompt plumbing (the facts verbatim in the captured call) plus a CAPPLAY-20 prompt-contract pin, and Tier B carries the one live prose probe.

### A-28 status (DR-028)

Rows A28-1…A28-5 and A28-6's substance landed with IR-035's commit `9e55bde`, verified against the committed suites: the PBRT-51 recovery/failure/parity/no-retry matrix at both boundaries, re-ask prompt byte-equality (`src/xstate-playbook-runtime.test.ts` asserts `prompts[1]` / `playerCalls[1].prompt` equal to the first call), and PBRT-38 resume selection including the cleared-token fresh leg.
Residue carried by this iteration:

- **A28-6 (wording only)** — PBRT-51's text pins neither fidelity fact; task 1 appends the two bullets (Touched-items row).
- **A28-7 (shell echo)** — a full Boss turn through the real shell and real CODE artifact with a scripted empty-then-text player recovers with normal lifecycle markers and exactly one turn summary; the recovery is invisible to the Boss surface except in traces. Task 4, CAPTAIN-37.
- **A28-8 (controller coupling)** — a durable controller call returning empty `ok` with no token gets exactly one corrective call, and it is the journal-seeded reseed — never reseed plus another retry. Task 4, CAPTAIN-39.

### A-29 hermetic rows (DR-029)

Fixture: real shell + real recompiled controller Captain + the real linked CODE artifact and real compiled DISCUSS artifact as registry entries, with `stubContext.callPlayer` extended to per-call scripted results and `captainReplies` scripting the adapter (function form wherever a row asserts captured prompt content).
Rows A29-1/4/5/6/17/18/19/20 must run on real entries (their asserts read genuine engine state); A29-19 runs on the real DISCUSS entry, its context-conditional leg engine-pinned by task 1's landed PBRT-53 rows rather than a shell fixture; FakeRuntime is reserved for A29-16 and A29-9's shell-composition leg; A29-2/3/21 use fake-entry `initHook`/`disposeHook` failure seams.

| # | Scenario | Gate |
| --- | --- | --- |
| A29-1 | Incident replay: CODE driven to `failed` (scripted player `error`), then the four incident Boss turns verbatim, turn 1 `Retry and continue the iteration` | Turn 1, both halves mechanically: one hidden decision call on the durable conversation (resume token in captured options) and a captured prompt carrying the exact Boss text plus the ControlView digest — failed leaf, sanitized context fields, `lastError` `{name, message}`, advertised retry id + label (§Contracts 5); the valid `runtime` selection is the retry id → one real `apply()` (`executed` receipt) → the result-phase prompt carries the settlement facts verbatim. Turns 2–4: grounded settle, never a dead NO_ACTION-like turn, never re-execution (idempotency key; `playerCalls` count fixed). |
| A29-2 | Clear-and-start: "clear this and start <target> on X" | `switch`: dismiss then start, in that order; receipt-grounded closing reply names both. |
| A29-3 | Switch dual-fact: target `start` scripted to fail after dismissal | Settlement reports both facts, no rollback pretense; shell idle after; next turn starts fresh. |
| A29-4 | Suspended player question answered by the Boss | `deliver` → `BOSS_REPLY` resumes the same state with the answer in context; the full question surfaced as captain speech (DR-007 path). |
| A29-5 | Mid-run status question while busy/parked | Answered from `describe()` only: zero `apply`, zero FSM events, snapshot identical before/after; reply reflects state + pending question. |
| A29-6 | "What went wrong?" asked twice after a failure | Both captured decision prompts carry the engine's `ControlView.lastError`; no `apply`; machine untouched. |
| A29-7 | Command table: idle `/code x`; `/code x` at leaf; `/discuss x` absent from path; bare `/code`; command naming an active ancestor | `start`; `deliver`; `switch`; `respond`; `respond` — per §Contracts 4, with no model call to parse the command itself. |
| A29-8 | Summary gating: acting turn with counted activity vs do-nothing turn | Acting: closing reply is the summary with the verbatim nonzero saved-counts line. Do-nothing: the literal substring `Saved you` absent; no summary call at all. |
| A29-9 | Grounded-summary prompt plumbing: scripted `failed` receipt with a normalized error (FakeRuntime leg) | The captured result-phase call carries the disposition, error `{name, message}`, and settlement facts verbatim; the emitted closing reply is exactly the scripted validated prose (`emitReply` plumbing). Model-side grounding is CAPPLAY-20 pin 5 + Tier B step 2. |
| A29-10 | Token rotation with an interleaved sub-runtime judge call | Pin rotates A1→A2; the judge call stays fresh/isolated and never replaces the pin; the next durable call resumes A2, not J. |
| A29-11 | Unsynchronized detection ×3 (throw / non-`ok` / `ok` without token), no executed action in flight | All three mark the conversation unsynchronized; only the failed call re-issued; exactly one fresh journal-seeded conversation; stack, player sessions, journal, completed work survive. |
| A29-12 | Reseed preserves knowledge (nonce fact, forced reseed, later reference) | Reseed prompt carries the journal digest; post-reseed reply proves the nonce; digest-outranks-memory instruction present. |
| A29-13 | Injection defense: player text with imperative instructions, a serialized action object, a receipt/nonce spoof | Player text enters only as fenced quotes; no `apply` the Boss turn did not request; no spoofed receipt honored; the reply does not obey the quoted instruction. |
| A29-14 | Prose validation: (a) durable `ok` with empty text; (b) valid action JSON but the visible reply leaks control syntax | (a) one corrective re-ask then the failure path — never an empty `captain_reply`; (b) one corrective re-ask, then Boss-appropriate failure text, never the leaked syntax on the Boss pane. |
| A29-15 | Chat-turn economy: pure chat turn | Exactly one durable call settles it (`respond`); no separate summary call; an acting turn costs two plus bounded correctives. |
| A29-16 | Capability absence (FakeRuntime without the pair) | No actions advertised; `deliver` is the only verb; no fabricated `runtime` action; the DR-022 gate reports the pair as absent, distinctly. |
| A29-17 | Receipts against real `apply()`: (a) advertised retry from `failed`; (b) same `actionId` after the state moved on; (c) player `error` mid-action; (d) leg (a)'s key repeated | (a) `executed` with the run result; (b) `rejected` with reason, before any effect — snapshot unchanged, zero player calls; (c) `failed` with normalized error, effects in traces; (d) the recorded receipt returned, exactly one execution (§Contracts 1 replay rule). Engine-level twins live in PBRT-53 (task 1). |
| A29-18 | Crash window: `apply()` executes, then the result-phase durable call throws | The re-issued call's journal digest carries the executed action and outcome records (§Contracts 6) — the reseed provably knows the action ran; no second `apply()` (settlement is final, §Contracts 2); stack, journal, completed work survive. |
| A29-19 | Capability degradation + context-conditional validity: real DISCUSS artifact engaged as leaf — its bespoke runtime ships without the `describe`/`apply` pair; status question | The DR-022 gate reports the pair absent; no actions advertised; `deliver` is the only verb; zero `apply`. Context-conditional action validity is engine-pinned on scalar machines with context-conditional guards by task 1's landed PBRT-53 advertisement and apply-refusal rows (`excludes refused DISCUSS targets at the bare runtime surface and includes them once context allows`, plus the rejected-before-any-effect receipt leg) and is not re-proven at the shell. No factory-parallel fixture exists or is required: the shared factory's scalar-state contract (single-region root machines) rejects a parallel snapshot, and no shipping artifact needs factory-parallel entry (CODE and the controller Captain are scalar; DISCUSS keeps its bespoke runtime) — shared-factory parallel support, and with it a hermetic row for the §Contracts 5 parallel-digest clause, is explicit future scope alongside porting DISCUSS to the shared factory, outside DR-029. |
| A29-20 | Jump action (DR-029 G3): CODE parked/failed; "resume from <named state>" | The captured digest advertises the jump action (id from `resumableStateIdsFromMachine` targets, label from the state description); the selection is that action; real `apply()` lands the snapshot at the target (`executed` receipt); the result-phase prompt carries the jump fact; the scripted closing reply names the state. |
| A29-21 | Dismissal failure: switch with the dismissed entry's dispose scripted to fail | Settlement names the dispose failure and whether the target started, per the §Contracts 2 dismissal-failure rule; the shell lands in the stated recoverable state and the next Boss turn settles. |

Fixture provenance (A29-1): `acceptance-fixtures/incident-boss-turns.ts`.
Turn 1 is recorded in DR-029 §Context; turns 2–4 must be recovered from the motivating session's log and recorded alongside the fixture, or, if unrecoverable, marked as reconstructions with the verbatim guarantee scoped to turn 1.

## Tasks

Each task is one commit and keeps `pnpm build` (no compiled-sibling drift) and `pnpm test` green at its boundary; the one exception is the tasks 4+5 landing unit, which is green only at its combined merge boundary.
Tasks 6 and 7 follow the 4+5 unit and may land in either order.

1. **Engine control surface.**
   Add the §Contracts 1 types and the `apply.started` / `apply.finished` `PlaybookTraceType` members to `src/runtime.ts`, implement `describe`/`apply` with idempotency and apply traces in `src/xstate-playbook-runtime.ts`, extend `src/runtime.test.ts`, `src/xstate-playbook-runtime.test.ts`, and `src/package-surface.test.ts`, add the control-surface section to `slc/link.md` §PlaybookRuntime contract and the apply pair to `slc/link.md` §Playbook trace, amend PBRT-5/PBRT-34, add PBRT-52/PBRT-53, append the two A28-6 fidelity bullets to PBRT-51, update the PBRT map summaries, and start the `[Unreleased]` CHANGELOG entry.
   Rationale: everything downstream — the recompiled Captain, the shell, and the scenarios — consumes this surface.
   Gate: the PBRT-53 suites, whose scenario list names the A29-17 engine-level twins — a repeated idempotency key returns the recorded receipt with exactly one execution; a failing action yields disposition `failed` while a guard refusal yields `rejected` before any effect.
   Lands: PBRT rows incl. the PBRT-51 amendment, `slc/link.md` §PlaybookRuntime and §Playbook trace rows, RELEASE stands-verification.
2. **Spec rewrite.**
   Rewrite `specs/{user,dev,test}/playbook-captain.md` and `specs/{user,dev,test}/captain-playbook.md` to the dispositions above, annotate the Status sections of DR-004/008/009/011/012/013/025, and update the CAPTAIN/CAPPLAY map summaries.
   Rationale: pins the target contracts the recompile and shell rework implement against; spec-only commit, verified by anchor/link integrity and an unchanged test suite.
   Lands: all DR-section, CAPTAIN, and CAPPLAY dispositions above except the new test items (tasks 3 and 4 land those with their suites).
3. **Captain playbook recompile.**
   Rewrite `reference/sdlc/captain.md` to the session-loop policy, recompile through the SLC pipeline (`text2gears` → `gears2fsm` → `link`) into `reference/sdlc/captain.playbook/` — GEARS, FSM, linked runtime, compiled siblings, and the regenerated verification bundle and suites — and apply the `slc/link.md` §Boss-event mapping amendments (default-Captain entry sentence and the `handleBossInput`-scoped judge-only sentence).
   Two further SLC contract amendments the controller compile needs are explicit task-3 deliverables, landing with this compile and not before.
   First, the result contracts of `slc/gears2fsm.md` §Setup gain an ADDITIVE decision-state class for controller playbooks: a controller decision state's direct-Captain result contract discriminates the closed action set — stable compiler-contract guards `respond`, `start`, `switch`, `dismiss`, `deliver`, and `runtime`, names the compiler may not invent — with each guard's required payload fields per §Contracts 2 (`text` for `respond`; `playbookId` and `input` for `start`/`switch`; `actionId` for `runtime`; none for `dismiss` and `deliver`).
   The existing decide-call-observe vocabulary (`question`/`delegation`, `final`/`followUpQuestion`/`continuing`) and the universal `needsBossReply` rule stay untouched for the artifacts that consume them (CODE and DISCUSS).
   Second, `slc/link.md`'s Captain-call presentation (the §Captain adjudication area) admits the hidden-decision + `emitReply` presentation for controller playbooks: a controller playbook's decision and closing-reply Captain calls run `{ visibility: 'hidden' }` on the host's durable conversation, and the decision reply is `{ action, … }` control JSON validated by the linked runtime with the single corrective re-ask — control data, never Boss presentation.
   Controller prose reaches the Boss only as host-validated captain speech through cligent `CaptainContext.emitReply` (§Contracts 7), so the visible-call `question`/`response` injection rule stays scoped to visible-presentation playbooks such as CODE and DISCUSS.
   Gate for both amendments: the CODE and DISCUSS conformance suites stay green.
   Rationale: depends on task 1's engine and task 2's contracts; proves the controller policy is expressible as a compiled playbook.
   Gate: regenerated GEARS↔FSM conformance and coverage suites, plus the new CAPPLAY-20 prompt-contract item with six re-pins — (1) the closed action menu `respond|start|switch|dismiss|deliver|runtime`; (2) the digest-outranks-memory clause; (3) the fenced player-quote rule; (4) the current-Boss-turn-only action rule; (5) the grounding instruction: closing replies and summaries compose only from the outcome-report facts (§Contracts 7 — the model-side half of A29-1/A29-9); (6) the compiled decision prompt references the labeled ControlView + catalog digest blocks on every ordinary decision call, not only in the reseed prompt.
   Lands: CAPPLAY implementation + CAPPLAY-20, `slc/link.md` §Boss-event mapping row, and the `slc/gears2fsm.md` §Setup result contracts and `slc/link.md` §Captain adjudication amendment rows.
4. **Shell controller rework.**
   Rework `reference/sdlc/code.playbook/playbook-captain.ts` (+ siblings and `playbook-captain.test.ts`): session Captain constructed at `init`, durable conversation with token pinning and §Contracts 6 reseed, journal, §Contracts 4 parse table, §Contracts 2 controller port, `emitReply` speech, gated summaries, and retirement of the lazy internal root and lifecycle classifier; update the CAPTAIN-numbered integration suites; revise the shipped user docs (`docs/cli.md`, `docs/configuration.md`, `docs/embedding.md`, `README.md`) wherever they describe the retired lazy-root/ask-first behavior, since RELEASE-20 packs `docs/` with the release.
   Includes the harness extension (register the real linked CODE and real compiled DISCUSS artifacts as registry entries under the shell; extend `stubContext.callPlayer` to per-call scripted results) and `acceptance-fixtures/incident-boss-turns.ts` under its provenance rule.
   Rationale: consumes tasks 1–3 plus the cligent `resumeToken`/`emitReply` surfaces, which the committed `^0.18.0` dependency does not provide — tasks 4 and 5 are one landing unit merged together (task 4 alone cannot keep CI green), unless cligent 0.19.0 ships first, in which case task 5 folds into this commit.
   Gate — the A-29/A-28 rows land here as new test items (numbers next free after CAPTAIN-36; re-check at land time):
   **CAPTAIN-37** observe–act–result loop: A29-1, A29-4, A29-5, A29-6, A29-9, A29-15, A29-19, A28-7;
   **CAPTAIN-38** validated actions and command table: A29-2, A29-3, A29-7, A29-16, A29-17, A29-20, A29-21;
   **CAPTAIN-39** durable continuity: A29-10, A29-11, A29-12, A29-18, A28-8;
   **CAPTAIN-40** injection and prose validation: A29-13, A29-14;
   amended **CAPTAIN-21**: A29-8.
   A29-5/6 live in CAPTAIN-37 only — no PBRT twin: status-question behavior is shell surface, and PBRT's shall-subjects are the runtime (META-13).
   Lands: CAPTAIN implementation rows + CAPTAIN-37…-40.
5. **cligent dependency bump.**
   Raise `package.json` to the cligent release shipping `CaptainRunResult.resumeToken` and `CaptainContext.emitReply` (expected `^0.19.0`), refresh the lockfile, and complete the CHANGELOG entries.
   Rationale: completes the task 4+5 landing unit — the two commits merge together because task 4's build fails against `^0.18.0`; ordered here because the release date is upstream-owned; fold into task 4 if 0.19.0 ships first.
   Task 7's RELEASE-28 step 8 (the nested-cligent floor guard) becomes this bump's standing regression guard.
6. **Live acceptance fifth scenario (Tier B).**
   Append the conversational scenario to `acceptance/playbook-live.acceptance.test.ts` — deliberately not a new file: the pack/install helpers are file-private (a second file would duplicate the once-per-run pack + global install against RELEASE-24/25's pack-once rule), and `vitest.acceptance.config.ts` has no sequencer, so in-file source order under the serial runner is what runs it after the existing four cases on the same single install.
   Add the DR-016 script-actor failure fixture (a bundled playbook whose middle step reads a flag file that does not yet exist, so the exit-status guard routes to `failed` with no model nondeterminism), and amend dev RELEASE-24 + test RELEASE-25 from four to five scenarios — replacing this task's earlier "keep RELEASE-24 unchanged" wording, which contradicted RELEASE-25's four-repository pin.
   Scenario steps (one session, real Claude captain, players only where the script needs them): (1) natural chat turn → `captain> ` prose reply, no engagement, no `Saved you`; (2) engage the fixture → deterministic `failed`; assert the failure-turn reply names the failed step and claims no completion (the live half of incident 4); (3) write the flag file, then `Retry and continue the iteration` verbatim → the turn ends `◇ … finished`-grounded (plain resume continuity — incident 1's repair branch stays in cligent's landed CLAUDE-010 canned unit, whose dangling-tool-call precondition this script deliberately never creates); (4) natural status question → mentions the failure + retry, no state movement; (5) remove the flag file and re-engage the fixture → deterministic `failed` again, a genuinely active engagement parked mid-iteration; then request the change in ordinary prose ("drop this and discuss <topic>" — deliberately no `/discuss` command), so the live decision call must produce the validated `switch` → dismissal + start markers in order (the deterministic absent-from-path `/discuss x` command mapping stays Tier A's A29-7 row); (6) dismiss and exit; whole-session: the literal `Saved you 0` never appeared, no failure markers beyond the rigged step's two engineered failures, clean fixture repo.
   Upstream note: the matching cligent live case (proposed TTMUX-094 — `emitReply` glow rendering, `resumeToken` chain, whitespace/copy-mode leg) plus cligent's own `smoke:release` chain is a cligent-repo follow-up commit, unblocked now; it is recorded here as a dependency note, not a task of this repo.
   Gate: amended RELEASE-24/RELEASE-25.
7. **Release smoke (Tier C).**
   Add `scripts/release-smoke.mjs` behind a `package.json` `smoke:release` entry — no model calls, no keys, no tmux, but registry access required (steps 2–3 install from npm) — with eight steps in one isolated temp root: (1) `npm pack`; (2) lean global shape with nested cligent, no SDK directories, `smoke-adapters.mjs unavailable`; (3) opted-in shape with both SDKs as top-level roots, `smoke-adapters.mjs available`; (4) installed `playbook --help` / `--list` naming `code` and `discuss`; (5) the DR-024 hermetic-run deterministic variant — bare repo, thin artifact whose single working state is a DR-016 script actor, one provisioning line, symlinks into the prefix, terminal JSON, second run provisions nothing; (6) Captain artifact integrity — installed `captain/playbook` import constructs and packed compiled bytes hash-equal the committed ones; (7) compiled-artifact fidelity — no recompile: the SLC pipeline is agentic, so the smoke cannot re-derive the artifacts deterministically; it instead verifies byte-equality of the packed compiled artifacts against the committed ones (extending step 6's hash equality to the full packed compiled set) and reruns the committed source-artifact conformance suites green — `pnpm vitest run reference/sdlc/captain.playbook` (92 tests), including the `.slc-verify`-driven `captain.gears-fsm.test.ts` (GEARS↔FSM conformance), `captain.fsm.coverage.test.ts` (declared-transition coverage), and `captain.fsm.introspect.test.ts` (pinned topology); (8) the cligent floor guard — the nested installed cligent's version satisfies the documented floor and its shipped declarations contain `emitReply` and `resumeToken`.
   Add dev RELEASE-28 (the entry point and the eight gate steps as observable outcomes) and test RELEASE-29 (`Verifies:` RELEASE-28, RELEASE-12, RELEASE-24 §hermetic), and amend RELEASE-10 to the ordering `pnpm test` → `pnpm smoke:release` → `pnpm test:acceptance` → conditional RELEASE-26.
   Script internals, temp-dir plumbing, and fixture playbooks stay plain implementation, like `smoke-adapters.mjs` today.
   Gate: RELEASE-28/RELEASE-29 and the amended RELEASE-10.

## Acceptance criteria

- Incident replay: with a root playbook parked in recoverable `failed`, "Retry and continue the iteration" selects and applies exactly one advertised `runtime` action (never a repeated `NO_ACTION`), the closing reply reports only the executed outcome, and across the four replayed turns no reply claims unperformed work and no `Saved you 0 …` line appears after a turn with zero counted activity.
  Mechanical form of the no-unperformed-work clause at the scripted seam: A29-1/A29-9 prompt plumbing plus CAPPLAY-20 pins 5–6, with task 6's step 2 as the live prose probe — scripted replies cannot test model prose.
- Clear-and-start: one Boss turn switches — the stack is dismissed, the target starts, both `◇` facts appear; a forced start failure reports both the completed dismissal and the failure.
- Suspended question: with a player question pending, a conversational Boss turn settles as `respond` in one durable call, the parked leaf and its pending question survive untouched, and the next turn's answer delivers to that same leaf.
- Status question: "where are we?" yields a reply grounded in the ControlView digest with no stack mutation, no action, and no summary block.
- Continuity drill: a durable call forced to throw, return non-`ok`, or return `ok` without a token triggers exactly one reseeded re-issue; the stack, player sessions, journal, and completed turn work survive; the next turns continue on the fresh conversation.
- Bare and ancestor commands only ever produce `respond`; an absent-from-path command switches; a leaf command delivers its remainder.
- Every inventory row above is landed and annotated: superseded and amended items rewritten in place, DR Status sections naming DR-029, stands rows verified untouched.
- Headless `playbook run` behavior and suites are unchanged; `pnpm build` shows no compiled-sibling drift; `pnpm test` passes end to end including every Tier A row; `pnpm smoke:release` and the five-scenario `pnpm test:acceptance` pass on the release candidate.
- Every incident of the motivating session has a named regression home:

| # | Incident | Regression home | Status |
| --- | --- | --- | --- |
| 1 | Claude adapter yielded terminal `done` on the CLI's resume-repair no-op, tearing the SDK down mid-turn | cligent canned unit CLAUDE-010 — the only genuine net (its dangling-tool-call precondition is never engineered live, by choice); echoes: A28-1/5, task 6 step 3 | landed (cligent `60670d8`) |
| 2 | `ok` with no `finalText` abandoned the whole turn | A28-1…A28-6 → PBRT-51 | landed (`9e55bde`); wording residue in task 1 |
| 3 | `Retry and continue the iteration` from `failed` → `NO_ACTION` four times | A29-1 (CAPTAIN-37, task 4) — durable half and digest half both pinned; live echo task 6 step 3 | task 4 / task 6 |
| 4 | Summary claimed completion that never happened | A29-9 (task 4) + CAPPLAY-20 pin 5 (task 3) + task 6 step 2 | tasks 3, 4, 6 |
| 5 | `Saved you 0 interruptions…` after a do-nothing turn | A29-8(ii) (CAPTAIN-21, task 4); task 6 step 6 | tasks 4, 6 |
| 6 | `lastError` spoken once, then unspeakable | A29-5/A29-6 (CAPTAIN-37, task 4) on the real CODE entry | task 4 |
| 7 | `/discuss` while engaged → refusal, asymmetric with conversational re-routing | A29-7 + A29-2 (CAPTAIN-38, task 4) | task 4 |
| 8 | Fresh judge calls clobbered the pinned resume token | A29-10 (+A29-11/A29-18) (CAPTAIN-39, task 4) | task 4 |
| 9 | Empty captain reply reached the Boss surface | A29-14 (CAPTAIN-40, task 4) + the landed A28-5 boundary | task 4 |
| 10 | Whitespace-only `captain_reply` snapped a scrolled pane out of copy-mode | cligent follow-observer unit; live counterpart in the cligent TTMUX-094 follow-up (task 6 note) | landed (cligent `f3efbeb`) |

Non-incident coverage residue — receipt discrimination/replay (A29-17), the executed-apply crash window (A29-18), dismissal failure (A29-21), capability degradation with the engine-pinned context-conditional leg (A29-19), and the G3 jump (A29-20) — is carried in the A-29 matrix above.
