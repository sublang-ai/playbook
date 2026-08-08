// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { assign, createActor, createMachine, type AnyActorRef } from 'xstate';
import { describe, expect, it, vi } from 'vitest';

import type {
  BossTurn,
  CaptainContext,
  CaptainRunResult,
  CaptainSession,
  PlayerRunResult,
} from '@sublang/cligent/tmux-play';
import type {
  JsonValue,
  NormalizedError,
  PlaybookCallResult,
  PlaybookPendingCall,
  PlaybookPorts,
  PlaybookRunResult,
  PlaybookRuntime,
  PlaybookSession,
  PlaybookState,
} from './runtime.js';
import {
  assertJsonSafe,
  createNestedPlaybookBridge,
  normalizeError,
  normalizePlaybookSnapshot,
  waitForPlaybookQuiescence,
  type NestedPlaybookBridge,
} from './xstate-runtime.js';
import {
  createPlaybookCaptainShell,
  type PlaybookCaptainRegistryEntry,
} from '../reference/sdlc/code.playbook/playbook-captain.ts';

type ParentEvent = { type: 'CALL'; text: string } | { type: 'CANCEL_CHILD' };

interface ParentContext {
  requestText: string;
}

const stateMeta = (stateId: string, description: string) => ({
  playbook: { stateId, description },
});

function childState(
  stateId: string,
  options: {
    status?: PlaybookState['status'];
    tags?: readonly string[];
  } = {},
): PlaybookState {
  const status = options.status ?? 'active';
  return {
    value: stateId,
    activeStateIds: [stateId],
    tags: options.tags ?? ['playbook.parked'],
    status,
    quiescent: true,
    stateId,
  };
}

class LinkedParentRuntime implements PlaybookRuntime {
  session: PlaybookSession | undefined;
  readonly handleResults: PlaybookRunResult[] = [];
  readonly resumeResults: PlaybookRunResult[] = [];
  readonly controlPlaneErrors: unknown[] = [];
  lastOutput: JsonValue | undefined;
  lastError: NormalizedError | undefined;
  disposedState: PlaybookState | undefined;
  disposeCount = 0;

  private actor: AnyActorRef | undefined;
  private bridge: NestedPlaybookBridge | undefined;
  private sequence = 0;
  private drainPhase = 'none';
  private disposed = false;
  private playerResume: string | false = false;
  private finishFailureConsumed = false;

  constructor(
    readonly playbookId: string,
    private readonly childPlaybookId: string,
    private readonly nextCallId: () => string,
    readonly order: string[],
    private readonly disposeOrder?: string[],
    private readonly exercisePlayerContinuation = false,
    private readonly finishFailure?: 'emit' | 'drain',
  ) {}

