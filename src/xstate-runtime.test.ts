// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createActor, createMachine, toPromise } from 'xstate';
import { describe, expect, it, vi } from 'vitest';

import type {
  JsonValue,
  PlaybookCallResult,
  PlaybookCallStart,
  PlaybookPendingCall,
  PlaybookStateValue,
} from './runtime.js';
import {
  activePlaybookStateMetadata,
  assertJsonSafe,
  combineAbortSignals,
  createNestedPlaybookBridge,
  NestedPlaybookCallError,
  normalizeError,
  normalizePlaybookSnapshot,
  registerPlaybookAbortCleanup,
  snapshotJsonValue,
  snapshotPlaybookSession,
  validateCaptainResult,
  validatePlayerResult,
  validatePlaybookCallResult,
  validatePlaybookCallStart,
  waitForPlaybookQuiescence,
  type NestedPlaybookBridgeOptions,
  type PendingCallObserver,
} from './xstate-runtime.js';

const INPUT = {
  stateId: 'call-review',
  playbookId: 'review',
  text: 'Review the proposed change.',
};

function pendingCall(
  bridge: ReturnType<typeof createNestedPlaybookBridge>,
): Promise<PlaybookPendingCall> {
  const current = bridge.getPendingCall();
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => {
    const unsubscribe = bridge.subscribePendingCall((pending) => {
      unsubscribe();
      resolve(pending);
    });
  });
}

function bridgeOptions(
  events: string[],
  callPlaybook: NestedPlaybookBridgeOptions['callPlaybook'],
): NestedPlaybookBridgeOptions {
  let call = 0;
  return {
    nextCallId: () => `call-${++call}`,
    async callPlaybook(request, signal) {
      events.push(`port:${request.callId}:${signal.aborted}`);
      return callPlaybook(request, signal);
    },
    async emitStarted(event) {
      events.push(`started:${event.callId}:${event.playbookId}`);
    },
    async emitFinished(event) {
      events.push(`finished:${event.callId}:${event.result.status}`);
    },
    async drain() {
      events.push('drain');
    },
  };
}

const parallelMachine = createMachine({
  id: 'parallel-test',
  initial: 'round',
  states: {
    round: {
      type: 'parallel',
      states: {
        host: {
          initial: 'working',
          states: {
            working: {
              tags: 'playbook.busy',
              meta: {
                playbook: {
                  stateId: 'host.proposal',
                  description: 'Host prepares a proposal.',
                },
              },
              on: { HOST_DONE: 'complete' },
            },
            complete: { type: 'final' },
          },
        },
        participant: {
          initial: 'working',
          states: {
            working: {
              tags: 'playbook.busy',
              meta: {
                playbook: {
                  stateId: 'participant.proposal',
                  description: 'Participant prepares a proposal.',
                },
              },
              on: { PARTICIPANT_DONE: 'complete' },
            },
            complete: { type: 'final' },
          },
        },
      },
      onDone: 'parked',
    },
    parked: {
      tags: 'playbook.parked',
      meta: {
        playbook: {
          stateId: 'parked',
          description: 'The workflow is waiting for the Boss.',
        },
      },
    },
  },
});

const suspendedMachine = createMachine({
  id: 'suspended-test',
  initial: 'calling',
  states: {
    calling: {
      tags: 'playbook.suspended',
      meta: {
        playbook: {
          stateId: 'calling',
          description: 'The parent is waiting for its child.',
        },
      },
    },
  },
});

