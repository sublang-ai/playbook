// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import createPlaybookRuntime, {
  type JsonValue,
  type PlaybookCallStart,
  type PlaybookPorts,
  type PlaybookSession,
  type PlayerResult,
} from './code.playbook.js';
import {
  codeCopyPasteGuardNames,
  codeStateCountLabels,
} from './code.registry.js';

const APPROVED = {
  approvedCommit: 'latest',
  noUnsettledFindings: true,
} as const;

interface Fixtures {
  players: PlayerResult[];
  judges: unknown[];
  children: PlaybookCallStart[];
}

function harness(fixtures: Partial<Fixtures> = {}) {
  const players = [...(fixtures.players ?? [])];
  const judges = [...(fixtures.judges ?? [])];
  const children = [...(fixtures.children ?? [])];
  const playerCalls: Array<{
    playerId: string;
    prompt: string;
    resume: string | false;
  }> = [];
  const judgePrompts: string[] = [];
  const childRequests: Array<{
    callId: string;
    playbookId: string;
    text: string;
  }> = [];
  const statuses: string[] = [];
  const telemetry: Array<{ topic: string; payload: unknown }> = [];
  const ports: PlaybookPorts = {
    async callPlayer(playerId, prompt, _signal, options) {
      playerCalls.push({ playerId, prompt, resume: options.resume });
      const result = players.shift();
      if (result === undefined) throw new Error('missing player fixture');
      return result;
    },
    async callCaptain() {
      throw new Error('CODE has no direct Captain state');
    },
    async callJudge(prompt) {
      judgePrompts.push(prompt);
      if (judges.length === 0) throw new Error('missing judge fixture');
      return JSON.stringify(judges.shift());
    },
    async callPlaybook(request) {
      childRequests.push(request);
      const start = children.shift();
      if (start === undefined) throw new Error('missing child fixture');
      return start;
    },
    async emitStatus(message) {
      statuses.push(message);
    },
    async emitTelemetry(event) {
      telemetry.push(event);
    },
  };
  return {
    ports,
    playerCalls,
    judgePrompts,
    childRequests,
    statuses,
    telemetry,
  };
}

function rootSession(ports: PlaybookPorts): PlaybookSession {
  return {
    sessionId: 'code-root',
    playbookId: 'code',
    rootSessionId: 'code-root',
    depth: 0,
    ports,
  };
}

function approvedChild(index: number): PlaybookCallStart {
  return {
    state: 'settled',
    result: {
      status: 'ok',
      playbookId: 'review',
      childSessionId: `review-${index}`,
      output: APPROVED,
    },
  };
}

