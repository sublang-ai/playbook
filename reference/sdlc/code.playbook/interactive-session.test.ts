// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createManagedInteractiveLifecycle,
  createManagedInteractiveSessionCommand,
  MANAGED_INTERACTIVE_PAYLOAD_FILE,
  MANAGED_INTERACTIVE_PAYLOAD_KIND,
  MANAGED_INTERACTIVE_READINESS_WITNESS_FILE,
  MANAGED_INTERACTIVE_PAYLOAD_SCHEMA_VERSION,
  publishManagedInteractiveReadinessWitness,
  runManagedInteractiveSessionChild,
  runManagedInteractiveSessionChildEntry,
  validateManagedInteractivePayload,
} from './bin/interactive-session.js';
import { captainOptionsFromConfig } from './bin/run.js';
import {
  createCaptainSessionStore,
  projectCaptainSessionStructure,
} from './bin/session-store.js';
import {
  PLAYBOOK_CAPTAIN_MODULE,
  projectHostAgent,
} from './bin/launch-config.js';
import { emptyPlaybookEffectLedger } from '../../../src/xstate-runtime.js';

const logicalSessionId = '90000000-0000-4000-8000-000000000041';
const internalSessionId = '80000000-0000-4000-8000-000000000041';
const retainedFrameSessionId = '80000000-0000-4000-8000-000000000042';
const attemptId = '90000000-0000-4000-8000-000000000042';
const predecessorSessionId = '90000000-0000-4000-8000-000000000043';
const olderPredecessorSessionId =
  '90000000-0000-4000-8000-000000000044';
