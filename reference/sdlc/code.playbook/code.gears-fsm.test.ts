// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  checkSourceGearsContract,
  parseGearsContract,
} from '../../../scripts/check-slc-source-gears.mjs';
import { codingMachine, type CodingContext } from './code.fsm.js';
import {
  enumerateNestedPlaybookStates,
  enumeratePlayerStates,
} from './code.fsm.introspect.js';

const source = readFileSync(
  fileURLToPath(new URL('../code.md', import.meta.url)),
  'utf8',
);
const gearsText = readFileSync(
  fileURLToPath(new URL('./code.gears.md', import.meta.url)),
  'utf8',
);
const gears = parseGearsContract(gearsText);
const byId = new Map(gears.map((item) => [item.id, item]));

interface RawTransition {
  guard?: string;
  target?: string;
  actions?: string;
}

interface RawReviewState {
  invoke?: {
    onDone?: readonly RawTransition[];
    onError?: readonly RawTransition[];
  };
}

const CODE_2_OUTCOMES = [
  'Workflow outcomes:',
  '- Exact approval after a direct implementation phase completes `code`.',
  '- Exact approval after a new-IR phase continues with its next unfinished IR task.',
  '- An authored `review` abort, error, or invalid approval terminates `code` with the failure and last `code`-owned commit.',
  '- Any other nested-call error parks `code` as failed and retains the control-plane error.',
].join('\n');

const CODE_4_OUTCOMES = [
  'Workflow outcomes:',
  '- Exact approval after a nonfinal IR-task phase continues with its next unfinished IR task.',
  '- Exact approval after the final IR-task phase completes `code`.',
  '- An authored `review` abort, error, or invalid approval terminates `code` with the failure and last `code`-owned commit.',
  '- Any other nested-call error parks `code` as failed and retains the control-plane error.',
].join('\n');

function gearsSection(id: 'CODE-2' | 'CODE-4'): string {
  const start = gearsText.indexOf(`### ${id}`);
  const end =
    id === 'CODE-2' ? gearsText.indexOf('### CODE-3', start) : gearsText.length;
  return gearsText.slice(start, end);
}

function route(transition: RawTransition | undefined) {
  return {
    guard: transition?.guard,
    target: transition?.target,
    actions: transition?.actions,
  };
}

const CONTEXT: CodingContext = {
  coderPlayer: 'GPT-5.6 Sol',
  runResults: '',
  callerInput: 'Implement the request.',
  coderOutput: 'Committed.\nCommit: abc123',
  latestCommit: 'abc123',
  irNumber: '040',
  irTask: 'Implement task 1.',
};

