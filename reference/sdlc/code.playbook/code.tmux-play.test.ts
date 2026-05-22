// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import type {
  BossTurn,
  CaptainContext,
  CaptainRunResult,
  CaptainSession,
  RoleRunResult,
} from '@sublang/cligent/tmux-play';
import createCodeTmuxPlayCaptain from './code.tmux-play.js';

// ─── Stub builders ──────────────────────────────────────────────

interface StubSession {
  session: CaptainSession;
  statuses: { message: string; data?: unknown }[];
  telemetry: { topic: string; payload: unknown }[];
  controller: AbortController;
}

function stubSession(): StubSession {
  const controller = new AbortController();
  const statuses: StubSession['statuses'] = [];
  const telemetry: StubSession['telemetry'] = [];
  return {
    session: {
      signal: controller.signal,
      roles: [],
      emitStatus: async (message, data) => {
        statuses.push({ message, data });
      },
      emitTelemetry: async (event) => {
        telemetry.push({ topic: event.topic, payload: event.payload });
      },
    },
    statuses,
    telemetry,
    controller,
  };
}

interface StubContext {
  context: CaptainContext;
  controller: AbortController;
  roleCalls: { roleId: string; prompt: string }[];
  captainCalls: string[];
}

function isClassifierPrompt(prompt: string): boolean {
  return prompt.startsWith('Classify the following Boss message');
}

function classifierReplyForTestPrompt(prompt: string): Record<string, unknown> {
  const message =
    prompt.match(/Boss message:\n```\n([\s\S]*?)\n```/)?.[1] ?? '';
  const trimmed = message.trim();
  const awaiting = prompt.includes('Current state: awaitBossReply');
  const slash = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (slash) {
    const [, command, rest = ''] = slash;
    const arg = rest.trim();
    if (command === 'start') {
      return { event: 'START_CODING', payload: { intent: arg } };
    }
    if (command === 'continue') {
      return { event: 'CONTINUE_IR', payload: { irNumber: arg } };
    }
    if (command === 'summarize') {
      return { event: 'SUMMARIZE_IR', payload: { irNumber: arg } };
    }
    if (command === 'interrupt') {
      const firstSpace = arg.search(/\s/);
      const targetId = firstSpace === -1 ? arg : arg.slice(0, firstSpace);
      const intent = firstSpace === -1 ? '' : arg.slice(firstSpace).trim();
      return {
        event: 'BOSS_INTERRUPT',
        payload: { targetId, ...(intent ? { intent } : {}) },
      };
    }
  }
  if (awaiting) {
    return { event: 'BOSS_REPLY', payload: { answer: message } };
  }
  return { event: 'START_CODING', payload: { intent: trimmed } };
}

function adjudicationPrompts(context: StubContext): string[] {
  return context.captainCalls.filter((prompt) => !isClassifierPrompt(prompt));
}

function stubContext(overrides: {
  roleResult?: (
    roleId: string,
    prompt: string,
    signal: AbortSignal,
  ) => Promise<RoleRunResult>;
  captainResult?: (
    prompt: string,
    signal: AbortSignal,
  ) => Promise<CaptainRunResult>;
  signal?: AbortSignal;
} = {}): StubContext {
  const controller = new AbortController();
  const signal = overrides.signal ?? controller.signal;
  const roleCalls: StubContext['roleCalls'] = [];
  const captainCalls: StubContext['captainCalls'] = [];
  const defaultCaptainReplies = [
    { guard: 'singleCommitReady' },
    { guard: 'needsBossInput' },
  ];
  let defaultCaptainIndex = 0;
  return {
    context: {
      signal,
      roles: [],
      callRole: async (roleId, prompt) => {
        roleCalls.push({ roleId, prompt });
        if (overrides.roleResult) {
          return overrides.roleResult(roleId, prompt, signal);
        }
        return {
          status: 'ok',
          roleId,
          turnId: 1,
          finalText: 'no progress — needs Boss input',
        };
      },
      callCaptain: async (prompt) => {
        captainCalls.push(prompt);
        if (isClassifierPrompt(prompt)) {
          return {
            status: 'ok',
            turnId: 1,
            finalText: JSON.stringify(classifierReplyForTestPrompt(prompt)),
          };
        }
        if (overrides.captainResult) {
          return overrides.captainResult(prompt, signal);
        }
        const reply = defaultCaptainReplies[defaultCaptainIndex++];
        if (!reply) {
          return {
            status: 'error',
            turnId: 1,
            error: `unexpected extra captain call #${defaultCaptainIndex}`,
          };
        }
        return {
          status: 'ok',
          turnId: 1,
          finalText: JSON.stringify(reply),
        };
      },
    },
    controller,
    roleCalls,
    captainCalls,
  };
}

const turn = (prompt: string, id = 1): BossTurn => ({
  id,
  prompt,
  timestamp: 0,
});

// ─── Tests ──────────────────────────────────────────────────────

describe('createCodeTmuxPlayCaptain — lifecycle (IR-004 Task 11)', () => {
  it('init → handleBossTurn → dispose drives through callRole + callCaptain', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start fix the bug'), c.context);
    await captain.dispose!();

    expect(c.roleCalls).toHaveLength(2);
    expect(c.captainCalls).toHaveLength(3);
    expect(s.statuses.length).toBeGreaterThan(0);
    expect(s.telemetry.length).toBeGreaterThan(0);
  });

  it('handleBossTurn before init rejects with the runtime guard error', async () => {
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await expect(
      captain.handleBossTurn(turn('/start x'), c.context),
    ).rejects.toThrow(/init must be called first/);
  });

  it('dispose stops the underlying runtime cleanly', async () => {
    const s = stubSession();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await expect(captain.dispose!()).resolves.toBeUndefined();
  });
});

