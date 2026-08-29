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
  codePlaybookRegistryEntry,
  codeStateCountLabels,
  validateCodeOptions,
} from './code.registry.js';

const APPROVED = {
  approvedCommit: 'latest',
  noUnsettledFindings: true,
} as const;

interface Fixtures {
  players: PlayerResult[];
  judges: unknown[];
  children: Array<PlaybookCallStart | Error>;
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
      if (start instanceof Error) throw start;
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
    roleBindings: {
      coder: { playerId: 'coder', promptIdentity: 'GPT-5.6 Sol' },
    },
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

  it('advertises the schema-2 local-role manifest', () => {
    expect(codePlaybookRegistryEntry).toMatchObject({
      artifactSchema: 2,
      runtimeProfile: {
        kind: 'shared-factory',
        compat: { artifactSchema: 2, runtimeAbi: 1 },
      },
      requiredRoleIds: ['coder'],
      concurrentRoleSets: [],
    });
    expect(codePlaybookRegistryEntry.runtimeProfile.compat).toBe(
      createPlaybookRuntime.compat,
    );
    expect(codePlaybookRegistryEntry.createRuntime(validateCodeOptions({}))).toBeDefined();
  });

  it('runs one direct commit and calls REVIEW with exact quoted context', async () => {
    const host = harness({
      players: [
        {
          status: 'ok',
          finalText: 'Tests passed.\nCommit: abc123',
          resumeToken: 'coder-1',
        },
      ],
      judges: [{ guard: 'directCommit', latestCommit: 'abc123' }],
      children: [approvedChild(1)],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Fix the bug.\nPreserve compatibility.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    expect(
      result.outcome === 'terminal' ? result.stateDescription : undefined,
    ).toBe(
      'The coding workflow completed after REVIEW found no unsettled findings.',
    );
    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'complete',
      lastCodeCommit: 'abc123',
      lastCodeOutput: 'Tests passed.\nCommit: abc123',
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
    expect(host.playerCalls[0]?.prompt).toContain(
      'exactly one final-response line beginning `Commit: `',
    );
    expect(host.childRequests).toHaveLength(1);
    expect(host.childRequests[0]).toMatchObject({
      playbookId: 'review',
      text:
        '> Initial intent: Fix the bug.\n' +
        '> Preserve compatibility.\n' +
        '> Coder output: Tests passed.\n' +
        '> Commit: abc123',
    });
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('done');
    expect(view.stateDescription).toBe(
      'The coding workflow completed after REVIEW found no unsettled findings.',
    );
    await runtime.dispose();
  });

  it('requires a nonempty commit identity before calling REVIEW', async () => {
    const host = harness({
      players: [{ status: 'ok', finalText: 'Committed without an identity.' }],
      judges: [{ guard: 'directCommit', latestCommit: '   ' }],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Fix it.',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
      error: {
        message: 'Coder result for CODE-1 did not match a declared outcome.',
      },
    });
    expect(host.childRequests).toEqual([]);
    await runtime.dispose();
  });

  it('requires the adjudicated commit identity in the Coder final text', async () => {
    const host = harness({
      players: [{ status: 'ok', finalText: 'Committed the requested fix.' }],
      judges: [{ guard: 'directCommit', latestCommit: 'abc123' }],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Fix it.',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      state: { stateId: 'failed' },
      error: {
        message: 'Coder result for CODE-1 did not match a declared outcome.',
      },
    });
    expect(host.childRequests).toEqual([]);
    await runtime.dispose();
  });

  it('makes the commit identity a required adjudication field', async () => {
    const host = harness({
      players: [{ status: 'ok', finalText: 'Committed.\nCommit: abc123' }],
      judges: [{ guard: 'directCommit' }],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(rootSession(host.ports));

    await expect(
      runtime.handleBossInput({
        text: 'Fix it.',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      'adjudicate: judge response missing required field "latestCommit" ' +
        'for guard "directCommit"',
    );
    expect(host.childRequests).toEqual([]);
    await runtime.dispose();
  });

  it('keeps one Coder conversation across reviewed IR phases', async () => {
    const host = harness({
      players: [
        {
          status: 'ok',
          finalText: 'Created IR-040.\nCommit: ir040',
          resumeToken: 'coder-1',
        },
        {
          status: 'ok',
          finalText: 'Completed task 1.\nCommit: task1',
          resumeToken: 'coder-2',
        },
        {
          status: 'ok',
          finalText: 'Completed task 2.\nCommit: task2',
          resumeToken: 'coder-3',
        },
      ],
      judges: [
        {
          guard: 'irCommit',
          latestCommit: 'ir040',
          irNumber: '040',
          irTask: 'Implement task 1.',
        },
        {
          guard: 'moreTasks',
          latestCommit: 'task1',
          irTask: 'Implement task 2.',
        },
        { guard: 'finalTask', latestCommit: 'task2' },
      ],
      children: [approvedChild(1), approvedChild(2), approvedChild(3)],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Implement the large change.',
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('terminal');
    expect(
      result.outcome === 'terminal' ? result.stateDescription : undefined,
    ).toBe(
      'The coding workflow completed after REVIEW found no unsettled findings.',
    );
    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'complete',
      lastCodeCommit: 'task2',
      lastCodeOutput: 'Completed task 2.\nCommit: task2',
    });
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
      '> Initial intent: Implement the large change.\n' +
        '> Coder output: Created IR-040.\n> Commit: ir040',
      '> IR task: Implement task 1.\n' +
        '> Coder output: Completed task 1.\n> Commit: task1',
      '> IR task: Implement task 2.\n' +
        '> Coder output: Completed task 2.\n> Commit: task2',
    ]);
    await runtime.dispose();
  });

  it('suspends on REVIEW and validates its exact approval on resume', async () => {
    const host = harness({
      players: [{ status: 'ok', finalText: 'Committed.\nCommit: abc123' }],
      judges: [{ guard: 'directCommit', latestCommit: 'abc123' }],
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
      players: [{ status: 'ok', finalText: 'Committed.\nCommit: abc123' }],
      judges: [{ guard: 'directCommit', latestCommit: 'abc123' }],
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
    expect(
      result.outcome === 'terminal' ? result.stateDescription : undefined,
    ).toBe(
      'The coding workflow reported a REVIEW failure and the last code-owned commit.',
    );
    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'review-failed',
      lastCodeCommit: 'abc123',
      lastCodeOutput: 'Committed.\nCommit: abc123',
      error: { name: 'ReviewError', message: 'Reviewer unavailable.' },
    });
    expect(host.playerCalls).toHaveLength(1);
    // A host with no access to the run output quotes this published meaning to
    // report the outcome, so it must not read as an approval.
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('reportedReviewFailure');
    expect(view.stateDescription).toBe(
      'The coding workflow reported a REVIEW failure and the last code-owned commit.',
    );
    await runtime.dispose();
  });

  it('parks a raw nested-call rejection with the committed phase visible', async () => {
    const host = harness({
      players: [{ status: 'ok', finalText: 'Committed.\nCommit: abc123' }],
      judges: [{ guard: 'directCommit', latestCommit: 'abc123' }],
      children: [new Error('nested REVIEW bridge failed')],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(rootSession(host.ports));

    await expect(
      runtime.handleBossInput({
        text: 'Fix it.',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('nested REVIEW bridge failed');
    expect(host.playerCalls).toHaveLength(1);
    expect(host.childRequests).toHaveLength(1);
    const view = runtime.describe!();
    expect(view.state.stateId).toBe('failed');
    expect(view.lastError).toMatchObject({
      name: 'Error',
      message: 'nested REVIEW bridge failed',
    });
    expect(view.context).toEqual({ phase: 'direct' });
    await runtime.dispose();
  });

  it('reports the new-IR commit and starts no task after REVIEW fails', async () => {
    const host = harness({
      players: [
        {
          status: 'ok',
          finalText: 'Created IR-041.\nCommit: ir041',
          resumeToken: 'coder-ir',
        },
      ],
      judges: [
        {
          guard: 'irCommit',
          latestCommit: 'ir041',
          irNumber: '041',
          irTask: 'Implement task 1.',
        },
      ],
      children: [
        {
          state: 'settled',
          result: {
            status: 'error',
            playbookId: 'review',
            childSessionId: 'review-ir-error',
            error: { name: 'ReviewError', message: 'IR review failed.' },
          },
        },
      ],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Implement a large change.',
      signal: new AbortController().signal,
    });

    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'review-failed',
      lastCodeCommit: 'ir041',
      lastCodeOutput: 'Created IR-041.\nCommit: ir041',
      error: { name: 'ReviewError', message: 'IR review failed.' },
    });
    expect(host.playerCalls).toHaveLength(1);
    expect(host.childRequests).toHaveLength(1);
    await runtime.dispose();
  });

  it('reports the current task commit and starts no next task after REVIEW fails', async () => {
    const host = harness({
      players: [
        {
          status: 'ok',
          finalText: 'Created IR-041.\nCommit: ir041',
          resumeToken: 'coder-ir',
        },
        {
          status: 'ok',
          finalText: 'Completed task 1.\nCommit: task1',
          resumeToken: 'coder-task-1',
        },
      ],
      judges: [
        {
          guard: 'irCommit',
          latestCommit: 'ir041',
          irNumber: '041',
          irTask: 'Implement task 1.',
        },
        {
          guard: 'moreTasks',
          latestCommit: 'task1',
          irTask: 'Implement task 2.',
        },
      ],
      children: [
        approvedChild(1),
        {
          state: 'settled',
          result: {
            status: 'error',
            playbookId: 'review',
            childSessionId: 'review-task-error',
            error: { name: 'ReviewError', message: 'Task review failed.' },
          },
        },
      ],
    });
    const runtime = createPlaybookRuntime({});
    await runtime.init(rootSession(host.ports));

    const result = await runtime.handleBossInput({
      text: 'Implement a large change.',
      signal: new AbortController().signal,
    });

    expect(result.outcome === 'terminal' ? result.output : undefined).toEqual({
      status: 'review-failed',
      lastCodeCommit: 'task1',
      lastCodeOutput: 'Completed task 1.\nCommit: task1',
      error: { name: 'ReviewError', message: 'Task review failed.' },
    });
    expect(host.playerCalls).toHaveLength(2);
    expect(host.childRequests).toHaveLength(2);
    await runtime.dispose();
  });

  it('treats an invalid REVIEW success result as terminal failure', async () => {
    const host = harness({
      players: [{ status: 'ok', finalText: 'Committed.\nCommit: abc123' }],
      judges: [{ guard: 'directCommit', latestCommit: 'abc123' }],
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
      lastCodeCommit: 'abc123',
      lastCodeOutput: 'Committed.\nCommit: abc123',
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
          finalText: 'Committed after the answer.\nCommit: def456',
          resumeToken: 'coder-done',
        },
      ],
      judges: [
        {
          guard: 'needsBossReply',
          question: 'Which branch should I use?',
        },
        { type: 'BOSS_REPLY' },
        { guard: 'directCommit', latestCommit: 'def456' },
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
    expect(() => createPlaybookRuntime({ extra: true } as never)).toThrow(
      'CODE runtime options.extra is not declared',
    );
    expect(() => createPlaybookRuntime({ runResults: 5 } as never)).toThrow(
      'CODE runtime options.runResults must be a string',
    );
    const mutable = { runResults: 'previous verification' };
    const runtime = createPlaybookRuntime(mutable);
    mutable.runResults = 'changed';
    expect(runtime).toBeDefined();
  });

  it('emits a complete trace pair around every nested REVIEW call', async () => {
    const host = harness({
      players: [{ status: 'ok', finalText: 'Committed.\nCommit: abc123' }],
      judges: [{ guard: 'directCommit', latestCommit: 'abc123' }],
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