  async init(session: PlaybookSession): Promise<void> {
    this.session = session;
    this.bridge = createNestedPlaybookBridge({
      nextCallId: this.nextCallId,
      callPlaybook: (request, signal) =>
        session.ports.callPlaybook(request, signal),
      emitStarted: async (event) => {
        await this.emitCallTrace('playbook.call.started', event.callId, {
          stateId: event.stateId,
          playbookId: event.playbookId,
          text: event.text,
        });
      },
      emitFinished: async (event) => {
        if (this.consumeFinishFailure('emit')) {
          throw new Error('finish emission failed');
        }
        const payload: unknown = {
          stateId: event.stateId,
          playbookId: event.playbookId,
          text: event.text,
          result: event.result,
        };
        assertJsonSafe(payload);
        await this.emitCallTrace(
          'playbook.call.finished',
          event.callId,
          payload,
        );
      },
      drain: async () => {
        if (
          this.drainPhase === 'playbook.call.finished' &&
          this.consumeFinishFailure('drain')
        ) {
          throw new Error('finish drain failed');
        }
        this.order.push(`trace:${this.drainPhase}:drained`);
      },
      onControlPlaneError: (error) => {
        this.controlPlaneErrors.push(error);
      },
    });

    const bridge = this.bridge;
    const childPlaybookId = this.childPlaybookId;
    const machine = createMachine({
      types: {} as {
        context: ParentContext;
        events: ParentEvent;
      },
      context: { requestText: '' },
      initial: 'idle',
      states: {
        idle: {
          tags: 'playbook.parked',
          meta: stateMeta('idle', 'The parent is ready.'),
          on: {
            CALL: {
              target: 'callingChild',
              actions: assign({
                requestText: ({ event }) => event.text,
              }),
            },
          },
        },
        callingChild: {
          tags: 'playbook.suspended',
          meta: stateMeta(
            'callingChild',
            'The parent is suspended on its child playbook.',
          ),
          invoke: {
            src: bridge.actorLogic,
            input: ({ context }) => ({
              stateId: 'callingChild',
              playbookId: childPlaybookId,
              text: context.requestText,
            }),
            onDone: {
              target: 'returned',
              actions: ({ event }) => {
                this.lastOutput = event.output;
                this.order.push('parent:onDone');
              },
            },
            onError: {
              target: 'childError',
              actions: ({ event }) => {
                this.lastError = normalizeError(event.error);
                this.order.push(`parent:onError:${this.lastError.message}`);
              },
            },
          },
          on: { CANCEL_CHILD: 'cancelled' },
        },
        returned: {
          tags: 'playbook.parked',
          meta: stateMeta('returned', 'The child returned to its parent.'),
          on: {
            CALL: {
              target: 'callingChild',
              actions: assign({
                requestText: ({ event }) => event.text,
              }),
            },
          },
        },
        childError: {
          tags: 'playbook.parked',
          meta: stateMeta('childError', 'The child returned an error.'),
          on: {
            CALL: {
              target: 'callingChild',
              actions: assign({
                requestText: ({ event }) => event.text,
              }),
            },
          },
        },
        cancelled: {
          tags: 'playbook.parked',
          meta: stateMeta('cancelled', 'The parent cancelled its child.'),
          on: {
            CALL: {
              target: 'callingChild',
              actions: assign({
                requestText: ({ event }) => event.text,
              }),
            },
          },
        },
      },
    });
    this.actor = createActor(machine).start();
  }

  async handleBossInput(turn: {
    text: string;
    signal: AbortSignal;
  }): Promise<PlaybookRunResult> {
    const actor = this.requireActor();
    if (this.exercisePlayerContinuation) {
      await this.callParentPlayer('before child', turn.signal);
    }
    actor.send({ type: 'CALL', text: turn.text });
    await waitForPlaybookQuiescence(actor, {
      signal: turn.signal,
      pendingCalls: this.requireBridge(),
    });
    const result = this.currentResult();
    this.handleResults.push(result);
    return result;
  }

  async resumePlaybookCall(input: {
    callId: string;
    result: PlaybookCallResult;
    signal: AbortSignal;
  }): Promise<PlaybookRunResult> {
    const bridge = this.requireBridge();
    await bridge.resume(input);
    await waitForPlaybookQuiescence(this.requireActor(), {
      signal: input.signal,
      pendingCalls: bridge,
    });
    if (this.exercisePlayerContinuation) {
      await this.callParentPlayer('after child', input.signal);
    }
    const result = this.currentResult();
    this.resumeResults.push(result);
    return result;
  }

  pendingCall(): PlaybookPendingCall | undefined {
    return this.bridge?.getPendingCall();
  }

  cancelChildInvocation(): void {
    this.requireActor().send({ type: 'CANCEL_CHILD' });
  }

