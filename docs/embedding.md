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
The generated CODE, REVIEW, and DECIDE modules re-export their shared
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
  type ReviewPlaybookHostCapabilities,
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
    promptIdentity: 'claude-opus-4-8[1m]',
  },
  reviewer: {
    playerId: 'team.reviewer',
    promptIdentity: 'gpt-5.5',
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
declare const hostCapabilities: ReviewPlaybookHostCapabilities;

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
exactly `repository: { identity, observe, runExclusive, runDeferred }` and
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

For an uncertain session, reopen with `mode:'retry'` and call `retry()`. It uses
the exact recorded input and attempted configuration. Module-free
`discardSessionUncertain(shared, sessionId)` restores the prior recovery only
when no effect-ledger advancement prevents discard.

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

The authored compiler-phase specs ship in the package and are exposed
as a public, semver-stable surface under `@sublang/playbook/slc/*`.
Resolve and read one with `import.meta.resolve` plus `fs`:

```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const url = import.meta.resolve('@sublang/playbook/slc/link.md');
const link = await readFile(fileURLToPath(url), 'utf8');
```

The four specs are [`slc/text2gears.md`](../slc/text2gears.md),
[`slc/gears2fsm.md`](../slc/gears2fsm.md),
[`slc/link.md`](../slc/link.md) — the FSM-to-runtime contract that
`@sublang/playbook/runtime` projects into TypeScript — and
[`slc/optimize.md`](../slc/optimize.md).
