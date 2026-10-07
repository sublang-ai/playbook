<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Embedding the runtime in your own host

The playbook runtime is host-agnostic; cligent's `tmux-play` adapter is
one host, and [spex](https://github.com/sublang-ai/spex) (the desktop
app) is another. This guide shows how to wire a playbook runtime into
your own host.

> **Release note:** this guide targets the current semver-stable six-port
> contract; see the [CHANGELOG](https://github.com/sublang-ai/playbook/blob/main/CHANGELOG.md) for migration details.

## The runtime contract

The port and runtime contracts live in the type-only module
[`@sublang/playbook/runtime`](../src/runtime.ts) — a public,
semver-stable surface (`PlayerResult`, `PlaybookPorts`,
`PlaybookRuntime`, `PlaybookSession`, `PlaybookRoleBinding`,
`PlayerCallOptions`, `PlayerSessionStore`, `CaptainCallOptions`, `CaptainResult`,
`PlaybookTraceEvent`, and `PlaybookRuntimeFactory`) that imports no CODE
or FSM types, so a host satisfies it once and inherits every playbook.
The generated CODE, REVIEW, DECIDE, DEV, BRANCH, and PR modules re-export their shared
runtime contract types from their public `playbook` subpaths;
`PlaybookRuntimeFactory` is available from `@sublang/playbook/runtime`.

Generated linked runtimes reuse the XState integration engine exposed
as `@sublang/playbook/xstate-runtime`, including strict JSON
validation, normalized snapshots, quiescence waiting, and the
nested-playbook bridge.

## Constructing a runtime against your own ports

`p-queue` is your host's own dependency here — declare it in your
application's `dependencies` (the same library `@sublang/playbook` itself
depends on) rather than relying on it resolving through the package's
tree, which pnpm's strict linking will not allow.

```ts
import createPlaybookRuntime, {
  type PlaybookHostCapabilities,
} from '@sublang/playbook/review/playbook';
import type {
  CaptainCallOptions,
  CaptainResult,
  PlaybookPorts,
  PlaybookRoleBinding,
  PlayerResult,
  PlayerSessionStore,
} from '@sublang/playbook/runtime';
import { randomUUID } from 'node:crypto';
import PQueue from 'p-queue';

declare const captainAdapter: {
  run(
    prompt: string,
    options: {
      signal: AbortSignal;
      visibility: 'visible' | 'hidden';
      resume: string | false;
      allowedTools?: readonly string[];
    },
  ): Promise<CaptainResult>;
};

declare const playerAdapter: {
  run(
    playerId: string,
    prompt: string,
    options: { signal: AbortSignal; resume: string | false },
  ): Promise<PlayerResult>;
};

// Roles are local workflow identities. Players are stable provider
// conversations owned by the logical Captain session. `promptIdentity` is
// the current model name, or the player's adapter when provider-default is
// selected; rebuild it from current compatible tuning on restore.
const roleBindings = {
  coder: {
    playerId: 'team.coder',
    promptIdentity: 'claude-opus-5-5',
  },
  reviewer: {
    playerId: 'team.reviewer',
    promptIdentity: 'gpt-6-sol',
  },
} satisfies Readonly<Record<string, PlaybookRoleBinding>>;

// Supply a frame-local role view over your session-wide player ledger.
// Equal player IDs must select/update the same token; distinct IDs must not.
declare const playerSessions: PlayerSessionStore;

// Construct one host-wide lane and reuse it for every runtime. Passing each
// call's signal to both the lane and adapter cancels queued and active work.
const captainLane = new PQueue({ concurrency: 1 });

async function runCaptain(
  prompt: string,
  signal: AbortSignal,
  options: CaptainCallOptions,
): Promise<CaptainResult> {
  return await captainLane.add(
    () => captainAdapter.run(prompt, { signal, ...options }),
    { signal },
  );
}

const ports: PlaybookPorts = {
  callPlayer: async (roleId, prompt, signal, { resume }) => {
    const binding = roleBindings[roleId as keyof typeof roleBindings];
    if (binding === undefined) throw new Error(`Unknown role: ${roleId}`);
    // `resume === false` starts fresh; a string selects that player's
    // prior backend conversation. Return the adapter's next token; the
    // runtime updates `playerSessions` only after validating this result.
    return await playerAdapter.run(binding.playerId, prompt, {
      signal,
      resume,
    });
  },
  callCaptain: async (prompt, signal, options) => {
    // Forward every option exactly: omission preserves configured tools, while
    // an explicit empty allowlist requests a tool-free call and must fail closed
    // when the adapter cannot enforce it.
    return await runCaptain(prompt, signal, options);
  },
  callJudge: async (prompt, signal) => {
    // Judge work is hidden control work: run it fresh and tool-free.
    const result = await runCaptain(prompt, signal, {
      visibility: 'hidden',
      resume: false,
      allowedTools: [],
    });
    if (result.status !== 'ok' || result.finalText === undefined) {
      throw new Error(result.error ?? 'Judge call failed');
    }
    return result.finalText;
  },
  callPlaybook: async (request, signal) => {
    throw new Error('No nested playbook host configured');
  },
  emitStatus: async (message, data) => {
    /* … */
  },
  emitTelemetry: async ({ topic, payload }) => {
    /* … */
  },
};

const playbookSessionId = randomUUID();

// Schema-3 artifacts keep persisted configured options separate from live
// current-host authority. Build these capabilities only after acquiring the
// session lease and resolving the canonical Git worktree. Their authority
// must name this playbook/session/working directory and their repository and
// effect-ledger operations must stay live; never put them in configuration,
// machine input, or a persisted snapshot. A host outside the CLI constructs
// the repository and effect-ledger members through the facade described in
// "Constructing worktree host capabilities" below.
declare const hostCapabilities: PlaybookHostCapabilities;

const runtime = createPlaybookRuntime({
  configuredOptions: {},
  hostCapabilities,
});

await runtime.init({
  sessionId: playbookSessionId,
  playbookId: 'review',
  rootSessionId: playbookSessionId,
  depth: 0,
  roleBindings,
  playerSessions,
  ports,
});
await runtime.handleBossInput({
  text: 'Review the latest commit against the requested intent',
  signal: new AbortController().signal,
});
await runtime.dispose();
```

