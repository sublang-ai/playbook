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
// machine input, or a persisted snapshot.
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

Runtime and complete shell snapshots are schema 4. Their role-resume
projection remains role-local, while the composing shell persists the stable
player ledger, every frame's exact role bindings, and the host's authoritative
effect-ledger mirror. The bundled CLI wraps that shell state in Captain
session-record schema 5. Do not restore an earlier snapshot or session record
by guessing identity or effect evidence. This includes the transitional
schema-5 record shape that predates required `unresolvedEffects`; explicit
selection rejects it, while fresh discovery may only report and skip it. On a
compatible restore, rebuild
`promptIdentity` from the current model selection (or adapter for an explicit
provider-default selection) and rebuild live host capabilities under the
current lease, so neither invocation identity nor repository authority comes
from stale machine state. Trace data, tokens, repository projections, and
capability functions never enter Boss-visible status text or configured
options. Because trace observers do receive opaque resume tokens, persisted
traces should be protected as sensitive data.

See
[`code.playbook.test.ts`](https://github.com/sublang-ai/playbook/blob/main/reference/sdlc/code.playbook/code.playbook.test.ts)
for the full range of port shapes (classifier, judge, abort, interrupt,
status/telemetry) the runtime is contract-tested against.

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
