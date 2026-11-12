// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// A host process that runs one script step through the shared factory and
// exits when the run ends, as a one-shot `playbook run` does. It prints its
// own process id and the step's `playbook.script` payloads as JSON. argv:
// the command.

import { createMachine } from 'xstate';
import {
  createXStatePlaybookRuntime,
  emptyPlaybookEffectLedger,
  RUNTIME_ABI,
} from '../xstate-runtime.js';

const [command] = process.argv.slice(2);
const meta = (stateId, extra = {}) => ({
  playbook: { stateId, description: stateId, ...extra },
});
const machine = createMachine({
  id: 'gate',
  initial: 'ready',
  context: {},
  states: {
    ready: {
      meta: meta('ready'),
      tags: ['playbook.parked'],
      on: { START: 'check' },
    },
    check: {
      meta: meta('check'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'script',
        input: {
          stateId: 'check',
          sourceItem: 'GATE-1',
          command,
          result: { passed: 'Exit zero.', failed: 'Exit nonzero.' },
        },
        onDone: 'done',
        onError: 'done',
      },
    },
    done: { meta: meta('done', { terminal: 'success' }), type: 'final' },
  },
});

const identity = { worktree: '/fixture', gitDir: '/fixture/.git' };
const ledger = emptyPlaybookEffectLedger();
const unavailable = async () => {
  throw new Error('repository work is outside this fixture');
};
const unused = async () => {
  throw new Error('this fixture makes no agent call');
};
const payloads = [];
const sessionId = '43000000-0000-4000-8000-000000000001';
const runtime = createXStatePlaybookRuntime(machine, {
  label: 'GATE',
  compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
  roleStates: {},
  outcomeAuthority: { governedPlayerStates: {} },
})({
  configuredOptions: {},
  hostCapabilities: {
    authority: {
      playbookId: 'gate',
      artifactSchema: 3,
      cwd: identity.worktree,
      sessionId,
      leaseOwnerToken: '43000000-0000-4000-8000-000000000002',
      canonicalWorktree: identity,
      requiredRoleIds: [],
      concurrentRoleSets: [],
    },
    repository: {
      identity,
      observe: unavailable,
      acquire: unavailable,
      runExclusive: unavailable,
      runCohort: unavailable,
      runDeferred: unavailable,
    },
    effectLedger: { snapshot: () => ledger, writeAhead: async () => ledger },
  },
});
await runtime.init({
  sessionId,
  rootSessionId: sessionId,
  playbookId: 'gate',
  depth: 0,
  ports: {
    callPlayer: unused,
    callCaptain: unused,
    callJudge: unused,
    callPlaybook: unused,
    emitStatus: async () => {},
    emitTelemetry: async (event) => {
      if (event.topic === 'playbook.script') payloads.push(event.payload);
    },
  },
});
await runtime.handleBossInput({
  text: 'run the gate',
  signal: new AbortController().signal,
});
await runtime.dispose();
process.stdout.write(JSON.stringify({ pid: process.pid, payloads }));