## Sessions and traces

Every init-to-dispose lifecycle is one playbook session. Schema-4
`playbook.trace` telemetry carries that immutable ID plus a contiguous
sequence across exact Boss input, judge/player calls, FSM transitions, visible
Captain work, nested playbook calls, status, settlement, and disposal. A
shell-hosted player boundary keeps both identities: `roleId` says which local
workflow job made the call, while `playerId` says which stable session
conversation owned it. A standalone runtime retains the role without
inventing host player identity.

Without `PlaybookSession.playerSessions`, a standalone runtime starts each
local role fresh and privately retains the latest opaque `resumeToken` its
adapter returned. A composing host instead supplies a frame-local
`PlayerSessionStore` view over one Captain-session ledger and explicit
`roleBindings`. The store's methods receive local role IDs; the view resolves
them to the configured stable player IDs. Equal IDs share one token and
sequential call lane across every frame that names them, while distinct IDs
remain isolated. Child return, frame disposal, and a later root engagement do
not clear the session ledger.

Runtime and complete shell snapshots are schema 4. The shared store projects
provider continuations out of nested snapshots and writes schema-7 manifests.
Local hints may rehydrate the current checkpoint; retained generations never
restore provider tokens. Use the shared migrator for older records instead of
guessing identity or effect evidence. On a compatible
restore, rebuild
`promptIdentity` from the current model selection (or adapter for an explicit
provider-default selection) and rebuild live host capabilities under the
current lease, so neither invocation identity nor repository authority comes
from stale machine state. Trace data, tokens, repository projections, and
capability functions never enter Boss-visible status text or configured
options. Because trace observers do receive opaque resume tokens, persisted
traces should be protected as sensitive data.

## Constructing worktree host capabilities

