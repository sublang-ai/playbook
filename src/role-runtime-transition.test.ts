// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { assign, createMachine } from 'xstate';
import { describe, expect, it, vi } from 'vitest';

import type {
  PlaybookPorts,
  PlaybookRoleBinding,
  PlaybookSession,
  PlayerResult,
  PlayerSessionStore,
} from './runtime.js';
import {
  adjudicatePlayerOutput,
  createXStatePlaybookRuntime,
  RUNTIME_ABI,
  SUPPORTED_ARTIFACT_SCHEMAS,
  type XStateOutcomeAuthoritySpec,
  type XStatePlaybookRuntimeSpec,
  type XStatePlaybookRuntimeSpecV3,
} from './xstate-runtime.js';

const stateMeta = (stateId: string, description: string) => ({
  playbook: { stateId, description },
});

const roleMeta = (stateId: string, role: string, description: string) => ({
  playbook: { stateId, role, description },
});

const repeatMachine = createMachine({
  id: 'role-repeat',
  context: { task: '' },
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for a task.'),
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'work',
          actions: assign({
            task: ({ event }) => (event as { task: string }).task,
          }),
        },
      },
    },
    work: {
      meta: roleMeta('work', 'coder', 'Implement the task.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: 'work',
          role: 'coder',
          sourceItem: 'ROLE-1',
          prompt: `Implement ${context.task}.`,
          result: { complete: 'The task is complete.' },
        }),
        onDone: 'ready',
        onError: 'ready',
      },
    },
  },
});

interface EmptyOptions {}

function repeatSpec(
  overrides: Partial<XStatePlaybookRuntimeSpec<EmptyOptions>> = {},
): XStatePlaybookRuntimeSpec<EmptyOptions> {
  return {
    label: 'ROLE-REPEAT',
    compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
    snapshotOptions: () => ({}),
    entryEvent: { type: 'START', textField: 'task' },
    roleStates: { work: { role: 'coder', label: 'Implement the task.' } },
    ...overrides,
  };
}

const repeatOutcomeAuthority: XStateOutcomeAuthoritySpec = {
  governedPlayerStates: {
    work: {
      complete: { fields: {}, repositoryDisposition: 'unchanged' },
    },
  },
};

function repeatSchema3Spec(
  overrides: Partial<XStatePlaybookRuntimeSpecV3<EmptyOptions>> = {},
): XStatePlaybookRuntimeSpecV3<EmptyOptions> {
  return {
    ...repeatSpec(),
    compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
    outcomeAuthority: repeatOutcomeAuthority,
    ...overrides,
  };
}

function recordingPorts(
  callPlayer: PlaybookPorts['callPlayer'],
  telemetry: unknown[] = [],
): PlaybookPorts {
  return {
    callPlayer,
    callCaptain: async () => {
      throw new Error('callCaptain not used');
    },
    callJudge: async () => '{"guard":"complete"}',
    callPlaybook: async () => {
      throw new Error('callPlaybook not used');
    },
    emitStatus: async () => undefined,
    emitTelemetry: async (event) => {
      telemetry.push(event);
    },
  };
}

let sessionSequence = 0;

function session(
  ports: PlaybookPorts,
  options: {
    roleBindings?: Readonly<Record<string, PlaybookRoleBinding>>;
    playerSessions?: PlayerSessionStore;
  } = {},
): PlaybookSession {
  const sessionId = `role-session-${++sessionSequence}`;
  return {
    sessionId,
    playbookId: 'role-fixture',
    rootSessionId: sessionId,
    depth: 0,
    ...options,
    ports,
  };
}

const bossTurn = (text: string) => ({
  text,
  signal: new AbortController().signal,
});

