// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReplayRecordObserver } from './bin/replay-observer.js';
import {
  createCaptainSessionStore,
  sanitizeReplayRecord,
} from './bin/session-store.js';

const sessionId = '90000000-0000-4000-8000-000000000091';
const outerSessionId = '80000000-0000-4000-8000-000000000091';
const nestedSessionId = '80000000-0000-4000-8000-000000000092';
const playerId = 'code-shared';
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function replayFixture() {
  const root = await mkdtemp(join(tmpdir(), 'captain-replay-observer-'));
  tempDirs.push(root);
  const store = createCaptainSessionStore({
    sessionsDir: join(root, 'sessions'),
  });
  return { store, lease: await store.acquire(sessionId) };
}

async function unavailableReplayFixture() {
  const root = await mkdtemp(join(tmpdir(), 'captain-replay-observer-'));
  tempDirs.push(root);
  const sessionsDir = join(root, 'sessions');
  await mkdir(sessionsDir, { mode: 0o700 });
  await chmod(sessionsDir, 0o700);
  const streamPath = join(sessionsDir, `${sessionId}.records.jsonl`);
  await writeFile(streamPath, '{"v":1,"seq":1,"record":[]}\n', {
    mode: 0o600,
  });
  await chmod(streamPath, 0o600);
  const store = createCaptainSessionStore({ sessionsDir });
  return { store, lease: await store.acquire(sessionId) };
}

function playerTrace(
  type: 'player.call.started' | 'player.call.finished',
  traceSessionId: string,
  callId: string,
  roleId: string,
  options: { status?: 'error' } = {},
) {
  return {
    type: 'captain_telemetry',
    topic: 'playbook.trace',
    payload: {
      schemaVersion: 4,
      sessionId: traceSessionId,
      playbookId: 'code',
      rootSessionId: outerSessionId,
      depth: traceSessionId === outerSessionId ? 0 : 1,
      sequence: 1,
      timestamp: 1,
      type,
      turnId: 1,
      callId,
      payload: {
        roleId,
        playerId,
        resume: false,
        ...(type === 'player.call.started'
          ? { prompt: 'player prompt' }
          : { status: options.status ?? 'ok' }),
      },
    },
  };
}

