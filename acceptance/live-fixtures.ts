// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The fixture playbook modules the live release gate writes for its hermetic
// and conversational scenarios. They live here, beside the configs that
// enable them (`live-config.ts`), for the same reason: the gate is excluded
// from `pnpm test` and CI, so an ordinary test in the normal suite can write
// these sources out, import them, and prove they still link and expose the
// registry entries that their configs name.

// RELEASE-25 fourth case: a compiled-style thin artifact whose bare
// `xstate` and `@sublang/playbook/xstate-runtime` imports resolve only
// through provisioning. One player state, deterministic START entry (no
// classifier call), one hidden judge adjudication, and a mechanically checked
// terminal meaning that the shared Captain grounds its visible reply in.
export function hermeticArtifactSource(): string {
  return `// Hermetic acceptance fixture: a compiled-style thin artifact.
import { readFileSync } from 'node:fs';
import { assign, fromPromise, setup } from 'xstate';
import {
  createXStatePlaybookRuntime,
} from '@sublang/playbook/xstate-runtime';

const machine = setup({
  actors: {
    player: fromPromise(async () => {
      throw new Error('player actor must be provided by the runner');
    }),
  },
  guards: {
    returnedExactFixtureToken: ({ event }) =>
      typeof event.output?.token === 'string' &&
      event.output.token ===
        readFileSync('acceptance-hermetic-token.txt', 'utf8').trim(),
  },
}).createMachine({
  id: 'hermetic',
  initial: 'ready',
  context: {},
  states: {
    ready: {
      id: 'ready',
      description: 'Waits for the Boss task.',
      meta: {
        playbook: { stateId: 'ready', description: 'Waits for the Boss task.' },
      },
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'work',
          actions: assign({ task: ({ event }) => event.task }),
        },
      },
    },
    work: {
      id: 'work',
      description: 'HERMETIC-1: Worker echoes the fixture token.',
      meta: {
        playbook: {
          stateId: 'work',
          description: 'HERMETIC-1: Worker echoes the fixture token.',
          role: 'worker',
        },
      },
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: 'work',
          role: 'worker',
          sourceItem: 'HERMETIC-1',
          prompt: [
            'Read acceptance-hermetic-token.txt in the working directory and',
            'reply with exactly its trimmed content. Do not modify any file.',
            \`Task context: \${context.task}\`,
          ].join('\\n'),
          result: {
            done: 'Worker replied with the token. Output shall include \`token: <the exact token text>\`.',
          },
        }),
        onDone: [
          {
            guard: 'returnedExactFixtureToken',
            target: 'done',
            actions: assign({ token: ({ event }) => event.output.token }),
          },
          {
            target: 'failed',
            actions: assign({
              lastError: () =>
                'Worker reply did not match the exact fixture token.',
            }),
          },
        ],
        onError: {
          target: 'failed',
          actions: assign({
            lastError: ({ event }) => String(event.error),
          }),
        },
      },
    },
    failed: {
      id: 'failed',
      description: 'Recoverable failure awaiting a fresh Boss task.',
      meta: {
        playbook: {
          stateId: 'failed',
          description: 'Recoverable failure awaiting a fresh Boss task.',
        },
      },
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'work',
          actions: assign({ task: ({ event }) => event.task }),
        },
      },
    },
    done: {
      id: 'done',
      description:
        'The worker returned the exact fixture token and the request completed.',
      meta: {
        playbook: {
          stateId: 'done',
          description:
            'The worker returned the exact fixture token and the request completed.',
        },
      },
      type: 'final',
    },
  },
  output: ({ context }) => ({ token: context.token ?? '' }),
});

const createRuntime = createXStatePlaybookRuntime(machine, {
  label: 'HERMETIC',
  // Link-time literal per slc/link.md, so the fixture models linker output.
  compat: { artifactSchema: 2, runtimeAbi: 1 },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
  roleStates: {
    work: {
      role: 'worker',
      label: 'HERMETIC-1: Worker echoes the fixture token.',
    },
  },
});

export default {
  id: 'hermetic',
  command: 'hermetic',
  intent: 'hermetic global-only acceptance fixture',
  artifactSchema: 2,
  runtimeProfile: { kind: 'shared-factory', compat: createRuntime.compat },
  requiredRoleIds: ['worker'],
  concurrentRoleSets: [],
  validateOptions(value) {
    return value ?? {};
  },
  createRuntime() {
    return createRuntime({});
  },
};
`;
}

// A three-step checklist whose middle step is a DR-016 script actor reading
// a flag file. With the flag absent the exit-status guard routes to
// `failed`; with it present the same replayed entry event runs the machine
// to terminal. No agent decides any of that — which is the point: the only
// live judgment in the scenario is the Captain's.
export function checklistFixtureSource(flagPath: string): string {
  return `// Conversational acceptance fixture: a deterministic script checklist.
import { assign, setup } from 'xstate';
import {
  createXStatePlaybookRuntime,
} from '@sublang/playbook/xstate-runtime';

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
  // Link-time literal per slc/link.md, so the fixture models linker output.
  compat: { artifactSchema: 2, runtimeAbi: 1 },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
  roleStates: {},
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
  artifactSchema: 2,
  runtimeProfile: { kind: 'shared-factory', compat: createRuntime.compat },
  requiredRoleIds: [],
  concurrentRoleSets: [],
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
import {
  createXStatePlaybookRuntime,
} from '@sublang/playbook/xstate-runtime';

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
  // Link-time literal per slc/link.md, so the fixture models linker output.
  compat: { artifactSchema: 2, runtimeAbi: 1 },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'topic' },
  roleStates: {},
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
  artifactSchema: 2,
  runtimeProfile: { kind: 'shared-factory', compat: createRuntime.compat },
  requiredRoleIds: [],
  concurrentRoleSets: [],
  validateOptions(value) {
    return value ?? {};
  },
  createRuntime() {
    return createRuntime({});
  },
};
`;
}
