// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';

import { createActor, fromPromise } from 'xstate';
import { describe, expect, it, vi } from 'vitest';

import discussMachine from './discuss.fsm.js';
import type { PlayerInput, PlayerOutput, DiscussEvent } from './discuss.fsm.js';

const gearsText = readFileSync(
  new URL('./discuss.gears.md', import.meta.url),
  'utf8',
);

function gearsPrompt(sourceItem: string): string {
  const section = gearsText.split(`### ${sourceItem}\n`)[1]?.split('\n### ')[0];
  if (!section) throw new Error(`missing ${sourceItem} in discuss.gears.md`);
  return section
    .split('\n')
    .filter((line) => line.startsWith('> '))
    .map((line) => line.slice(2))
    .join('\n');
}

interface ControlledCall {
  input: PlayerInput;
  signal: AbortSignal;
  resolve(output: PlayerOutput): void;
  reject(error: unknown): void;
}

interface ObservableStateConfig {
  id?: string;
  description?: string;
  invoke?: { src?: unknown };
  meta?: {
    playbook?: {
      stateId?: string;
      description?: string;
    };
  };
  states?: Record<string, ObservableStateConfig>;
}

function activePlaybookStateIds(snapshot: {
  getMeta(): Record<string, unknown>;
}): string[] {
  return Object.values(snapshot.getMeta())
    .map(
      (meta) =>
        (meta as { playbook?: { stateId?: unknown } }).playbook?.stateId,
    )
    .filter((stateId): stateId is string => typeof stateId === 'string')
    .sort();
}

function controlledMachine(): {
  calls: ControlledCall[];
  machine: ReturnType<typeof discussMachine.provide>;
} {
  const calls: ControlledCall[] = [];
  const player = fromPromise<PlayerOutput, PlayerInput>(
    ({ input, signal }) =>
      new Promise<PlayerOutput>((resolve, reject) => {
        calls.push({ input, signal, resolve, reject });
      }),
  );
  return {
    calls,
    machine: discussMachine.provide({ actors: { player } }),
  };
}

async function waitForCalls(
  calls: ControlledCall[],
  stateId: PlayerInput['stateId'],
  count = 1,
): Promise<ControlledCall[]> {
  await vi.waitFor(() => {
    expect(calls.filter((call) => call.input.stateId === stateId)).toHaveLength(
      count,
    );
  });
  return calls.filter((call) => call.input.stateId === stateId);
}

function startDiscussion(actor: { send(event: DiscussEvent): void }): void {
  actor.send({
    type: 'START_DISCUSSION',
    topic: 'Compose playbooks.',
  } satisfies DiscussEvent);
}

