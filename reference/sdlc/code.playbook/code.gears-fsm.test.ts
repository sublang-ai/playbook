// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  checkSourceGearsContract,
  parseGearsContract,
} from '../../../scripts/check-slc-source-gears.mjs';
import {
  codeMachine,
  concurrentRoleSets,
  type CodeContext,
} from './code.fsm.js';
import {
  enumerateNestedPlaybookStates,
  enumeratePlayerStates,
} from './code.fsm.introspect.js';
import { codePlaybookRegistryEntry } from './code.registry.js';

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

// The one REVIEW item carries its authored workflow outcomes as its own
// sentences (playbook-1 lets an outcome attach to its corresponding item).
const CODE_3_OUTCOMES = [
  'A nested `review` passes only when its result applies to that supplied review scope, returns the exact evaluated repository revision, and affirmatively establishes that no unsettled findings remain.',
  'When `review` passes, `code` is complete and returns to its caller the exact last `code`-owned commit, the exact final evaluated repository revision, and the fact that the intent\'s review passed with no unsettled findings.',
  'When `review` returns an authored abort or failure, or a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings, `code` starts no further phase and reports the failure and the last `code`-owned commit to its caller.',
  'When the nested `review` call fails outside that authored result contract, `code` parks as failed and retains the control-plane error instead of reporting an authored review outcome.',
];

// DR-102: a nonfinal phase continues without a review; the Coder items carry
// that continuation as their own sentences.
const PHASE_CONTINUATION_OUTCOMES = {
  'CODE-1':
    'When a new-IR or a nonfinal IR-task phase completes, Captain continues with the next unfinished IR-task phase without a review.',
  'CODE-2':
    'When a nonfinal IR-task phase completes, Captain continues with the next unfinished IR-task phase without a review.',
} as const;

function gearsSection(id: 'CODE-1' | 'CODE-2' | 'CODE-3'): string {
  const start = gearsText.indexOf(`### ${id}`);
  const next = gearsText.indexOf('\n### ', start + 1);
  return gearsText.slice(start, next === -1 ? gearsText.length : next);
}

// Arms name their target either bare or by `#id`; both mean the same state.
const stateName = (target: string | undefined): string | undefined =>
  target?.startsWith('#') ? target.slice(1) : target;

function route(transition: RawTransition | undefined) {
  return {
    guard: transition?.guard,
    target: stateName(transition?.target),
    actions: transition?.actions,
  };
}

const CONTEXT: CodeContext = {
  runResults: '',
  callerInput: 'Implement the request.',
  coderOutput: 'Committed the requested change.',
  codeCommit: 'abc123',
  codeCommits: ['abc123'],
  irNumber: '040',
  irTask: 'Implement task 1.',
};

const RETIRED_COMMIT_RESPONSE_INSTRUCTION =
  'Report it as exactly one final-response line beginning `Commit: `, followed only by the exact commit identity.';

