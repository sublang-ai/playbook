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
  '- A nested `review` passes the phase only when its result applies to the supplied review scope, returns the exact evaluated repository revision, and affirmatively establishes that no unsettled findings remain.',
  '- A pass after a direct implementation phase completes `code` with the exact last `code`-owned commit, the exact final evaluated repository revision, and the fact that every phase\'s review passed with no unsettled findings.',
  '- A pass after a new-IR phase continues with the next unfinished IR-task phase.',
  '- An authored `review` abort or failure, or a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings, terminates `code` with the failure and the last `code`-owned commit.',
  '- Any other nested-call error parks `code` as failed and retains the control-plane error.',
].join('\n');

const CODE_4_OUTCOMES = [
  'Workflow outcomes:',
  '- A nested `review` passes the phase only when its result applies to the supplied review scope, returns the exact evaluated repository revision, and affirmatively establishes that no unsettled findings remain.',
  '- A pass after a nonfinal IR-task phase continues with the next unfinished IR-task phase.',
  '- A pass after the final IR-task phase completes `code` with the exact last `code`-owned commit, the exact final evaluated repository revision, and the fact that every phase\'s review passed with no unsettled findings.',
  '- An authored `review` abort or failure, or a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings, terminates `code` with the failure and the last `code`-owned commit.',
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
  runResults: '',
  callerInput: 'Implement the request.',
  coderOutput: 'Committed the requested change.',
  latestCommit: 'abc123',
  irNumber: '040',
  irTask: 'Implement task 1.',
};

