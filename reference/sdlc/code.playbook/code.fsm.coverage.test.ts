// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createActor, fromPromise, waitFor } from 'xstate';
import { describe, expect, it } from 'vitest';

import {
  codingMachine,
  type JsonValue,
  type PlaybookInput,
  type PlayerInput,
  type PlayerOutput,
} from './code.fsm.js';

const APPROVED = {
  approvedCommit: 'latest',
  noUnsettledFindings: true,
} as const;

function createWorkflow(
  playerOutputs: readonly PlayerOutput[],
  reviewOutputs: readonly (JsonValue | Error | undefined)[],
) {
  const pendingPlayers = [...playerOutputs];
  const pendingReviews = [...reviewOutputs];
  const playerInputs: PlayerInput[] = [];
  const reviewInputs: PlaybookInput[] = [];
  const machine = codingMachine.provide({
    actors: {
      player: fromPromise<PlayerOutput, PlayerInput>(async ({ input }) => {
        playerInputs.push(input);
        const output = pendingPlayers.shift();
        if (output === undefined) throw new Error('missing player fixture');
        return output;
      }),
      playbook: fromPromise<JsonValue | undefined, PlaybookInput>(
        async ({ input }) => {
          reviewInputs.push(input);
          if (pendingReviews.length === 0) {
            throw new Error('missing REVIEW fixture');
          }
          const output = pendingReviews.shift();
          if (output instanceof Error) throw output;
          return output;
        },
      ),
    },
  });
  const actor = createActor(machine, {
    input: { coderPlayer: 'GPT-5.6 Sol', runResults: '' },
  });
  actor.start();
  return { actor, playerInputs, reviewInputs };
}

describe('CODE FSM transition coverage', () => {
  it('completes one direct phase only after exact REVIEW approval', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'directCommit',
          coderOutput: 'Committed abc123.',
          latestCommit: 'abc123',
        },
      ],
      [APPROVED],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Fix the bug.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.output).toEqual({
      status: 'complete',
      lastCodeCommit: 'abc123',
      lastCodeOutput: 'Committed abc123.',
    });
    expect(workflow.reviewInputs[0]?.text).toBe(
      '> Initial intent: Fix the bug.\n> Coder output: Committed abc123.',
    );
  });

  it('loops one commit per IR task and stops after the final reviewed task', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'irCommit',
          coderOutput: 'Created IR-040.',
          latestCommit: 'ir040',
          irNumber: '040',
          irTask: 'Implement task 1.',
        },
        {
          guard: 'moreTasks',
          coderOutput: 'Committed task 1.',
          latestCommit: 'task1',
          irTask: 'Implement task 2.',
        },
        {
          guard: 'finalTask',
          coderOutput: 'Committed task 2.',
          latestCommit: 'task2',
        },
      ],
      [APPROVED, APPROVED, APPROVED],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Large change.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.output).toEqual({
      status: 'complete',
      lastCodeCommit: 'task2',
      lastCodeOutput: 'Committed task 2.',
    });
    expect(workflow.playerInputs.map(({ stateId }) => stateId)).toEqual([
      'runFirstPhase',
      'runIrTask',
      'runIrTask',
    ]);
    expect(workflow.reviewInputs.map(({ stateId }) => stateId)).toEqual([
      'reviewFirstCommit',
      'reviewIrTask',
      'reviewIrTask',
    ]);
    expect(workflow.reviewInputs[2]?.text).toContain(
      '> IR task: Implement task 2.',
    );
  });

  it('parks and resumes the same Coder leaf after a Boss reply', async () => {
    const workflow = createWorkflow(
      [
        { guard: 'needsBossReply', question: 'Which branch?' },
        {
          guard: 'directCommit',
          coderOutput: 'Committed with the answer.',
          latestCommit: 'def456',
        },
      ],
      [APPROVED],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Implement it.' });
    await waitFor(workflow.actor, (value) => value.matches('awaitBossReply'));
    workflow.actor.send({
      type: 'BOSS_REPLY',
      questionId: 'runFirstPhase',
      answer: 'Use the narrow branch.',
    });
    await waitFor(workflow.actor, (value) => value.status === 'done');
    expect(workflow.playerInputs[1]?.pendingBossQuestion?.question).toBe(
      'Which branch?',
    );
    expect(workflow.playerInputs[1]?.bossReply).toBe(
      'Use the narrow branch.',
    );
  });

  it('reports a terminal REVIEW result that does not prove approval', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'directCommit',
          coderOutput: 'Committed abc123.',
          latestCommit: 'abc123',
        },
      ],
      [{ approvedCommit: 'previous', noUnsettledFindings: true }],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Fix it.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.output).toEqual({
      status: 'review-failed',
      lastCodeCommit: 'abc123',
      lastCodeOutput: 'Committed abc123.',
      error: {
        name: 'ReviewContractError',
        message:
          'REVIEW returned an invalid approval result: ' +
          '{"approvedCommit":"previous","noUnsettledFindings":true}',
      },
    });
  });

  it('reports a terminal failure when the REVIEW call itself fails', async () => {
    const workflow = createWorkflow(
      [
        {
          guard: 'directCommit',
          coderOutput: 'Committed abc123.',
          latestCommit: 'abc123',
        },
      ],
      [new Error('REVIEW transport failed.')],
    );
    workflow.actor.send({ type: 'START_CODE', callerInput: 'Fix it.' });
    const snapshot = await waitFor(
      workflow.actor,
      (value) => value.status === 'done',
    );
    expect(snapshot.output).toEqual({
      status: 'review-failed',
      lastCodeCommit: 'abc123',
      lastCodeOutput: 'Committed abc123.',
      error: { name: 'Error', message: 'REVIEW transport failed.' },
    });
  });
});
