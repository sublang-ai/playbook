<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Embedding the runtime in your own host

The playbook runtime is host-agnostic; cligent's `tmux-play` adapter is
one host, and [spex](https://github.com/sublang-ai/spex) (the desktop
app) is another. This guide shows how to wire a playbook runtime into
your own host.

> **Release note:** this guide tracks the `main` branch's composed
> six-port contract. The latest published release, 0.9.0, still ships
> the earlier four-port contract without `callCaptain` /
> `callPlaybook`; see the [CHANGELOG](../CHANGELOG.md).

## The runtime contract

The port and runtime contracts live in the type-only module
[`@sublang/playbook/runtime`](../src/runtime.ts) — a public,
semver-stable surface (`PlayerResult`, `PlaybookPorts`,
`PlaybookRuntime`, `PlaybookSession`, `PlayerCallOptions`,
`CaptainCallOptions`, `CaptainResult`, `PlaybookTraceEvent`, and
`PlaybookRuntimeFactory`) that imports no CODE or FSM types, so a host
satisfies it once and inherits every playbook. The CODE runtime
re-exports `PlayerResult`, `PlaybookPorts`, `PlaybookSession`, and
`PlaybookRuntime` from `@sublang/playbook/code/playbook`;
`PlaybookRuntimeFactory` is available from `@sublang/playbook/runtime`.

Generated linked runtimes reuse the XState integration engine exposed
as `@sublang/playbook/xstate-runtime`, including strict JSON
validation, normalized snapshots, quiescence waiting, and the
nested-playbook bridge.

## Constructing a runtime against your own ports

```ts
import createPlaybookRuntime from '@sublang/playbook/code/playbook';
import type { PlaybookPorts } from '@sublang/playbook/runtime';
import { randomUUID } from 'node:crypto';

const ports: PlaybookPorts = {
  callPlayer: async (playerId, prompt, signal, { resume }) => {
    // `resume === false` starts fresh; a string selects that player's
    // prior backend conversation. Return the adapter's next token.
    return { status: 'ok', finalText: 'done', resumeToken: 'next-token' };
  },
  callCaptain: async (prompt, signal, { visibility }) => {
    // visibility is 'visible' or 'hidden' — hidden calls (judge-style
    // control work) must produce no Boss-facing output.
    return { status: 'ok', finalText: 'done' };
  },
  callJudge: async (prompt, signal) => '{}',
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

const runtime = createPlaybookRuntime({
  coderPlayer: 'claude',
  reviewerPlayer: 'codex',
});

const playbookSessionId = randomUUID();
await runtime.init({
  sessionId: playbookSessionId,
  playbookId: 'code',
  rootSessionId: playbookSessionId,
  depth: 0,
  ports,
});
await runtime.handleBossInput({
  text: 'Start fixing the bug',
  signal: new AbortController().signal,
});
await runtime.dispose();
```

## Sessions and traces

Every init-to-dispose lifecycle is one playbook session. Its
`playbook.trace` telemetry carries that immutable ID plus a contiguous
sequence across exact Boss input, judge/player calls, FSM transitions,
visible Captain work, nested playbook calls, status, settlement, and
disposal. Each resolved player starts fresh in a new playbook session
and then resumes only from the latest opaque `resumeToken` its adapter
returned; trace data and tokens never enter Boss-visible status text.
Because trace observers do receive opaque resume tokens, persisted
traces should be protected as sensitive data.

See
[`code.playbook.test.ts`](../reference/sdlc/code.playbook/code.playbook.test.ts)
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

The three specs are [`slc/text2gears.md`](../slc/text2gears.md),
[`slc/gears2fsm.md`](../slc/gears2fsm.md), and
[`slc/link.md`](../slc/link.md) — the FSM-to-runtime contract that
`@sublang/playbook/runtime` projects into TypeScript.