const RETIRED_COMMIT_RESPONSE_INSTRUCTION =
  'Report it as exactly one final-response line beginning `Commit: `, followed only by the exact commit identity.';

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
      expect(item?.player).toBeDefined();
      expect(input.role).toBe(item?.player?.toLowerCase());
      expect(input.prompt).toBe(item?.prompt.join('\n'));
      expect(Object.entries(input.result).slice(0, -1)).toEqual(
        item?.results.map(({ guard, description }) => [guard, description]),
      );
      expect(input.result.needsBossReply).toContain('question:');
    }
  });

  it('does not ask Coder to encode repository evidence in response prose', () => {
    expect(source).not.toContain(RETIRED_COMMIT_RESPONSE_INSTRUCTION);
    expect(gearsText).not.toContain(RETIRED_COMMIT_RESPONSE_INSTRUCTION);
    for (const state of enumeratePlayerStates(codingMachine)) {
      expect(state.getInput(CONTEXT).prompt).not.toContain(
        RETIRED_COMMIT_RESPONSE_INSTRUCTION,
      );
    }
  });

  it('compiles nested items as literal REVIEW calls, never player calls', () => {
    for (const state of enumerateNestedPlaybookStates(codingMachine)) {
      const input = state.getInput(CONTEXT);
      expect(input.playbookId).toBe('review');
      expect(input.sourceItem).toBe(state.sourceItem);
      expect(byId.get(state.sourceItem)?.delegated).toBe(false);
      expect(byId.get(state.sourceItem)?.player).toBeUndefined();
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
      'When `review` returns an authored abort or failure, or a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings, `code` shall start no further phase and shall report the failure and the last `code`-owned commit to its caller.',
      'When the nested `review` call fails outside that authored result contract, `code` shall park as failed and retain the control-plane error instead of reporting an authored review outcome.',
      'A nested `review` passes the phase only when its result applies to that supplied review scope, returns the exact evaluated repository revision, and affirmatively establishes that no unsettled findings remain.',
      'On successful completion, `code` returns the exact last `code`-owned commit, the exact final evaluated repository revision, and the fact that every phase\'s review passed with no unsettled findings.',
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
        target: 'reportedReviewFailure',
        actions: 'completeWithInvalidReviewOutput',
      },
      firstAuthoredFailure: {
        guard: 'authoredReviewFailure',
        target: 'reportedReviewFailure',
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
        actions: undefined,
      },
      taskApprovedFinal: {
        guard: 'reviewApprovedFinalTask',
        target: 'done',
        actions: 'completeSuccessfully',
      },
      taskInvalidApproval: {
        guard: undefined,
        target: 'reportedReviewFailure',
        actions: 'completeWithInvalidReviewOutput',
      },
      taskAuthoredFailure: {
        guard: 'authoredReviewFailure',
        target: 'reportedReviewFailure',
        actions: 'completeWithReviewFailure',
      },
      taskControlFailure: {
        guard: undefined,
        target: 'failed',
        actions: 'rememberActorError',
      },
    });
  });

  it('publishes a distinct terminal meaning per authored outcome', () => {
    const states = (codingMachine as unknown as {
      config: {
        states: Record<
          string,
          { type?: string; description?: string } & RawReviewState
        >;
      };
    }).config.states;

    const finalIds = Object.entries(states)
      .filter(([, state]) => state.type === 'final')
      .map(([id]) => id)
      .sort();
    expect(finalIds).toEqual(['done', 'reportedReviewFailure']);

    const armList = (value: unknown): readonly RawTransition[] =>
      value === undefined
        ? []
        : ((Array.isArray(value) ? value : [value]) as RawTransition[]);

    const entering = new Map<string, string[]>();
    for (const state of Object.values(states)) {
      for (const arm of [
        ...armList(state.invoke?.onDone),
        ...armList(state.invoke?.onError),
      ]) {
        if (arm.target === undefined || !finalIds.includes(arm.target)) continue;
        entering.set(arm.target, [
          ...(entering.get(arm.target) ?? []),
          String(arm.actions),
        ]);
      }
    }

    // Every arm entering a terminal state carries that state's own outcome, so
    // the description a host quotes holds however the run arrived there.
    expect(entering.get('done')).toEqual([
      'completeSuccessfully',
      'completeSuccessfully',
    ]);
    expect(entering.get('reportedReviewFailure')?.sort()).toEqual([
      'completeWithInvalidReviewOutput',
      'completeWithInvalidReviewOutput',
      'completeWithReviewFailure',
      'completeWithReviewFailure',
    ]);
    expect(states.done?.description).toContain('no unsettled findings');
    expect(states.reportedReviewFailure?.description).toContain(
      'reported a REVIEW failure',
    );
    expect(states.reportedReviewFailure?.description).not.toContain(
      'no unsettled findings',
    );
  });

  it('publishes stable descriptions and the correct runtime tags', () => {
    const states = (codingMachine as unknown as {
      config: {
        states: Record<
          string,
          {
            type?: string;
            description?: string;
            tags?: readonly string[];
            meta?: unknown;
          }
        >;
      };
    }).config.states;
    // DR-048: every final state declares whether its outcome means success
    // or failure, so a caller routes CODE's report of a failed review
    // through its own error path without reading CODE's output fields.
    const terminalKinds: Readonly<Record<string, 'success' | 'failure'>> = {
      done: 'success',
      reportedReviewFailure: 'failure',
    };
    expect(
      Object.entries(states)
        .filter(([, state]) => state.type === 'final')
        .map(([id]) => id)
        .sort(),
    ).toEqual(Object.keys(terminalKinds).sort());
    for (const id of ['runFirstPhase', 'runIrTask']) {
      expect(states[id]?.tags).toContain('playbook.busy');
    }
    for (const id of ['reviewFirstCommit', 'reviewIrTask']) {
      expect(states[id]?.tags).toContain('playbook.suspended');
    }
    for (const id of ['ready', 'awaitBossReply', 'failed']) {
      expect(states[id]?.tags).toContain('playbook.parked');
    }
    const declaredRoles = new Map(
      enumeratePlayerStates(codingMachine).map(({ stateId, sourceItem }) => [
        stateId,
        byId.get(sourceItem)?.player?.toLowerCase(),
      ]),
    );
    for (const [id, state] of Object.entries(states)) {
      const delegated = declaredRoles.has(id);
      const role = declaredRoles.get(id);
      if (delegated) expect(role, id).toBeDefined();
      expect(state.description, id).toBeTruthy();
      expect(state.meta, id).toEqual({
        playbook: {
          stateId: id,
          description: state.description,
          ...(delegated ? { role } : {}),
          ...(terminalKinds[id] === undefined
            ? {}
            : { terminal: terminalKinds[id] }),
        },
      });
    }
  });
});