A schema-3 artifact takes live `{ repository, effectLedger }` capabilities
beside its configured options. Rather than reimplementing the engine's
observation, claim, receipt, and ledger contract, construct them through the
narrow, semver-stable `@sublang/playbook/host-capabilities` facade. It is the
CLI host's own implementation, re-exported: every classification the engine
makes for `playbook run` is the one your host makes too.

```ts
import {
  createFailClosedHostCapabilities,
  createWorktreeHostCapabilities,
} from '@sublang/playbook/host-capabilities';

declare const workdir: string;
declare const createPlaybookRuntime: (construction: {
  configuredOptions: object;
  hostCapabilities: object;
}) => unknown;

// One capability per playbook and Git worktree, constructed after the
// working directory is resolved and before the runtime is. The roles are the
// artifact's declared roles; an undeclared role is refused at boundary start.
const hostCapabilities = await createWorktreeHostCapabilities({
  cwd: workdir,
  playbookId: 'workflow',
  requiredRoleIds: ['coder', 'reviewer'],
});
const runtime = createPlaybookRuntime({
  configuredOptions: {},
  hostCapabilities,
});

// An artifact declaring no governed player state needs no worktree at all:
// every repository operation and ledger write rejects, and the ledger stays
// empty.
const inert = createPlaybookRuntime({
  configuredOptions: {},
  hostCapabilities: createFailClosedHostCapabilities(),
});
```

`createWorktreeHostCapabilities()` requires only that `cwd` exist and returns
exactly `repository: { identity, observe, acquire, runExclusive, runDeferred }` and
`effectLedger: { snapshot, writeAhead }`. The governed worktree is bound at
every governed call and observation rather than fixed at construction: it is
the canonical root of the nearest Git worktree containing `cwd`, or — when
there is none — `cwd` itself as the prospective root `{ worktree, gitDir:
worktree/.git }` that a later `git init` there binds unchanged. A directory
that is not a repository yet observes as the null (all-zero) HEAD over its
non-ignored content, exactly as `git init` would then see it, and an unborn
HEAD observes as the null OID too; so a workflow whose first step runs
`test -e .git || git init` in its working directory receives `unchanged`, and
its first root commit receives `one-descendant-commit` with that commit's OID.
`identity` is the binding at construction; each boundary records the binding
its baseline observed. The ledger is in memory and starts from the optional
`effectLedger` seed, so a host that wants durability keeps
`effectLedger.snapshot()` at its own boundaries and seeds the next
construction from it; each construction is one attempt over its seed.
`runExclusive` and `runDeferred` hold the same cross-process worktree claim the
CLI uses (process-local until the repository exists, since there is no `.git`
to publish it in), observe before and after the operation, apply the engine's
correction-budget `writeAhead` mid-completion, and bind, park, continue, and
restore deferred Boss questions with the engine's exact checkpoint semantics.
`acquire({signal})` holds that same worktree claim for preparation checks; call `assertOwner()` before checking and `release()` in `finally`.
Overlapping calls on one worktree run one at a time, in no guaranteed order.
A write the ledger rejects after a boundary has started leaves the worktree
claim quarantined, exactly as it would under `playbook run`: treat that
rejection as terminal for the worktree in this process.