  currentState(): PlaybookState {
    const bridge = this.requireBridge();
    return normalizePlaybookSnapshot(this.requireActor().getSnapshot(), {
      pendingCall: bridge.getPendingCall(),
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeCount += 1;
    this.disposeOrder?.push(this.playbookId);
    const actor = this.requireActor();
    const bridge = this.requireBridge();
    await bridge.dispose();
    if (!normalizePlaybookSnapshot(actor.getSnapshot()).quiescent) {
      await waitForPlaybookQuiescence(actor, { timeout: 1_000 });
    }
    this.disposedState = normalizePlaybookSnapshot(actor.getSnapshot());
    actor.stop();
  }

  private currentResult(): PlaybookRunResult {
    const pendingCall = this.requireBridge().getPendingCall();
    const state = normalizePlaybookSnapshot(this.requireActor().getSnapshot(), {
      pendingCall,
    });
    if (pendingCall) {
      return { outcome: 'suspended', state, pendingCall };
    }
    if (state.stateId === 'childError') {
      return {
        outcome: 'failed',
        state,
        ...(this.lastError ? { error: this.lastError } : {}),
      };
    }
    return { outcome: 'quiescent', state };
  }

  private async emitCallTrace(
    type: 'playbook.call.started' | 'playbook.call.finished',
    callId: string,
    payload: JsonValue,
  ): Promise<void> {
    const session = this.requireSession();
    this.drainPhase = type;
    await session.ports.emitTelemetry({
      topic: 'playbook.trace',
      payload: {
        schemaVersion: 2,
        sessionId: session.sessionId,
        playbookId: session.playbookId,
        rootSessionId: session.rootSessionId,
        ...(session.parentSessionId
          ? { parentSessionId: session.parentSessionId }
          : {}),
        ...(session.parentCallId ? { parentCallId: session.parentCallId } : {}),
        depth: session.depth,
        sequence: ++this.sequence,
        timestamp: this.sequence,
        type,
        callId,
        payload,
      },
    });
    this.order.push(`trace:${type}:emitted`);
  }

  private requireSession(): PlaybookSession {
    if (!this.session) throw new Error('parent runtime is not initialized');
    return this.session;
  }

  private requireActor(): AnyActorRef {
    if (!this.actor) throw new Error('parent actor is not initialized');
    return this.actor;
  }

  private requireBridge(): NestedPlaybookBridge {
    if (!this.bridge) throw new Error('parent bridge is not initialized');
    return this.bridge;
  }

  private async callParentPlayer(
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.requireSession().ports.callPlayer(
      'worker',
      prompt,
      signal,
      { resume: this.playerResume },
    );
    if (result.status !== 'ok') {
      throw new Error(result.error ?? `parent player ${result.status}`);
    }
    this.playerResume = result.resumeToken ?? false;
  }

  private consumeFinishFailure(stage: 'emit' | 'drain'): boolean {
    if (this.finishFailureConsumed || this.finishFailure !== stage) {
      return false;
    }
    this.finishFailureConsumed = true;
    return true;
  }
}

type ChildBehavior = 'immediate-ok' | 'park-then-ok' | 'throw' | 'aborted';

class ScenarioChildRuntime implements PlaybookRuntime {
  session: PlaybookSession | undefined;
  readonly inputs: string[] = [];
  disposeCount = 0;

  constructor(
    private readonly behavior: ChildBehavior,
    private readonly disposeOrder?: string[],
    private readonly disposeError?: Error,
    private readonly label = 'child',
    private readonly disposeStarted?: () => void,
    private readonly disposeGate?: Promise<void>,
    private readonly onDispose?: (session: PlaybookSession) => Promise<void>,
  ) {}

  async init(session: PlaybookSession): Promise<void> {
    this.session = session;
  }

  async handleBossInput(turn: {
    text: string;
    signal: AbortSignal;
  }): Promise<PlaybookRunResult> {
    this.inputs.push(turn.text);
    if (this.behavior === 'throw') {
      throw new Error('child exploded');
    }
    if (this.behavior === 'aborted') {
      return {
        outcome: 'aborted',
        state: childState('aborted', {
          status: 'stopped',
          tags: [],
        }),
        error: { name: 'AbortError', message: 'child cancelled' },
      };
    }
    if (
      this.behavior === 'immediate-ok' ||
      (this.behavior === 'park-then-ok' && this.inputs.length > 1)
    ) {
      return {
        outcome: 'terminal',
        state: childState('done', { status: 'done', tags: [] }),
        output: { answer: 'child complete' },
      };
    }
    return {
      outcome: 'quiescent',
      state: childState('parked'),
    };
  }

  async resumePlaybookCall(): Promise<PlaybookRunResult> {
    throw new Error('scenario child has no nested call');
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    this.disposeStarted?.();
    await this.disposeGate;
    if (this.onDispose && this.session) await this.onDispose(this.session);
    this.disposeOrder?.push(this.label);
    if (this.disposeError) throw this.disposeError;
  }
}

function registryEntry(
  id: string,
  command: string,
  createRuntime: () => PlaybookRuntime,
  requiredRoleIds: readonly string[] = [],
): PlaybookCaptainRegistryEntry {
  return {
    id,
    command,
    intent: `${id} integration playbook`,
    requiredRoleIds,
    validateOptions: (options) => options,
    createRuntime,
  };
}

interface Harness {
  shell: ReturnType<typeof createPlaybookCaptainShell>;
  session: CaptainSession;
  context: CaptainContext;
  telemetry: { topic: string; payload: unknown }[];
  statuses: string[];
  playerCalls: Array<{
    playerId: string;
    prompt: string;
    resume: string | false;
  }>;
  routerDecisions: CaptainRunResult[];
}

function createHarness(
  entries: readonly PlaybookCaptainRegistryEntry[],
): Harness {
  const modules: Record<string, unknown> = {};
  const playbooks: Record<string, { from: string; options: object }> = {};
  for (const entry of entries) {
    const from = `test://${entry.id}`;
    modules[from] = { default: entry };
    playbooks[entry.id] = { from, options: {} };
  }
  let id = 0;
  // The session Captain takes its own id at `init` (CAPTAIN-16/26), before any
  // engagement, so engagement ids keep their numbering.
  let captainIdIssued = false;
  const shell = createPlaybookCaptainShell(
    { playbooks },
    {
      loadModule: async (specifier) => modules[specifier],
      createSessionId: () => {
        if (!captainIdIssued) {
          captainIdIssued = true;
          return '30000000-0000-4000-8000-0000000000ff';
        }
        return `30000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;
      },
    },
  );
  const telemetry: Harness['telemetry'] = [];
  const statuses: string[] = [];
  const playerCalls: Harness['playerCalls'] = [];
  const routerDecisions: CaptainRunResult[] = [];
  const replies: string[] = [];
  let captainCalls = 0;
  const controller = new AbortController();
  const players: CaptainSession['players'] = entries.flatMap((entry) =>
    entry.requiredRoleIds.map((roleId) => ({
      id: `${entry.id}-${roleId}`,
      adapter: 'codex',
    })),
  );
  const session: CaptainSession = {
    signal: controller.signal,
    players,
    emitStatus: async (message) => {
      statuses.push(message);
    },
    emitTelemetry: async (event) => {
      telemetry.push(event);
    },
    setVisiblePlayers: async () => {},
  };
  const context: CaptainContext = {
    signal: controller.signal,
    players,
    callPlayer: async (playerId, prompt, options): Promise<PlayerRunResult> => {
      playerCalls.push({
        playerId,
        prompt,
        resume: options?.resume ?? false,
      });
      return {
        status: 'ok',
        playerId,
        turnId: playerCalls.length,
        finalText: 'parent player completed',
        resumeToken:
          prompt === 'before child' ? 'parent-token' : 'rotated-token',
      };
    },
    // The session Captain's durable conversation returns a rotating token on
    // every call (CAPTAIN-31/35); a decision call answers with control JSON
    // over the closed action set, a prose call with captain speech.
    callCaptain: async (prompt): Promise<CaptainRunResult> => {
      const scripted = routerDecisions.shift();
      if (scripted !== undefined) {
        return scripted.resumeToken === undefined
          ? { ...scripted, resumeToken: `conversation-${++captainCalls}` }
          : scripted;
      }
      const decision = prompt.includes(
        'Select exactly one action from the closed set',
      );
      return {
        status: 'ok',
        turnId: 1,
        finalText: decision
          ? JSON.stringify({ action: 'deliver' })
          : 'The child is running.',
        resumeToken: `conversation-${++captainCalls}`,
      };
    },
    emitReply: async (text: string): Promise<void> => {
      replies.push(text);
    },
    setVisiblePlayers: async () => {},
  };
  return {
    shell,
    session,
    context,
    telemetry,
    statuses,
    playerCalls,
    routerDecisions,
    replies,
  };
}

function turn(prompt: string, id = 1): BossTurn {
  return { id, prompt, timestamp: id };
}

function expectFinishBeforeParentTransition(
  order: readonly string[],
  transitionPrefix: 'parent:onDone' | 'parent:onError:',
): void {
  const emitted = order.lastIndexOf('trace:playbook.call.finished:emitted');
  const drained = order.lastIndexOf('trace:playbook.call.finished:drained');
  const transition = order.findIndex((event) =>
    event.startsWith(transitionPrefix),
  );
  expect(emitted).toBeGreaterThan(-1);
  expect(drained).toBeGreaterThan(emitted);
  expect(transition).toBeGreaterThan(drained);
}

describe('linked nested playbook integration (PBRT-44)', () => {
  it('takes immediate child output through invoke onDone and rejects a reused call id', async () => {
    const order: string[] = [];
    const parents: LinkedParentRuntime[] = [];
    const children: ScenarioChildRuntime[] = [];
    const parentEntry = registryEntry('parent', 'parent', () => {
      const runtime = new LinkedParentRuntime(
        'parent',
        'child',
        () => 'reused-call',
        order,
      );
      parents.push(runtime);
      return runtime;
    });
    const childEntry = registryEntry('child', 'child', () => {
      const runtime = new ScenarioChildRuntime('immediate-ok');
      children.push(runtime);
      return runtime;
    });
    const harness = createHarness([parentEntry, childEntry]);
    await harness.shell.init!(harness.session);

    await harness.shell.handleBossTurn(
      turn('/parent invoke immediate child'),
      harness.context,
    );

    expect(parents[0]?.currentState().stateId).toBe('returned');
    expect(parents[0]?.lastOutput).toEqual({ answer: 'child complete' });
    expect(children[0]?.disposeCount).toBe(1);
    expectFinishBeforeParentTransition(order, 'parent:onDone');
    expect(
      harness.telemetry.filter(
        (event) =>
          event.topic === 'playbook.trace' &&
          (event.payload as { type?: unknown }).type ===
            'playbook.call.finished',
      ),
    ).toHaveLength(1);

    await harness.shell.handleBossTurn(
      turn('/parent invoke duplicate', 2),
      harness.context,
    );

    expect(parents[0]?.currentState().stateId).toBe('childError');
    expect(parents[0]?.lastError?.message).toContain(
      'allocated duplicate playbook call id reused-call',
    );
    expect(children).toHaveLength(1);
    await harness.shell.dispose!();
  });

  it('returns a parked child as suspended, then routes the next turn to the child and resumes invoke onDone', async () => {
    const order: string[] = [];
    const parents: LinkedParentRuntime[] = [];
    const children: ScenarioChildRuntime[] = [];
    const parentEntry = registryEntry(
      'parent',
      'parent',
      () => {
        const runtime = new LinkedParentRuntime(
          'parent',
          'child',
          () => 'call-1',
          order,
          undefined,
          true,
        );
        parents.push(runtime);
        return runtime;
      },
      ['worker'],
    );
    const childEntry = registryEntry('child', 'child', () => {
      const runtime = new ScenarioChildRuntime('park-then-ok');
      children.push(runtime);
      return runtime;
    });
    const harness = createHarness([parentEntry, childEntry]);
    await harness.shell.init!(harness.session);

    await expect(
      harness.shell.handleBossTurn(
        turn('/parent invoke parked child'),
        harness.context,
      ),
    ).resolves.toBeUndefined();

    expect(parents[0]?.handleResults[0]).toMatchObject({
      outcome: 'suspended',
      pendingCall: {
        callId: 'call-1',
        playbookId: 'child',
        childSessionId: '30000000-0000-4000-8000-000000000002',
      },
    });
    expect(parents[0]?.currentState()).toMatchObject({
      stateId: 'callingChild',
      quiescent: true,
    });
    expect(children[0]?.inputs).toEqual(['invoke parked child']);

    await harness.shell.handleBossTurn(
      turn('finish the active child', 2),
      harness.context,
    );

    expect(children[0]?.inputs).toEqual([
      'invoke parked child',
      'finish the active child',
    ]);
    expect(parents[0]?.resumeResults[0]).toMatchObject({
      outcome: 'quiescent',
      state: { stateId: 'returned' },
    });
    expect(parents[0]?.lastOutput).toEqual({ answer: 'child complete' });
    expect(harness.playerCalls).toEqual([
      {
        playerId: 'parent-worker',
        prompt: 'before child',
        resume: false,
      },
      {
        playerId: 'parent-worker',
        prompt: 'after child',
        resume: 'parent-token',
      },
    ]);
    expect(children[0]?.session).toMatchObject({
      rootSessionId: '30000000-0000-4000-8000-000000000001',
      parentSessionId: '30000000-0000-4000-8000-000000000001',
      parentCallId: 'call-1',
      depth: 1,
    });
    expectFinishBeforeParentTransition(order, 'parent:onDone');
    await harness.shell.dispose!();
  });

  it('reports a failed finish boundary so Captain can retry without an orphaned child', async () => {
    const order: string[] = [];
    const parents: LinkedParentRuntime[] = [];
    const children: ScenarioChildRuntime[] = [];
    let call = 0;
    const parentEntry = registryEntry('parent', 'parent', () => {
      const runtime = new LinkedParentRuntime(
        'parent',
        'child',
        () => `call-${++call}`,
        order,
        undefined,
        false,
        'drain',
      );
      parents.push(runtime);
      return runtime;
    });
    const childEntry = registryEntry('child', 'child', () => {
      const runtime = new ScenarioChildRuntime(
        children.length === 0 ? 'park-then-ok' : 'immediate-ok',
      );
      children.push(runtime);
      return runtime;
    });
    const harness = createHarness([parentEntry, childEntry]);
    await harness.shell.init!(harness.session);
    await harness.shell.handleBossTurn(
      turn('/parent suspend on child'),
      harness.context,
    );

    const repliesBefore = harness.replies.length;
    await expect(
      harness.shell.handleBossTurn(
        turn('finish child with broken trace drain', 2),
        harness.context,
      ),
    ).resolves.toBeUndefined();

    expect(children[0]?.disposeCount).toBe(1);
    expect(parents[0]?.pendingCall()).toBeUndefined();
    expect(parents[0]?.controlPlaneErrors).toHaveLength(1);
    expect(
      (parents[0]?.controlPlaneErrors[0] as Error | undefined)?.message,
    ).toBe('finish drain failed');
    await vi.waitFor(() => {
      expect(parents[0]?.currentState().stateId).toBe('childError');
    });
    expect(harness.replies).toHaveLength(repliesBefore + 1);

    // The failed child frame was already popped before the parent boundary
    // failed. A fresh explicit parent command therefore reaches the root,
    // creates a new child, and completes normally with a new call id.
    await harness.shell.handleBossTurn(
      turn('/parent retry after boundary failure', 3),
      harness.context,
    );

    expect(children).toHaveLength(2);
    expect(children[1]?.disposeCount).toBe(1);
    expect(parents[0]?.currentState().stateId).toBe('returned');
    expect(parents[0]?.lastOutput).toEqual({ answer: 'child complete' });
    expect(parents[0]?.pendingCall()).toBeUndefined();
    await harness.shell.dispose!();
  });

  it('awaits gated child-session cleanup before an invocation-abort finish boundary', async () => {
    const order: string[] = [];
    const parents: LinkedParentRuntime[] = [];
    const children: ScenarioChildRuntime[] = [];
    let releaseDispose!: () => void;
    let markDisposeStarted!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    const disposeStarted = new Promise<void>((resolve) => {
      markDisposeStarted = resolve;
    });
    let call = 0;
    const parentEntry = registryEntry('parent', 'parent', () => {
      const runtime = new LinkedParentRuntime(
        'parent',
        'child',
        () => `abort-call-${++call}`,
        order,
      );
      parents.push(runtime);
      return runtime;
    });
    const childEntry = registryEntry('child', 'child', () => {
      const first = children.length === 0;
      const runtime = new ScenarioChildRuntime(
        first ? 'park-then-ok' : 'immediate-ok',
        undefined,
        undefined,
        'child',
        first ? markDisposeStarted : undefined,
        first ? disposeGate : undefined,
        first
          ? async (session) => {
              order.push('child:session.disposed');
              await session.ports.emitTelemetry({
                topic: 'playbook.trace',
                payload: {
                  schemaVersion: 2,
                  sessionId: session.sessionId,
                  playbookId: session.playbookId,
                  rootSessionId: session.rootSessionId,
                  parentSessionId: session.parentSessionId,
                  parentCallId: session.parentCallId,
                  depth: session.depth,
                  sequence: 1,
                  timestamp: 1,
                  type: 'session.disposed',
                  payload: { stateId: 'parked' },
                },
              });
            }
          : undefined,
      );
      children.push(runtime);
      return runtime;
    });
    const harness = createHarness([parentEntry, childEntry]);
    await harness.shell.init!(harness.session);
    await harness.shell.handleBossTurn(
      turn('/parent suspend before cancellation'),
      harness.context,
    );

    parents[0]?.cancelChildInvocation();
    await disposeStarted;
    expect(children[0]?.disposeCount).toBe(1);
    expect(
      order.some((event) => event.startsWith('trace:playbook.call.finished')),
    ).toBe(false);

    releaseDispose();
    await vi.waitFor(() => {
      expect(order).toContain('trace:playbook.call.finished:emitted');
      expect(parents[0]?.pendingCall()).toBeUndefined();
    });

    expect(order.indexOf('child:session.disposed')).toBeLessThan(
      order.indexOf('trace:playbook.call.finished:emitted'),
    );
    const traceTypes = harness.telemetry
      .filter((event) => event.topic === 'playbook.trace')
      .map((event) => (event.payload as { type?: unknown }).type);
    expect(traceTypes.indexOf('session.disposed')).toBeLessThan(
      traceTypes.lastIndexOf('playbook.call.finished'),
    );
    expect(parents[0]?.currentState().stateId).toBe('cancelled');

    // Cleanup also removed the child frame, so a new parent command can
    // start and synchronously return a fresh child.
    await harness.shell.handleBossTurn(
      turn('/parent retry after invocation cancellation', 2),
      harness.context,
    );
    expect(children).toHaveLength(2);
    expect(children[1]?.disposeCount).toBe(1);
    expect(parents[0]?.currentState().stateId).toBe('returned');
    await harness.shell.dispose!();
  });

  it.each([
    ['throw', 'error', 'child exploded'],
    ['aborted', 'aborted', 'child cancelled'],
  ] as const)(
    'routes a child %s result through invoke onError',
    async (behavior, expectedStatus, expectedMessage) => {
      const order: string[] = [];
      const parents: LinkedParentRuntime[] = [];
      const children: ScenarioChildRuntime[] = [];
      const parentEntry = registryEntry('parent', 'parent', () => {
        const runtime = new LinkedParentRuntime(
          'parent',
          'child',
          () => 'call-error',
          order,
        );
        parents.push(runtime);
        return runtime;
      });
      const childEntry = registryEntry('child', 'child', () => {
        const runtime = new ScenarioChildRuntime(behavior);
        children.push(runtime);
        return runtime;
      });
      const harness = createHarness([parentEntry, childEntry]);
      await harness.shell.init!(harness.session);

      await harness.shell.handleBossTurn(
        turn('/parent invoke failing child'),
        harness.context,
      );

      expect(parents[0]?.currentState().stateId).toBe('childError');
      expect(parents[0]?.lastError?.message).toContain(expectedMessage);
      expect(children[0]?.disposeCount).toBe(1);
      const finish = harness.telemetry.find(
        (event) =>
          event.topic === 'playbook.trace' &&
          (event.payload as { type?: unknown }).type ===
            'playbook.call.finished',
      );
      expect(finish?.payload).toMatchObject({
        payload: { result: { status: expectedStatus } },
      });
      expectFinishBeforeParentTransition(order, 'parent:onError:');
      await harness.shell.dispose!();
    },
  );

  it('rejects an unknown resume id and aborts the pending invocation on host disposal', async () => {
    const order: string[] = [];
    const parents: LinkedParentRuntime[] = [];
    const children: ScenarioChildRuntime[] = [];
    const parentEntry = registryEntry('parent', 'parent', () => {
      const runtime = new LinkedParentRuntime(
        'parent',
        'child',
        () => 'call-pending',
        order,
      );
      parents.push(runtime);
      return runtime;
    });
    const childEntry = registryEntry('child', 'child', () => {
      const runtime = new ScenarioChildRuntime('park-then-ok');
      children.push(runtime);
      return runtime;
    });
    const harness = createHarness([parentEntry, childEntry]);
    await harness.shell.init!(harness.session);
    await harness.shell.handleBossTurn(
      turn('/parent leave child pending'),
      harness.context,
    );
    const pending = parents[0]?.pendingCall();
    expect(pending).toBeDefined();

    await expect(
      parents[0]?.resumePlaybookCall({
        callId: 'unknown-call',
        result: {
          status: 'ok',
          playbookId: 'child',
          childSessionId: pending!.childSessionId,
        },
        signal: harness.context.signal,
      }),
    ).rejects.toThrow('does not match call-pending');
    expect(parents[0]?.pendingCall()).toEqual(pending);

    await harness.shell.prepareDispose!();

    expect(children[0]?.disposeCount).toBe(1);
    expect(parents[0]?.disposeCount).toBe(1);
    expect(parents[0]?.disposedState?.stateId).toBe('childError');
    expect(parents[0]?.lastError?.message).toContain(
      'Nested playbook bridge disposed',
    );
    expectFinishBeforeParentTransition(order, 'parent:onError:');
    await expect(
      parents[0]?.resumePlaybookCall({
        callId: 'call-pending',
        result: {
          status: 'ok',
          playbookId: 'child',
          childSessionId: pending!.childSessionId,
        },
        signal: harness.context.signal,
      }),
    ).rejects.toThrow('unknown or stale playbook call id call-pending');
    await harness.shell.dispose!();
  });

  it('tears down a three-frame stack LIFO even when descendant disposal rejects', async () => {
    const traceOrder: string[] = [];
    const disposeOrder: string[] = [];
    const parents: LinkedParentRuntime[] = [];
    const linkedChildren: LinkedParentRuntime[] = [];
    const grandchildren: ScenarioChildRuntime[] = [];
    const parentEntry = registryEntry('parent', 'parent', () => {
      const runtime = new LinkedParentRuntime(
        'parent',
        'child',
        () => 'root-call',
        traceOrder,
        disposeOrder,
      );
      parents.push(runtime);
      return runtime;
    });
    const childEntry = registryEntry('child', 'child', () => {
      const runtime = new LinkedParentRuntime(
        'child',
        'grandchild',
        () => 'child-call',
        traceOrder,
        disposeOrder,
      );
      linkedChildren.push(runtime);
      return runtime;
    });
    const grandchildEntry = registryEntry('grandchild', 'grandchild', () => {
      const runtime = new ScenarioChildRuntime(
        'park-then-ok',
        disposeOrder,
        new Error('grandchild dispose failed'),
        'grandchild',
      );
      grandchildren.push(runtime);
      return runtime;
    });
    const harness = createHarness([parentEntry, childEntry, grandchildEntry]);
    await harness.shell.init!(harness.session);
    await harness.shell.handleBossTurn(
      turn('/parent build nested stack'),
      harness.context,
    );

    expect(parents[0]?.pendingCall()?.playbookId).toBe('child');
    expect(linkedChildren[0]?.pendingCall()?.playbookId).toBe('grandchild');
    expect(grandchildren[0]?.session).toMatchObject({ depth: 2 });

    await expect(harness.shell.prepareDispose!()).rejects.toThrow(
      'grandchild dispose failed',
    );

    expect(disposeOrder).toEqual(['grandchild', 'child', 'parent']);
    expect(grandchildren[0]?.disposeCount).toBe(1);
    expect(linkedChildren[0]?.disposeCount).toBe(1);
    expect(parents[0]?.disposeCount).toBe(1);
    await expect(harness.shell.dispose!()).resolves.toBeUndefined();
    expect(disposeOrder).toEqual(['grandchild', 'child', 'parent']);
  });
});