describe('DR-032 shared role runtime transition', () => {
  it('advertises artifact schemas 2 and 3 and rejects legacy declarations', () => {
    expect(SUPPORTED_ARTIFACT_SCHEMAS).toEqual([2, 3]);
    expect(Object.isFrozen(SUPPORTED_ARTIFACT_SCHEMAS)).toBe(true);

    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        compat: undefined,
      }),
    ).toThrow('spec.compat is required');
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        compat: { artifactSchema: 1, runtimeAbi: RUNTIME_ABI },
      }),
    ).toThrow('supports [2, 3]');
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        roleStates: undefined,
      }),
    ).toThrow('roleStates must be supplied for schema 2');

    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        playerStates: {
          work: { player: 'Coder', label: 'Implement the task.' },
        },
      } as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>),
    ).toThrow('must supply roleStates, not playerStates');
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        resolvePlayerId: () => 'coder',
      } as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>),
    ).toThrow('must not derive concrete player bindings');

    const accessorSpec = repeatSpec() as Record<string, unknown>;
    const legacyGetter = vi.fn(() => ({}));
    Object.defineProperty(accessorSpec, 'playerStates', {
      enumerable: true,
      get: legacyGetter,
    });
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        accessorSpec as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>,
      ),
    ).toThrow('must supply roleStates, not playerStates');
    expect(legacyGetter).not.toHaveBeenCalled();

    const roleStatesGetter = vi.fn(() => ({
      work: { role: 'coder', label: 'Implement the task.' },
    }));
    const accessorRoleStates = repeatSpec() as Record<string, unknown>;
    Object.defineProperty(accessorRoleStates, 'roleStates', {
      enumerable: true,
      get: roleStatesGetter,
    });
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        accessorRoleStates as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>,
      ),
    ).toThrow('roleStates must be an own data property');
    expect(roleStatesGetter).not.toHaveBeenCalled();

    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        roleStates: {
          work: {
            role: 'coder',
            label: 'Implement the task.',
            playerId: 'dev.coder',
          },
        },
      } as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>),
    ).toThrow('roleStates.work.playerId is not allowed');

    const roleGetter = vi.fn(() => 'coder');
    const accessorEntry = { label: 'Implement the task.' } as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessorEntry, 'role', {
      enumerable: true,
      get: roleGetter,
    });
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        roleStates: { work: accessorEntry },
      } as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>),
    ).toThrow('roleStates.work.role must be a JSON data property');
    expect(roleGetter).not.toHaveBeenCalled();
  });

  it('validates the closed schema-3 authority contract at construction', () => {
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, repeatSchema3Spec()),
    ).not.toThrow();
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        outcomeAuthority: repeatOutcomeAuthority,
      }),
    ).toThrow('outcomeAuthority is not allowed for schema 2');
    expect(() =>
      createXStatePlaybookRuntime(repeatMachine, {
        ...repeatSpec(),
        compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
      }),
    ).toThrow(
      'outcomeAuthority must be an own enumerable data property for schema 3',
    );

    const cases: readonly [
      authority: unknown,
      diagnostic: string,
    ][] = [
      [
        { governedPlayerStates: {}, extra: true },
        'must contain exactly governedPlayerStates',
      ],
      [
        { governedPlayerStates: {} },
        'must declare player state work',
      ],
      [
        {
          governedPlayerStates: {
            work: {},
          },
        },
        'work must declare at least one outcome',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: {},
                repositoryDisposition: 'unchanged',
                extra: true,
              },
            },
          },
        },
        'must contain exactly fields, repositoryDisposition',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: { fields: {} },
            },
          },
        },
        'missing repositoryDisposition',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: {},
                repositoryDisposition: 'changed',
              },
            },
          },
        },
        'repositoryDisposition must be unchanged, one-descendant-commit, or deferred',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: { message: 'operator' },
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
        'must name presentation, semantic, effect, or runtime authority',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: { guard: 'semantic' },
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
        'outcome key owns the semantic discriminator',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              committed: {
                fields: { latestCommit: 'semantic' },
                repositoryDisposition: 'one-descendant-commit',
              },
            },
          },
        },
        'latestCommit must use effect authority',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: { irNumber: 'runtime' },
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
        'irNumber must use semantic authority',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              needsBossReply: {
                fields: { question: 'semantic' },
                repositoryDisposition: 'deferred',
              },
            },
          },
        },
        'question must use presentation authority',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: { latestCommit: 'effect' },
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
        'effect-owned fields only for one-descendant-commit',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              paused: {
                fields: { question: 'presentation' },
                repositoryDisposition: 'deferred',
              },
            },
          },
        },
        'may use deferred only for needsBossReply',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              committed: {
                fields: {},
                repositoryDisposition: 'one-descendant-commit',
              },
              needsBossReply: {
                fields: {},
                repositoryDisposition: 'deferred',
              },
            },
          },
        },
        'must declare presentation-owned question',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              needsBossReply: {
                fields: { question: 'presentation' },
                repositoryDisposition: 'deferred',
              },
            },
          },
        },
        'requires another one-descendant-commit outcome',
      ],
      [
        {
          governedPlayerStates: {
            work: {
              complete: {
                fields: {},
                repositoryDisposition: 'unchanged',
              },
            },
            other: {
              complete: {
                fields: {},
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
        'other does not name a player state',
      ],
    ];
    for (const [outcomeAuthority, diagnostic] of cases) {
      expect(() =>
        createXStatePlaybookRuntime(
          repeatMachine,
          repeatSchema3Spec({
            outcomeAuthority:
              outcomeAuthority as XStateOutcomeAuthoritySpec,
          }),
        ),
      ).toThrow(diagnostic);
    }

    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        repeatSchema3Spec({
          outcomeAuthority: {
            governedPlayerStates: {
              work: {
                committed: {
                  fields: { latestCommit: 'effect' },
                  repositoryDisposition: 'one-descendant-commit',
                },
                needsBossReply: {
                  fields: { question: 'presentation' },
                  repositoryDisposition: 'deferred',
                },
              },
            },
          },
        }),
      ),
    ).not.toThrow();

    const authorityGetter = vi.fn(() => repeatOutcomeAuthority);
    const accessorSpec = repeatSchema3Spec() as Record<string, unknown>;
    Object.defineProperty(accessorSpec, 'outcomeAuthority', {
      enumerable: true,
      get: authorityGetter,
    });
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        accessorSpec as unknown as XStatePlaybookRuntimeSpec<EmptyOptions>,
      ),
    ).toThrow(
      'outcomeAuthority must be an own enumerable data property for schema 3',
    );
    expect(authorityGetter).not.toHaveBeenCalled();

    const nonEnumerableSpec = repeatSchema3Spec() as Record<string, unknown>;
    Object.defineProperty(nonEnumerableSpec, 'outcomeAuthority', {
      value: repeatOutcomeAuthority,
      enumerable: false,
    });
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        nonEnumerableSpec as unknown as XStatePlaybookRuntimeSpecV3<EmptyOptions>,
      ),
    ).toThrow(
      'outcomeAuthority must be an own enumerable data property for schema 3',
    );

    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        repeatSchema3Spec({
          verbatimPayloadFields: new Set(['message']),
          outcomeAuthority: {
            governedPlayerStates: {
              work: {
                complete: {
                  fields: { message: 'semantic' },
                  repositoryDisposition: 'unchanged',
                },
              },
            },
          },
        }),
      ),
    ).toThrow('message must use presentation authority');
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        repeatSchema3Spec({
          outcomeAuthority: {
            governedPlayerStates: {
              work: {
                complete: {
                  fields: { message: 'presentation' },
                  repositoryDisposition: 'unchanged',
                },
              },
            },
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        repeatSchema3Spec({
          outcomeAuthority: {
            governedPlayerStates: {
              work: {
                complete: {
                  fields: {
                    moreTasks: 'runtime',
                    finalTask: 'runtime',
                  },
                  repositoryDisposition: 'unchanged',
                },
              },
            },
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      createXStatePlaybookRuntime(
        repeatMachine,
        repeatSchema3Spec({
          verbatimPayloadFields: new Set(['unused']),
        }),
      ),
    ).toThrow('unused is absent from governed payload fields');

    const rolelessMachine = createMachine({
      id: 'schema-3-roleless',
      initial: 'ready',
      states: {
        ready: {
          meta: stateMeta('ready', 'Waiting.'),
          tags: ['playbook.parked'],
        },
      },
    });
    expect(() =>
      createXStatePlaybookRuntime(rolelessMachine, {
        label: 'ROLELESS-3',
        compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
        snapshotOptions: () => ({}),
        roleStates: {},
        outcomeAuthority: { governedPlayerStates: {} },
      }),
    ).not.toThrow();
  });

  it('keeps schema-3 configured options disjoint from live capabilities', async () => {
    interface ConfiguredOptions {
      readonly marker: string;
    }
    interface CapabilityMachineInput {
      readonly configuredOptions: ConfiguredOptions;
    }
    const configuredOptions = { marker: 'configured-marker' };
    const hostCapabilities = {
      marker: 'capability-marker',
      observe: () => 'observed',
    };
    const snapshotOptions = vi.fn((value: unknown): ConfiguredOptions => {
      const options = value as ConfiguredOptions;
      return { marker: options.marker };
    });
    const machineInput = vi.fn(
      (options: ConfiguredOptions): CapabilityMachineInput => ({
        configuredOptions: options,
      }),
    );
    const capabilityMachine = createMachine({
      id: 'schema-3-capability-exclusion',
      context: ({
        input,
      }: {
        input: CapabilityMachineInput | undefined;
      }) => ({ configuredOptions: input?.configuredOptions }),
      initial: 'ready',
      states: {
        ready: {
          meta: stateMeta('ready', 'Waiting.'),
          tags: ['playbook.parked'],
        },
      },
    });
    const createRuntime = createXStatePlaybookRuntime<
      ConfiguredOptions,
      typeof hostCapabilities
    >(capabilityMachine, {
      label: 'CAPABILITY-EXCLUSION',
      compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
      snapshotOptions,
      machineInput,
      roleStates: {},
      outcomeAuthority: { governedPlayerStates: {} },
    });

    const mutableSchema3Spec = repeatSchema3Spec();
    const schema3Factory = createXStatePlaybookRuntime<
      EmptyOptions,
      typeof hostCapabilities
    >(repeatMachine, mutableSchema3Spec);
    const schema3Compat = schema3Factory.compat;
    expect(schema3Compat).toEqual({
      artifactSchema: 3,
      runtimeAbi: RUNTIME_ABI,
    });
    expect(Object.isFrozen(schema3Compat)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(schema3Factory, 'compat'),
    ).toMatchObject({
      enumerable: true,
      writable: false,
      configurable: false,
    });
    (mutableSchema3Spec.compat as { artifactSchema: number }).artifactSchema = 2;
    expect(schema3Factory.compat).toBe(schema3Compat);
    expect(() =>
      schema3Factory({} as {
        configuredOptions: EmptyOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('schema-3 factory input must contain exactly');

    const mutableSchema2Spec = repeatSpec();
    const schema2Factory = createXStatePlaybookRuntime(
      repeatMachine,
      mutableSchema2Spec,
    );
    const schema2Compat = schema2Factory.compat;
    expect(schema2Compat).toEqual({
      artifactSchema: 2,
      runtimeAbi: RUNTIME_ABI,
    });
    expect(Object.isFrozen(schema2Compat)).toBe(true);
    (mutableSchema2Spec.compat as { artifactSchema: number }).artifactSchema = 3;
    expect(schema2Factory.compat).toBe(schema2Compat);
    expect(() => schema2Factory({})).not.toThrow();

    expect(() =>
      createRuntime({} as {
        configuredOptions: ConfiguredOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('schema-3 factory input must contain exactly');
    const nonPlainInput = Object.assign(Object.create({ inherited: true }), {
      configuredOptions,
      hostCapabilities,
    });
    expect(() =>
      createRuntime(nonPlainInput as {
        configuredOptions: ConfiguredOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('schema-3 factory input must be a plain object');
    expect(() =>
      createRuntime({
        configuredOptions,
        hostCapabilities: 1,
      } as unknown as {
        configuredOptions: ConfiguredOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('hostCapabilities must be a live object');
    expect(() =>
      createRuntime({
        configuredOptions,
        hostCapabilities,
        extra: true,
      } as unknown as {
        configuredOptions: ConfiguredOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('schema-3 factory input must contain exactly');

    const capabilityGetter = vi.fn(() => hostCapabilities);
    const accessorInput = { configuredOptions } as Record<string, unknown>;
    Object.defineProperty(accessorInput, 'hostCapabilities', {
      enumerable: true,
      get: capabilityGetter,
    });
    expect(() =>
      createRuntime(accessorInput as {
        configuredOptions: ConfiguredOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('schema-3 factory input must contain exactly');
    expect(capabilityGetter).not.toHaveBeenCalled();
    expect(snapshotOptions).not.toHaveBeenCalled();
    expect(() =>
      createRuntime({
        configuredOptions: {
          marker: 'configured-marker',
          hostCapabilities: {},
        },
        hostCapabilities,
      } as unknown as {
        configuredOptions: ConfiguredOptions;
        hostCapabilities: typeof hostCapabilities;
      }),
    ).toThrow('configured options must not contain hostCapabilities');
    expect(snapshotOptions).not.toHaveBeenCalled();

    const runtime = createRuntime({ configuredOptions, hostCapabilities });
    expect(snapshotOptions).toHaveBeenCalledOnce();
    expect(snapshotOptions).toHaveBeenCalledWith(configuredOptions);
    const callPlayer = vi.fn(async () => {
      throw new Error('roleless runtime must not call a player');
    });
    await runtime.init(session(recordingPorts(callPlayer)));
    expect(machineInput).toHaveBeenCalledOnce();
    expect(machineInput).toHaveBeenCalledWith(
      { marker: 'configured-marker' },
      expect.objectContaining({ playbookId: 'role-fixture' }),
    );
    const exported = runtime.exportSnapshot?.();
    expect(exported?.machine).toMatchObject({
      context: { configuredOptions: { marker: 'configured-marker' } },
    });
    expect(JSON.stringify(exported)).toContain('configured-marker');
    expect(JSON.stringify(exported)).not.toContain('capability-marker');
    expect(callPlayer).not.toHaveBeenCalled();
    await runtime.dispose();

    const injectedFactory = createXStatePlaybookRuntime<
      EmptyOptions,
      typeof hostCapabilities
    >(
      repeatMachine,
      repeatSchema3Spec({
        snapshotOptions: () =>
          ({ hostCapabilities: {} }) as unknown as EmptyOptions,
      }),
    );
    expect(() =>
      injectedFactory({ configuredOptions: {}, hostCapabilities }),
    ).toThrow('configured options must not contain hostCapabilities');
  });

  it('snapshots linker-declared verbatim fields at factory construction', async () => {
    const mutableVerbatimFields = new Set(['message']);
    const callPlayer = vi.fn(async () => ({
      status: 'ok' as const,
      finalText: 'exact player prose',
    }));
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      repeatMachine,
      repeatSchema3Spec({
        extractRequiredFields: () => ['message'],
        verbatimPayloadFields: mutableVerbatimFields,
        outcomeAuthority: {
          governedPlayerStates: {
            work: {
              complete: {
                fields: { message: 'presentation' },
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
      }),
    )({ configuredOptions: {}, hostCapabilities: {} });
    mutableVerbatimFields.clear();
    await runtime.init(session(recordingPorts(callPlayer)));

    await expect(
      runtime.handleBossInput(bossTurn('the task')),
    ).resolves.toBeDefined();

    expect(callPlayer).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it('rejects mismatched schema-3 outcome fields before a player call', async () => {
    const callPlayer = vi.fn(async () => ({
      status: 'ok' as const,
      finalText: 'unused',
    }));
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      repeatMachine,
      repeatSchema3Spec({
        outcomeAuthority: {
          governedPlayerStates: {
            work: {
              complete: {
                fields: { message: 'semantic' },
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
      }),
    )({ configuredOptions: {}, hostCapabilities: {} });
    await runtime.init(session(recordingPorts(callPlayer)));

    await expect(runtime.handleBossInput(bossTurn('the task'))).rejects.toThrow(
      'must exactly match its described output fields',
    );

    expect(callPlayer).not.toHaveBeenCalled();
    await runtime.dispose();

    const mismatchedOutcomeCall = vi.fn(async () => ({
      status: 'ok' as const,
      finalText: 'unused',
    }));
    const mismatchedOutcomeRuntime = createXStatePlaybookRuntime<
      EmptyOptions,
      object
    >(
      repeatMachine,
      repeatSchema3Spec({
        outcomeAuthority: {
          governedPlayerStates: {
            work: {
              other: {
                fields: {},
                repositoryDisposition: 'unchanged',
              },
            },
          },
        },
      }),
    )({ configuredOptions: {}, hostCapabilities: {} });
    await mismatchedOutcomeRuntime.init(
      session(recordingPorts(mismatchedOutcomeCall)),
    );

    await expect(
      mismatchedOutcomeRuntime.handleBossInput(bossTurn('the task')),
    ).rejects.toThrow('must exactly match outcomes other');

    expect(mismatchedOutcomeCall).not.toHaveBeenCalled();
    await mismatchedOutcomeRuntime.dispose();
  });

  it('preserves prototype-shaped authority field identifiers exactly', async () => {
    const callPlayer = vi.fn(async () => ({
      status: 'ok' as const,
      finalText: 'done',
    }));
    const outcomeAuthority = JSON.parse(
      '{"governedPlayerStates":{"work":{"complete":{"fields":{"__proto__":"runtime"},"repositoryDisposition":"unchanged"}}}}',
    ) as XStateOutcomeAuthoritySpec;
    const runtime = createXStatePlaybookRuntime<EmptyOptions, object>(
      repeatMachine,
      repeatSchema3Spec({
        extractRequiredFields: () => ['__proto__'],
        outcomeAuthority,
      }),
    )({ configuredOptions: {}, hostCapabilities: {} });
    await runtime.init(session(recordingPorts(callPlayer)));

    await expect(runtime.handleBossInput(bossTurn('the task'))).rejects.toThrow(
      'missing required field "__proto__"',
    );

    expect(callPlayer).toHaveBeenCalledTimes(1);
    await runtime.dispose();

    const adjudicated = await adjudicatePlayerOutput(
      {
        extractRequiredFields: () => ['__proto__'],
        verbatimPayloadFields: new Set(['__proto__']),
      },
      {
        stateId: 'work',
        role: 'coder',
        sourceItem: 'ROLE-1',
        prompt: 'Implement the task.',
        result: { complete: 'The task is complete.' },
      },
      'exact player prose',
      recordingPorts(callPlayer),
      new AbortController().signal,
    );
    expect(Object.hasOwn(adjudicated, '__proto__')).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(adjudicated, '__proto__')?.value,
    ).toBe('exact player prose');
  });

  it('uses detached bindings for prompt identity while the port receives the role', async () => {
    const telemetry: unknown[] = [];
    const calls: Array<{ roleId: string; prompt: string; resume: string | false }> = [];
    const mutableBinding = {
      playerId: 'dev.shared',
      promptIdentity: 'GPT-5.6 Sol',
    };
    let retainedLookup: ((roleId: string) => string) | undefined;
    const ports = recordingPorts(async (roleId, prompt, _signal, options) => {
      calls.push({ roleId, prompt, resume: options.resume });
      return { status: 'ok', resumeToken: 'thread-1', finalText: 'done' };
    }, telemetry);
    const createRuntime = createXStatePlaybookRuntime(
      repeatMachine,
      repeatSpec({
        composePlayerPrompt: (input, promptIdentity) => {
          retainedLookup = promptIdentity;
          return `${promptIdentity(input.role)}\n\n${input.prompt}`;
        },
      }),
    );
    const runtime = createRuntime({});
    await runtime.init(
      session(ports, { roleBindings: { coder: mutableBinding } }),
    );
    mutableBinding.playerId = 'mutated.player';
    mutableBinding.promptIdentity = 'mutated model';

    await runtime.handleBossInput(bossTurn('the change'));

    expect(calls).toEqual([
      {
        roleId: 'coder',
        prompt: 'GPT-5.6 Sol\n\nImplement the change.',
        resume: false,
      },
    ]);
    const playerTraces = telemetry
      .map((event) => event as { topic: string; payload: Record<string, unknown> })
      .filter(
        ({ topic, payload }) =>
          topic === 'playbook.trace' &&
          String(payload.type).startsWith('player.call.'),
      );
    expect(playerTraces).toHaveLength(2);
    for (const { payload } of playerTraces) {
      expect(payload.schemaVersion).toBe(3);
      expect(payload.payload).toMatchObject({
        roleId: 'coder',
        playerId: 'dev.shared',
      });
    }
    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot).toMatchObject({
      schemaVersion: 3,
      roleResumeTokens: { coder: 'thread-1' },
    });
    expect(JSON.stringify(snapshot)).not.toContain('dev.shared');
    expect(JSON.stringify(snapshot)).not.toContain('GPT-5.6 Sol');
    expect(() => retainedLookup?.('coder')).toThrow(
      'prompt identity lookup is no longer active',
    );
    await runtime.dispose();

    const restored = createRuntime({});
    await restored.restore?.(
      session(ports, {
        roleBindings: {
          coder: {
            playerId: 'dev.shared',
            promptIdentity: 'Claude Opus 5',
          },
        },
      }),
      snapshot!,
    );
    await restored.handleBossInput(bossTurn('the follow-up'));
    expect(calls[1]).toEqual({
      roleId: 'coder',
      prompt: 'Claude Opus 5\n\nImplement the follow-up.',
      resume: 'thread-1',
    });
    expect(JSON.stringify(restored.exportSnapshot?.())).not.toContain(
      'Claude Opus 5',
    );
    expect(() => retainedLookup?.('coder')).toThrow(
      'prompt identity lookup is no longer active',
    );
    await restored.dispose();
  });

  it('validates exact bindings and limits prompt lookup to declared roles', async () => {
    const port = vi.fn(async () => ({
      status: 'ok' as const,
      finalText: 'done',
    }));
    const ports = recordingPorts(port);
    const createRuntime = createXStatePlaybookRuntime(
      repeatMachine,
      repeatSpec({
        composePlayerPrompt: (_input, promptIdentity) =>
          promptIdentity('reviewer'),
      }),
    );

    for (const roleBindings of [
      {},
      {
        coder: { playerId: 'dev.coder', promptIdentity: 'Coder' },
        reviewer: { playerId: 'dev.reviewer', promptIdentity: 'Reviewer' },
      },
    ]) {
      const runtime = createRuntime({});
      await expect(runtime.init(session(ports, { roleBindings }))).rejects.toThrow(
        'must cover exactly [coder]',
      );
      await runtime.dispose();
    }

    const emptyIdentity = createRuntime({});
    await expect(
      emptyIdentity.init(
        session(ports, {
          roleBindings: { coder: { playerId: 'dev.coder', promptIdentity: ' ' } },
        }),
      ),
    ).rejects.toThrow('promptIdentity must be a non-empty string');
    await emptyIdentity.dispose();

    const lookup = createRuntime({});
    await lookup.init(
      session(ports, {
        roleBindings: {
          coder: { playerId: 'dev.coder', promptIdentity: 'Coder' },
        },
      }),
    );
    await expect(
      lookup.handleBossInput(bossTurn('task')),
    ).rejects.toThrow('lookup rejected undeclared role reviewer');
    expect(port).not.toHaveBeenCalled();
    await lookup.dispose();
  });

  it('preserves, clears, and replaces external continuation only when authorized', async () => {
    const tokens = new Map<string, string>();
    const updates: Array<[string, string | undefined]> = [];
    const store: PlayerSessionStore = {
      select: (roleId) => tokens.get(roleId) ?? false,
      update: (roleId, token) => {
        updates.push([roleId, token]);
        if (token === undefined) tokens.delete(roleId);
        else tokens.set(roleId, token);
      },
      snapshot: () => Object.fromEntries(tokens),
      restore: (next) => {
        tokens.clear();
        for (const [roleId, token] of Object.entries(next)) {
          tokens.set(roleId, token);
        }
      },
    };
    const results: PlayerResult[] = [
      { status: 'ok', resumeToken: 'thread-1', finalText: 'done' },
      { status: 'aborted' },
      { status: 'ok', resumeToken: '   ', finalText: 'invalid' },
      { status: 'error', error: 'failed' },
      { status: 'ok', finalText: 'done' },
      { status: 'ok', resumeToken: 'thread-2', finalText: 'done' },
    ];
    const resumes: Array<string | false> = [];
    const standalonePromptIdentities: string[] = [];
    const ports = recordingPorts(async (_roleId, _prompt, _signal, options) => {
      resumes.push(options.resume);
      return results.shift()!;
    });
    const runtime = createXStatePlaybookRuntime(
      repeatMachine,
      repeatSpec({
        composePlayerPrompt: (input, promptIdentity) => {
          standalonePromptIdentities.push(promptIdentity(input.role));
          return input.prompt;
        },
      }),
    )({});
    await runtime.init(session(ports, { playerSessions: store }));

    await runtime.handleBossInput(bossTurn('one'));
    await runtime.handleBossInput(bossTurn('two'));
    await expect(runtime.handleBossInput(bossTurn('three'))).rejects.toThrow(
      'resumeToken must be a non-empty string',
    );
    await runtime.handleBossInput(bossTurn('four'));
    await runtime.handleBossInput(bossTurn('five'));
    await runtime.handleBossInput(bossTurn('six'));

    expect(resumes).toEqual([
      false,
      'thread-1',
      'thread-1',
      'thread-1',
      'thread-1',
      false,
    ]);
    expect(updates).toEqual([
      ['coder', 'thread-1'],
      ['coder', undefined],
      ['coder', 'thread-2'],
    ]);
    expect(standalonePromptIdentities).toEqual(Array(6).fill('coder'));
    expect(runtime.exportSnapshot?.()?.roleResumeTokens).toEqual({
      coder: 'thread-2',
    });
    await runtime.dispose();
  });
});

const aliasMachine = createMachine({
  id: 'role-alias',
  context: {},
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for a task.'),
      tags: ['playbook.parked'],
      on: { START: 'code' },
    },
    code: {
      meta: roleMeta('code', 'coder', 'Draft a proposal.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: {
          stateId: 'code',
          role: 'coder',
          sourceItem: 'ALIAS-1',
          prompt: 'Draft.',
          result: { complete: 'Complete.' },
        },
        onDone: 'review',
        onError: 'ready',
      },
    },
    review: {
      meta: roleMeta('review', 'reviewer', 'Review the proposal.'),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: {
          stateId: 'review',
          role: 'reviewer',
          sourceItem: 'ALIAS-2',
          prompt: 'Review.',
          result: { complete: 'Complete.' },
        },
        onDone: 'ready',
        onError: 'ready',
      },
    },
  },
});

const aliasSpec: XStatePlaybookRuntimeSpec<EmptyOptions> = {
  label: 'ROLE-ALIAS',
  compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
  roleStates: {
    code: { role: 'coder', label: 'Draft a proposal.' },
    review: { role: 'reviewer', label: 'Review the proposal.' },
  },
};

describe('DR-032 aliased private continuation', () => {
  it('shares by player privately but projects and restores by local role', async () => {
    const calls: Array<{ roleId: string; resume: string | false }> = [];
    const results: PlayerResult[] = [
      { status: 'ok', resumeToken: 'thread-1', finalText: 'draft' },
      { status: 'ok', resumeToken: 'thread-2', finalText: 'review' },
    ];
    const ports = recordingPorts(async (roleId, _prompt, _signal, options) => {
      calls.push({ roleId, resume: options.resume });
      return results.shift()!;
    });
    const bindings = {
      coder: { playerId: 'dev.shared', promptIdentity: 'Coder' },
      reviewer: { playerId: 'dev.shared', promptIdentity: 'Reviewer' },
    };
    const createRuntime = createXStatePlaybookRuntime(aliasMachine, aliasSpec);
    const runtime = createRuntime({});
    await runtime.init(session(ports, { roleBindings: bindings }));
    await runtime.handleBossInput(bossTurn('start'));
    expect(calls).toEqual([
      { roleId: 'coder', resume: false },
      { roleId: 'reviewer', resume: 'thread-1' },
    ]);
    const snapshot = runtime.exportSnapshot?.();
    expect(snapshot?.roleResumeTokens).toEqual({
      coder: 'thread-2',
      reviewer: 'thread-2',
    });
    await runtime.dispose();

    const conflicting = structuredClone(snapshot!);
    conflicting.roleResumeTokens = {
      coder: 'thread-a',
      reviewer: 'thread-b',
    };
    const restored = createRuntime({});
    await expect(
      restored.restore?.(
        session(ports, { roleBindings: bindings }),
        conflicting,
      ),
    ).rejects.toThrow('conflicting tokens');
    await restored.dispose();
  });

  it('rejects a one-sided external alias projection', async () => {
    const ports = recordingPorts(async () => ({
      status: 'ok',
      finalText: 'unused',
    }));
    const store: PlayerSessionStore = {
      select: () => false,
      update: () => undefined,
      snapshot: () => ({ coder: 'thread-1' }),
      restore: () => undefined,
    };
    const runtime = createXStatePlaybookRuntime(aliasMachine, aliasSpec)({});
    await runtime.init(
      session(ports, {
        roleBindings: {
          coder: { playerId: 'dev.shared', promptIdentity: 'Coder' },
          reviewer: { playerId: 'dev.shared', promptIdentity: 'Reviewer' },
        },
        playerSessions: store,
      }),
    );
    expect(() => runtime.exportSnapshot?.()).toThrow(
      'through every aliased role',
    );
    await runtime.dispose();
  });

  it('rejects an accessor-bearing external projection without invoking it', async () => {
    const tokenGetter = vi.fn(() => 'thread-1');
    const store: PlayerSessionStore = {
      select: () => false,
      update: () => undefined,
      snapshot: () => {
        const projected = {} as Record<string, string>;
        Object.defineProperty(projected, 'coder', {
          enumerable: true,
          get: tokenGetter,
        });
        return projected;
      },
      restore: () => undefined,
    };
    const runtime = createXStatePlaybookRuntime(repeatMachine, repeatSpec())({});
    await runtime.init(
      session(
        recordingPorts(async () => ({
          status: 'ok',
          finalText: 'unused',
        })),
        { playerSessions: store },
      ),
    );

    expect(() => runtime.exportSnapshot?.()).toThrow(
      'player session store snapshot.coder must be a JSON data property',
    );
    expect(tokenGetter).not.toHaveBeenCalled();
    await runtime.dispose();
  });
});

const collisionMachine = createMachine({
  id: 'role-collision',
  context: {},
  initial: 'ready',
  states: {
    ready: {
      meta: stateMeta('ready', 'Waiting for a task.'),
      tags: ['playbook.parked'],
      on: { START: 'work' },
    },
    work: {
      meta: roleMeta('work', 'coder', 'Run simultaneous work.'),
      tags: ['playbook.busy'],
      invoke: [
        {
          id: 'coder-call',
          src: 'player',
          input: {
            stateId: 'work',
            role: 'coder',
            sourceItem: 'COLLISION-1',
            prompt: 'Code.',
            result: { complete: 'Complete.' },
          },
          onDone: 'ready',
          onError: 'ready',
        },
        {
          id: 'reviewer-call',
          src: 'player',
          input: {
            stateId: 'work',
            role: 'reviewer',
            sourceItem: 'COLLISION-2',
            prompt: 'Review.',
            result: { complete: 'Complete.' },
          },
          onDone: 'ready',
          onError: 'ready',
        },
      ],
    },
    reviewerDeclaration: {
      meta: roleMeta(
        'reviewerDeclaration',
        'reviewer',
        'Declare the Reviewer role.',
      ),
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: {
          stateId: 'reviewerDeclaration',
          role: 'reviewer',
          sourceItem: 'COLLISION-DECLARATION',
          prompt: 'Unused.',
          result: { complete: 'Complete.' },
        },
        onDone: 'ready',
        onError: 'ready',
      },
    },
  },
});

describe('DR-032 resolved-player concurrency', () => {
  it('rejects an aliased overlap before a second host call', async () => {
    const hostCalls = vi.fn(
      (_roleId: string, _prompt: string, signal: AbortSignal) =>
        new Promise<PlayerResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const telemetry: unknown[] = [];
    const runtime = createXStatePlaybookRuntime(collisionMachine, {
      label: 'ROLE-COLLISION',
      compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI },
      snapshotOptions: () => ({}),
      entryEvent: { type: 'START', textField: 'task' },
      roleStates: {
        work: { role: 'coder', label: 'Run simultaneous work.' },
        reviewerDeclaration: {
          role: 'reviewer',
          label: 'Declare the Reviewer role.',
        },
      },
    })({});
    await runtime.init(
      session(recordingPorts(hostCalls, telemetry), {
        roleBindings: {
          coder: { playerId: 'dev.shared', promptIdentity: 'Coder' },
          reviewer: { playerId: 'dev.shared', promptIdentity: 'Reviewer' },
        },
      }),
    );

    await runtime.handleBossInput(bossTurn('start'));

    expect(hostCalls).toHaveBeenCalledTimes(1);
    const finishes = telemetry
      .map((entry) => entry as { topic: string; payload: Record<string, unknown> })
      .filter(
        ({ topic, payload }) =>
          topic === 'playbook.trace' && payload.type === 'player.call.finished',
      )
      .map(({ payload }) => payload.payload as Record<string, unknown>);
    expect(finishes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          playerId: 'dev.shared',
          status: 'error',
          error: expect.objectContaining({
            message: expect.stringContaining('player key dev.shared'),
          }),
        }),
      ]),
    );
    await runtime.dispose();
  });
});
