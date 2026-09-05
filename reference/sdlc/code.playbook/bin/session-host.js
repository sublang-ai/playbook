// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';
import { createCaptainSessionStore, projectCaptainSessionStructure } from './session-store.js';
import { createCaptainSessionHost, executionConfigFromPlan, installRetainedGenerationsForLaunch, validateFrozenExecutionConfig } from './run.js';
import { createReplayRecordObserver } from './replay-observer.js';

/** Own one session lease and the same durable turn transaction as the CLIs. */
export async function openSessionHost(options) {
  const store = options.store ?? createCaptainSessionStore({ sessionsDir: options.sessionsDir });
  const sessionId = options.sessionId ?? randomUUID();
  const loadModule = options.loadModule ?? ((specifier) => import(specifier));
  const lease = await store.acquire(sessionId);
  let active, closed = false, closing;
  let created;
  let retryPending = options.mode === 'retry';
  try {
    let record = await lease.recoverUnresolvedEffectAbandonment();
    if (options.mode === 'new' && record !== undefined) throw new Error('session already exists');
    if (options.mode !== 'new' && options.sessionId && record === undefined) throw new Error('session does not exist');
    if (record?.state === 'uncertain' && !retryPending) throw new Error('session has an uncertain turn; select Retry or Discard');
    if (retryPending && record?.state !== 'uncertain') throw new Error('session has no uncertain turn to retry');
    const cwd = options.cwd ?? record?.cwd ?? process.cwd();
    const selected = retryPending ? record.uncertain.attemptedExecutionProjection : options.config ?? (options.plan ? executionConfigFromPlan(options.plan) : record?.lastAppliedExecutionProjection);
    if (!selected) throw new Error('a new session requires a validated execution configuration');
    const structure = record?.structuralProjection ?? projectCaptainSessionStructure(selected);
    const config = await validateFrozenExecutionConfig(structure, selected, { loadModule, prepareRegistryModule: options.prepareRegistryModule });
    if (record !== undefined) await lease.assertContinuable({ cwd, executionProjection: config });
    const replay = createReplayRecordObserver({ lease, onIncomplete: options.onIncomplete ?? (() => {}), onStored: options.onStoredRecord });
    let terminal, replies = [];
    const observe = {
      async onRecord(value) {
        if (value.type === "turn_finished" || value.type === "turn_aborted") terminal = value;
        if (value.type === "captain_reply") replies.push(value);
        await replay.observer.onRecord(value);
        for (const observer of options.observers ?? []) await observer.onRecord?.(value);
      },
    };
    created = await createCaptainSessionHost({ ...options, config, sessionId, cwd, sessionLease: lease, loadModule, observers: [observe], restoreSnapshot: record?.snapshot, reconcileUncertainTurnReplay: retryPending });
    await installRetainedGenerationsForLaunch({ lease, shell: created.shell, ...(record === undefined ? { freshBoundary: { cwd, structuralProjection: structure, executionProjection: config, snapshot: created.snapshot } } : {}), retainedGenerations: record?.retainedGenerations ?? {}, reconcileRepositoryEffects: created.reconcileRepositoryEffects });
    record = await lease.read();
    const execute = async (input, retry) => {
      if (closed || closing) throw new Error('session host is closing');
      if (active) throw new Error('session turn is already active');
      const operation = (async () => {
        let prior = await lease.read();
        if (retry) {
          if (prior?.state !== 'uncertain') throw new Error('session has no uncertain turn to retry');
          input = prior.uncertain.input;
          if (!retryPending) throw new Error('retry requires reopening the uncertain checkpoint');
        } else if (prior?.state !== 'settled') throw new Error('session has an uncertain turn; select Retry or Discard');
        if (typeof input !== 'string' || input.trim().length === 0) throw new Error('session input must be nonempty');
        await created.reconcileRepositoryEffects();
        terminal = undefined; replies = [];
        const attemptId = options.createAttemptId?.() ?? randomUUID();
        const marked = retry ? await lease.beginRetry({ expectedAttemptId: prior.uncertain.attemptId, nextAttemptId: attemptId }) : await lease.beginTurn({ input, attemptId, attemptedExecutionProjection: config });
        retryPending = false;
        await options.onCheckpoint?.(marked);
        await lease.assertOwner();
        await created.host.runBossTurn(input);
        if (terminal?.type !== "turn_finished" || replies.length !== 1 || typeof replies[0].text !== "string" || replies[0].text.trim().length === 0) throw new Error("Captain turn did not finish with one reply; session remains uncertain");
        const settlement = created.shell.exportSettlement();
        if (settlement === undefined) throw new Error('Captain turn ended without durable settlement; session remains uncertain');
        record = await lease.settle({ attemptId, snapshot: settlement.snapshot, unresolvedEffects: settlement.unresolvedEffects, retentionUpdates: settlement.retentionUpdates });
        await options.onCheckpoint?.(record);
        return record;
      })();
      active = operation;
      try { return await operation; } finally { active = undefined; }
    };
    const dispose = () => {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      closing = (async () => {
        try { await active; } catch { /* Preserve the durable uncertain marker. */ }
        await created.host.dispose();
        await lease.release(); closed = true;
      })();
      return closing;
    };
    return Object.freeze({ sessionId, host: created.host, shell: created.shell, lease, read: () => lease.read(), handleBossTurn: (input) => execute(input, false), retry: () => execute(undefined, true), dispose });
  } catch (cause) {
    const failures = [cause];
    let disposed = true;
    try { await created?.host.dispose(); } catch (error) { disposed = false; failures.push(error); }
    if (disposed) try { await lease.release(); } catch (error) { failures.push(error); }
    throw failures.length === 1 ? cause : new AggregateError(failures, 'session host setup and cleanup failed');
  }
}

export async function discardSessionUncertain(store, sessionId) {
  const lease = await store.acquire(sessionId);
  try {
    const record = await lease.recoverUnresolvedEffectAbandonment();
    if (record?.state !== 'uncertain') throw new Error('session has no uncertain turn to discard');
    return await lease.discard({ attemptId: record.uncertain.attemptId });
  } finally { await lease.release(); }
}