describe('CODE Source, GEARS, and FSM agreement', () => {
  it('preserves every authored instruction and quoted relay', () => {
    expect(checkSourceGearsContract(source, gearsText)).toEqual([]);
    // DR-102 retired the DR-081 prior-phase relay: no record is frozen and
    // no later task reads one.
    for (const text of [source, gearsText]) {
      expect(text).not.toContain('previous-phase-review');
      expect(text).not.toContain('On each successful nested REVIEW');
      expect(text).not.toContain('evaluatedRevision; a mismatch is not approval');
    }
    expect(source).toContain(
      'The earlier phases of this intent await the one REVIEW that follows its final task; do not ask Boss to review or approve them.',
    );
  });

  it('maps exactly CODE-1 through CODE-3 once', () => {
    expect(gears.map(({ id }) => id)).toEqual([
      'CODE-1',
      'CODE-2',
      'CODE-3',
    ]);
    const stateItems = [
      ...enumeratePlayerStates(codeMachine),
      ...enumerateNestedPlaybookStates(codeMachine),
    ].map(({ sourceItem }) => sourceItem);
    expect(stateItems.sort()).toEqual(gears.map(({ id }) => id).sort());
    // playbook-1: the FSM export and the registry manifest agree on the
    // (empty) ordered concurrent role sets.
    expect(concurrentRoleSets).toEqual([]);
    expect(concurrentRoleSets).toEqual(
      codePlaybookRegistryEntry.concurrentRoleSets,
    );
  });

  it('keeps each delegated prompt and result contract verbatim', () => {
    for (const state of enumeratePlayerStates(codeMachine)) {
      const item = byId.get(state.sourceItem);
      expect(item, state.sourceItem).toBeDefined();
      const input = state.getInput(CONTEXT);
      expect(item?.player).toBeDefined();
      expect(input.role).toBe(item?.player?.toLowerCase());
      expect(input.prompt).toBe(item?.prompt.join('\n'));
      expect(
        Object.entries(input.result).filter(([guard]) => guard !== 'needsBossReply'),
      ).toEqual(
        item?.results.map(({ guard, description }) => [guard, description]),
      );
      expect(input.result.needsBossReply).toBe(
        "The acting agent's prose surfaces a clarifying question for Boss that the agent cannot answer alone. Output shall include `question: <verbatim question text from the acting agent's prose>`.",
      );
    }
    // DR-065: the prefix pass moved each Coder item's relays after its last
    // instruction line; the layout itself records that rewrite.
    expect(byId.get('CODE-1')?.prompt[0]).toBe(
      'First determine whether the request starts a new change intent or continues an existing IR with unfinished work.',
    );
    expect(byId.get('CODE-1')?.prompt.slice(-2)).toEqual([
      '> Original request: <caller-input>',
      '> Run results: <run-results>',
    ]);
    expect(byId.get('CODE-2')?.prompt[0]).toBe(
      'Read the identified IR and implement exactly its next unfinished task, including corresponding tests or specs if any.',
    );
    expect(byId.get('CODE-2')?.prompt.slice(-3)).toEqual([
      '> Original request: <caller-input>',
      '> IR number: <ir-number>',
      '> Run results: <run-results>',
    ]);
    for (const [id, relays] of [['CODE-1', 2], ['CODE-2', 3]] as const) {
      const prompt = byId.get(id)?.prompt ?? [];
      expect(prompt.at(-relays - 1), id).toBe('');
      expect(
        prompt.slice(0, -relays).some((line) => line.startsWith('> ')),
        id,
      ).toBe(false);
    }
    expect(gearsText).not.toMatch(/^## Prefixed prompts$/m);
  });

  it('does not ask Coder to encode repository evidence in response prose', () => {
    expect(source).not.toContain(RETIRED_COMMIT_RESPONSE_INSTRUCTION);
    expect(gearsText).not.toContain(RETIRED_COMMIT_RESPONSE_INSTRUCTION);
    for (const state of enumeratePlayerStates(codeMachine)) {
      expect(state.getInput(CONTEXT).prompt).not.toContain(
        RETIRED_COMMIT_RESPONSE_INSTRUCTION,
      );
    }
  });

  it('compiles nested items as literal REVIEW calls, never player calls', () => {
    for (const state of enumerateNestedPlaybookStates(codeMachine)) {
      const input = state.getInput(CONTEXT);
      expect(input.playbookId).toBe('review');
      expect(input.sourceItem).toBe(state.sourceItem);
      expect(byId.get(state.sourceItem)?.delegated).toBe(false);
      expect(byId.get(state.sourceItem)?.player).toBeUndefined();
    }
    expect(
      enumeratePlayerStates(codeMachine).some(
        ({ sourceItem }) => sourceItem === 'CODE-3',
      ),
    ).toBe(false);
    expect(enumerateNestedPlaybookStates(codeMachine)).toHaveLength(1);
  });

  it('pins every authored post-REVIEW outcome to its compiled route', () => {
    for (const clause of [
      'When a new-IR or a nonfinal IR-task phase completes, Captain shall continue with the next unfinished IR-task phase without a review.',
      'After the direct phase or the final IR-task phase, Captain shall call the `review` playbook once over every `code`-owned commit of this run and wait until it passes with no unsettled findings.',
      'When `review` passes, `code` is complete.',
      'When `review` returns an authored abort or failure, or a terminal result that does not establish that the supplied scope was evaluated with no unsettled findings, `code` shall start no further phase and shall report the failure and the last `code`-owned commit to its caller.',
      'When the nested `review` call fails outside that authored result contract, `code` shall park as failed and retain the control-plane error instead of reporting an authored review outcome.',
      'A nested `review` passes only when its result applies to that supplied review scope, returns the exact evaluated repository revision, and affirmatively establishes that no unsettled findings remain.',
      'On successful completion, `code` returns the exact last `code`-owned commit, the exact final evaluated repository revision, and the fact that the intent\'s review passed with no unsettled findings.',
    ]) {
      expect(source).toContain(clause);
    }
    for (const outcome of CODE_3_OUTCOMES) {
      expect(gearsSection('CODE-3')).toContain(outcome);
    }
    for (const [id, outcome] of Object.entries(PHASE_CONTINUATION_OUTCOMES)) {
      expect(gearsSection(id as 'CODE-1' | 'CODE-2')).toContain(outcome);
    }

    const states = (codeMachine as unknown as {
      config: {
        states: Record<string, RawReviewState & { invoke?: { onDone?: readonly RawTransition[] } }>;
      };
    }).config.states;
    const review = states.reviewIntent?.invoke;
    expect({
      approved: route(review?.onDone?.[0]),
      invalidApproval: route(review?.onDone?.[1]),
      authoredFailure: route(review?.onError?.[0]),
      controlFailure: route(review?.onError?.[1]),
    }).toEqual({
      approved: {
        guard: 'reviewPassed',
        target: 'done',
        actions: 'rememberReviewPass',
      },
      invalidApproval: {
        guard: undefined,
        target: 'reviewFailed',
        actions: 'rememberReviewNotPassed',
      },
      authoredFailure: {
        guard: 'authoredReviewFailure',
        target: 'reviewFailed',
        actions: 'rememberAuthoredReviewFailure',
      },
      controlFailure: {
        guard: undefined,
        target: 'failed',
        actions: 'rememberActorError',
      },
    });
    // DR-102: the phase arms route by finality, never through a review.
    const armTargets = (stateId: string) =>
      (states[stateId]?.invoke?.onDone ?? []).map((arm) => [
        arm.guard,
        stateName(arm.target),
      ]);
    expect(armTargets('firstPhase')).toEqual([
      ['needsBossReplyWithQuestion', 'awaitBossReply'],
      ['acceptDirectCommit', 'reviewIntent'],
      ['acceptIrCommit', 'irTaskPhase'],
      ['acceptMoreTasks', 'irTaskPhase'],
      ['acceptFinalTask', 'reviewIntent'],
      [undefined, 'failed'],
    ]);
    expect(armTargets('irTaskPhase')).toEqual([
      ['needsBossReplyWithQuestion', 'awaitBossReply'],
      ['acceptMoreTasks', 'irTaskPhase'],
      ['acceptFinalTask', 'reviewIntent'],
      [undefined, 'failed'],
    ]);
    // The self-loop restarts the Coder actor for the next task.
    expect(
      (states.irTaskPhase?.invoke?.onDone?.[1] as { reenter?: boolean } | undefined)?.reenter,
    ).toBe(true);
  });

  it('publishes a distinct terminal meaning per authored outcome', () => {
    const states = (codeMachine as unknown as {
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
    expect(finalIds).toEqual(['done', 'reviewFailed']);

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
        const target = stateName(arm.target);
        if (target === undefined || !finalIds.includes(target)) continue;
        entering.set(target, [
          ...(entering.get(target) ?? []),
          String(arm.actions),
        ]);
      }
    }

    // Every arm entering a terminal state carries that state's own outcome, so
    // the description a host quotes holds however the run arrived there.
    expect(entering.get('done')).toEqual(['rememberReviewPass']);
    expect(entering.get('reviewFailed')?.sort()).toEqual([
      'rememberAuthoredReviewFailure',
      'rememberReviewNotPassed',
    ]);
    expect(states.done?.description).toContain('no unsettled findings');
    expect(states.reviewFailed?.description).toContain(
      "review did not pass the intent's commits",
    );
    expect(states.reviewFailed?.description).not.toContain(
      'no unsettled findings',
    );
  });

  it('publishes stable descriptions and the correct runtime tags', () => {
    const states = (codeMachine as unknown as {
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
      reviewFailed: 'failure',
    };
    expect(
      Object.entries(states)
        .filter(([, state]) => state.type === 'final')
        .map(([id]) => id)
        .sort(),
    ).toEqual(Object.keys(terminalKinds).sort());
    for (const id of ['firstPhase', 'irTaskPhase']) {
      expect(states[id]?.tags).toContain('playbook.busy');
    }
    expect(states.reviewIntent?.tags).toContain('playbook.suspended');
    for (const id of ['ready', 'awaitBossReply', 'failed']) {
      expect(states[id]?.tags).toContain('playbook.parked');
    }
    const declaredRoles = new Map(
      enumeratePlayerStates(codeMachine).map(({ stateId, sourceItem }) => [
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