describe('DISCUSS parallel rounds', () => {
  it('restarts both initial-proposal branches only with a retained topic', async () => {
    const { calls, machine } = controlledMachine();
    const actor = createActor(machine, {
      input: { host: 'host', participant: 'participant' },
    });
    actor.start();
    startDiscussion(actor);
    const [oldHost] = await waitForCalls(calls, 'askHostInitial');
    const [oldParticipant] = await waitForCalls(
      calls,
      'askParticipantInitial',
    );

    actor.send({
      type: 'BOSS_INTERRUPT',
      targetId: 'initialProposalRound',
    } satisfies DiscussEvent);

    const restartedHosts = await waitForCalls(calls, 'askHostInitial', 2);
    const restartedParticipants = await waitForCalls(
      calls,
      'askParticipantInitial',
      2,
    );
    expect(oldHost.signal.aborted).toBe(true);
    expect(oldParticipant.signal.aborted).toBe(true);
    expect(restartedHosts[1]?.input.topic).toBe('Compose playbooks.');
    expect(restartedParticipants[1]?.input.topic).toBe('Compose playbooks.');
    expect(activePlaybookStateIds(actor.getSnapshot())).toEqual(
      expect.arrayContaining([
        'initialProposalRound',
        'askHostInitial',
        'askParticipantInitial',
      ]),
    );
    actor.stop();
  });

  it('restarts both reconciliation branches only with promoted proposals', async () => {
    const { calls, machine } = controlledMachine();
    const actor = createActor(machine, {
      input: { host: 'host', participant: 'participant' },
    });
    actor.start();
    startDiscussion(actor);
    const [hostInitial] = await waitForCalls(calls, 'askHostInitial');
    const [participantInitial] = await waitForCalls(
      calls,
      'askParticipantInitial',
    );
    hostInitial.resolve({ guard: 'proposalMade', proposal: 'host proposal' });
    participantInitial.resolve({
      guard: 'proposalMade',
      proposal: 'participant proposal',
    });
    const [oldHost] = await waitForCalls(calls, 'hostInitialRound');
    const [oldParticipant] = await waitForCalls(
      calls,
      'participantInitialRound',
    );

    actor.send({
      type: 'BOSS_INTERRUPT',
      targetId: 'reconciliationRound',
    } satisfies DiscussEvent);

    const restartedHosts = await waitForCalls(calls, 'hostInitialRound', 2);
    const restartedParticipants = await waitForCalls(
      calls,
      'participantInitialRound',
      2,
    );
    expect(oldHost.signal.aborted).toBe(true);
    expect(oldParticipant.signal.aborted).toBe(true);
    for (const restarted of [
      restartedHosts[1],
      restartedParticipants[1],
    ]) {
      expect(restarted?.input).toMatchObject({
        hostProposal: 'host proposal',
        participantProposal: 'participant proposal',
      });
    }
    actor.stop();
  });

  it('ignores parallel-parent interrupts without their required context', async () => {
    const { calls, machine } = controlledMachine();
    const actor = createActor(machine, {
      input: { host: 'host', participant: 'participant' },
    });
    actor.start();

    actor.send({
      type: 'BOSS_INTERRUPT',
      targetId: 'initialProposalRound',
    } satisfies DiscussEvent);
    actor.send({
      type: 'BOSS_INTERRUPT',
      targetId: 'reconciliationRound',
    } satisfies DiscussEvent);
    await Promise.resolve();

    expect(calls).toEqual([]);
    expect(actor.getSnapshot().value).toBe('ready');
    actor.stop();
  });

  it('uses the first-class player actor for every delegated leaf', () => {
    const root = discussMachine.config as ObservableStateConfig;
    const invocations: Array<{ src?: unknown }> = [];
    const visit = (state: ObservableStateConfig): void => {
      if (state.invoke !== undefined) invocations.push(state.invoke);
      Object.values(state.states ?? {}).forEach(visit);
    };
    Object.values(root.states ?? {}).forEach(visit);

    expect(invocations).toHaveLength(15);
    expect(invocations.every((invoke) => invoke.src === 'player')).toBe(true);
    expect(invocations.some((invoke) => invoke.src === 'captain')).toBe(false);
  });

  it('publishes matching JSON-safe metadata for every observable state', () => {
    const root = discussMachine.config as ObservableStateConfig;
    const states: ObservableStateConfig[] = [];
    const visit = (state: ObservableStateConfig): void => {
      states.push(state);
      Object.values(state.states ?? {}).forEach(visit);
    };
    Object.values(root.states ?? {}).forEach(visit);

    expect(states).toHaveLength(33);
    for (const state of states) {
      expect(state.id).toBeTypeOf('string');
      expect(state.description).toBeTypeOf('string');
      expect(state.meta).toEqual({
        playbook: {
          stateId: state.id,
          description: state.description,
        },
      });
      expect(JSON.parse(JSON.stringify(state.meta))).toEqual(state.meta);
    }
  });

  it.each([
    ['Host first in both rounds', 'host', 'host'] as const,
    ['Participant first in both rounds', 'participant', 'participant'] as const,
  ])(
    'stages overlapping branches and promotes deterministic inputs: %s',
    async (_label, first, reconciliationFirst) => {
      const { calls, machine } = controlledMachine();
      const actor = createActor(machine, {
        input: { host: 'host', participant: 'participant' },
      });
      actor.start();
      startDiscussion(actor);

      const [hostInitial] = await waitForCalls(calls, 'askHostInitial');
      const [participantInitial] = await waitForCalls(
        calls,
        'askParticipantInitial',
      );
      expect(hostInitial.input).toMatchObject({
        stateId: 'askHostInitial',
        player: 'Host',
        sourceItem: 'DISCUSS-1',
        topic: 'Compose playbooks.',
      });
      expect(hostInitial.input.prompt).toBe(gearsPrompt('DISCUSS-1'));
      expect(participantInitial.input).toMatchObject({
        stateId: 'askParticipantInitial',
        player: 'Participant',
        sourceItem: 'DISCUSS-2',
        topic: 'Compose playbooks.',
      });
      expect(participantInitial.input.prompt).toBe(gearsPrompt('DISCUSS-2'));
      expect(activePlaybookStateIds(actor.getSnapshot())).toEqual([
        'askHostInitial',
        'askParticipantInitial',
        'initialProposalHost',
        'initialProposalParticipant',
        'initialProposalRound',
      ]);
      expect(JSON.parse(JSON.stringify(actor.getSnapshot().getMeta()))).toEqual(
        actor.getSnapshot().getMeta(),
      );

      const firstCall = first === 'host' ? hostInitial : participantInitial;
      const secondCall = first === 'host' ? participantInitial : hostInitial;
      firstCall.resolve({
        guard: 'proposalMade',
        proposal: first === 'host' ? 'host v1' : 'participant v1',
      });
      await vi.waitFor(() => {
        expect(actor.getSnapshot().context.hostProposal).toBeUndefined();
        expect(actor.getSnapshot().context.participantProposal).toBeUndefined();
        expect(calls).toHaveLength(2);
      });
      secondCall.resolve({
        guard: 'proposalMade',
        proposal: first === 'host' ? 'participant v1' : 'host v1',
      });

      const [hostReconciliation] = await waitForCalls(
        calls,
        'hostInitialRound',
      );
      const [participantReconciliation] = await waitForCalls(
        calls,
        'participantInitialRound',
      );
      for (const call of [hostReconciliation, participantReconciliation]) {
        expect(call.input).toMatchObject({
          hostProposal: 'host v1',
          participantProposal: 'participant v1',
        });
      }
      expect(hostReconciliation.input.prompt).toBe(gearsPrompt('DISCUSS-3'));
      expect(participantReconciliation.input.prompt).toBe(
        gearsPrompt('DISCUSS-4'),
      );
      expect(activePlaybookStateIds(actor.getSnapshot())).toEqual([
        'hostInitialRound',
        'participantInitialRound',
        'reconciliationHost',
        'reconciliationParticipant',
        'reconciliationRound',
      ]);

      const firstReconciliation =
        reconciliationFirst === 'host'
          ? hostReconciliation
          : participantReconciliation;
      const secondReconciliation =
        reconciliationFirst === 'host'
          ? participantReconciliation
          : hostReconciliation;
      firstReconciliation.resolve({
        guard: 'endedInitialDiscussion',
        agreement:
          reconciliationFirst === 'host'
            ? 'host agreement'
            : 'participant agreement',
      });
      await vi.waitFor(() => {
        expect(calls).toHaveLength(4);
        expect(actor.getSnapshot().context.agreement).toBeUndefined();
        expect(secondReconciliation.signal.aborted).toBe(false);
      });
      secondReconciliation.resolve({
        guard: 'endedInitialDiscussion',
        agreement:
          reconciliationFirst === 'host'
            ? 'participant agreement'
            : 'host agreement',
      });

      const [writer] = await waitForCalls(calls, 'hostWritesAgreement');
      expect(writer.input.agreement).toBe('participant agreement');
      expect(actor.getSnapshot().context.stagedHostResult).toBeUndefined();
      expect(
        actor.getSnapshot().context.stagedParticipantResult,
      ).toBeUndefined();
      actor.stop();
    },
  );

  it('parks and resumes questions inside only their owning branches', async () => {
    const { calls, machine } = controlledMachine();
    const actor = createActor(machine, {
      input: { host: 'host', participant: 'participant' },
    });
    actor.start();
    startDiscussion(actor);

    const [hostInitial] = await waitForCalls(calls, 'askHostInitial');
    const [participantInitial] = await waitForCalls(
      calls,
      'askParticipantInitial',
    );
    hostInitial.resolve({
      guard: 'needsBossReply',
      question: 'Host question?',
    });
    participantInitial.resolve({
      guard: 'needsBossReply',
      question: 'Participant question?',
    });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toEqual({
        initialProposalRound: {
          host: 'waiting',
          participant: 'waiting',
        },
      });
      expect(actor.getSnapshot().context.pendingBossQuestions).toEqual({
        askHostInitial: {
          questionId: 'askHostInitial',
          resumeStateId: 'askHostInitial',
          sourceItem: 'DISCUSS-1',
          player: 'Host',
          question: 'Host question?',
        },
        askParticipantInitial: {
          questionId: 'askParticipantInitial',
          resumeStateId: 'askParticipantInitial',
          sourceItem: 'DISCUSS-2',
          player: 'Participant',
          question: 'Participant question?',
        },
      });
      expect(activePlaybookStateIds(actor.getSnapshot())).toEqual([
        'initialProposalHost',
        'initialProposalParticipant',
        'initialProposalRound',
        'waitHostInitialReply',
        'waitParticipantInitialReply',
      ]);
    });

    actor.send({ type: 'BOSS_REPLY', answer: 'ambiguous' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(2);

    actor.send({
      type: 'BOSS_REPLY',
      questionId: 'askHostInitial',
      answer: 'Host answer.',
    });
    const hostCalls = await waitForCalls(calls, 'askHostInitial', 2);
    expect(hostCalls[1].input).toMatchObject({
      stateId: 'askHostInitial',
      bossReply: 'Host answer.',
      pendingBossQuestion: {
        questionId: 'askHostInitial',
        question: 'Host question?',
      },
    });
    expect(
      calls.filter((call) => call.input.stateId === 'askParticipantInitial'),
    ).toHaveLength(1);
    hostCalls[1].resolve({ guard: 'proposalMade', proposal: 'host v1' });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toEqual({
        initialProposalRound: {
          host: 'complete',
          participant: 'waiting',
        },
      });
      expect(actor.getSnapshot().context.pendingBossQuestions).toEqual({
        askParticipantInitial: expect.any(Object),
      });
    });

    actor.send({ type: 'BOSS_REPLY', answer: 'Participant answer.' });
    const participantCalls = await waitForCalls(
      calls,
      'askParticipantInitial',
      2,
    );
    expect(participantCalls[1].input).toMatchObject({
      stateId: 'askParticipantInitial',
      bossReply: 'Participant answer.',
      pendingBossQuestion: {
        questionId: 'askParticipantInitial',
        question: 'Participant question?',
      },
    });
    expect(
      calls.filter((call) => call.input.stateId === 'askHostInitial'),
    ).toHaveLength(2);
    participantCalls[1].resolve({
      guard: 'proposalMade',
      proposal: 'participant v1',
    });

    await waitForCalls(calls, 'hostInitialRound');
    await waitForCalls(calls, 'participantInitialRound');
    actor.stop();
  });

  it('resolves an omitted question id when only one parallel branch waits', async () => {
    const { calls, machine } = controlledMachine();
    const actor = createActor(machine, { input: {} });
    actor.start();
    startDiscussion(actor);

    const [hostInitial] = await waitForCalls(calls, 'askHostInitial');
    const [participantInitial] = await waitForCalls(
      calls,
      'askParticipantInitial',
    );
    hostInitial.resolve({
      guard: 'needsBossReply',
      question: 'Only Host needs clarification?',
    });
    participantInitial.resolve({
      guard: 'proposalMade',
      proposal: 'participant v1',
    });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toEqual({
        initialProposalRound: {
          host: 'waiting',
          participant: 'complete',
        },
      });
      expect(actor.getSnapshot().context.pendingBossQuestions).toEqual({
        askHostInitial: expect.objectContaining({
          questionId: 'askHostInitial',
          question: 'Only Host needs clarification?',
        }),
      });
    });

    actor.send({ type: 'BOSS_REPLY', answer: 'Host-only answer.' });
    const hostCalls = await waitForCalls(calls, 'askHostInitial', 2);
    expect(hostCalls[1].input).toMatchObject({
      bossReply: 'Host-only answer.',
      pendingBossQuestion: { questionId: 'askHostInitial' },
    });
    expect(
      calls.filter((call) => call.input.stateId === 'askParticipantInitial'),
    ).toHaveLength(1);
    actor.stop();
  });

  it('abandons parallel waits when Boss starts a fresh discussion', async () => {
    const { calls, machine } = controlledMachine();
    const actor = createActor(machine, { input: {} });
    actor.start();
    startDiscussion(actor);

    const [hostInitial] = await waitForCalls(calls, 'askHostInitial');
    const [participantInitial] = await waitForCalls(
      calls,
      'askParticipantInitial',
    );
    hostInitial.resolve({
      guard: 'needsBossReply',
      question: 'Old Host question?',
    });
    participantInitial.resolve({
      guard: 'needsBossReply',
      question: 'Old Participant question?',
    });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.pendingBossQuestions).toBeDefined();
    });

    actor.send({
      type: 'START_DISCUSSION',
      topic: 'Replacement topic.',
    });
    const hostCalls = await waitForCalls(calls, 'askHostInitial', 2);
    const participantCalls = await waitForCalls(
      calls,
      'askParticipantInitial',
      2,
    );
    expect(hostCalls[1].input).toMatchObject({ topic: 'Replacement topic.' });
    expect(participantCalls[1].input).toMatchObject({
      topic: 'Replacement topic.',
    });
    expect(actor.getSnapshot().context.pendingBossQuestions).toBeUndefined();
    expect(actor.getSnapshot().context.bossReplies).toBeUndefined();
    actor.stop();
  });

  it('abandons one waiting branch when Boss starts a fresh review', async () => {
    const { calls, machine } = controlledMachine();
    const actor = createActor(machine, { input: {} });
    actor.start();
    startDiscussion(actor);

    const [hostInitial] = await waitForCalls(calls, 'askHostInitial');
    const [participantInitial] = await waitForCalls(
      calls,
      'askParticipantInitial',
    );
    hostInitial.resolve({
      guard: 'needsBossReply',
      question: 'Old question?',
    });
    participantInitial.resolve({
      guard: 'proposalMade',
      proposal: 'old participant proposal',
    });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toEqual({
        initialProposalRound: {
          host: 'waiting',
          participant: 'complete',
        },
      });
    });

    actor.send({
      type: 'START_REVIEW',
      latestChanges: 'Replacement changes.',
      reviewScope: 'mixed',
    });
    const [review] = await waitForCalls(calls, 'reviewMixedInitialCommit');
    expect(review.input).toMatchObject({
      latestChanges: 'Replacement changes.',
    });
    expect(actor.getSnapshot().context.reviewScope).toBe('mixed');
    expect(actor.getSnapshot().context.pendingBossQuestions).toBeUndefined();
    expect(actor.getSnapshot().context.stagedHostResult).toBeUndefined();
    expect(actor.getSnapshot().context.stagedParticipantResult).toBeUndefined();
    expect(actor.getSnapshot().context.hostProposal).toBeUndefined();
    expect(actor.getSnapshot().context.participantProposal).toBeUndefined();
    actor.stop();
  });

  it('exits the parallel parent and stops a sibling on branch failure', async () => {
    const { calls, machine } = controlledMachine();
    const actor = createActor(machine, { input: {} });
    actor.start();
    startDiscussion(actor);

    const [hostInitial] = await waitForCalls(calls, 'askHostInitial');
    const [participantInitial] = await waitForCalls(
      calls,
      'askParticipantInitial',
    );
    hostInitial.reject(new Error('host failed'));

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('failed');
      expect(participantInitial.signal.aborted).toBe(true);
    });
    expect(actor.getSnapshot().context.lastError).toMatchObject({
      message: 'host failed',
    });
    actor.stop();
  });
});