describe('public XState snapshot normalization', () => {
  it('normalizes parallel values, public metadata, tags, and quiescence', () => {
    const actor = createActor(parallelMachine).start();
    expect(activePlaybookStateMetadata(actor.getSnapshot())).toEqual([
      {
        stateId: 'host.proposal',
        description: 'Host prepares a proposal.',
      },
      {
        stateId: 'participant.proposal',
        description: 'Participant prepares a proposal.',
      },
    ]);
    expect(normalizePlaybookSnapshot(actor.getSnapshot())).toEqual({
      value: {
        round: { host: 'working', participant: 'working' },
      },
      activeStateIds: ['host.proposal', 'participant.proposal'],
      tags: ['playbook.busy'],
      status: 'active',
      quiescent: false,
    });

    actor.send({ type: 'HOST_DONE' });
    expect(normalizePlaybookSnapshot(actor.getSnapshot()).quiescent).toBe(
      false,
    );
    actor.send({ type: 'PARTICIPANT_DONE' });
    expect(normalizePlaybookSnapshot(actor.getSnapshot())).toEqual({
      value: 'parked',
      activeStateIds: ['parked'],
      tags: ['playbook.parked'],
      status: 'active',
      quiescent: true,
      stateId: 'parked',
    });
    actor.stop();
  });

  it('does not settle a suspended state before its child identity exists', () => {
    const actor = createActor(suspendedMachine).start();
    expect(normalizePlaybookSnapshot(actor.getSnapshot()).quiescent).toBe(
      false,
    );
    expect(
      normalizePlaybookSnapshot(actor.getSnapshot(), {
        pendingCall: {
          callId: 'call-1',
          playbookId: 'review',
          childSessionId: 'child-1',
        },
      }),
    ).toMatchObject({ quiescent: true, stateId: 'calling' });
    actor.stop();
  });

  it('uses waitFor and a pending notification without polling', async () => {
    const actor = createActor(suspendedMachine).start();
    let pending: PlaybookPendingCall | undefined;
    const listeners = new Set<(call: PlaybookPendingCall) => void>();
    const observer: PendingCallObserver = {
      getPendingCall: () => pending,
      subscribePendingCall(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    const waiting = waitForPlaybookQuiescence(actor, {
      pendingCalls: observer,
    });
    pending = {
      callId: 'call-1',
      playbookId: 'review',
      childSessionId: 'child-1',
    };
    for (const listener of listeners) listener(pending);

    await expect(waiting).resolves.toBe(actor.getSnapshot());
    expect(listeners.size).toBe(0);
    actor.stop();
  });
});

describe('abort signal composition', () => {
  it('preserves one signal and composes independent abort owners', () => {
    const invocation = new AbortController();
    const boundary = new AbortController();
    expect(combineAbortSignals(undefined, invocation.signal)).toBe(
      invocation.signal,
    );

    const combined = combineAbortSignals(invocation.signal, boundary.signal);
    const reason = new Error('Boss turn cancelled');
    boundary.abort(reason);

    expect(combined).not.toBe(invocation.signal);
    expect(combined).not.toBe(boundary.signal);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe(reason);
    expect(invocation.signal.aborted).toBe(false);
  });

  it('validates supplied signals at the shared boundary', () => {
    expect(combineAbortSignals().aborted).toBe(false);
    expect(() => combineAbortSignals(null as never)).toThrow(
      'must be an AbortSignal',
    );
  });
});

describe('nested XState playbook call bridge', () => {
  it('finishes an immediate child before resolving the promise actor', async () => {
    const events: string[] = [];
    const bridge = createNestedPlaybookBridge(
      bridgeOptions(events, async () => ({
        state: 'settled',
        result: {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'child-1',
          output: { accepted: true },
        },
      })),
    );
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    actor.subscribe((snapshot) => {
      if (snapshot.status === 'done') events.push('actor:done');
    });
    const completion = toPromise(actor);
    actor.start();

    await expect(completion).resolves.toEqual({ accepted: true });
    expect(events).toEqual([
      'drain',
      'started:call-1:review',
      'drain',
      'port:call-1:false',
      'finished:call-1:ok',
      'drain',
      'actor:done',
    ]);
    expect(bridge.getPendingCall()).toBeUndefined();
  });

  it.each([
    [
      'blank suspended child identity',
      { state: 'suspended', childSessionId: '' },
      'non-empty string',
    ],
    [
      'mismatched settled target',
      {
        state: 'settled',
        result: {
          status: 'ok',
          playbookId: 'other',
          childSessionId: 'child-1',
        },
      },
      'does not match review',
    ],
    [
      'undeclared settled result field',
      {
        state: 'settled',
        result: {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'child-1',
          internalState: 'must not cross the boundary',
        },
      },
      'is not a declared property',
    ],
  ])(
    'pairs a finish boundary for a malformed %s',
    async (_name, rawStart, expectedMessage) => {
      const events: string[] = [];
      const controlErrors: unknown[] = [];
      const options = bridgeOptions(events, async () => rawStart as never);
      options.onControlPlaneError = (error) => controlErrors.push(error);
      const bridge = createNestedPlaybookBridge(options);
      const actor = createActor(bridge.actorLogic, { input: INPUT });
      const completion = toPromise(actor);
      actor.start();

      await expect(completion).rejects.toThrow(expectedMessage);
      expect(controlErrors).toHaveLength(1);
      expect(events).toEqual([
        'drain',
        'started:call-1:review',
        'drain',
        'port:call-1:false',
        'finished:call-1:error',
        'drain',
      ]);
      expect(bridge.getPendingCall()).toBeUndefined();
    },
  );

  it('aborts and drains a malformed suspended child before finishing', async () => {
    const events: string[] = [];
    const controlErrors: unknown[] = [];
    const finishedResults: PlaybookCallResult[] = [];
    let observedSignal: AbortSignal | undefined;
    let releaseChildCleanup!: () => void;
    const childCleanupGate = new Promise<void>((resolve) => {
      releaseChildCleanup = resolve;
    });
    const options = bridgeOptions(events, async (_request, signal) => {
      observedSignal = signal;
      signal.addEventListener(
        'abort',
        () => {
          events.push('child:abort');
          registerPlaybookAbortCleanup(
            signal,
            childCleanupGate.then(() => {
              events.push('child:disposed');
            }),
          );
        },
        { once: true },
      );
      return {
        state: 'suspended',
        childSessionId: 'child-1',
        internalState: 'must not cross the boundary',
      } as never;
    });
    options.emitFinished = async (event) => {
      finishedResults.push(event.result);
      events.push(`finished:${event.callId}:${event.result.status}`);
    };
    options.onControlPlaneError = (error) => controlErrors.push(error);
    const bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    const completion = toPromise(actor);
    const completionFailure = expect(completion).rejects.toThrow(
      'is not a declared property',
    );
    actor.start();

    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    expect(events).toContain('child:abort');
    expect(events.some((event) => event.startsWith('finished:'))).toBe(false);

    releaseChildCleanup();
    await completionFailure;
    expect(controlErrors).toHaveLength(1);
    expect(events.slice(-4)).toEqual([
      'child:abort',
      'child:disposed',
      'finished:call-1:error',
      'drain',
    ]);
    expect(finishedResults).toHaveLength(1);
    expect(finishedResults[0]).toMatchObject({
      status: 'error',
      playbookId: 'review',
      childSessionId: 'child-1',
      error: { name: 'TypeError' },
    });
    expect(bridge.getPendingCall()).toBeUndefined();
  });

  it('does not publish a call when the entering-state drain fails', async () => {
    const events: string[] = [];
    const controlErrors: unknown[] = [];
    const options = bridgeOptions(events, async () => ({
      state: 'suspended',
      childSessionId: 'unreachable-child',
    }));
    options.drain = async () => {
      events.push('entering-drain');
      throw new Error('entering transition failed to drain');
    };
    options.onControlPlaneError = (error) => controlErrors.push(error);
    const bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    const completion = toPromise(actor);
    actor.start();

    await expect(completion).rejects.toThrow(
      'entering transition failed to drain',
    );
    expect(controlErrors).toHaveLength(1);
    expect(events).toEqual(['entering-drain']);
    expect(bridge.getPendingCall()).toBeUndefined();
  });

  it('pairs a finish after a published start fails to drain', async () => {
    const events: string[] = [];
    const controlErrors: unknown[] = [];
    const options = bridgeOptions(events, async () => ({
      state: 'suspended',
      childSessionId: 'unreachable-child',
    }));
    let drains = 0;
    options.drain = async () => {
      drains += 1;
      events.push(`drain:${drains}`);
      if (drains === 2) throw new Error('start drain failed');
    };
    options.onControlPlaneError = (error) => controlErrors.push(error);
    const bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    const completion = toPromise(actor);
    actor.start();

    await expect(completion).rejects.toThrow('start drain failed');
    expect(controlErrors).toHaveLength(1);
    expect(events).toEqual([
      'drain:1',
      'started:call-1:review',
      'drain:2',
      'finished:call-1:error',
      'drain:3',
    ]);
    expect(bridge.getPendingCall()).toBeUndefined();
  });

  it('attempts an error finish when the start sink records then rejects', async () => {
    const events: string[] = [];
    const startError = new Error('start sink rejected after recording');
    const options = bridgeOptions(events, async () => ({
      state: 'suspended',
      childSessionId: 'unreachable-child',
    }));
    options.emitStarted = async (event) => {
      events.push(`started:${event.callId}:${event.playbookId}`);
      throw startError;
    };
    const bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    const completion = toPromise(actor);
    actor.start();

    await expect(completion).rejects.toBe(startError);
    expect(events).toEqual([
      'drain',
      'started:call-1:review',
      'finished:call-1:error',
      'drain',
    ]);
    expect(bridge.getPendingCall()).toBeUndefined();
  });

  it.each(['throw', 'reject'] as const)(
    'pairs a finish when the child port %ss',
    async (failureMode) => {
      const events: string[] = [];
      const controlErrors: unknown[] = [];
      const options = bridgeOptions(events, async () => {
        throw new Error('child port rejected');
      });
      options.onControlPlaneError = (error) => controlErrors.push(error);
      if (failureMode === 'throw') {
        options.callPlaybook = () => {
          throw new Error('child port threw');
        };
      }
      const bridge = createNestedPlaybookBridge(options);
      const actor = createActor(bridge.actorLogic, { input: INPUT });
      const completion = toPromise(actor);
      actor.start();

      await expect(completion).rejects.toThrow(
        failureMode === 'throw' ? 'child port threw' : 'child port rejected',
      );
      expect(controlErrors).toHaveLength(1);
      expect(events.slice(-2)).toEqual(['finished:call-1:error', 'drain']);
      expect(bridge.getPendingCall()).toBeUndefined();
    },
  );

  it('combines the active boundary with the XState invocation lifetime', async () => {
    const events: string[] = [];
    const boundary = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let releaseOpening!: () => void;
    const openingGate = new Promise<void>((resolve) => {
      releaseOpening = resolve;
    });
    const options = bridgeOptions(events, (_request, signal) => {
      observedSignal = signal;
      const opening = openingGate.then(() => {
        events.push('opening:finished');
        return {
          state: 'settled' as const,
          result: {
            status: 'aborted' as const,
            playbookId: 'review',
            childSessionId: 'child-opening',
            error: { name: 'AbortError', message: 'Boss turn cancelled' },
          },
        };
      });
      signal.addEventListener(
        'abort',
        () => registerPlaybookAbortCleanup(signal, opening),
        { once: true },
      );
      return opening;
    });
    options.getBoundarySignal = () => boundary.signal;
    const bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    const completion = toPromise(actor);
    const completionFailure = expect(completion).rejects.toBeInstanceOf(
      NestedPlaybookCallError,
    );
    actor.start();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    const reason = new Error('Boss turn cancelled');
    boundary.abort(reason);
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    expect(observedSignal).not.toBe(boundary.signal);
    expect(observedSignal?.reason).toBe(reason);
    expect(events.some((event) => event.startsWith('finished:'))).toBe(false);

    releaseOpening();
    await completionFailure;
    expect(events.slice(-3)).toEqual([
      'opening:finished',
      'finished:call-1:aborted',
      'drain',
    ]);
    await bridge.dispose();
  });

  it('suspends one call, validates its full identity, then resumes it', async () => {
    const events: string[] = [];
    let resumedSignal: AbortSignal | undefined;
    const options = bridgeOptions(events, async () => ({
      state: 'suspended',
      childSessionId: 'child-1',
    }));
    options.bindResumeSignal = (signal) => {
      resumedSignal = signal;
      events.push('signal:bound');
    };
    const bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    actor.subscribe((snapshot) => {
      if (snapshot.status === 'done') events.push('actor:done');
    });
    const completion = toPromise(actor);
    const pending = pendingCall(bridge);
    actor.start();

    await expect(pending).resolves.toEqual({
      callId: 'call-1',
      playbookId: 'review',
      childSessionId: 'child-1',
    });
    await expect(
      bridge.resume({
        callId: 'stale-call',
        result: {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'child-1',
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('does not match call-1');
    await expect(
      bridge.resume({
        callId: 'call-1',
        result: {
          status: 'aborted',
          playbookId: 'review',
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('does not match child-1');
    await expect(
      bridge.resume({
        callId: 'call-1',
        result: {
          status: 'ok',
          playbookId: 'other',
          childSessionId: 'child-1',
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('does not match review');
    expect(bridge.getPendingCall()?.callId).toBe('call-1');

    const signal = new AbortController().signal;
    await bridge.resume({
      callId: 'call-1',
      result: {
        status: 'ok',
        playbookId: 'review',
        childSessionId: 'child-1',
        output: ['approved'],
      },
      signal,
    });
    await expect(completion).resolves.toEqual(['approved']);
    await expect(
      bridge.resume({
        callId: 'call-1',
        result: {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'child-1',
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('unknown or stale playbook call id call-1');
    expect(resumedSignal).toBe(signal);
    expect(events.slice(-4)).toEqual([
      'signal:bound',
      'finished:call-1:ok',
      'drain',
      'actor:done',
    ]);
  });

  it('treats a resume that races invocation abort as aborted', async () => {
    const events: string[] = [];
    let bridge!: ReturnType<typeof createNestedPlaybookBridge>;
    let racingResume: Promise<void> | undefined;
    const options = bridgeOptions(events, async (_request, signal) => {
      signal.addEventListener(
        'abort',
        () => {
          racingResume = bridge.resume({
            callId: 'call-1',
            result: {
              status: 'ok',
              playbookId: 'review',
              childSessionId: 'child-1',
              output: { stale: 'success' },
            },
            signal: new AbortController().signal,
          });
        },
        { once: true },
      );
      return { state: 'suspended', childSessionId: 'child-1' };
    });
    bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    const completion = toPromise(actor);
    actor.start();
    await pendingCall(bridge);

    actor.stop();

    await expect(racingResume).resolves.toBeUndefined();
    await expect(completion).resolves.toBeUndefined();
    expect(events.slice(-2)).toEqual(['finished:call-1:aborted', 'drain']);
    await bridge.dispose();
  });

  it('terminally rejects a suspended call for a non-identity result schema error', async () => {
    const events: string[] = [];
    const controlErrors: unknown[] = [];
    const options = bridgeOptions(events, async () => ({
      state: 'suspended',
      childSessionId: 'child-1',
    }));
    options.onControlPlaneError = (error) => controlErrors.push(error);
    const bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    const completion = toPromise(actor);
    const completionFailure =
      expect(completion).rejects.toThrow('finite JSON number');
    actor.start();
    await pendingCall(bridge);

    await expect(
      bridge.resume({
        callId: 'call-1',
        result: {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'child-1',
          output: { score: Number.NaN },
        } as never,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('finite JSON number');
    await completionFailure;

    expect(controlErrors).toHaveLength(1);
    expect(controlErrors[0]).toBeInstanceOf(TypeError);
    expect(events.slice(-2)).toEqual(['finished:call-1:error', 'drain']);
    expect(bridge.getPendingCall()).toBeUndefined();
    await expect(
      bridge.resume({
        callId: 'call-1',
        result: {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'child-1',
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('unknown or stale playbook call id call-1');
    await expect(bridge.dispose()).resolves.toBeUndefined();
  });

  it('rejects a second outstanding call and preserves the first', async () => {
    const events: string[] = [];
    const bridge = createNestedPlaybookBridge(
      bridgeOptions(events, async () => ({
        state: 'suspended',
        childSessionId: 'child-1',
      })),
    );
    const first = createActor(bridge.actorLogic, { input: INPUT });
    const firstCompletion = toPromise(first);
    first.start();
    await pendingCall(bridge);

    const second = createActor(bridge.actorLogic, { input: INPUT });
    const secondCompletion = toPromise(second);
    second.start();
    await expect(secondCompletion).rejects.toThrow(
      'call-1 is already outstanding',
    );
    expect(bridge.getPendingCall()?.callId).toBe('call-1');

    await bridge.dispose();
    await expect(firstCompletion).rejects.toBeInstanceOf(
      NestedPlaybookCallError,
    );
    expect(events.slice(-2)).toEqual(['finished:call-1:aborted', 'drain']);
  });

  it('awaits signal-triggered finish settlement during disposal', async () => {
    const events: string[] = [];
    let releaseFinish!: () => void;
    const finishGate = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    const options = bridgeOptions(events, async () => ({
      state: 'suspended',
      childSessionId: 'child-1',
    }));
    options.emitFinished = async (event) => {
      events.push(`finishing:${event.callId}`);
      await finishGate;
      events.push(`finished:${event.callId}:${event.result.status}`);
    };
    const bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    actor.start();
    await pendingCall(bridge);

    actor.stop();
    await vi.waitFor(() => expect(events).toContain('finishing:call-1'));
    let disposed = false;
    const disposal = bridge.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseFinish();
    await disposal;
    expect(events.slice(-2)).toEqual(['finished:call-1:aborted', 'drain']);
  });

  it('drains registered abort cleanup before emitting the parent finish boundary', async () => {
    const events: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const bridge = createNestedPlaybookBridge(
      bridgeOptions(events, async (_request, signal) => {
        signal.addEventListener(
          'abort',
          () => {
            events.push('cleanup:started');
            const cleanup = cleanupGate.then(() => {
              events.push('cleanup:finished');
            });
            registerPlaybookAbortCleanup(signal, cleanup);
          },
          { once: true },
        );
        return {
          state: 'suspended',
          childSessionId: 'child-1',
        };
      }),
    );
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    actor.start();
    await pendingCall(bridge);

    actor.stop();
    await vi.waitFor(() => expect(events).toContain('cleanup:started'));
    expect(events.some((event) => event.startsWith('finished:'))).toBe(false);
    const disposal = bridge.dispose();
    releaseCleanup();
    await disposal;

    expect(events.slice(-3)).toEqual([
      'cleanup:finished',
      'finished:call-1:aborted',
      'drain',
    ]);
    expect(bridge.getPendingCall()).toBeUndefined();
  });

  it('reports abort-cleanup failure and records an error finish', async () => {
    const events: string[] = [];
    const controlErrors: unknown[] = [];
    const options = bridgeOptions(events, async (_request, signal) => {
      signal.addEventListener(
        'abort',
        () => {
          registerPlaybookAbortCleanup(
            signal,
            Promise.reject(new Error('child cleanup failed')),
          );
        },
        { once: true },
      );
      return {
        state: 'suspended',
        childSessionId: 'child-1',
      };
    });
    options.onControlPlaneError = (error) => controlErrors.push(error);
    const bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    actor.start();
    await pendingCall(bridge);

    actor.stop();
    await expect(bridge.dispose()).rejects.toThrow('child cleanup failed');

    expect(controlErrors).toHaveLength(1);
    expect((controlErrors[0] as Error).message).toBe('child cleanup failed');
    expect(events.slice(-2)).toEqual(['finished:call-1:error', 'drain']);
    expect(bridge.getPendingCall()).toBeUndefined();
  });

  it('aborts and drains disposal while the child is still opening', async () => {
    const events: string[] = [];
    let observedSignal: AbortSignal | undefined;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const bridge = createNestedPlaybookBridge(
      bridgeOptions(events, async (_request, signal) => {
        observedSignal = signal;
        await startGate;
        return {
          state: 'suspended',
          childSessionId: 'late-child',
        };
      }),
    );
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    const completion = toPromise(actor);
    actor.start();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    let disposed = false;
    const disposal = bridge.dispose().then(() => {
      disposed = true;
    });
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseStart();
    await disposal;
    expect(disposed).toBe(true);
    await expect(completion).rejects.toBeInstanceOf(NestedPlaybookCallError);
    expect(events.slice(-2)).toEqual(['finished:call-1:aborted', 'drain']);
    expect(bridge.getPendingCall()).toBeUndefined();
    expect(events.filter((event) => event.startsWith('finished:'))).toEqual([
      'finished:call-1:aborted',
    ]);
  });

  it('drains its opening promise before an aborted finish', async () => {
    const events: string[] = [];
    const finishedResults: PlaybookCallResult[] = [];
    let observedSignal: AbortSignal | undefined;
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const options = bridgeOptions(events, async () => {
      throw new Error('overridden below');
    });
    options.callPlaybook = (_request, signal) => {
      observedSignal = signal;
      return cleanupGate.then(() => {
        events.push('opening-cleanup:finished');
        return {
          state: 'settled' as const,
          result: {
            status: 'aborted' as const,
            playbookId: 'review',
            childSessionId: 'child-opening',
            error: { name: 'AbortError', message: 'opening cancelled' },
          },
        };
      });
    };
    options.emitFinished = async (event) => {
      finishedResults.push(event.result);
      events.push(`finished:${event.callId}:${event.result.status}`);
    };
    const bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    const completion = toPromise(actor);
    actor.start();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    let abortSettled = false;
    const aborting = bridge
      .abortPending(new Error('opening cancelled'))
      .then(() => {
        abortSettled = true;
      });
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    await Promise.resolve();
    expect(abortSettled).toBe(false);
    expect(events.some((event) => event.startsWith('finished:'))).toBe(false);

    releaseCleanup();
    await aborting;
    await expect(completion).rejects.toBeInstanceOf(NestedPlaybookCallError);
    expect(events.slice(-3)).toEqual([
      'opening-cleanup:finished',
      'finished:call-1:aborted',
      'drain',
    ]);
    expect(finishedResults).toEqual([
      expect.objectContaining({ childSessionId: 'child-opening' }),
    ]);
    await bridge.dispose();
  });

  it('keeps an abort-like late opening rejection as an authored abort', async () => {
    const events: string[] = [];
    let observedSignal: AbortSignal | undefined;
    let rejectOpening!: (error: unknown) => void;
    const opening = new Promise<PlaybookCallStart>((_resolve, reject) => {
      rejectOpening = reject;
    });
    const bridge = createNestedPlaybookBridge(
      bridgeOptions(events, async (_request, signal) => {
        observedSignal = signal;
        return opening;
      }),
    );
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    const completion = toPromise(actor);
    actor.start();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    const aborting = bridge.abortPending(new Error('opening cancelled'));
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    rejectOpening(new DOMException('opening cancelled', 'AbortError'));

    await expect(aborting).resolves.toBeUndefined();
    await expect(completion).rejects.toBeInstanceOf(NestedPlaybookCallError);
    expect(events.slice(-2)).toEqual(['finished:call-1:aborted', 'drain']);
    await bridge.dispose();
  });

  it('promotes a non-abort late opening rejection to a control error', async () => {
    const events: string[] = [];
    const controlErrors: unknown[] = [];
    let observedSignal: AbortSignal | undefined;
    let rejectOpening!: (error: unknown) => void;
    const opening = new Promise<PlaybookCallStart>((_resolve, reject) => {
      rejectOpening = reject;
    });
    const options = bridgeOptions(events, async (_request, signal) => {
      observedSignal = signal;
      return opening;
    });
    options.onControlPlaneError = (error) => controlErrors.push(error);
    const bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    const completion = toPromise(actor);
    actor.start();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    const aborting = bridge.abortPending(new Error('opening cancelled'));
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    rejectOpening(new Error('late opening failed'));

    await expect(aborting).rejects.toThrow('late opening failed');
    await expect(completion).rejects.toThrow('late opening failed');
    expect(controlErrors).toHaveLength(1);
    expect(events.slice(-2)).toEqual(['finished:call-1:error', 'drain']);
    await expect(bridge.dispose()).resolves.toBeUndefined();
  });

  it('reports an instant opening-cleanup rejection before finishing', async () => {
    const events: string[] = [];
    const controlErrors: unknown[] = [];
    let observedSignal: AbortSignal | undefined;
    const options = bridgeOptions(events, (_request, signal) => {
      observedSignal = signal;
      return new Promise<PlaybookCallStart>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            registerPlaybookAbortCleanup(
              signal,
              Promise.reject(new Error('instant opening cleanup failed')),
            );
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    options.onControlPlaneError = (error) => controlErrors.push(error);
    const bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    const completion = toPromise(actor);
    actor.start();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    const completionFailure = expect(completion).rejects.toThrow(
      'instant opening cleanup failed',
    );

    await expect(
      bridge.abortPending(new Error('opening cancelled')),
    ).rejects.toThrow('instant opening cleanup failed');
    await completionFailure;
    expect(controlErrors).toHaveLength(1);
    expect((controlErrors[0] as Error).message).toBe(
      'instant opening cleanup failed',
    );
    expect(events.slice(-2)).toEqual(['finished:call-1:error', 'drain']);
    expect(bridge.getPendingCall()).toBeUndefined();
    await expect(bridge.dispose()).resolves.toBeUndefined();
  });

  it('finishes an error result before rejecting the promise actor', async () => {
    const events: string[] = [];
    const result: PlaybookCallResult = {
      status: 'error',
      playbookId: 'review',
      childSessionId: 'child-1',
      error: { name: 'ChildFailure', message: 'review failed' },
    };
    const bridge = createNestedPlaybookBridge(
      bridgeOptions(events, async () => ({ state: 'settled', result })),
    );
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    actor.subscribe({
      error: () => events.push('actor:error'),
    });
    const completion = toPromise(actor);
    actor.start();

    await expect(completion).rejects.toMatchObject({
      name: 'ChildFailure',
      result,
    });
    expect(events.slice(-3)).toEqual([
      'finished:call-1:error',
      'drain',
      'actor:error',
    ]);
  });

  it.each(['emit', 'drain'] as const)(
    'terminally clears an immediate call when finish %s fails',
    async (failureStage) => {
      const events: string[] = [];
      const controlErrors: unknown[] = [];
      let finishing = false;
      const options = bridgeOptions(events, async () => ({
        state: 'settled',
        result: {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'child-1',
        },
      }));
      const baseDrain = options.drain;
      options.emitFinished = async () => {
        finishing = true;
        if (failureStage === 'emit') {
          throw new Error('finish emission failed');
        }
        events.push('finished:call-1:ok');
      };
      options.drain = async () => {
        if (finishing && failureStage === 'drain') {
          throw new Error('finish drain failed');
        }
        await baseDrain();
      };
      options.onControlPlaneError = (error) => controlErrors.push(error);
      const bridge = createNestedPlaybookBridge(options);
      const actor = createActor(bridge.actorLogic, { input: INPUT });
      const completion = toPromise(actor);
      actor.start();

      await expect(completion).rejects.toThrow(
        failureStage === 'emit'
          ? 'finish emission failed'
          : 'finish drain failed',
      );
      expect(controlErrors).toHaveLength(1);
      expect(bridge.getPendingCall()).toBeUndefined();
      await expect(bridge.dispose()).resolves.toBeUndefined();
    },
  );

  it.each(['emit', 'drain'] as const)(
    'terminally rejects a suspended invocation when finish %s fails',
    async (failureStage) => {
      const events: string[] = [];
      const controlErrors: unknown[] = [];
      let finishing = false;
      const options = bridgeOptions(events, async () => ({
        state: 'suspended',
        childSessionId: 'child-1',
      }));
      const baseDrain = options.drain;
      options.emitFinished = async () => {
        finishing = true;
        if (failureStage === 'emit') {
          throw new Error('finish emission failed');
        }
        events.push('finished:call-1:ok');
      };
      options.drain = async () => {
        if (finishing && failureStage === 'drain') {
          throw new Error('finish drain failed');
        }
        await baseDrain();
      };
      options.onControlPlaneError = (error) => controlErrors.push(error);
      const bridge = createNestedPlaybookBridge(options);
      const actor = createActor(bridge.actorLogic, { input: INPUT });
      const completion = toPromise(actor);
      const completionFailure = expect(completion).rejects.toThrow(
        failureStage === 'emit'
          ? 'finish emission failed'
          : 'finish drain failed',
      );
      actor.start();
      await pendingCall(bridge);

      await expect(
        bridge.resume({
          callId: 'call-1',
          result: {
            status: 'ok',
            playbookId: 'review',
            childSessionId: 'child-1',
          },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(
        failureStage === 'emit'
          ? 'finish emission failed'
          : 'finish drain failed',
      );
      await completionFailure;
      expect(controlErrors).toHaveLength(1);
      expect(bridge.getPendingCall()).toBeUndefined();
      await expect(
        bridge.resume({
          callId: 'call-1',
          result: {
            status: 'ok',
            playbookId: 'review',
            childSessionId: 'child-1',
          },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('unknown or stale playbook call id call-1');
      await expect(bridge.dispose()).resolves.toBeUndefined();
    },
  );

  it('turns a non-JSON-safe port result into a traced control error', async () => {
    const events: string[] = [];
    const controlErrors: unknown[] = [];
    const options = bridgeOptions(
      events,
      async () =>
        ({
          state: 'settled',
          result: {
            status: 'ok',
            playbookId: 'review',
            childSessionId: 'child-1',
            output: { score: Number.NaN },
          },
        }) as never,
    );
    options.onControlPlaneError = (error) => controlErrors.push(error);
    const bridge = createNestedPlaybookBridge(options);
    const actor = createActor(bridge.actorLogic, { input: INPUT });
    const completion = toPromise(actor);
    actor.start();

    await expect(completion).rejects.toThrow('finite JSON number');
    expect(controlErrors).toHaveLength(1);
    expect(controlErrors[0]).toBeInstanceOf(TypeError);
    expect(events.slice(-2)).toEqual(['finished:call-1:error', 'drain']);
    expect(bridge.getPendingCall()).toBeUndefined();
    await expect(bridge.dispose()).resolves.toBeUndefined();
  });
});

describe('JSON boundary validation', () => {
  it('rejects values JSON would change or cannot encode', () => {
    expect(() => assertJsonSafe({ value: undefined })).toThrow(
      '$.value must be a JSON value',
    );
    expect(() => assertJsonSafe({ value: Number.NaN })).toThrow(
      'finite JSON number',
    );
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => assertJsonSafe(cyclic)).toThrow('JSON cycle');
  });

  it('rejects non-plain, hidden, accessor, symbol, and sparse data', () => {
    expect(() => assertJsonSafe(new Date())).toThrow('must be a JSON value');
    expect(() => assertJsonSafe(new Map())).toThrow('must be a JSON value');

    const hidden = {};
    Object.defineProperty(hidden, 'secret', { value: 'omitted' });
    expect(() => assertJsonSafe(hidden)).toThrow(
      'must be an enumerable JSON property',
    );

    const getter = vi.fn(() => 'not evaluated');
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: getter,
    });
    expect(() => assertJsonSafe(accessor)).toThrow(
      'must be a JSON data property',
    );
    expect(getter).not.toHaveBeenCalled();

    expect(() => assertJsonSafe({ [Symbol('secret')]: true })).toThrow(
      'symbol-keyed',
    );
    expect(() => assertJsonSafe(new Array(1))).toThrow(
      'must not be a sparse JSON array',
    );
  });

  it('preserves __proto__ as an own JSON and state-value property', () => {
    const source = JSON.parse(
      '{"__proto__":{"owned":true},"nested":{"__proto__":"value"}}',
    ) as Record<string, JsonValue>;
    const json = snapshotJsonValue(source) as Record<string, JsonValue>;
    const nested = json.nested as Record<string, JsonValue>;

    expect(Object.hasOwn(json, '__proto__')).toBe(true);
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(JSON.stringify(json)).toBe(JSON.stringify(source));
    expect(Object.isFrozen(json)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);

    const rawStateValue = JSON.parse(
      '{"__proto__":"root","round":{"__proto__":"working"}}',
    ) as Record<string, unknown>;
    const state = normalizePlaybookSnapshot({
      value: rawStateValue,
      status: 'active',
      tags: new Set<string>(),
      getMeta: () => ({}),
    });
    const stateValue = state.value as Record<string, PlaybookStateValue>;
    const round = stateValue.round as Record<string, PlaybookStateValue>;

    expect(Object.hasOwn(stateValue, '__proto__')).toBe(true);
    expect(Object.hasOwn(round, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(stateValue)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(round)).toBe(Object.prototype);
    expect(stateValue).toEqual(rawStateValue);
  });

  it('snapshots object and array Proxies without re-reading their members', () => {
    const objectGet = vi.fn(() => {
      throw new Error('object member was re-read');
    });
    const arrayGet = vi.fn(() => {
      throw new Error('array member was re-read');
    });
    const objectSource = new Proxy(
      { value: 'descriptor value', nested: { safe: true } },
      { get: objectGet },
    );
    const arraySource = new Proxy([1, { value: 'array descriptor' }], {
      get: arrayGet,
    });

    const objectSnapshot = snapshotJsonValue(objectSource);
    const arraySnapshot = snapshotJsonValue(arraySource);

    expect(objectSnapshot).toEqual({
      value: 'descriptor value',
      nested: { safe: true },
    });
    expect(arraySnapshot).toEqual([1, { value: 'array descriptor' }]);
    expect(objectGet).not.toHaveBeenCalled();
    expect(arrayGet).not.toHaveBeenCalled();
    expect(Object.isFrozen(objectSnapshot)).toBe(true);
    expect(Object.isFrozen(arraySnapshot)).toBe(true);
  });

  it('snapshots host-owned JSON and session identity', () => {
    const source = {
      catalog: [{ id: 'code', intent: 'Build it.' }],
    };
    const json = snapshotJsonValue(source);
    source.catalog[0]!.intent = 'mutated';
    expect(json).toEqual({
      catalog: [{ id: 'code', intent: 'Build it.' }],
    });
    expect(Object.isFrozen(json)).toBe(true);
    expect(
      Object.isFrozen((json as { catalog: readonly unknown[] }).catalog),
    ).toBe(true);

    const ports = {
      callPlayer: vi.fn(),
      callCaptain: vi.fn(),
      callJudge: vi.fn(),
      callPlaybook: vi.fn(),
      emitStatus: vi.fn(),
      emitTelemetry: vi.fn(),
    };
    const originalEmitStatus = ports.emitStatus;
    const input = {
      sessionId: 'root-1',
      playbookId: 'captain',
      rootSessionId: 'root-1',
      depth: 0,
      ports,
    };
    const session = snapshotPlaybookSession(input);
    input.sessionId = 'mutated';
    ports.emitStatus = vi.fn();
    expect(session.sessionId).toBe('root-1');
    expect(session.ports.emitStatus).toBe(originalEmitStatus);
    expect(session.ports).not.toBe(ports);
    expect(Object.isFrozen(session.ports)).toBe(true);
    expect(Object.isFrozen(session)).toBe(true);

    expect(() =>
      snapshotPlaybookSession({
        ...input,
        sessionId: 'root-2',
        rootSessionId: 'other',
      }),
    ).toThrow('must be its own rootSessionId');
    expect(() =>
      snapshotPlaybookSession({
        ...input,
        sessionId: 'child-1',
        rootSessionId: 'root-1',
        depth: 1,
      }),
    ).toThrow('parentSessionId');
    expect(() =>
      snapshotPlaybookSession({
        sessionId: 'root-1',
        playbookId: 'captain',
        rootSessionId: 'root-1',
        parentSessionId: 'root-1',
        parentCallId: 'call-1',
        depth: 1,
        ports,
      }),
    ).toThrow('must differ from its root and parent');
    expect(() =>
      snapshotPlaybookSession({
        sessionId: 'parent-1',
        playbookId: 'captain',
        rootSessionId: 'root-1',
        parentSessionId: 'parent-1',
        parentCallId: 'call-2',
        depth: 2,
        ports,
      }),
    ).toThrow('must differ from its root and parent');
    expect(() =>
      snapshotPlaybookSession({
        sessionId: 'root-1',
        playbookId: 'captain',
        rootSessionId: 'root-1',
        parentSessionId: undefined,
        depth: 0,
        ports,
      }),
    ).toThrow('must not carry parent identity');
  });

  it('captures session identity and ports from own data descriptors once', () => {
    const ports = {
      callPlayer: vi.fn(),
      callCaptain: vi.fn(),
      callJudge: vi.fn(),
      callPlaybook: vi.fn(),
      emitStatus: vi.fn(),
      emitTelemetry: vi.fn(),
    };
    const sessionGet = vi.fn(() => {
      throw new Error('session member was re-read');
    });
    const portsGet = vi.fn(() => {
      throw new Error('port member was re-read');
    });
    const proxiedPorts = new Proxy(ports, { get: portsGet });
    const proxiedSession = new Proxy(
      {
        sessionId: 'root-proxy',
        playbookId: 'captain',
        rootSessionId: 'root-proxy',
        depth: 0,
        ports: proxiedPorts,
      },
      { get: sessionGet },
    );

    const session = snapshotPlaybookSession(proxiedSession);

    expect(session).toMatchObject({
      sessionId: 'root-proxy',
      playbookId: 'captain',
      rootSessionId: 'root-proxy',
      depth: 0,
    });
    expect(session.ports.callCaptain).toBe(ports.callCaptain);
    expect(sessionGet).not.toHaveBeenCalled();
    expect(portsGet).not.toHaveBeenCalled();

    const accessor = {
      playbookId: 'captain',
      rootSessionId: 'root-accessor',
      depth: 0,
      ports,
    } as Record<string, unknown>;
    const getter = vi.fn(() => 'root-accessor');
    Object.defineProperty(accessor, 'sessionId', {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      snapshotPlaybookSession(
        accessor as unknown as Parameters<typeof snapshotPlaybookSession>[0],
      ),
    ).toThrow('must be an own data property');
    expect(getter).not.toHaveBeenCalled();
  });

  it('validates, detaches, and freezes exact host actor results', () => {
    const captainInput = {
      status: 'ok' as const,
      finalText: 'I handled it directly.',
    };
    const playerInput = {
      status: 'error' as const,
      resumeToken: 'player-session-1',
      error: 'The delegated task failed.',
    };

    const captainResult = validateCaptainResult(captainInput);
    const playerResult = validatePlayerResult(playerInput);
    captainInput.finalText = 'mutated';
    playerInput.resumeToken = 'mutated';

    expect(captainResult).toEqual({
      status: 'ok',
      finalText: 'I handled it directly.',
    });
    expect(playerResult).toEqual({
      status: 'error',
      resumeToken: 'player-session-1',
      error: 'The delegated task failed.',
    });
    expect(Object.isFrozen(captainResult)).toBe(true);
    expect(Object.isFrozen(playerResult)).toBe(true);

    expect(() =>
      validateCaptainResult({ status: 'ok', resumeToken: 'not allowed' }),
    ).toThrow('not a declared property');
    expect(() =>
      validatePlayerResult({ status: 'ok', finalText: undefined }),
    ).toThrow('must be a JSON value');
    expect(() => validatePlayerResult({ status: 'done' })).toThrow(
      'status is invalid',
    );
    expect(() =>
      validateCaptainResult({ status: 'ok', finalText: 42 }),
    ).toThrow('finalText must be a string');
  });

  it('normalizes Error and JSON error-like values consistently', () => {
    expect(
      normalizeError({ name: 'ChildFailure', message: 'review failed' }),
    ).toEqual({ name: 'ChildFailure', message: 'review failed' });

    const hostile = new Error('hidden');
    Object.defineProperties(hostile, {
      name: {
        get: () => {
          throw new Error('name trap');
        },
      },
      message: {
        get: () => {
          throw new Error('message trap');
        },
      },
      stack: {
        get: () => {
          throw new Error('stack trap');
        },
      },
    });
    expect(normalizeError(hostile)).toEqual({
      name: 'Error',
      message: 'Unknown error',
    });
  });

  it('validates exact nested-call and structured-state schemas', () => {
    expect(
      validatePlaybookCallStart(
        { state: 'suspended', childSessionId: 'child-1' },
        'review',
      ),
    ).toEqual({ state: 'suspended', childSessionId: 'child-1' });

    expect(() =>
      validatePlaybookCallResult(
        {
          status: 'ok',
          playbookId: 'review',
          childSessionId: 'child-1',
          state: {
            value: 'parked',
            activeStateIds: ['parked'],
            tags: ['playbook.parked'],
            status: 'active',
            quiescent: true,
            stateId: 'other',
          },
        },
        'review',
      ),
    ).toThrow('must equal the sole active state id');
    expect(() =>
      validatePlaybookCallResult(
        {
          status: 'error',
          playbookId: 'review',
          childSessionId: 'child-1',
        },
        'review',
      ),
    ).toThrow('requires a normalized error');

    const mutable = {
      status: 'ok' as const,
      playbookId: 'review',
      childSessionId: 'child-1',
      output: { summary: 'original' },
    };
    const validated = validatePlaybookCallResult(mutable, 'review');
    mutable.output.summary = 'mutated';
    expect(validated.output).toEqual({ summary: 'original' });
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.output)).toBe(true);
  });

  it('validates nested starts and results from one detached Proxy snapshot', () => {
    const resultGet = vi.fn(() => {
      throw new Error('result member was re-read');
    });
    const startGet = vi.fn(() => {
      throw new Error('start member was re-read');
    });
    const result = new Proxy(
      {
        status: 'ok' as const,
        playbookId: 'review',
        childSessionId: 'child-proxy',
        output: { summary: 'descriptor result' },
      },
      { get: resultGet },
    );
    const start = new Proxy(
      { state: 'settled' as const, result },
      { get: startGet },
    );

    const validatedResult = validatePlaybookCallResult(result, 'review');
    const validatedStart = validatePlaybookCallStart(start, 'review');

    expect(validatedResult).toEqual({
      status: 'ok',
      playbookId: 'review',
      childSessionId: 'child-proxy',
      output: { summary: 'descriptor result' },
    });
    expect(validatedStart).toEqual({
      state: 'settled',
      result: validatedResult,
    });
    expect(resultGet).not.toHaveBeenCalled();
    expect(startGet).not.toHaveBeenCalled();
    expect(Object.isFrozen(validatedResult)).toBe(true);
    expect(Object.isFrozen(validatedStart)).toBe(true);
  });
});
