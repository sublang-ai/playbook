// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';
import { normalizeSessionTurnInput } from '../session-assets.js';
import { createCaptainSessionStore, isUncertainTurnDiscardable, projectCaptainSessionStructure } from './session-store.js';
import { createCaptainSessionHost, executionConfigFromPlan, installRetainedGenerationsForLaunch, validateFrozenExecutionConfig } from './run.js';
import { createReplayRecordObserver } from './replay-observer.js';

const RECOVERY_REOPEN = "This controller stopped with an uncertain turn. Dispose it, reopen with mode: 'recover', then call recover() without new input.";

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
    let record = await lease.read();
    if (record !== undefined) await lease.assertContinuable({ cwd: options.cwd });
    record = await lease.recoverUnresolvedEffectAbandonment();
    if (options.mode === 'recover') retryPending = record?.state === 'uncertain';
    if (options.mode === 'new' && record !== undefined) throw new Error('session already exists');
    if (options.mode !== 'new' && options.sessionId && record === undefined) throw new Error('session does not exist');
    if (record?.state === 'uncertain' && !retryPending) throw new Error(isUncertainTurnDiscardable(record) ? 'session has an uncertain turn; select Retry or Discard' : 'session has recorded work or repository evidence; select Retry to restore and report it');
    if (retryPending && record?.state !== 'uncertain') throw new Error('session has no uncertain turn to retry');
    const cwd = options.cwd ?? record?.cwd ?? process.cwd();
    const selected = retryPending ? record.uncertain.attemptedExecutionProjection : options.config ?? (options.plan ? executionConfigFromPlan(options.plan) : record?.lastAppliedExecutionProjection);
    if (!selected) throw new Error('a new session requires a validated execution configuration');
    const structure = record?.structuralProjection ?? projectCaptainSessionStructure(selected);
    if (record !== undefined) await lease.assertContinuable({ cwd, executionProjection: selected });
    const config = await validateFrozenExecutionConfig(structure, selected, { loadModule, prepareRegistryModule: options.prepareRegistryModule });
    const replay = createReplayRecordObserver({ lease, onIncomplete: options.onIncomplete ?? (() => {}), onStored: options.onStoredRecord });
    let terminal, replies = [], submittedAttachments = [];
    const observe = {
      async onRecord(value) {
        if (value.type === 'turn_started' && submittedAttachments.length) value = { ...value, turn: { ...value.turn, attachments: submittedAttachments } };
        if (value.type === "turn_finished" || value.type === "turn_aborted") terminal = value;
        if (value.type === "captain_reply") replies.push(value);
        await replay.observer.onRecord(value);
        for (const observer of options.observers ?? []) await observer.onRecord?.(value);
      },
    };
    created = await createCaptainSessionHost({ ...options, config, sessionId, cwd, sessionLease: lease, loadModule, observers: [observe], restoreSnapshot: record?.snapshot, reconcileUncertainTurnReplay: retryPending });
    await installRetainedGenerationsForLaunch({ lease, shell: created.shell, ...(record === undefined ? { freshBoundary: { cwd, structuralProjection: structure, executionProjection: config, snapshot: created.snapshot } } : {}), retainedGenerations: record?.retainedGenerations ?? {}, reconcileRepositoryEffects: created.reconcileRepositoryEffects });
    record = await lease.read();
    await replay.flushStoredRecords();
    const assertIdle = () => {
      if (closed || closing) throw new Error('session host is closing');
      if (active) throw new Error('session turn is already active');
    };
    const execute = async (input, retry, actionId, shellActionId) => {
      assertIdle();
      let attemptId;
      let attachments = [];
      const operation = (async () => {
        let prior = await lease.read();
        if (retry) {
          if (prior?.state !== 'uncertain') throw new Error('session has no uncertain turn to retry');
          input = prior.uncertain.input;
          attachments = prior.uncertain.attachments ?? [];
          if (!retryPending) throw new Error(RECOVERY_REOPEN);
        } else if (prior?.state !== 'settled') throw new Error(RECOVERY_REOPEN);
        if (actionId === undefined && shellActionId === undefined) {
          const normalized = normalizeSessionTurnInput(retry ? { text: input, attachments } : input);
          input = normalized.text; attachments = normalized.attachments;
          if (!input.trim() && attachments.length === 0) throw new Error('session input must contain text or attachments');
          if (attachments.length) await lease.resolveAttachments(attachments, { signal: options.signal });
        }
        await created.reconcileRepositoryEffects();
        // The selection is made after reconciliation, so the advertised
        // reading it is validated against is the one this turn settles
        // against, and its Boss text is this turn's durable input.
        if (actionId !== undefined) {
          if (typeof created.shell.submitRuntimeAction !== 'function') throw new Error('this Captain shell advertises no runtime actions');
          input = created.shell.submitRuntimeAction(actionId);
        } else if (shellActionId !== undefined) {
          if (typeof created.shell.submitShellAction !== 'function') throw new Error('this Captain shell advertises no controls of its own');
          input = created.shell.submitShellAction(shellActionId);
        }
        terminal = undefined; replies = [];
        attemptId = options.createAttemptId?.() ?? randomUUID();
        const marked = retry ? await lease.beginRetry({ expectedAttemptId: prior.uncertain.attemptId, nextAttemptId: attemptId }) : await lease.beginTurn({ input, attachments, attemptId, attemptedExecutionProjection: config });
        retryPending = false;
        await replay.flushStoredRecords();
        await options.onCheckpoint?.(marked);
        await lease.assertOwner();
        submittedAttachments = attachments;
        created.shell.setTurnAttachments?.(attachments);
        await created.host.runBossTurn(input);
        if (terminal?.type !== "turn_finished" || replies.length !== 1 || typeof replies[0].text !== "string" || replies[0].text.trim().length === 0) throw new Error("Captain turn did not finish with one reply; session remains uncertain");
        const settlement = created.shell.exportSettlement();
        if (settlement === undefined) throw new Error('Captain turn ended without durable settlement; session remains uncertain');
        record = await lease.settle({ attemptId, snapshot: settlement.snapshot, unresolvedEffects: settlement.unresolvedEffects, retentionUpdates: settlement.retentionUpdates });
        await replay.flushStoredRecords();
        await options.onCheckpoint?.(record);
        return record;
      })().catch(async (error) => {
        try {
          const parked = created.getInterruptedSettlement(attemptId);
          if (parked?.state === 'settled') {
            record = parked;
            await replay.flushStoredRecords();
            await options.onCheckpoint?.(record);
          }
        } catch (reportError) {
          throw new AggregateError([error, reportError], 'Captain turn stopped and its saved state could not be reported');
        }
        throw error;
      });
      active = operation;
      try { return await operation; } finally { active = undefined; submittedAttachments = []; }
    };

    const dispose = () => {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      created.cancelPendingApprovals();
      closing = (async () => {
        try { await active; } catch { /* Preserve the durable uncertain marker. */ }
        await created.host.dispose();
        await lease.release(); closed = true;
      })();
      return closing;
    };
    const recover = async (input) => {
      assertIdle();
      const prior = await lease.read();
      assertIdle();
      if (prior?.state === 'uncertain' && !retryPending) throw new Error(RECOVERY_REOPEN);
      if (retryPending) {
        if (input !== undefined) throw new Error('Restore and report the interrupted run before supplying new input');
        return execute(undefined, true);
      }
      if (typeof input !== 'string' || !input.trim()) throw new Error('Recovery of a paused task requires a Boss instruction');
      return execute(input, false);
    };
    return Object.freeze({ sessionId, host: created.host, shell: created.shell, lease, read: () => lease.read(), handleBossTurn: (input) => execute(input, false), recover, listRuntimeActions: () => created.shell.describeRuntimeActions?.() ?? Object.freeze([]), submitRuntimeAction: (actionId) => execute(undefined, false, actionId), listShellActions: () => created.shell.describeShellActions?.() ?? Object.freeze([]), submitShellAction: (actionId) => execute(undefined, false, undefined, actionId), retry: () => execute(undefined, true), dispose });
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