const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('managed interactive Captain lifecycle (PBCLI-49/50/56/84)', () => {
  it('rejects a mismatched tmux snapshot before lease acquisition', async () => {
    const fixture = await lifecycleFixture();
    let acquired = 0;
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: {
        sessionsDir: fixture.sessionsDir,
        async acquire() {
          acquired += 1;
          throw new Error('must not acquire');
        },
      },
    });
    await expect(
      lifecycle.initializeRuntime({
        ...fixture.context,
        config: { ...fixture.context.config, players: [] },
      }),
    ).rejects.toThrow(/player roster does not match/);
    expect(acquired).toBe(0);
  });

  it('presents a replay-source failure after the source without dispatcher re-entry', async () => {
    const fixture = await lifecycleFixture();
    const order: string[] = [];
    const appended: Array<{ record: unknown; role: unknown }> = [];
    const presentedWarnings: unknown[] = [];
    const rawStderr: string[] = [];
    let hostObservers: any[] = [];
    let liveStatus = {
      lastReadableSeq: 0,
      lastDurableSeq: 0,
      incomplete: false,
    };
    const presentationGate = {
      async onRecord(record: any) {
        if (record.type === 'captain_status') {
          order.push('present:warning');
          presentedWarnings.push(record);
          return;
        }
        order.push(`present:${record.type}`);
      },
    };
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      stderr: {
        write(value: unknown) {
          rawStderr.push(String(value));
          return true;
        },
      },
      sessionStore: {
        ...fixture.store,
        async acquire(sessionId: string) {
          const owned = await fixture.store.acquire(sessionId);
          return {
            ...owned,
            async append(record: unknown, role: unknown) {
              if (liveStatus.incomplete) return;
              order.push(`append:${(record as any).type}`);
              appended.push({ record, role });
              liveStatus = { ...liveStatus, incomplete: true };
              throw new Error('synthetic managed replay append failure');
            },
            streamStatus: () => liveStatus,
            async release() {
              await owned.release();
              return liveStatus;
            },
          };
        },
      },
      createSessionHost: async (options: any) => {
        hostObservers = [...options.observers];
        const snapshot = shellSnapshot(fixture.execution, 0);
        return {
          host: fakeHost([]),
          shell: {
            async installRetainedGenerations() {},
            exportSnapshot: () => snapshot,
          },
          snapshot,
        };
      },
    });

    const runtime = await lifecycle.initializeRuntime({
      ...fixture.context,
      observers: [presentationGate],
    });
    expect(hostObservers).toHaveLength(2);
    expect(hostObservers[0]).toBe(presentationGate);

    const source = {
      type: 'player_event',
      turnId: 1,
      timestamp: 1,
      playerId: 'dev.coder',
      event: { type: 'text_delta', role: 'reviewer', text: 'open block' },
    };
    for (const observer of hostObservers) await observer.onRecord(source);
    const later = { type: 'turn_finished', turnId: 1, timestamp: 2 };
    for (const observer of hostObservers) await observer.onRecord(later);

    expect(order).toEqual([
      'present:player_event',
      'append:player_event',
      'present:warning',
      'present:turn_finished',
    ]);
    expect(appended).toEqual([{ record: source, role: undefined }]);
    expect(presentedWarnings).toEqual([
      {
        type: 'captain_status',
        turnId: null,
        timestamp: expect.any(Number),
        message:
          `warning: replay history for session ` +
          `${JSON.stringify(logicalSessionId)} may be incomplete; ` +
          'recording has stopped',
      },
    ]);
    expect(rawStderr).toEqual([]);

    await runtime.dispose();
    await lifecycle.shutdown();
    expect(presentedWarnings).toHaveLength(1);
  });

  it.each([
    'initialization',
    'sanitization',
    'append',
    'first-publication directory sync',
    'torn-tail repair',
    'settlement checkpoint',
    'release checkpoint',
  ] as const)(
    'attempts one presentation warning at the completed %s boundary',
    async (boundary) => {
      const fixture = await lifecycleFixture();
      const events: string[] = [];
      const warningAttempts: unknown[] = [];
      const rawStderr: string[] = [];
      let snapshot = shellSnapshot(fixture.execution, 0);
      let liveStatus = {
        lastReadableSeq: 0,
        lastDurableSeq: 0,
        incomplete:
          boundary === 'initialization' || boundary === 'torn-tail repair',
      };
      const presentationGate = {
        async onRecord(record: any) {
          if (record.type !== 'captain_status') {
            events.push(`source:${record.topic ?? record.type}`);
            return;
          }
          events.push('warning');
          warningAttempts.push(record);
          throw new Error('synthetic managed warning presentation failure');
        },
      };
      const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
        stderr: {
          write(value: unknown) {
            rawStderr.push(String(value));
            return true;
          },
        },
        sessionStore: {
          ...fixture.store,
          async acquire(sessionId: string) {
            const owned = await fixture.store.acquire(sessionId);
            let sourceFailurePending = [
              'sanitization',
              'append',
              'first-publication directory sync',
            ].includes(boundary);
            const latch = () => {
              liveStatus = { ...liveStatus, incomplete: true };
            };
            const adopt = (status: typeof liveStatus) => {
              if (!liveStatus.incomplete) liveStatus = status;
              return liveStatus;
            };
            return {
              ...owned,
              async append(record: unknown, role: unknown) {
                if (liveStatus.incomplete) return;
                if (sourceFailurePending) {
                  sourceFailurePending = false;
                  if (boundary === 'sanitization') {
                    try {
                      await owned.append(
                        new Date('2026-08-31T00:00:00.000Z'),
                      );
                    } catch (error) {
                      liveStatus = owned.streamStatus();
                      throw error;
                    }
                  }
                  if (boundary === 'first-publication directory sync') {
                    await owned.append(record, role);
                    liveStatus = owned.streamStatus();
                  }
                  latch();
                  throw new Error(`synthetic replay ${boundary} failure`);
                }
                await owned.append(record, role);
                adopt(owned.streamStatus());
              },
              streamStatus: () => liveStatus,
              async settle(value: unknown) {
                const record = await owned.settle(value);
                events.push('settlement-complete');
                adopt(owned.streamStatus());
                if (boundary === 'settlement checkpoint') latch();
                return record;
              },
              async release() {
                const status = await owned.release();
                events.push('release-complete');
                adopt(status);
                if (boundary === 'release checkpoint') latch();
                return liveStatus;
              },
            };
          },
        },
        createAttemptId: () => attemptId,
        createSessionHost: async (options: any) => {
          const initializationRecord = {
            type: 'captain_telemetry',
            turnId: null,
            timestamp: 1,
            topic: 'fixture.trigger',
            payload: {},
          };
          for (const observer of options.observers) {
            await observer.onRecord(initializationRecord);
          }
          const laterRecord = {
            ...initializationRecord,
            timestamp: 2,
            topic: 'fixture.later',
          };
          for (const observer of options.observers) {
            await observer.onRecord(laterRecord);
          }
          return {
            host: fakeHost([]),
            shell: {
              async installRetainedGenerations() {
                events.push('installation-complete');
              },
              exportSnapshot: () => snapshot,
              exportSettlement: () => ({
                snapshot,
                unresolvedEffects: [],
                retentionUpdates: [],
              }),
            },
            snapshot,
          };
        },
      });

      const runtime = await lifecycle.initializeRuntime({
        ...fixture.context,
        observers: [presentationGate],
      });
      if (boundary === 'settlement checkpoint') {
        await lifecycle.beforeNonEmptyTurn({
          sessionId: logicalSessionId,
          prompt: 'checkpoint replay',
        });
        snapshot = shellSnapshot(fixture.execution, 1);
        await lifecycle.afterTurn({
          sessionId: logicalSessionId,
          prompt: 'checkpoint replay',
          replies: [
            { type: 'captain_reply', text: 'durable reply', turnId: 1 },
          ],
          terminal: { type: 'turn_finished', turnId: 1 },
        });
      }
      await runtime.dispose();
      await lifecycle.shutdown();

      const warningMessage =
        `warning: replay history for session ` +
        `${JSON.stringify(logicalSessionId)} may be incomplete; ` +
        'recording has stopped';
      expect(warningAttempts).toEqual([
        {
          type: 'captain_status',
          turnId: null,
          timestamp: expect.any(Number),
          message: warningMessage,
        },
      ]);
      const sourceBoundary = [
        'sanitization',
        'append',
        'first-publication directory sync',
      ].includes(boundary);
      if (sourceBoundary) {
        expect(events.indexOf('source:fixture.trigger')).toBeLessThan(
          events.indexOf('warning'),
        );
        expect(events.indexOf('warning')).toBeLessThan(
          events.indexOf('source:fixture.later'),
        );
      } else {
        const completedBoundary =
          boundary === 'initialization' || boundary === 'torn-tail repair'
            ? 'installation-complete'
            : boundary === 'settlement checkpoint'
              ? 'settlement-complete'
              : 'release-complete';
        expect(events).toContain(completedBoundary);
        expect(events.indexOf(completedBoundary)).toBeLessThan(
          events.indexOf('warning'),
        );
      }
      expect(events.filter((event) => event === 'warning')).toHaveLength(1);
      expect(rawStderr).toEqual([]);
      const replay = await fixture.store.readStream(logicalSessionId);
      expect(
        replay.entries.some(
          ({ record }: any) =>
            record.type === 'captain_status' &&
            record.message === warningMessage,
        ),
      ).toBe(false);
    },
  );

  it('assembles schema-3 capabilities under the managed child lease', async () => {
    const execution = executionProjection();
    const fixture = await lifecycleFixture(execution);
    const payload = { ...fixture.payload, cwd: process.cwd() };
    const context = { ...fixture.context, cwd: process.cwd() };
    const events: string[] = [];
    let writerLease: any;
    const lifecycle = createManagedInteractiveLifecycle(payload, {
      sessionStore: fixture.store,
      loadModule: registryLoader(execution),
      createEffectLedgerWriteAhead: (lease: unknown) => {
        writerLease = lease;
        const effectLedger = emptyPlaybookEffectLedger();
        return {
          snapshot: () => effectLedger,
          writeAhead: async () => effectLedger,
        };
      },
      createHostRuntime: async (options: any) => {
        await options.captain.init({
          signal: new AbortController().signal,
          players: options.players.map(({ id, adapter }: any) => ({
            id,
            adapter,
          })),
          async emitStatus() {},
          async emitTelemetry() {},
          async setVisiblePlayers() {},
        });
        return {
          ...fakeHost(events),
          async dispose() {
            await options.captain.dispose();
            events.push('disposed');
          },
        };
      },
    });

    const runtime = await lifecycle.initializeRuntime(context);
    expect(writerLease).toMatchObject({ sessionId: logicalSessionId });
    const record = await fixture.store.read(logicalSessionId);
    expect(record.cwd).toBe(process.cwd());
    const durable = JSON.stringify(record);
    expect(durable).not.toContain(writerLease.ownerToken);
    for (const key of [
      'hostCapabilities',
      'leaseOwnerToken',
    ]) {
      expect(durable).not.toContain(`"${key}"`);
    }
    expect(record.effectLedger).toEqual(emptyPlaybookEffectLedger());

    await runtime.dispose();
    await lifecycle.shutdown();
    expect(events).toEqual(['disposed']);
  });

  it('rejects schema-3 host construction under a different session lease', async () => {
    const execution = executionProjection();
    const fixture = await lifecycleFixture(execution);
    let writerCreations = 0;
    let hostCreations = 0;
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: {
        ...fixture.store,
        async acquire(sessionId: string) {
          const lease = await fixture.store.acquire(sessionId);
          return { ...lease, sessionId: predecessorSessionId };
        },
      },
      loadModule: registryLoader(execution),
      createEffectLedgerWriteAhead: () => {
        writerCreations += 1;
        const effectLedger = emptyPlaybookEffectLedger();
        return {
          snapshot: () => effectLedger,
          writeAhead: async () => effectLedger,
        };
      },
      createHostRuntime: async () => {
        hostCreations += 1;
        throw new Error('must not construct a host under the wrong lease');
      },
    });

    await expect(
      lifecycle.initializeRuntime(fixture.context),
    ).rejects.toThrow(/lease authority does not match its logical session/);
    expect({ writerCreations, hostCreations }).toEqual({
      writerCreations: 0,
      hostCreations: 0,
    });
  });

  it('persists turn zero before readiness, brackets each reply, and retains the lease until shutdown', async () => {
    const fixture = await lifecycleFixture();
    let snapshot = shellSnapshot(fixture.execution, 0);
    const events: string[] = [];
    const installed: unknown[] = [];
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: fixture.store,
      createAttemptId: () => attemptId,
      createSessionHost: async () => ({
        host: fakeHost(events),
        shell: {
          async installRetainedGenerations(value: unknown) {
            installed.push(value);
          },
          exportSnapshot: () => snapshot,
          exportSettlement: () => ({
            snapshot,
            unresolvedEffects: [],
            retentionUpdates: [
              {
                kind: 'retain',
                rootPlaybookId: 'code',
                generation: retainedGeneration(),
              },
            ],
          }),
        },
        snapshot,
      }),
    });

    const runtime = await lifecycle.initializeRuntime(fixture.context);
    expect(installed).toEqual([{}]);
    expect((await fixture.store.read(logicalSessionId)).state).toBe('settled');
    await expect(fixture.store.acquire(logicalSessionId)).rejects.toThrow(
      /lease is active/,
    );

    await lifecycle.beforeNonEmptyTurn({
      sessionId: logicalSessionId,
      prompt: 'exact Boss input',
    });
    expect(await fixture.store.read(logicalSessionId)).toMatchObject({
      state: 'uncertain',
      uncertain: { input: 'exact Boss input', attemptId },
    });
    snapshot = shellSnapshot(fixture.execution, 1);
    await lifecycle.afterTurn({
      sessionId: logicalSessionId,
      prompt: 'exact Boss input',
      replies: [
        { type: 'captain_reply', text: 'durable reply', turnId: 1 },
      ],
      terminal: { type: 'turn_finished', turnId: 1 },
    });
    expect(await fixture.store.read(logicalSessionId)).toMatchObject({
      state: 'settled',
      snapshot: { sequences: { turn: 1 } },
      retainedGenerations: {
        code: { frames: [{ sessionId: retainedFrameSessionId }] },
      },
    });

    await runtime.dispose();
    await lifecycle.shutdown();
    expect(await fixture.store.read(logicalSessionId)).toMatchObject({
      retainedGenerations: {
        code: { frames: [{ sessionId: retainedFrameSessionId }] },
      },
    });
    const next = await fixture.store.acquire(logicalSessionId);
    await next.release();
    expect(events).toEqual(['disposed']);
  });

  it('retracts exact empty turn zero when child shutdown wins the readiness claim', async () => {
    const fixture = await lifecycleFixture();
    const events: string[] = [];
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: fixture.store,
      createSessionHost: async () => {
        const snapshot = shellSnapshot(fixture.execution, 0);
        return {
          host: fakeHost(events),
          shell: {
            async installRetainedGenerations() {},
            exportSnapshot: () => snapshot,
          },
          snapshot,
        };
      },
    });
    const runtime = await lifecycle.initializeRuntime(fixture.context);

    await runtime.dispose();
    await lifecycle.shutdown({
      sessionId: logicalSessionId,
      reason: 'SIGINT',
    });

    await expect(fixture.store.read(logicalSessionId)).rejects.toThrow(
      /does not exist/,
    );
    await expect(
      publishManagedInteractiveReadinessWitness(
        fixture.payload.workDir,
        logicalSessionId,
      ),
    ).rejects.toThrow(/readiness claim could not be created/);
    const next = await fixture.store.acquire(logicalSessionId);
    await next.release();
    expect(events).toEqual(['disposed']);
  });

  it('preserves outer-claimed turn zero after readiness cleanup and detached EOF', async () => {
    const fixture = await lifecycleFixture();
    const events: string[] = [];
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: fixture.store,
      createSessionHost: async () => {
        const snapshot = shellSnapshot(fixture.execution, 0);
        return {
          host: fakeHost(events),
          shell: {
            async installRetainedGenerations() {},
            exportSnapshot: () => snapshot,
          },
          snapshot,
        };
      },
    });
    const runtime = await lifecycle.initializeRuntime(fixture.context);
    await publishManagedInteractiveReadinessWitness(
      fixture.payload.workDir,
      logicalSessionId,
    );
    await rm(dirname(fixture.payload.readinessPath), {
      recursive: true,
      force: true,
    });

    await runtime.dispose();
    await lifecycle.shutdown({
      sessionId: logicalSessionId,
      reason: 'EOF',
    });

    expect(await fixture.store.read(logicalSessionId)).toMatchObject({
      state: 'settled',
      retainedGenerations: {},
    });
    expect(
      await readFile(
        join(
          fixture.payload.workDir,
          MANAGED_INTERACTIVE_READINESS_WITNESS_FILE,
        ),
        'utf8',
      ),
    ).toBe(`ready ${logicalSessionId}\n`);
    const next = await fixture.store.acquire(logicalSessionId);
    await next.release();
    expect(events).toEqual(['disposed']);
  });

  it('transfers and installs predecessor generations before fresh readiness', async () => {
    const fixture = await lifecycleFixture();
    await seedRetainedSettled(fixture, predecessorSessionId);
    let installCalls = 0;
    let installed: unknown;
    let targetDuringInstall: unknown;
    const reconciliationOrder: string[] = [];
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: fixture.store,
      createSessionHost: async () => {
        const snapshot = shellSnapshot(fixture.execution, 0);
        return {
          host: fakeHost([]),
          async reconcileRepositoryEffects() {
            reconciliationOrder.push('reconcile');
            expect(await fixture.store.read(logicalSessionId)).toMatchObject({
              state: 'settled',
              retainedGenerations: { code: retainedGeneration() },
            });
          },
          shell: {
            async installRetainedGenerations(value: unknown) {
              reconciliationOrder.push('install');
              installCalls += 1;
              installed = value;
              targetDuringInstall = await fixture.store.read(logicalSessionId);
            },
            exportSnapshot: () => snapshot,
          },
          snapshot,
        };
      },
    });

    const runtime = await lifecycle.initializeRuntime(fixture.context);
    expect(installCalls).toBe(1);
    expect(reconciliationOrder).toEqual(['reconcile', 'install']);
    expect(installed).toEqual({ code: retainedGeneration() });
    expect(targetDuringInstall).toMatchObject({
      state: 'settled',
      retainedGenerations: { code: retainedGeneration() },
    });
    expect(await fixture.store.read(predecessorSessionId)).toMatchObject({
      state: 'settled',
      retainedGenerations: {},
    });
    await runtime.dispose();
    await lifecycle.shutdown();
  });

  it('starts fresh while the newest settled predecessor lease is live', async () => {
    const fixture = await lifecycleFixture();
    await seedRetainedSettled(fixture, predecessorSessionId);
    const sourceBefore = await fixture.store.read(predecessorSessionId);
    const held = await fixture.store.acquire(predecessorSessionId);
    const installed: unknown[] = [];
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: fixture.store,
      createSessionHost: async () => {
        const snapshot = shellSnapshot(fixture.execution, 0);
        return {
          host: fakeHost([]),
          shell: {
            async installRetainedGenerations(value: unknown) {
              installed.push(value);
            },
            exportSnapshot: () => snapshot,
          },
          snapshot,
        };
      },
    });

    const runtime = await lifecycle.initializeRuntime(fixture.context);
    expect(installed).toEqual([{}]);
    expect(await fixture.store.read(predecessorSessionId)).toEqual(
      sourceBefore,
    );
    expect(await fixture.store.read(logicalSessionId)).toMatchObject({
      state: 'settled',
      retainedGenerations: {},
    });
    await runtime.dispose();
    await lifecycle.shutdown();
    await held.release();
  });

  it('starts fresh and diagnoses a pre-cutover predecessor without changing it', async () => {
    const fixture = await lifecycleFixture();
    await seedRetainedSettled(fixture, predecessorSessionId);
    const predecessorPath = join(
      fixture.sessionsDir,
      `${predecessorSessionId}.json`,
    );
    const canonical = JSON.parse(await readFile(predecessorPath, 'utf8'));
    const olderPredecessor = {
      ...structuredClone(canonical),
      sessionId: olderPredecessorSessionId,
      createdAt: new Date(
        Date.parse(canonical.createdAt) - 2,
      ).toISOString(),
      updatedAt: new Date(
        Date.parse(canonical.createdAt) - 1,
      ).toISOString(),
    };
    const olderPredecessorPath = join(
      fixture.sessionsDir,
      `${olderPredecessorSessionId}.json`,
    );
    const olderPredecessorBytes = `${JSON.stringify(olderPredecessor)}\n`;
    await writeFile(olderPredecessorPath, olderPredecessorBytes, {
      mode: 0o600,
    });
    const preCutoverBytes = `${JSON.stringify(
      preUnresolvedEffectsRecord(canonical),
    )}\n`;
    await writeFile(predecessorPath, preCutoverBytes, 'utf8');
    const diagnostics: string[] = [];
    const installed: unknown[] = [];
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: fixture.store,
      stderr: {
        write(chunk: string) {
          diagnostics.push(String(chunk));
          return true;
        },
      },
      createSessionHost: async () => {
        const snapshot = shellSnapshot(fixture.execution, 0);
        return {
          host: fakeHost([]),
          shell: {
            async installRetainedGenerations(value: unknown) {
              installed.push(value);
            },
            exportSnapshot: () => snapshot,
          },
          snapshot,
        };
      },
    });

    const runtime = await lifecycle.initializeRuntime(fixture.context);
    expect(installed).toEqual([{}]);
    const diagnostic =
      `playbook: skipping legacy Captain session "${predecessorSessionId}" at "${predecessorPath}" because schema 5 predates the canonical schema-6 unresolved-effect settlement boundary for the artifact-schema-3 effect-authority cutover and is not resumable; move it outside the sessions directory or remove it to silence this warning`;
    const diagnosticText = diagnostics.join('');
    expect(diagnosticText).toContain(diagnostic);
    expect(diagnosticText.split(diagnostic)).toHaveLength(2);
    expect(diagnosticText).not.toContain(
      'missing field "unresolvedEffects"',
    );
    expect(await readFile(predecessorPath, 'utf8')).toBe(preCutoverBytes);
    expect(await readFile(olderPredecessorPath, 'utf8')).toBe(
      olderPredecessorBytes,
    );
    expect(
      (await fixture.store.read(olderPredecessorSessionId))
        .retainedGenerations,
    ).toEqual({ code: retainedGeneration() });
    expect(await fixture.store.read(logicalSessionId)).toMatchObject({
      state: 'settled',
      retainedGenerations: {},
    });
    await runtime.dispose();
    await lifecycle.shutdown();
  });

  it.each([
    { boundary: 'guarded initialization', transferPublished: false },
    { boundary: 'predecessor transfer', transferPublished: true },
    { boundary: 'retained installation', transferPublished: true },
  ])(
    'contains a $boundary failure before readiness',
    async ({ boundary, transferPublished }) => {
      const fixture = await lifecycleFixture();
      await seedRetainedSettled(fixture, predecessorSessionId);
      const events: string[] = [];
      let installCalls = 0;
      const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
        sessionStore: {
          ...fixture.store,
          async acquire(sessionId: string) {
            const lease = await fixture.store.acquire(sessionId);
            if (sessionId !== logicalSessionId) return lease;
            return {
              ...lease,
              async initializeSettledWithPredecessor(options: unknown) {
                if (boundary === 'guarded initialization') {
                  throw new Error('synthetic guarded initialization failure');
                }
                const result =
                  await lease.initializeSettledWithPredecessor(options);
                if (boundary === 'predecessor transfer') {
                  throw new Error('synthetic predecessor transfer failure');
                }
                return result;
              },
            };
          },
        },
        createSessionHost: async () => {
          const snapshot = shellSnapshot(fixture.execution, 0);
          return {
            host: {
              abortActiveTurn() {},
              async runBossTurn() {
                events.push('boss');
              },
              async dispose() {
                events.push('disposed');
              },
            },
            shell: {
              async installRetainedGenerations() {
                installCalls += 1;
                if (boundary === 'retained installation') {
                  throw new Error('synthetic retained installation failure');
                }
              },
              exportSnapshot: () => snapshot,
            },
            snapshot,
          };
        },
      });

      await expect(lifecycle.initializeRuntime(fixture.context)).rejects.toThrow(
        `synthetic ${boundary} failure`,
      );
      expect(installCalls).toBe(
        boundary === 'retained installation' ? 1 : 0,
      );
      expect(events).toEqual(['disposed']);
      if (transferPublished) {
        expect(await fixture.store.read(logicalSessionId)).toMatchObject({
          state: 'settled',
          retainedGenerations: { code: retainedGeneration() },
        });
      } else {
        await expect(
          fixture.store.read(logicalSessionId),
        ).rejects.toThrow(/does not exist/);
      }
      expect(await fixture.store.read(predecessorSessionId)).toMatchObject({
        state: 'settled',
        retainedGenerations: transferPublished
          ? {}
          : { code: retainedGeneration() },
      });
      const next = await fixture.store.acquire(logicalSessionId);
      await next.release();
    },
  );

  it('rechecks lease ownership after installation before fresh readiness', async () => {
    const fixture = await lifecycleFixture();
    const events: string[] = [];
    let installed = false;
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: {
        ...fixture.store,
        async acquire(sessionId: string) {
          const lease = await fixture.store.acquire(sessionId);
          return {
            ...lease,
            async assertOwner() {
              if (installed) {
                throw new Error('synthetic owner loss after installation');
              }
              return lease.assertOwner();
            },
          };
        },
      },
      createSessionHost: async () => {
        const snapshot = shellSnapshot(fixture.execution, 0);
        return {
          host: fakeHost(events),
          shell: {
            async installRetainedGenerations() {
              installed = true;
            },
            exportSnapshot: () => snapshot,
          },
          snapshot,
        };
      },
    });

    await expect(lifecycle.initializeRuntime(fixture.context)).rejects.toThrow(
      'synthetic owner loss after installation',
    );
    expect(installed).toBe(true);
    expect(events).toEqual(['disposed']);
    await expect(
      fixture.store.read(logicalSessionId),
    ).rejects.toThrow(/does not exist/);
    const next = await fixture.store.acquire(logicalSessionId);
    await next.release();
  });

  it('restores and installs a selected map before leaving an aborted turn uncertain', async () => {
    const fixture = await lifecycleFixture();
    await seedRetainedSettled(fixture, logicalSessionId);
    let restored: unknown;
    let installCalls = 0;
    let installed: unknown;
    const lifecycle = createManagedInteractiveLifecycle(
      { ...fixture.payload, mode: 'selected' },
      {
        sessionStore: fixture.store,
        loadModule: registryLoader(fixture.execution),
        createAttemptId: () => attemptId,
        createSessionHost: async (options: any) => {
          restored = options.restoreSnapshot;
          return {
            host: fakeHost([]),
            shell: {
              async installRetainedGenerations(value: unknown) {
                installCalls += 1;
                installed = value;
              },
              exportSnapshot: () => options.restoreSnapshot,
            },
            snapshot: options.restoreSnapshot,
          };
        },
      },
    );

    await lifecycle.initializeRuntime(fixture.context);
    expect(restored).toEqual(shellSnapshot(fixture.execution, 0));
    expect(installCalls).toBe(1);
    expect(installed).toEqual({ code: retainedGeneration() });
    await lifecycle.beforeNonEmptyTurn({
      sessionId: logicalSessionId,
      prompt: 'will abort',
    });
    await expect(
      lifecycle.afterTurn({
        sessionId: logicalSessionId,
        prompt: 'will abort',
        replies: [],
        terminal: { type: 'turn_aborted', turnId: 1 },
      }),
    ).rejects.toThrow(/remains uncertain/);
    expect((await fixture.store.read(logicalSessionId)).state).toBe('uncertain');
    await lifecycle.shutdown();
  });

  it('rejects uncertain selected state before host work and retires ownership', async () => {
    const fixture = await lifecycleFixture();
    const seed = await fixture.store.acquire(logicalSessionId);
    await seed.initializeSettledWithPredecessor({
      cwd: fixture.payload.cwd,
      structuralProjection: projectCaptainSessionStructure(fixture.execution),
      executionProjection: fixture.execution,
      snapshot: shellSnapshot(fixture.execution, 0),
    });
    await seed.beginTurn({
      input: 'uncertain',
      attemptId,
      attemptedExecutionProjection: fixture.execution,
    });
    await seed.release();
    let hostCalls = 0;
    let prepareCalls = 0;
    let importCalls = 0;
    const lifecycle = createManagedInteractiveLifecycle(
      { ...fixture.payload, mode: 'selected' },
      {
        sessionStore: fixture.store,
        prepareRegistryModule: async () => {
          prepareCalls += 1;
        },
        loadModule: async () => {
          importCalls += 1;
          throw new Error('must not import');
        },
        createSessionHost: async () => {
          hostCalls += 1;
          throw new Error('must not construct');
        },
      },
    );

    await expect(lifecycle.initializeRuntime(fixture.context)).rejects.toThrow(
      /uncertain turn/,
    );
    expect(hostCalls).toBe(0);
    expect(prepareCalls).toBe(0);
    expect(importCalls).toBe(0);
    const next = await fixture.store.acquire(logicalSessionId);
    await next.release();
  });

  it('rejects fresh manifest drift under the lease before host or turn-zero persistence', async () => {
    const fixture = await lifecycleFixture();
    let importCalls = 0;
    let hostCalls = 0;
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: fixture.store,
      loadModule: async () => {
        importCalls += 1;
        return {
          default: {
            ...registryEntry(fixture.execution),
            command: 'drifted-before-pane-start',
          },
        };
      },
      createSessionHost: async () => {
        hostCalls += 1;
        throw new Error('must not construct');
      },
    });

    await expect(lifecycle.initializeRuntime(fixture.context)).rejects.toThrow(
      /recorded manifest identity/,
    );
    expect(importCalls).toBe(1);
    expect(hostCalls).toBe(0);
    await expect(fixture.store.read(logicalSessionId)).rejects.toThrow(
      /does not exist/,
    );
    const next = await fixture.store.acquire(logicalSessionId);
    await next.release();
  });

  it('snapshots every consumed reopened manifest member once under the lease', async () => {
    const fixture = await lifecycleFixture();
    const consumed = [
      'id',
      'command',
      'intent',
      'artifactSchema',
      'runtimeProfile',
      'requiredRoleIds',
      'concurrentRoleSets',
      'validateOptions',
      'createRuntime',
    ] as const;
    const reads = Object.fromEntries(consumed.map((key) => [key, 0]));
    const manifest = new Proxy(registryEntry(fixture.execution), {
      get(target, key, receiver) {
        if (typeof key === 'string' && key in reads) {
          reads[key] += 1;
          if (key === 'artifactSchema' && reads[key] > 1) return 3;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: fixture.store,
      loadModule: async () => ({ default: manifest }),
      createSessionHost: async () => {
        throw new Error('manifest snapshot complete');
      },
    });

    await expect(lifecycle.initializeRuntime(fixture.context)).rejects.toThrow(
      'manifest snapshot complete',
    );
    expect(reads).toEqual(
      Object.fromEntries(consumed.map((key) => [key, 1])),
    );
  });

  it.each([
    {
      label: 'manifest command',
      execution: executionProjection,
      mutate: (entry: any) => ({ ...entry, command: 'changed' }),
    },
    {
      label: 'manifest intent',
      execution: executionProjection,
      mutate: (entry: any) => ({ ...entry, intent: 'changed' }),
    },
    {
      label: 'artifact schema',
      execution: executionProjection,
      mutate: (entry: any) => ({ ...entry, artifactSchema: 1 }),
    },
    {
      label: 'runtime profile schema',
      execution: executionProjection,
      mutate: (entry: any) => ({
        ...entry,
        runtimeProfile: { kind: 'bespoke', artifactSchema: 2 },
      }),
    },
    {
      label: 'concurrent roles',
      execution: concurrentExecutionProjection,
      mutate: (entry: any) => ({
        ...entry,
        concurrentRoleSets: [['coder', 'reviewer']],
      }),
    },
  ])(
    'rejects selected $label drift under the lease before host work',
    async ({ execution: createExecution, mutate }) => {
      const fixture = await lifecycleFixture(createExecution());
      await seedSettled(fixture, shellSnapshot(fixture.execution, 0));
      let prepareCalls = 0;
      let importCalls = 0;
      let hostCalls = 0;
      const lifecycle = createManagedInteractiveLifecycle(
        { ...fixture.payload, mode: 'selected' },
        {
          sessionStore: fixture.store,
          prepareRegistryModule: async ({ from }: any) => {
            prepareCalls += 1;
            await expect(
              fixture.store.acquire(logicalSessionId),
            ).rejects.toThrow(/lease is active/);
            return from;
          },
          loadModule: async () => {
            importCalls += 1;
            return {
              default: mutate(registryEntry(fixture.execution)),
            };
          },
          createSessionHost: async () => {
            hostCalls += 1;
            throw new Error('must not construct');
          },
        },
      );

      await expect(lifecycle.initializeRuntime(fixture.context)).rejects.toThrow(
        /recorded manifest identity|valid registry entry/,
      );
      expect(prepareCalls).toBe(1);
      expect(importCalls).toBe(1);
      expect(hostCalls).toBe(0);
      const next = await fixture.store.acquire(logicalSessionId);
      await next.release();
    },
  );

  it.each([
    { mode: 'fresh', noProvision: false, enabled: true },
    { mode: 'fresh', noProvision: true, enabled: false },
    { mode: 'selected', noProvision: false, enabled: true },
    { mode: 'selected', noProvision: true, enabled: false },
  ])(
    'maps $mode noProvision=$noProvision to provisioning enabled=$enabled under the lease',
    async ({ mode, noProvision, enabled }) => {
      const fixture = await lifecycleFixture();
      if (mode === 'selected') {
        await seedSettled(fixture, shellSnapshot(fixture.execution, 0));
      }
      const factoryCalls: any[] = [];
      let prepareCalls = 0;
      let importCalls = 0;
      const lifecycle = createManagedInteractiveLifecycle(
        { ...fixture.payload, mode, noProvision },
        {
          sessionStore: fixture.store,
          stderr: {
            write() {
              return true;
            },
          },
          createRegistryPreparer(options: any) {
            factoryCalls.push(options);
            return async ({ from }: any) => {
              prepareCalls += 1;
              await expect(
                fixture.store.acquire(logicalSessionId),
              ).rejects.toThrow(/lease is active/);
              return from;
            };
          },
          loadModule: async () => {
            importCalls += 1;
            return { default: registryEntry(fixture.execution) };
          },
          createSessionHost: async (options: any) => ({
            host: fakeHost([]),
            shell: {
              async installRetainedGenerations() {},
              exportSnapshot: () =>
                options.restoreSnapshot ?? shellSnapshot(fixture.execution, 0),
            },
            snapshot:
              options.restoreSnapshot ?? shellSnapshot(fixture.execution, 0),
          }),
        },
      );

      await lifecycle.initializeRuntime(fixture.context);
      expect(factoryCalls).toHaveLength(1);
      expect(factoryCalls[0]).toMatchObject({
        enabled,
        commandName: 'playbook',
      });
      expect(prepareCalls).toBe(1);
      expect(importCalls).toBe(1);
      await lifecycle.shutdown();
    },
  );

  it('quarantines the writer lease when partial host disposal cannot be proved', async () => {
    const fixture = await lifecycleFixture();
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: fixture.store,
      createSessionHost: async () => ({
        host: {
          ...fakeHost([]),
          async dispose() {
            throw new Error('dispose failed');
          },
        },
        shell: {
          async installRetainedGenerations() {},
          exportSnapshot: () => undefined,
        },
        snapshot: undefined,
      }),
    });

    await expect(lifecycle.initializeRuntime(fixture.context)).rejects.toThrow(
      /cleanup could not prove complete host disposal/,
    );
    await lifecycle.shutdown();
    await expect(fixture.store.acquire(logicalSessionId)).rejects.toThrow(
      /lease is active/,
    );
  });

  it('quarantines the writer lease when Cligent-observed runtime disposal fails', async () => {
    const fixture = await lifecycleFixture();
    const snapshot = shellSnapshot(fixture.execution, 0);
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: fixture.store,
      createSessionHost: async () => ({
        host: {
          ...fakeHost([]),
          async dispose() {
            throw new Error('runtime dispose failed');
          },
        },
        shell: {
          async installRetainedGenerations() {},
          exportSnapshot: () => snapshot,
        },
        snapshot,
      }),
    });

    const runtime = await lifecycle.initializeRuntime(fixture.context);
    await expect(runtime.dispose()).rejects.toThrow('runtime dispose failed');
    await lifecycle.shutdown();
    await expect(fixture.store.acquire(logicalSessionId)).rejects.toThrow(
      /lease is active/,
    );
  });

  it('quarantines the writer lease when shared host construction cannot roll back its host', async () => {
    const fixture = await lifecycleFixture();
    const lifecycle = createManagedInteractiveLifecycle(
      { ...fixture.payload, cwd: process.cwd() },
      {
        sessionStore: fixture.store,
        loadModule: async () => ({
          default: {
            ...registryEntry(fixture.execution),
            validateOptions() {
              throw new Error('shell init failed');
            },
          },
        }),
        createHostRuntime: async () => ({
          abortActiveTurn() {},
          async runBossTurn() {},
          async dispose() {
            throw new Error('rollback dispose failed');
          },
        }),
      },
    );

    await expect(
      lifecycle.initializeRuntime({
        ...fixture.context,
        cwd: process.cwd(),
      }),
    ).rejects.toThrow(/cleanup also failed/);
    await lifecycle.shutdown();
    await expect(fixture.store.acquire(logicalSessionId)).rejects.toThrow(
      /lease is active/,
    );
  });

  it('requires the exact prompt, one Captain reply, and the terminal turn id before settlement', async () => {
    const fixture = await lifecycleFixture();
    const snapshot = shellSnapshot(fixture.execution, 0);
    const lifecycle = createManagedInteractiveLifecycle(fixture.payload, {
      sessionStore: fixture.store,
      createAttemptId: () => attemptId,
      createSessionHost: async () => ({
        host: fakeHost([]),
        shell: {
          async installRetainedGenerations() {},
          exportSnapshot: () => snapshot,
          exportSettlement: () => ({
            snapshot,
            unresolvedEffects: [],
            retentionUpdates: [],
          }),
        },
        snapshot,
      }),
    });
    await lifecycle.initializeRuntime(fixture.context);
    await lifecycle.beforeNonEmptyTurn({
      sessionId: logicalSessionId,
      prompt: 'same prompt',
    });
    await expect(
      lifecycle.afterTurn({
        sessionId: logicalSessionId,
        prompt: 'changed',
        replies: [
          { type: 'captain_reply', text: 'reply', turnId: 1 },
        ],
        terminal: { type: 'turn_finished', turnId: 1 },
      }),
    ).rejects.toThrow(/prompt changed/);
    await expect(
      lifecycle.afterTurn({
        sessionId: logicalSessionId,
        prompt: 'same prompt',
        replies: [
          { type: 'captain_reply', text: 'reply', turnId: 2 },
        ],
        terminal: { type: 'turn_finished', turnId: 1 },
      }),
    ).rejects.toThrow(/expected exactly one/);
    expect((await fixture.store.read(logicalSessionId)).state).toBe('uncertain');
    await lifecycle.shutdown();
  });
});

