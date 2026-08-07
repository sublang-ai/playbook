// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The two fixture playbook modules the live release gate writes into the
// conversational scenario's repository. They live here, beside the config
// that enables them (`live-config.ts`), for the same reason: the gate is
// excluded from `pnpm test` and CI, so an ordinary test in the normal suite
// can write these sources out, import them, and prove they still link and
// still expose the registry entries that config names.

// A three-step checklist whose middle step is a DR-016 script actor reading
// a flag file. With the flag absent the exit-status guard routes to
// `failed`; with it present the same replayed entry event runs the machine
// to terminal. No agent decides any of that — which is the point: the only
// live judgment in the scenario is the Captain's.
export function checklistFixtureSource(flagPath: string): string {
  return `// Conversational acceptance fixture: a deterministic script checklist.
import { assign, setup } from 'xstate';
import { createXStatePlaybookRuntime } from '@sublang/playbook/xstate-runtime';

const flagPath = ${JSON.stringify(flagPath)};

const scriptStep = (stateId, sourceItem, description, command, guards, next) => ({
  id: stateId,
  description,
  meta: { playbook: { stateId, description } },
  tags: ['playbook.busy'],
  invoke: {
    src: 'script',
    input: () => ({
      stateId,
      sourceItem,
      command,
      result: {
        [guards.ok]: 'The step command exited zero.',
        [guards.failed]: 'The step command exited nonzero.',
      },
    }),
    onDone: [
      {
        guard: ({ event }) => event.output.guard === guards.ok,
        target: next,
      },
      {
        target: 'failed',
        actions: assign({
          lastError: () => new Error(guards.message),
        }),
      },
    ],
    onError: {
      target: 'failed',
      actions: assign({ lastError: ({ event }) => event.error }),
    },
  },
});

const machine = setup({}).createMachine({
  id: 'checklist',
  initial: 'ready',
  context: { task: undefined, lastError: undefined },
  states: {
    ready: {
      id: 'ready',
      description: 'Waits for the Boss checklist task.',
      meta: {
        playbook: {
          stateId: 'ready',
          description: 'Waits for the Boss checklist task.',
        },
      },
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'prepare',
          actions: assign({
            task: ({ event }) => event.task,
            lastError: () => undefined,
          }),
        },
      },
    },
    prepare: scriptStep(
      'prepare',
      'CHECK-1',
      'Prepare step: stage the checklist run.',
      'exit 0',
      {
        ok: 'prepared',
        failed: 'prepareFailed',
        message: 'The prepare step failed.',
      },
      'verify',
    ),
    verify: scriptStep(
      'verify',
      'CHECK-2',
      'Verify step: confirm the checklist flag file is present.',
      \`test -f '\${flagPath}'\`,
      {
        ok: 'verified',
        failed: 'verifyFailed',
        message:
          'The verify step failed: the checklist flag file is missing, so the checklist cannot continue.',
      },
      'publish',
    ),
    publish: scriptStep(
      'publish',
      'CHECK-3',
      'Publish step: close the checklist run.',
      'exit 0',
      {
        ok: 'published',
        failed: 'publishFailed',
        message: 'The publish step failed.',
      },
      'done',
    ),
    failed: {
      id: 'failed',
      description: 'Recoverable checklist failure awaiting Boss recovery.',
      meta: {
        playbook: {
          stateId: 'failed',
          description: 'Recoverable checklist failure awaiting Boss recovery.',
        },
      },
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'prepare',
          actions: assign({
            task: ({ event }) => event.task,
            lastError: () => undefined,
          }),
        },
      },
    },
    done: {
      id: 'done',
      description: 'The checklist run finished.',
      meta: {
        playbook: {
          stateId: 'done',
          description: 'The checklist run finished.',
        },
      },
      type: 'final',
    },
  },
  output: () => ({ checklist: 'complete' }),
});

const createRuntime = createXStatePlaybookRuntime(machine, {
  label: 'CHECKLIST',
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
  // The same failure grammar the bundled playbooks use, so the gate can
  // count the two engineered failures apart from any real one.
  statusesForState: (state) =>
    state.stateId === undefined || state.stateId === 'ready'
      ? []
      : state.stateId === 'failed'
        ? [{ message: '◆ failed' }]
        : [{ message: \`⤷ \${state.stateId}\` }],
});

export default {
  id: 'checklist',
  command: 'checklist',
  intent: 'run the fixture release checklist end to end',
  requiredRoleIds: [],
  validateOptions(value) {
    return value ?? {};
  },
  createRuntime() {
    return createRuntime({});
  },
};
`;
}

// The switch target: one deterministic step, then a parked state that keeps
// the engagement genuinely active so the dismissal turn has something to
// dismiss.
export function notesFixtureSource(): string {
  return `// Conversational acceptance fixture: the release-notes switch target.
import { assign, setup } from 'xstate';
import { createXStatePlaybookRuntime } from '@sublang/playbook/xstate-runtime';

const machine = setup({}).createMachine({
  id: 'notes',
  initial: 'ready',
  context: { topic: undefined },
  states: {
    ready: {
      id: 'ready',
      description: 'Waits for the Boss release-notes topic.',
      meta: {
        playbook: {
          stateId: 'ready',
          description: 'Waits for the Boss release-notes topic.',
        },
      },
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'draft',
          actions: assign({ topic: ({ event }) => event.topic }),
        },
      },
    },
    draft: {
      id: 'draft',
      description: 'Draft step: open the release-notes outline.',
      meta: {
        playbook: {
          stateId: 'draft',
          description: 'Draft step: open the release-notes outline.',
        },
      },
      tags: ['playbook.busy'],
      invoke: {
        src: 'script',
        input: () => ({
          stateId: 'draft',
          sourceItem: 'NOTES-1',
          command: 'exit 0',
          result: {
            drafted: 'The step command exited zero.',
            draftFailed: 'The step command exited nonzero.',
          },
        }),
        onDone: [
          {
            guard: ({ event }) => event.output.guard === 'drafted',
            target: 'outline',
          },
          { target: 'failed' },
        ],
        onError: {
          target: 'failed',
          actions: assign({ lastError: ({ event }) => event.error }),
        },
      },
    },
    outline: {
      id: 'outline',
      description: 'The outline is open; awaiting the next Boss turn.',
      meta: {
        playbook: {
          stateId: 'outline',
          description: 'The outline is open; awaiting the next Boss turn.',
        },
      },
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'draft',
          actions: assign({ topic: ({ event }) => event.topic }),
        },
      },
    },
    failed: {
      id: 'failed',
      description: 'Recoverable release-notes failure awaiting Boss recovery.',
      meta: {
        playbook: {
          stateId: 'failed',
          description:
            'Recoverable release-notes failure awaiting Boss recovery.',
        },
      },
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'draft',
          actions: assign({ topic: ({ event }) => event.topic }),
        },
      },
    },
  },
});

const createRuntime = createXStatePlaybookRuntime(machine, {
  label: 'NOTES',
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'topic' },
  statusesForState: (state) =>
    state.stateId === undefined || state.stateId === 'ready'
      ? []
      : state.stateId === 'failed'
        ? [{ message: '◆ failed' }]
        : [{ message: \`⤷ \${state.stateId}\` }],
});

export default {
  id: 'notes',
  command: 'notes',
  intent: 'draft and discuss the release notes for this repository',
  requiredRoleIds: [],
  validateOptions(value) {
    return value ?? {};
  },
  createRuntime() {
    return createRuntime({});
  },
};
`;
}