describe('replay record observer (PBCLI-74/77/79/84)', () => {
  it(
    'folds exact trace frames into unambiguous local envelope roles',
    async () => {
      const { store, lease } = await replayFixture();
      const channel = createReplayRecordObserver({
        lease,
        async onIncomplete() {
          throw new Error('a healthy stream must not warn');
        },
      });
      const records = [
        {
          type: 'player_event',
          playerId: 'coder',
          event: { type: 'message', role: 'reviewer', text: 'unassociated' },
        },
        playerTrace(
          'player.call.started',
          outerSessionId,
          'player-1',
          'coder',
        ),
        { type: 'player_prompt', playerId, prompt: 'outer prompt' },
        playerTrace(
          'player.call.started',
          nestedSessionId,
          'player-1',
          'reviewer',
        ),
        {
          type: 'player_event',
          playerId,
          event: { type: 'message', role: 'coder', text: 'nested ambiguity' },
        },
        playerTrace(
          'player.call.finished',
          nestedSessionId,
          'player-1',
          'reviewer',
        ),
        {
          type: 'player_event',
          playerId,
          event: { type: 'message', role: 'reviewer', text: 'outer resumes' },
        },
        playerTrace(
          'player.call.started',
          outerSessionId,
          'player-2',
          'reviewer',
        ),
        playerTrace(
          'player.call.finished',
          outerSessionId,
          'player-2',
          'reviewer',
          { status: 'error' },
        ),
        { type: 'player_finished', playerId, status: 'success' },
        playerTrace(
          'player.call.finished',
          outerSessionId,
          'player-1',
          'coder',
        ),
        {
          type: 'player_event',
          playerId,
          event: { type: 'message', role: 'coder', text: 'after close' },
        },
      ];

      for (const record of records) await channel.observer.onRecord(record);
      await lease.release();

      const stream = await store.readStream(sessionId);
      expect(stream.entries.map(({ seq }) => seq)).toEqual(
        records.map((_, index) => index + 1),
      );
      expect(stream.entries.map(({ role }) => role)).toEqual([
        undefined,
        undefined,
        'coder',
        undefined,
        undefined,
        undefined,
        'coder',
        undefined,
        undefined,
        'coder',
        undefined,
        undefined,
      ]);
      expect(stream.entries.map(({ record }) => record)).toEqual(records);
    },
  );

  it(
    'marks a warning attempted before delivery and never retries it',
    async () => {
      const { lease } = await replayFixture();
      const deliveryAttempts: string[] = [];
      const channel = createReplayRecordObserver({
        lease,
        async onIncomplete() {
          deliveryAttempts.push('attempted');
          throw new Error('synthetic warning sink failure');
        },
      });
      const cyclic: Record<string, unknown> = { type: 'cyclic' };
      cyclic.self = cyclic;

      await expect(channel.observer.onRecord(cyclic)).resolves.toBeUndefined();
      expect(lease.streamStatus()).toEqual({
        lastReadableSeq: 0,
        lastDurableSeq: 0,
        incomplete: true,
      });
      await expect(
        channel.observer.onRecord({
          type: 'captain_status',
          message: 'suppressed',
        }),
      ).resolves.toBeUndefined();
      await expect(
        channel.reportIfIncomplete(lease.streamStatus()),
      ).resolves.toBeUndefined();
      expect(deliveryAttempts).toEqual(['attempted']);

      await lease.release();
    },
  );

  it('does not treat a malformed trace fragment as role authority', async () => {
    const { store, lease } = await replayFixture();
    const channel = createReplayRecordObserver({
      lease,
      async onIncomplete() {
        throw new Error('a JSON-safe malformed trace must not warn');
      },
    });
    const malformed = playerTrace(
      'player.call.started',
      outerSessionId,
      'malformed-player',
      'coder',
    );
    delete (malformed.payload as Record<string, unknown>).playbookId;
    const playerRecord = {
      type: 'player_prompt',
      playerId,
      prompt: 'must remain role-free',
    };
    const blankResume = playerTrace(
      'player.call.started',
      outerSessionId,
      'blank-resume-player',
      'reviewer',
    );
    blankResume.payload.payload.resume = '  ';
    const secondPlayerRecord = {
      type: 'player_event',
      playerId,
      event: { type: 'message', text: 'also role-free' },
    };

    await channel.observer.onRecord(malformed);
    await channel.observer.onRecord(playerRecord);
    await channel.observer.onRecord(blankResume);
    await channel.observer.onRecord(secondPlayerRecord);
    await lease.release();

    const stream = await store.readStream(sessionId);
    expect(stream.entries.map(({ role }) => role)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(stream.entries.map(({ record }) => record)).toEqual(
      [malformed, playerRecord, blankResume, secondPlayerRecord].map(
        sanitizeReplayRecord,
      ),
    );
  });

  it('accepts a valid player frame without an optional turn id', async () => {
    const { store, lease } = await replayFixture();
    const channel = createReplayRecordObserver({
      lease,
      async onIncomplete() {
        throw new Error('a healthy stream must not warn');
      },
    });
    const started = playerTrace(
      'player.call.started',
      outerSessionId,
      'initial-player',
      'coder',
    );
    delete (started.payload as Record<string, unknown>).turnId;
    const playerRecord = {
      type: 'player_prompt',
      playerId,
      prompt: 'initial-state prompt',
    };

    await channel.observer.onRecord(started);
    await channel.observer.onRecord(playerRecord);
    await lease.release();

    const stream = await store.readStream(sessionId);
    expect(stream.entries.map(({ role }) => role)).toEqual([
      undefined,
      'coder',
    ]);
  });

  it(
    'defers a preexisting incomplete writer to an explicit boundary',
    async () => {
      const { lease } = await unavailableReplayFixture();
      const deliveryAttempts: string[] = [];
      const channel = createReplayRecordObserver({
        lease,
        async onIncomplete() {
          deliveryAttempts.push('attempted');
        },
      });
      expect(lease.streamStatus()).toEqual({
        lastReadableSeq: null,
        lastDurableSeq: null,
        incomplete: true,
      });

      await channel.observer.onRecord({
        type: 'captain_status',
        message: 'host initialization record',
      });
      expect(deliveryAttempts).toEqual([]);
      await channel.reportIfIncomplete();
      await channel.reportIfIncomplete(lease.streamStatus());
      expect(deliveryAttempts).toEqual(['attempted']);

      await lease.release();
    },
  );
});