describe('managed interactive private runner boundary (PBCLI-50)', () => {
  it('requires explicit work-directory cleanup authority at both descriptor boundaries', async () => {
    const fixture = await lifecycleFixture();
    expect(() =>
      validateManagedInteractivePayload({
        ...fixture.payload,
        workDirOwnedByLauncher: 'true',
      }),
    ).toThrow(/workDirOwnedByLauncher must be a boolean/);

    const controls = await controlBoundary(fixture.payload.cwd);
    await expect(
      createManagedInteractiveSessionCommand(
        { ...controls.context, workDirOwnedByLauncher: undefined },
        fixture.payload,
      ),
    ).rejects.toThrow(/work-directory ownership is missing/);
  });

  it('writes one private descriptor, validates its Cligent boundary, and unlinks it before imports or host work', async () => {
    const fixture = await lifecycleFixture();
    const controls = await controlBoundary(fixture.payload.cwd);
    const command = await createManagedInteractiveSessionCommand(
      controls.context,
      fixture.payload,
      { execPath: '/usr/bin/node', selfBin: '/tmp/interactive-session.js' },
    );
    const descriptor = join(
      controls.context.workDir,
      MANAGED_INTERACTIVE_PAYLOAD_FILE,
    );
    expect(command).toBe(`/usr/bin/node /tmp/interactive-session.js ${descriptor}`);
    expect((await stat(descriptor)).mode & 0o777).toBe(0o600);

    await runManagedInteractiveSessionChild({
      argv: [descriptor],
      sessionStore: fixture.store,
      createSessionHost: async () => {
        throw new Error('host sentinel');
      },
      runManagedSession: async (options: any) => {
        await expect(stat(descriptor)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(options.workDirOwnedByLauncher).toBe(false);
        await expect(options.lifecycle.initializeRuntime({
          ...fixture.context,
          observers: [],
        })).rejects.toThrow('host sentinel');
      },
    });
  });

  it('passes launcher-owned cleanup authority unchanged to the runner', async () => {
    const fixture = await lifecycleFixture();
    const controls = await controlBoundary(fixture.payload.cwd);
    await createManagedInteractiveSessionCommand(
      { ...controls.context, workDirOwnedByLauncher: true },
      fixture.payload,
    );
    const descriptor = join(
      controls.context.workDir,
      MANAGED_INTERACTIVE_PAYLOAD_FILE,
    );

    await runManagedInteractiveSessionChild({
      argv: [descriptor],
      runManagedSession: async (options: any) => {
        expect(options.workDirOwnedByLauncher).toBe(true);
      },
    });
  });

  it('does not unlink a caller-chosen descriptor outside a valid boundary', async () => {
    const fixture = await lifecycleFixture();
    const arbitrary = await mkdtemp(join(tmpdir(), 'playbook-arbitrary-'));
    tempDirs.push(arbitrary);
    await chmod(arbitrary, 0o700);
    const descriptor = join(arbitrary, MANAGED_INTERACTIVE_PAYLOAD_FILE);
    await writeFile(
      descriptor,
      `${JSON.stringify({
        ...fixture.payload,
        workDir: arbitrary,
        readinessPath: join(arbitrary, 'status.json'),
        inputGatePath: join(arbitrary, 'input-ready'),
        inputActivePath: join(arbitrary, 'input-active'),
        shutdownRequestPath: join(arbitrary, 'shutdown-request'),
        shutdownCompletePath: join(arbitrary, 'shutdown-complete'),
      })}\n`,
      { mode: 0o600 },
    );
    await expect(
      runManagedInteractiveSessionChild({ argv: [descriptor] }),
    ).rejects.toThrow();
    expect(await readFile(descriptor, 'utf8')).toContain(
      MANAGED_INTERACTIVE_PAYLOAD_KIND,
    );
  });

  it('rejects a multiply linked descriptor before consuming either name', async () => {
    const fixture = await lifecycleFixture();
    const controls = await controlBoundary(fixture.payload.cwd);
    await createManagedInteractiveSessionCommand(controls.context, fixture.payload);
    const descriptor = join(
      controls.context.workDir,
      MANAGED_INTERACTIVE_PAYLOAD_FILE,
    );
    const alias = join(controls.context.workDir, 'descriptor-alias.json');
    await link(descriptor, alias);
    await expect(
      runManagedInteractiveSessionChild({ argv: [descriptor] }),
    ).rejects.toThrow(/singly linked/);
    await stat(descriptor);
    await stat(alias);
  });

  it('rejects symlinked or non-private descriptors without running the child', async () => {
    const fixture = await lifecycleFixture();
    const controls = await controlBoundary(fixture.payload.cwd);
    await createManagedInteractiveSessionCommand(controls.context, fixture.payload);
    const descriptor = join(
      controls.context.workDir,
      MANAGED_INTERACTIVE_PAYLOAD_FILE,
    );
    const original = join(controls.context.workDir, 'original.json');
    await rename(descriptor, original);
    await symlink(original, descriptor);
    let runnerCalls = 0;
    await expect(
      runManagedInteractiveSessionChild({
        argv: [descriptor],
        runManagedSession: async () => {
          runnerCalls += 1;
        },
      }),
    ).rejects.toThrow();
    expect(runnerCalls).toBe(0);
    await stat(original);

    await rm(descriptor);
    await rename(original, descriptor);
    await chmod(descriptor, 0o644);
    await expect(
      runManagedInteractiveSessionChild({ argv: [descriptor] }),
    ).rejects.toThrow(/private regular file/);
    await stat(descriptor);
  });

  it('rejects non-private control directories and durable/ephemeral overlap without consuming the descriptor', async () => {
    const fixture = await lifecycleFixture();
    const controls = await controlBoundary(fixture.payload.cwd);
    await createManagedInteractiveSessionCommand(controls.context, fixture.payload);
    const descriptor = join(
      controls.context.workDir,
      MANAGED_INTERACTIVE_PAYLOAD_FILE,
    );
    await chmod(controls.context.workDir, 0o755);
    await expect(
      runManagedInteractiveSessionChild({ argv: [descriptor] }),
    ).rejects.toThrow(/work directory is not private/);
    await stat(descriptor);

    await chmod(controls.context.workDir, 0o700);
    await chmod(dirname(controls.context.readinessPath), 0o755);
    await expect(
      runManagedInteractiveSessionChild({ argv: [descriptor] }),
    ).rejects.toThrow(/coordination directory is not private/);
    await stat(descriptor);

    await chmod(dirname(controls.context.readinessPath), 0o700);
    const parsed = JSON.parse(await readFile(descriptor, 'utf8'));
    parsed.sessionsDir = controls.context.workDir;
    await writeFile(descriptor, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    await expect(
      runManagedInteractiveSessionChild({ argv: [descriptor] }),
    ).rejects.toThrow(/durable Captain session storage overlaps/);
    await stat(descriptor);
  });

  it('detects descriptor pathname replacement before unlinking either inode', async () => {
    const fixture = await lifecycleFixture();
    const controls = await controlBoundary(fixture.payload.cwd);
    await createManagedInteractiveSessionCommand(controls.context, fixture.payload);
    const descriptor = join(
      controls.context.workDir,
      MANAGED_INTERACTIVE_PAYLOAD_FILE,
    );
    const opened = join(controls.context.workDir, 'opened.json');
    let runnerCalls = 0;
    await expect(
      runManagedInteractiveSessionChild({
        argv: [descriptor],
        beforeDescriptorUnlink: async () => {
          const contents = await readFile(descriptor, 'utf8');
          await rename(descriptor, opened);
          await writeFile(descriptor, contents, { mode: 0o600 });
        },
        runManagedSession: async () => {
          runnerCalls += 1;
        },
      }),
    ).rejects.toThrow(/changed during validation/);
    expect(runnerCalls).toBe(0);
    await stat(descriptor);
    await stat(opened);
  });

  it('re-raises a child signal only after the managed runner completes cleanup', async () => {
    const fixture = await lifecycleFixture();
    const controls = await controlBoundary(fixture.payload.cwd);
    await createManagedInteractiveSessionCommand(controls.context, fixture.payload);
    const descriptor = join(
      controls.context.workDir,
      MANAGED_INTERACTIVE_PAYLOAD_FILE,
    );
    const signalTarget = new FakeSignalTarget();
    const events: string[] = [];
    const result = await runManagedInteractiveSessionChildEntry({
      argv: [descriptor],
      signalTarget,
      runManagedSession: async () => {
        signalTarget.emit('SIGTERM');
        await Promise.resolve();
        events.push('cleanup-complete');
        throw new Error('turn aborted after cleanup');
      },
    });
    events.push(`returned:${result.signal}`);
    expect(events).toEqual(['cleanup-complete', 'returned:SIGTERM']);
    expect(result.error).toMatchObject({ message: 'turn aborted after cleanup' });
  });

  it('does not start Cligent when a signal arrives while consuming the descriptor', async () => {
    const fixture = await lifecycleFixture();
    const controls = await controlBoundary(fixture.payload.cwd);
    await createManagedInteractiveSessionCommand(controls.context, fixture.payload);
    const descriptor = join(
      controls.context.workDir,
      MANAGED_INTERACTIVE_PAYLOAD_FILE,
    );
    const signalTarget = new FakeSignalTarget();
    let enterConsume: () => void = () => {};
    const consuming = new Promise<void>((resolvePromise) => {
      enterConsume = resolvePromise;
    });
    let releaseConsume: () => void = () => {};
    const consumeGate = new Promise<void>((resolvePromise) => {
      releaseConsume = resolvePromise;
    });
    let runnerCalls = 0;
    const resultPromise = runManagedInteractiveSessionChildEntry({
      argv: [descriptor],
      signalTarget,
      beforeDescriptorUnlink: async () => {
        enterConsume();
        await consumeGate;
      },
      runManagedSession: async () => {
        runnerCalls += 1;
      },
    });

    await consuming;
    signalTarget.emit('SIGTERM');
    releaseConsume();
    const result = await resultPromise;
    expect(runnerCalls).toBe(0);
    expect(result).toMatchObject({
      signal: 'SIGTERM',
      error: { message: 'received SIGTERM' },
    });
  });
});

async function lifecycleFixture(
  execution: ReturnType<typeof executionProjection> = executionProjection(),
) {
  const root = await mkdtemp(join(tmpdir(), 'playbook-interactive-'));
  tempDirs.push(root);
  const sessionsDir = join(root, 'sessions');
  const cwd = join(root, 'cwd');
  await mkdir(cwd);
  await execFileAsync('git', ['init', '-q', cwd]);
  await execFileAsync('git', [
    '-C',
    cwd,
    'config',
    'user.name',
    'Playbook Interactive Test',
  ]);
  await execFileAsync('git', [
    '-C',
    cwd,
    'config',
    'user.email',
    'interactive@example.invalid',
  ]);
  await writeFile(join(cwd, 'tracked.txt'), 'baseline\n', 'utf8');
  await execFileAsync('git', ['-C', cwd, 'add', 'tracked.txt']);
  await execFileAsync('git', ['-C', cwd, 'commit', '-qm', 'baseline']);
  const controls = await controlBoundary(cwd);
  const payload = {
    schemaVersion: MANAGED_INTERACTIVE_PAYLOAD_SCHEMA_VERSION,
    kind: MANAGED_INTERACTIVE_PAYLOAD_KIND,
    mode: 'fresh' as const,
    sessionId: logicalSessionId,
    cwd,
    sessionsDir,
    noProvision: false,
    executionProjection: execution,
    workDir: controls.context.workDir,
    workDirOwnedByLauncher: false,
    readinessPath: controls.context.readinessPath,
    inputGatePath: controls.context.inputGatePath,
    inputActivePath: controls.context.inputActivePath,
    shutdownRequestPath: controls.context.shutdownRequestPath,
    shutdownCompletePath: controls.context.shutdownCompletePath,
  };
  const context = {
    sessionId: logicalSessionId,
    cwd,
    config: tmuxConfig(execution),
    observers: [],
  };
  return {
    root,
    sessionsDir,
    execution,
    payload,
    context,
    store: createCaptainSessionStore({ sessionsDir }),
  };
}

async function controlBoundary(cwd: string) {
  const workDir = await mkdtemp(join(tmpdir(), 'tmux-play-managed-test-'));
  const coordinationDir = await mkdtemp(join(tmpdir(), 'tmux-play-ready-test-'));
  tempDirs.push(workDir, coordinationDir);
  await chmod(workDir, 0o700);
  await chmod(coordinationDir, 0o700);
  return {
    context: {
      sessionId: logicalSessionId,
      cwd,
      workDir,
      workDirOwnedByLauncher: false,
      readinessPath: join(coordinationDir, 'status.json'),
      inputGatePath: join(coordinationDir, 'input-ready'),
      inputActivePath: join(coordinationDir, 'input-active'),
      shutdownRequestPath: join(coordinationDir, 'shutdown-request'),
      shutdownCompletePath: join(coordinationDir, 'shutdown-complete'),
    },
  };
}

function executionProjection() {
  return {
    schemaVersion: 2,
    captain: {
      adapter: 'claude',
      model: { kind: 'provider-default' },
      effort: { kind: 'provider-default' },
      permissions: { mode: 'auto' },
    },
    players: [
      {
        id: 'dev.coder',
        adapter: 'codex',
        model: { kind: 'provider-default' },
        effort: { kind: 'value', value: 'high' },
        permissions: { fileWrite: 'ask' },
      },
    ],
    catalog: {
      code: {
        id: 'code',
        from: '@sublang/playbook/code/registry',
        manifestCommand: 'code',
        command: 'code',
        intent:
          'implement a coding intent in reviewed, one-commit phases, using an intent record when needed',
        artifactSchema: 3,
        requiredRoleIds: ['coder'],
        concurrentRoleSets: [],
        roles: {
          coder: {
            playerId: 'dev.coder',
            model: { kind: 'provider-default' },
            effort: { kind: 'value', value: 'high' },
          },
        },
        options: {},
      },
    },
  };
}

function concurrentExecutionProjection(): ReturnType<
  typeof executionProjection
> {
  const execution = executionProjection();
  return {
    ...execution,
    players: [
      ...execution.players,
      {
        id: 'dev.reviewer',
        adapter: 'claude',
        model: { kind: 'provider-default' as const },
        effort: { kind: 'provider-default' as const },
        permissions: { mode: 'auto' },
      },
    ],
    catalog: {
      code: {
        ...execution.catalog.code,
        requiredRoleIds: ['coder', 'reviewer'],
        roles: {
          ...execution.catalog.code.roles,
          reviewer: {
            playerId: 'dev.reviewer',
            model: { kind: 'provider-default' as const },
            effort: { kind: 'provider-default' as const },
          },
        },
      },
    },
  } as ReturnType<typeof executionProjection>;
}

function registryEntry(execution: ReturnType<typeof executionProjection>) {
  const item = execution.catalog.code;
  return {
    id: item.id,
    command: item.manifestCommand,
    intent: item.intent,
    artifactSchema: item.artifactSchema,
    runtimeProfile: {
      kind: 'bespoke',
      artifactSchema: item.artifactSchema,
    },
    requiredRoleIds: [...item.requiredRoleIds],
    concurrentRoleSets: item.concurrentRoleSets.map((set) => [...set]),
    validateOptions: (value: unknown) => value,
    createRuntime: () => ({}),
  };
}

function registryLoader(execution: ReturnType<typeof executionProjection>) {
  return async () => ({ default: registryEntry(execution) });
}

function tmuxConfig(execution: ReturnType<typeof executionProjection>) {
  return {
    captain: {
      ...projectHostAgent(execution.captain, 'test captain'),
      from: PLAYBOOK_CAPTAIN_MODULE,
      options: captainOptionsFromConfig(execution),
    },
    players: execution.players.map(({ id, ...agent }) => ({
      id,
      ...projectHostAgent(agent, `test player ${id}`),
    })),
  };
}

function shellSnapshot(
  execution: ReturnType<typeof executionProjection>,
  turn: number,
) {
  const structural = projectCaptainSessionStructure(execution);
  const state = {
    value: 'routing',
    activeStateIds: ['routing'],
    tags: ['playbook.parked'],
    status: 'active',
    quiescent: true,
    stateId: 'routing',
  };
  const journal = Array.from({ length: turn }, (_, index) => ({
    seq: index + 1,
    turnId: index + 1,
    kind: 'boss',
    payload: `turn-${index + 1}`,
  }));
  const effectLedger = emptyPlaybookEffectLedger();
  return {
    schemaVersion: 4,
    captain: {
      sessionId: internalSessionId,
      runtime: {
        schemaVersion: 4,
        playbookId: 'captain',
        machine: { value: state.value, status: state.status },
        roleResumeTokens: {},
        sequences: {
          trace: 0,
          turn,
          judgeCall: 0,
          playerCall: 0,
          playbookCall: 0,
          captainCall: 0,
        },
        state,
        pendingBossQuestions: [],
        effectLedger,
      },
      agent: structural.captain,
      conversation:
        turn === 0
          ? { kind: 'unopened' }
          : { kind: 'pinned', token: `captain-token-${turn}` },
    },
    playerSessions: Object.fromEntries(
      structural.players.map(({ id, ...agent }) => [id, agent]),
    ),
    issuedSessionIds: [internalSessionId],
    sequences: { turn, journal: journal.length },
    journal,
    effectLedger,
    ...(turn === 0
      ? {}
      : { lastAction: 'respond', lastSettlementStatus: 'ok' }),
    mode: 'chat',
  };
}

function retainedGeneration() {
  const state = {
    value: 'editing',
    activeStateIds: ['editing'],
    tags: ['playbook.parked'],
    status: 'active',
    quiescent: true,
    stateId: 'editing',
  } as const;
  return {
    effectLedger: emptyPlaybookEffectLedger(),
    frames: [
      {
        playbookId: 'code',
        sessionId: retainedFrameSessionId,
        rootSessionId: retainedFrameSessionId,
        depth: 0,
        options: {},
        roleBindings: { coder: 'dev.coder' },
        runtime: {
          schemaVersion: 4,
          playbookId: 'code',
          machine: { value: state.value, status: state.status },
          roleResumeTokens: {},
          sequences: {
            trace: 0,
            turn: 1,
            judgeCall: 0,
            playerCall: 0,
            playbookCall: 0,
            captainCall: 0,
          },
          state,
          pendingBossQuestions: [],
          effectLedger: emptyPlaybookEffectLedger(),
        },
      },
    ],
  };
}

function preUnresolvedEffectsRecord(value: Record<string, any>) {
  const record = structuredClone(value);
  record.schemaVersion = 5;
  delete record.unresolvedEffects;
  for (const projection of [
    record.structuralProjection,
    record.lastAppliedExecutionProjection,
    record.uncertain?.attemptedExecutionProjection,
  ]) {
    for (const item of Object.values(projection?.catalog ?? {}) as any[]) {
      item.artifactSchema = 2;
    }
  }
  return record;
}

async function seedSettled(
  fixture: Awaited<ReturnType<typeof lifecycleFixture>>,
  snapshot: ReturnType<typeof shellSnapshot>,
) {
  const lease = await fixture.store.acquire(logicalSessionId);
  await lease.initializeSettledWithPredecessor({
    cwd: fixture.payload.cwd,
    structuralProjection: projectCaptainSessionStructure(fixture.execution),
    executionProjection: fixture.execution,
    snapshot,
  });
  await lease.release();
}

async function seedRetainedSettled(
  fixture: Awaited<ReturnType<typeof lifecycleFixture>>,
  sessionId: string,
) {
  const snapshot = shellSnapshot(fixture.execution, 0);
  const lease = await fixture.store.acquire(sessionId);
  await lease.initializeSettledWithPredecessor({
    cwd: fixture.payload.cwd,
    structuralProjection: projectCaptainSessionStructure(fixture.execution),
    executionProjection: fixture.execution,
    snapshot,
  });
  await lease.beginTurn({
    input: 'seed retained generation',
    attemptId,
    attemptedExecutionProjection: fixture.execution,
  });
  await lease.settle({
    attemptId,
    snapshot,
    unresolvedEffects: [],
    retentionUpdates: [
      {
        kind: 'retain',
        rootPlaybookId: 'code',
        generation: retainedGeneration(),
      },
    ],
  });
  await lease.release();
}

function fakeHost(events: string[]) {
  return {
    abortActiveTurn() {},
    async runBossTurn() {},
    async dispose() {
      events.push('disposed');
    },
  };
}

class FakeSignalTarget extends EventEmitter {
  pid = 101;
  kill() {}
}