describe('createCodeTmuxPlayCaptain — port wiring (DR-004 §11)', () => {
  it('callPlayer forwards (playerId, prompt) to context.callRole', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start add a button'), c.context);

    expect(c.roleCalls[0].roleId).toBe('coder');
    expect(c.roleCalls[0].prompt).toContain('add a button');
  });

  it('callJudge forwards the adjudication prompt to context.callCaptain', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start something'), c.context);

    const adjudication = adjudicationPrompts(c);
    expect(adjudication[0]).toContain('needsBossReply'); // result key in prompt
    expect(adjudication[0]).toContain('Pick exactly one outcome');
  });

  it('callJudge throws when callCaptain status !== "ok"', async () => {
    const s = stubSession();
    const c = stubContext({
      captainResult: async () => ({
        status: 'error',
        turnId: 1,
        error: 'captain crashed',
      }),
    });
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    // The captain bridge re-wraps the thrown error and routes through
    // onError → #failed; the turn completes (no throw), but FSM lands
    // at failed. We surface the cause via emitStatus.
    await captain.handleBossTurn(turn('/start x'), c.context);

    const failedStatus = s.statuses.find(
      (st) => st.message === '◆ failed',
    );
    expect(failedStatus).toBeDefined();
  });

  it('emitStatus forwards verbatim to session.emitStatus', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    // init emits '◆ ready' on initial entry — verify that
    // session.emitStatus was the recipient.
    expect(s.statuses.map((x) => x.message)).toContain('◆ ready');
  });

  it('emitTelemetry forwards verbatim to session.emitTelemetry', async () => {
    const s = stubSession();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    expect(s.telemetry[0].topic).toBe('playbook.fsm.state');
    expect(s.telemetry[0].payload).toEqual(
      expect.objectContaining({ to: 'ready' }),
    );
  });
});

describe('createCodeTmuxPlayCaptain — RoleRunResult ↔ PlayerResult identity (TMUX-033)', () => {
  it('status="ok" with finalText round-trips and drives the FSM', async () => {
    const s = stubSession();
    const c = stubContext();
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start x'), c.context);
    // Verify the turn completed by ending at ready.
    expect(
      s.statuses.map((st) => st.message).filter((m) => m === '◆ ready')
        .length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('status="aborted" surfaces and lands FSM at #failed', async () => {
    const s = stubSession();
    const c = stubContext({
      roleResult: async () => ({
        status: 'aborted',
        roleId: 'coder',
        turnId: 1,
        error: 'host aborted',
      }),
    });
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start x'), c.context);

    const failedStatus = s.statuses.find(
      (st) => st.message === '◆ failed',
    );
    expect(failedStatus).toBeDefined();
    expect(failedStatus?.data).toEqual(
      expect.objectContaining({ lastError: expect.anything() }),
    );
  });

  it('status="error" surfaces and lands FSM at #failed', async () => {
    const s = stubSession();
    const c = stubContext({
      roleResult: async () => ({
        status: 'error',
        roleId: 'coder',
        turnId: 1,
        error: 'coder crashed',
      }),
    });
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start x'), c.context);
    expect(
      s.statuses.find((st) => st.message === '◆ failed'),
    ).toBeDefined();
  });
});

describe('createCodeTmuxPlayCaptain — multi-stage Boss turn', () => {
  it('reaches the reviewer role through a full /start single-commit flow', async () => {
    const s = stubSession();
    const guards = ['singleCommitReady', 'committedSpecs', 'noFindings'];
    let i = 0;
    const c = stubContext({
      captainResult: async () => ({
        status: 'ok',
        turnId: 1,
        finalText: JSON.stringify({ guard: guards[i++] }),
      }),
    });
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    await captain.handleBossTurn(turn('/start fix the bug'), c.context);

    const roleIds = c.roleCalls.map((r) => r.roleId);
    expect(roleIds).toContain('coder');
    expect(roleIds).toContain('reviewer');
    expect(
      s.statuses.some((st) => st.message === '◆ done'),
    ).toBe(true);
  });
});

describe('createCodeTmuxPlayCaptain — signal propagation (DR-004 §11)', () => {
  it('context.signal flows into runtime.handleBossInput via handleBossTurn', async () => {
    // Use a callRole that resolves only when the signal aborts; the
    // FSM lands at #failed via the aborted status, proving that the
    // adapter wired context.signal into the player call.
    const s = stubSession();
    const c = stubContext({
      roleResult: async (_id, _p, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          status: 'aborted',
          roleId: 'coder',
          turnId: 1,
          error: 'aborted via context.signal',
        };
      },
    });
    const captain = createCodeTmuxPlayCaptain({
      coderPlayer: 'claude',
      reviewerPlayer: 'codex',
    });
    await captain.init!(s.session);
    setTimeout(() => c.controller.abort(), 5);
    await captain.handleBossTurn(turn('/start x'), c.context);

    expect(
      s.statuses.find((st) => st.message === '◆ failed'),
    ).toBeDefined();
  });
});