describe('linked CODE runtime', () => {
  it('leaves review-round counting to the nested REVIEW playbook', () => {
    expect(codeStateCountLabels).toEqual({});
    expect(codeCopyPasteGuardNames).toEqual([
      'directCommit',
      'irCommit',
      'moreTasks',
      'finalTask',
    ]);
  });

  it('runs one direct commit and calls REVIEW with exact quoted context', async () => {
    const host = harness({
      players: [
        {
          status: 'ok',
          finalText: 'Committed abc123.\nTests passed.',
          resumeToken: 'coder-1',
        },
      ],
      judges: [{ guard: 'directCommit' }],
      children: [approvedChild(1)],
    });
    const runtime = createPlaybookRuntime({ coderPlayer: 'GPT-5.6 Sol' });
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Fix the bug.\nPreserve compatibility.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'complete',
      lastCodeOutput: 'Committed abc123.\nTests passed.',
    });
    expect(host.playerCalls).toHaveLength(1);
    expect(host.playerCalls[0]).toMatchObject({
      playerId: 'coder',
      resume: false,
    });
    expect(host.playerCalls[0]?.prompt).toContain(
      '> Fix the bug.\n> Preserve compatibility.',
    );
    expect(host.playerCalls[0]?.prompt).toContain('Coder is GPT-5.6 Sol;');
    expect(host.childRequests).toHaveLength(1);
    expect(host.childRequests[0]).toMatchObject({
      playbookId: 'review',
      text:
        '> Initial intent: Fix the bug.\n' +
        '> Preserve compatibility.\n' +
        '> Coder output: Committed abc123.\n' +
        '> Tests passed.',
    });
    await runtime.dispose();
  });

  it('keeps one Coder conversation across reviewed IR phases', async () => {
    const host = harness({
      players: [
        {
          status: 'ok',
          finalText: 'Created IR-040.',
          resumeToken: 'coder-1',
        },
        {
          status: 'ok',
          finalText: 'Committed task 1.',
          resumeToken: 'coder-2',
        },
        {
          status: 'ok',
          finalText: 'Committed task 2.',
          resumeToken: 'coder-3',
        },
      ],
      judges: [
        {
          guard: 'irCommit',
          irNumber: '040',
          irTask: 'Implement task 1.',
        },
        { guard: 'moreTasks', irTask: 'Implement task 2.' },
        { guard: 'finalTask' },
      ],
      children: [approvedChild(1), approvedChild(2), approvedChild(3)],
    });
    const runtime = createPlaybookRuntime({ coderPlayer: 'GPT-5.6 Sol' });
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Implement the large change.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    expect(host.playerCalls.map(({ resume }) => resume)).toEqual([
      false,
      'coder-1',
      'coder-2',
    ]);
    expect(host.playerCalls[1]?.prompt).toContain(
      '> Implement task 1.\n\nRead IR-040',
    );
    expect(host.playerCalls[2]?.prompt).toContain(
      '> Implement task 2.\n\nRead IR-040',
    );
    expect(host.childRequests.map(({ text }) => text)).toEqual([
      '> Initial intent: Implement the large change.\n> Coder output: Created IR-040.',
      '> IR task: Implement task 1.\n> Coder output: Committed task 1.',
      '> IR task: Implement task 2.\n> Coder output: Committed task 2.',
    ]);
    await runtime.dispose();
  });

  it('suspends on REVIEW and validates its exact approval on resume', async () => {
    const host = harness({
      players: [{ status: 'ok', finalText: 'Committed abc123.' }],
      judges: [{ guard: 'directCommit' }],
      children: [
        { state: 'suspended', childSessionId: 'review-suspended' },
      ],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(rootSession(host.ports));
    const suspended = await runtime.handleBossInput({
      text: 'Fix it.',
      signal: new AbortController().signal,
    });
    expect(suspended.outcome).toBe('suspended');
    if (suspended.outcome !== 'suspended') throw new Error('expected suspension');

    const resumed = await runtime.resumePlaybookCall({
      callId: suspended.pendingCall.callId,
      signal: new AbortController().signal,
      result: {
        status: 'ok',
        playbookId: 'review',
        childSessionId: 'review-suspended',
        output: APPROVED,
      },
    });
    expect(resumed.outcome).toBe('terminal');
    await runtime.dispose();
  });

  it('reports valid REVIEW abort/error results with the last CODE evidence', async () => {
    const host = harness({
      players: [{ status: 'ok', finalText: 'Committed abc123.' }],
      judges: [{ guard: 'directCommit' }],
      children: [
        {
          state: 'settled',
          result: {
            status: 'error',
            playbookId: 'review',
            childSessionId: 'review-error',
            error: { name: 'ReviewError', message: 'Reviewer unavailable.' },
          },
        },
      ],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(rootSession(host.ports));
    const result = await runtime.handleBossInput({
      text: 'Fix it.',
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe('terminal');
    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'review-failed',
      lastCodeOutput: 'Committed abc123.',
      error: { name: 'ReviewError', message: 'Reviewer unavailable.' },
    });
    expect(host.playerCalls).toHaveLength(1);
    await runtime.dispose();
  });

  it('treats an invalid REVIEW success result as terminal failure', async () => {
    const host = harness({
      players: [{ status: 'ok', finalText: 'Committed abc123.' }],
      judges: [{ guard: 'directCommit' }],
      children: [
        {
          state: 'settled',
          result: {
            status: 'ok',
            playbookId: 'review',
            childSessionId: 'review-invalid',
            output: { approvedCommit: 'old', noUnsettledFindings: true },
          },
        },
      ],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(rootSession(host.ports));
    const result = await runtime.handleBossInput({
      text: 'Fix it.',
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe('terminal');
    const output = result.outcome === 'terminal' ? result.output : undefined;
    expect(output).toMatchObject({
      status: 'review-failed',
      lastCodeOutput: 'Committed abc123.',
      error: { name: 'ReviewContractError' },
    });
    await runtime.dispose();
  });

  it('resumes the same Coder state with a quoted Boss answer', async () => {
    const host = harness({
      players: [
        {
          status: 'ok',
          finalText: 'Which branch should I use?',
          resumeToken: 'coder-question',
        },
        {
          status: 'ok',
          finalText: 'Committed after the answer.',
          resumeToken: 'coder-done',
        },
      ],
      judges: [
        {
          guard: 'needsBossReply',
          question: 'Which branch should I use?',
        },
        { type: 'BOSS_REPLY' },
        { guard: 'directCommit' },
      ],
      children: [approvedChild(1)],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(rootSession(host.ports));
    const parked = await runtime.handleBossInput({
      text: 'Implement it.',
      signal: new AbortController().signal,
    });
    expect(parked.outcome).toBe('quiescent');

    const completed = await runtime.handleBossInput({
      text: 'Use the narrow branch.',
      signal: new AbortController().signal,
    });
    expect(completed.outcome).toBe('terminal');
    expect(host.playerCalls.map(({ resume }) => resume)).toEqual([
      false,
      'coder-question',
    ]);
    expect(host.playerCalls[1]?.prompt).toContain(
      'Boss question:\nWhich branch should I use?\n\n' +
        'Boss reply:\nUse the narrow branch.',
    );
    await runtime.dispose();
  });

  it('validates and snapshots the small runtime option surface', () => {
    expect(() => createPlaybookRuntime({ coderPlayer: 'GPT', extra: true } as never)).toThrow(
      'CODE runtime options.extra is not declared',
    );
    expect(() => createPlaybookRuntime({ coderPlayer: 5 } as never)).toThrow(
      'CODE runtime options.coderPlayer must be a string',
    );
    const mutable = { coderPlayer: 'GPT' };
    const runtime = createPlaybookRuntime(mutable);
    mutable.coderPlayer = 'changed';
    expect(runtime).toBeDefined();
  });

  it('emits a complete trace pair around every nested REVIEW call', async () => {
    const host = harness({
      players: [{ status: 'ok', finalText: 'Committed abc123.' }],
      judges: [{ guard: 'directCommit' }],
      children: [approvedChild(1)],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(rootSession(host.ports));
    await runtime.handleBossInput({
      text: 'Fix it.',
      signal: new AbortController().signal,
    });
    const trace = host.telemetry
      .filter(({ topic }) => topic === 'playbook.trace')
      .map(({ payload }) => payload as { type?: string; payload?: JsonValue });
    expect(trace.filter(({ type }) => type === 'playbook.call.started')).toHaveLength(1);
    expect(trace.filter(({ type }) => type === 'playbook.call.finished')).toHaveLength(1);
    await runtime.dispose();
  });
});