The module functions `observeGitRepository(cwd)`,
`captureRepositoryReceipt(baseline, { allowedDispositions })`, and
`classifyRepositoryReceipt(baseline, after, { allowedDispositions })` expose
the same observation and receipt classification for a host that inspects a
worktree outside a governed call. The declaration is self-contained — it
re-declares the ledger, receipt, observation, and question types of
`@sublang/playbook/runtime` name for name — and the facade carries no session
lease, session record, resume credential, catalog, or recovery member
([[playbook-cli-87](https://github.com/sublang-ai/playbook/blob/main/specs/packages/playbook-cli.md#playbook-cli-87)]).

## Sharing the CLI session store

`@sublang/playbook/session-store` provides the shared lifecycle and management
API. Its existing `openSessionStore()` facade remains available for narrow
summary/replay consumers:

```ts
import {
  defaultSessionsDir,
  openSessionStore,
} from '@sublang/playbook/session-store';

const store = openSessionStore(defaultSessionsDir());
const { sessions, skipped } = await store.list();

const sessionId = sessions[0]?.sessionId;
if (sessionId !== undefined) {
  const summary = await store.read(sessionId);
  console.log(summary.sessionId, summary.state, summary.cwd);

  const first = await store.readStream(sessionId);
  const next = await store.readStream(sessionId, {
    afterSeq: first.lastReadableSeq,
  });
  console.log(next.entries, skipped);
}
```

`list()` reports valid summaries and separately reports skipped canonical
manifests with their validation or cutover reason. A summary has exactly
`schemaVersion`, `sessionId`, `state`, `cwd`, and `updatedAt`. A lease-free
`readStream()` returns complete envelopes and `lastReadableSeq` only: it makes
no claim that another process has durably checkpointed the observed bytes or
that its live writer remains complete. An absent stream reads as empty, and
acquiring its lease does not require a manifest; only `read()` requires a
canonical session summary. Pass an absolute path to `openSessionStore()` when
using a directory other than the environment-derived default.

Writing requires the one exclusive session lease. The writer assigns envelope
version and sequence, serializes overlapping appends in invocation order, and
strips provider resume credentials from every accepted record:

```ts
const lease = await store.acquire(
  '4f2c0000-0000-4000-8000-000000009ab1',
);
try {
  await lease.append({ type: 'host_notice', message: 'attached' });
  const status = lease.streamStatus();
  console.log(status);
  if (status.lastReadableSeq !== null) {
    const replay = await lease.readStream();
    console.log(replay.lastReadableSeq, replay.lastDurableSeq);
  }
} finally {
  const finalStatus = await lease.release();
  console.log(finalStatus);
}
```

`streamStatus()` synchronously returns the current live status. If initialization
could not establish a trustworthy whole-stream boundary, it returns
`{ lastReadableSeq: null, lastDurableSeq: null, incomplete: true }`, and
`lease.readStream()` rejects rather than return partial history.
An `append()` suppressed before release by either unavailable initialization or
a numeric incomplete latch resolves `undefined` without recording the supplied
record, so fulfillment alone does not prove persistence.

Always release a successfully acquired lease. Release drains admitted work,
saves newly detected incompleteness and retires ownership. A failed save or
unproved ownership leaves the lease held. The facade owns no presentation;
embedding hosts decide how to display recording failures.

For control flow, a missing canonical manifest from `read()` uses
`Error.code === 'PLAYBOOK_SESSION_NOT_FOUND'`, and a competing live or foreign
lease uses `Error.code === 'PLAYBOOK_SESSION_LEASE_ACTIVE'`. Do not match error
messages or assume those codes for malformed input, unsafe storage, an
indeterminate owner probe, or another storage failure
([[playbook-cli-73](https://github.com/sublang-ai/playbook/blob/main/specs/packages/playbook-cli.md#playbook-cli-73)]).

For complete sessions, use `createSessionStore()` and `openSessionHost()`:

```ts
import { createSessionStore } from '@sublang/playbook/session-store';
import { openSessionHost } from '@sublang/playbook/session-host';

const shared = createSessionStore();
await shared.prepare();
const controller = await openSessionHost({
  store: shared,
  sessionId,
  mode: 'continue',
});
try {
  await controller.handleBossTurn('Continue the recorded work.');
} finally {
  await controller.dispose();
}
```

A new host supplies a validated `SessionExecutionProjection` as `config`, or a
plan from `loadLaunchPlan()`, and the working directory. Resolve a configured
`sessions` path with `resolveLaunchSessionsDir()` and pass that store explicitly.
The controller owns uncertainty, reconciliation, settlement and lease release;
observers receive presentation events or exact appended envelopes through
`onStoredRecord`. Keep the controller open for successive turns.

`loadLaunchPlan()` and `normalizeLaunchPlan()` accept an optional `modules`
option, a read-only record from playbook id to module specifier. A host that
keeps each playbook installed somewhere of its own hands the module locations
there instead of writing them into the shared config, whose
`playbooks.<id>.from` may then be left out:

```ts
import { loadLaunchPlan } from '@sublang/playbook/session-host';

const plan = await loadLaunchPlan({
  userConfigPath,
  modules: { code: '/opt/env/code/registry.mjs', review: '@sublang/playbook/review/registry' },
});
```

Each enabled playbook takes `modules[id]` ahead of its `from`. An absolute
path becomes a file URL, while a file URL or package specifier is kept; a
relative path is refused, so resolve it against your own working directory
first. On a new launch, a module naming no enabled playbook is refused before
any import; with `selectedMembers`, one for a current playbook outside the
selection is skipped, while one naming no current playbook is still refused.
These loaders hold no stored session record, so they refuse a playbook with
neither a supplied module nor `from`, with or without `selectedMembers`; only
the CLI's reopen of a recorded session falls back to the module that record
holds. The preparation hook, single import, registry checks and the plan's
canonical `from` are unchanged, and a supplied module is never written back to
your config files
([DR-083](https://github.com/sublang-ai/playbook/blob/main/specs/decisions/083-module-locations-supplied-at-launch.md)).

`shared.readLeaseState(sessionId)` reports `active`, `idle` or `unknown` without
changing files. Use it for presentation; mutations still require a lease.

`shared.migrate(id, { sourcePath })` imports a legacy manifest and its adjacent
replay while holding both stores' leases. `shared.migrateLegacyDefault()` imports
the former XDG default and reports migrated and preserved unsupported IDs.
Embedding applications select and migrate stores during startup;
`openSessionHost()` does not discover old profiles. Stop old writers first.
Automatic discovery belongs only to the ordinary
`~/.spex/sessions` profile with no `SPEX_HOME` or `sessions` override; custom
profiles require an explicit migration request.

Captain may answer a player from the original task when it already answers the question. It reports what it reused, respects later Boss instructions and never sends that original answer twice automatically.

If a process loses the exact stopping point, retry settles the attempt in chat without repeating player work. Files and recorded evidence remain; unrelated saved workflows remain available. This also works when the attempt began from chat or used a custom runtime.

All applications sharing a session store, including Spex and the CLI, must upgrade together before running this version. Every saved shell snapshot carries `presentedEffectPrefix`, which hosts through 16.0.x reject as unknown, so they cannot open any session this version saves.

A single recovery entry point handles either a paused step or an uncertain attempt:

```ts
const controller = await openSessionHost({ store: shared, sessionId, mode: 'recover' });
try {
  const record = await controller.read();
  await controller.recover(record?.state === 'uncertain' ? undefined : bossInstruction);
} finally { await controller.dispose(); }
```

For uncertainty it restores the saved position and reports the recorded work using the attempted settings. It runs no player, script or preparation. Boss then chooses an available action or supplies input. Completed results are reused; before repeating unfinished work, Boss must stop any old worker and check outside actions. A runtime without a saved position returns to Captain with work preserved. It never chooses discard. For an already settled pause, `recover(bossInstruction)` requires Boss's instruction or answer and passes it through the same Captain turn as CLI input; an ordinary answer does not force preparation. New input cannot replace an uncertain instruction before recovery.

If a turn fails and leaves this open controller uncertain, dispose it and reopen with `mode:'recover'` before calling `recover()` without new input.

Explicit `mode:'retry'` and `retry()` remain supported. Module-free
`discardSessionUncertain(shared, sessionId)` restores the prior recovery, or
deletes a never-settled fresh session and resolves `undefined`,
only when `isUncertainTurnDiscardable(record)` returns true: no abandonment, no recorded steps, and a ledger equal to the pre-turn snapshot. Use the same exported predicate to enable a Discard control.

`readHistory()` returns readable history and a damaged boundary, including a
clearly marked synthetic projection when a validated legacy journal has no
stream. `validate()` separates byte integrity from resumability.
`readManifest()` may return an older or unknown object; use
`validateSessionManifest()` before interpreting schema-7 recovery.
`migrate()` preserves original inputs before conversion. `delete()` removes the
bundle under the shared lease, with the manifest last. Management needs no
playbook module. A coordination-only `acquireManagement()` lease reserves even
an absent ID and never checkpoints or rewrites selected bytes on release.

The [storage contract](https://github.com/sublang-ai/playbook/blob/main/specs/packages/session-storage.md)
defines the files, versions and compatibility rules.

## Reading the published spec contracts

The compiler definitions and supporting assets ship in the package and are exposed
as a public, semver-stable surface under `@sublang/playbook/slc/*`.
Resolve and read one with `import.meta.resolve` plus `fs`:

```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const url = import.meta.resolve('@sublang/playbook/slc/link.md');
const link = await readFile(fileURLToPath(url), 'utf8');
```

The five specs are [`slc/text2gears.md`](../slc/text2gears.md),
[`slc/gears2fsm.md`](../slc/gears2fsm.md),
[`slc/link.md`](../slc/link.md) — the FSM-to-runtime contract that
`@sublang/playbook/runtime` projects into TypeScript —
[`slc/optimize.md`](../slc/optimize.md), and
[`slc/prefix.md`](../slc/prefix.md).

Six supporting assets use the same resolution mechanism:

| Asset | Purpose |
| --- | --- |
| [`slc/workflow-contracts.json`](../slc/workflow-contracts.json) | Public output schemas and default literal target bindings for the builtin REVIEW, DECIDE, CODE, BRANCH, and PR workflows; compilers and embedders can read them without importing workflow implementations. |
| [`slc/materialize-link.mjs`](../slc/materialize-link.mjs) | Optional CLI that emits a thin linked module from a supported FSM and JSON descriptor; see the profiles and invocation in `slc/link.md`. |
| [`slc/scaffold-fsm.mjs`](../slc/scaffold-fsm.mjs) | Optional CLI that initializes an incomplete typed FSM from supported GEARS source. |
| [`slc/prefix-prompts.mjs`](../slc/prefix-prompts.mjs) | CLI that performs the prompt-prefix pass's rewrite of a GEARS package exactly; see the invocation in `slc/prefix.md`. |
| [`slc/experiments/fsm-scaffold-guidance.md`](../slc/experiments/fsm-scaffold-guidance.md) | Opt-in compiler guidance for the initializer, outside ordinary phase discovery. |
| [`slc/slc.pin-inputs.json`](../slc/slc.pin-inputs.json) | SLC semantic-input closures for `gears2fsm`, `prefix`, and `link`, including the workflow catalog, the prefix tool, and, for `link`, the materializer. Other phases use SLC's inline-input discovery. |

For example, resolve `@sublang/playbook/slc/workflow-contracts.json`, read it
with `readFile`, and parse the result as JSON to inspect the published workflow
interfaces. Execute the `.mjs` helpers with Node and their documented CLI
arguments: their supported public interfaces are their resolvable paths and CLI
contracts. Their JavaScript module exports are internal implementation details
and carry no SemVer compatibility guarantee.
The initializer requires further semantic compilation and verification
before its output is runnable.

## Attachments and captured evidence

The shared host accepts `handleBossTurn({ text, attachments })` as well as a plain
string. Keep the user's text exact. Import uploads through the controller's
existing lease before submitting the turn; portable references contain a content
hash, MIME type, byte count and optional display name, never a machine path.

```ts
const reference = await controller.lease.importAsset({
  path: stagedUploadPath,
  mimeType: 'image/png',
  name: 'Reference screen.png',
});
await controller.handleBossTurn({
  text: 'Compare the running interface with this reference.',
  attachments: [reference],
});
```

An empty text with attachments is accepted, recorded and answered with a host-owned
clarification. It makes no model call and fabricates no instruction. Captain can
then explicitly select the pending attachment IDs for the clarified request.
Omitted selection means only uploads from the current turn. Working engagements
retain selected references, and nested calls inherit their parent's snapshot;
finishing, dismissing or starting unrelated work does not implicitly reuse them.
Captain decisions, judges and closing replies see metadata only. A capable worker
receives the actual selected files; unavailable required evidence fails that call
explicitly, without requiring the controller's provider to support the same media.

Observe the `SessionRecord` union from `@sublang/playbook/session-assets` or
`@sublang/playbook/session-host`. `turn_started.turn.attachments` preserves input
references. A `playbook_evidence` record carries a saved output asset with its turn,
call and player or preparation origin; present it in the main conversation.
Duplicate content is promoted once per call. Native worker `media` events remain
in the worker lane, using `playbook-asset:<assetId>` URIs after persistence. Hidden
controller traffic is never promoted as visible evidence. URI-only native media
is preserved without fetching remote URLs or reading arbitrary local files.

Tool-result output JSON larger than 4096 UTF-8 bytes becomes
`{ type: 'asset_reference', asset }`; retrieve and decode the original JSON when a
user opens its details. Base64 media is stored outside replay lines. An unavailable
or oversized output is reported explicitly instead of being replayed inline.
These host projections do not alter the native agent's own tool-result reasoning.

Use `shared.openAsset(sessionId, reference)` for verified bounded reads and close
the returned reader in `finally`. `shared.readAsset()` reads a whole asset, and
`describeAsset()` looks up a descriptor by ID. The default per-asset maximum is
100 MiB; hosts may impose smaller upload or turn limits. `exportBundle()` returns
exact manifest bytes, the checkpoint's exact replay prefix and verified relative
asset entries. Copy all of them together. Session deletion removes only that
session's asset owner; copies in other owners remain independent. All hosts sharing
the store must support the optional asset inventory before writing it.

For uploads awaiting a session, draft work or direct authoring calls, use
`createAssetStore({ directory })` from `@sublang/playbook/session-assets` under your
own owner lifetime and writer coordination. Its `prepare()` validates ownership
and tightens Git-restored permissions without changing bytes. `copyAsset()` imports
verified content into another owner. `externalizeAgentEvent(store, event)` shares
the same native-media and large-tool-result ingestion boundary with authoring;
it returns the projected event and, for native media, its asset reference. Handle
persistence failures explicitly, and never save the original large payload as a
fallback.

Captured native media also becomes evidence for still-active parent workflows in the same engagement, so a parent can continue reasoning about a child's figure. Newly submitted Boss attachments stay scoped to the addressed worker; neither kind is implicitly inherited by unrelated later work.

Before adopting asset-bearing sessions, upgrade every Playbook CLI and embedded SDK that shares the store and stop all older writers. Older readers tolerating unknown replay records does not make older writers compatible: they may discard additive asset metadata on save.

Accepted visible worker prose also reaches Captain as attributed, quoted observations, separately from effect and completion facts. Reports keep up to 8192 rendered characters each and 24576 across the latest accepted observations, labeling truncated or omitted content; full text stays in the durable ledger. Interrupted reporting uses an exact producing-boundary reference saved with the player result. Older progress without that reference contributes no inferred report, and recovery never reruns a worker merely to recreate its prose.

## Live tool approvals

`openSessionHost` and `createCaptainSessionHost` accept an ephemeral
`approvalHandler(envelope, { signal })` callback. Its exported
`TmuxPlayApprovalRequest` envelope contains the original native `request`, the
persisted `turnId`, the concrete `actorId`, and a fresh `invocationId` for that
working call. Return `allow_once` or `deny`; an application should bind its own
session or draft identity in the callback closure and stop showing a request
when its signal aborts. Hidden control and tool-free calls receive no callback.

The callback is never configuration or model input. Native request/response
events remain historical actor records, and reopening does not make an old
request actionable. Native provider limits and OS dialogs still apply; a tool
approval cannot grant an operating-system permission. Controller disposal denies
pending requests before draining work and releasing the session lease. Without a
handler, adapters retain their native fail-closed behavior.

This callback handles tool consent independently of tool or application names.
Native questions, forms, and URL authentication require separate typed response
transports; a later Boss reply cannot answer a native callback still waiting
inside the current call. A workflow can instead return its declared Boss-question
outcome and resume after a reply, including a request to perform an external
prerequisite. The reply is an acknowledgement; the working agent must check the
prerequisite before claiming that it is satisfied.