describe('CODE Source, GEARS, and FSM agreement', () => {
  it('preserves every authored instruction and quoted relay', () => {
    expect(checkSourceGearsContract(source, gearsText)).toEqual([]);
  });

  it('maps exactly CODE-1 through CODE-4 once', () => {
    expect(gears.map(({ id }) => id)).toEqual([
      'CODE-1',
      'CODE-2',
      'CODE-3',
      'CODE-4',
    ]);
    const stateItems = [
      ...enumeratePlayerStates(codingMachine),
      ...enumerateNestedPlaybookStates(codingMachine),
    ].map(({ sourceItem }) => sourceItem);
    expect(stateItems.sort()).toEqual(gears.map(({ id }) => id).sort());
  });

  it('keeps each delegated prompt and result contract verbatim', () => {
    for (const state of enumeratePlayerStates(codingMachine)) {
      const item = byId.get(state.sourceItem);
      expect(item, state.sourceItem).toBeDefined();
      const input = state.getInput(CONTEXT);
      expect(input.player).toBe('Coder');
      expect(input.prompt).toBe(item?.prompt.join('\n'));
      expect(Object.entries(input.result).slice(0, -1)).toEqual(
        item?.results.map(({ guard, description }) => [guard, description]),
      );
      expect(input.result.needsBossReply).toContain('question:');
    }
  });

  it('compiles nested items as literal REVIEW calls, never player calls', () => {
    for (const state of enumerateNestedPlaybookStates(codingMachine)) {
      const input = state.getInput(CONTEXT);
      expect(input.playbookId).toBe('review');
      expect(input.sourceItem).toBe(state.sourceItem);
      expect(byId.get(state.sourceItem)?.delegated).toBe(false);
    }
    expect(
      enumeratePlayerStates(codingMachine).some(({ sourceItem }) =>
        sourceItem === 'CODE-2' || sourceItem === 'CODE-4',
      ),
    ).toBe(false);
  });

  it('pins every authored post-REVIEW outcome to its compiled route', () => {
    for (const clause of [
      'When `review` passes a direct implementation phase, `code` is complete.',
      'When `review` passes a new IR or a nonfinal IR-task phase, Captain shall continue with the next unfinished IR-task phase.',
      'When `review` passes the final IR-task phase, `code` is complete.',
      'When `review` returns an authored abort or failure, or a terminal result that does not prove exact approval, `code` shall start no further phase and shall report the failure and the last `code`-owned commit to its caller.',
      'When the nested `review` call fails outside that authored result contract, `code` shall park as failed and retain the control-plane error instead of reporting an authored review outcome.',
    ]) {
      expect(source).toContain(clause);
    }
    expect(gearsSection('CODE-2')).toContain(CODE_2_OUTCOMES);
    expect(gearsSection('CODE-4')).toContain(CODE_4_OUTCOMES);

    const states = (codingMachine as unknown as {
      config: { states: Record<string, RawReviewState> };
    }).config.states;
    const first = states.reviewFirstCommit?.invoke;
    const task = states.reviewIrTask?.invoke;
    expect({
      firstApprovedDirect: route(first?.onDone?.[0]),
      firstApprovedIr: route(first?.onDone?.[1]),
      firstInvalidApproval: route(first?.onDone?.[2]),
      firstAuthoredFailure: route(first?.onError?.[0]),
      firstControlFailure: route(first?.onError?.[1]),
      taskApprovedMore: route(task?.onDone?.[0]),
      taskApprovedFinal: route(task?.onDone?.[1]),
      taskInvalidApproval: route(task?.onDone?.[2]),
      taskAuthoredFailure: route(task?.onError?.[0]),
      taskControlFailure: route(task?.onError?.[1]),
    }).toEqual({
      firstApprovedDirect: {
        guard: 'reviewApprovedDirect',
        target: 'done',
        actions: 'completeSuccessfully',
      },
      firstApprovedIr: {
        guard: 'reviewApprovedIrCreated',
        target: 'runIrTask',
        actions: undefined,
      },
      firstInvalidApproval: {
        guard: undefined,
        target: 'done',
        actions: 'completeWithInvalidReviewOutput',
      },
      firstAuthoredFailure: {
        guard: 'authoredReviewFailure',
        target: 'done',
        actions: 'completeWithReviewFailure',
      },
      firstControlFailure: {
        guard: undefined,
        target: 'failed',
        actions: 'rememberActorError',
      },
      taskApprovedMore: {
        guard: 'reviewApprovedMoreTasks',
        target: 'runIrTask',
        actions: 'advanceToNextIrTask',
      },
      taskApprovedFinal: {
        guard: 'reviewApprovedFinalTask',
        target: 'done',
        actions: 'completeSuccessfully',
      },
      taskInvalidApproval: {
        guard: undefined,
        target: 'done',
        actions: 'completeWithInvalidReviewOutput',
      },
      taskAuthoredFailure: {
        guard: 'authoredReviewFailure',
        target: 'done',
        actions: 'completeWithReviewFailure',
      },
      taskControlFailure: {
        guard: undefined,
        target: 'failed',
        actions: 'rememberActorError',
      },
    });
  });

  it('publishes stable descriptions and the correct runtime tags', () => {
    const states = (codingMachine as unknown as {
      config: {
        states: Record<
          string,
          { description?: string; tags?: readonly string[]; meta?: unknown }
        >;
      };
    }).config.states;
    for (const id of ['runFirstPhase', 'runIrTask']) {
      expect(states[id]?.tags).toContain('playbook.busy');
    }
    for (const id of ['reviewFirstCommit', 'reviewIrTask']) {
      expect(states[id]?.tags).toContain('playbook.suspended');
    }
    for (const id of ['ready', 'awaitBossReply', 'failed']) {
      expect(states[id]?.tags).toContain('playbook.parked');
    }
    const delegatedStateIds = new Set(['runFirstPhase', 'runIrTask']);
    for (const [id, state] of Object.entries(states)) {
      expect(state.description, id).toBeTruthy();
      expect(state.meta, id).toEqual({
        playbook: {
          stateId: id,
          description: state.description,
          ...(delegatedStateIds.has(id) ? { player: 'Coder' } : {}),
        },
      });
    }
  });
});
