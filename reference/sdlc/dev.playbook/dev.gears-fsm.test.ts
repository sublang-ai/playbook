// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  checkSourceGearsContract,
  parseGearsContract,
  verbatimFieldsFromGears,
} from '../../../scripts/check-slc-source-gears.mjs';
import { devMachine, type DevContext } from './dev.fsm.js';
import {
  enumerateNestedPlaybookStates,
  enumeratePlayerStates,
  enumerateRootEvents,
} from './dev.fsm.introspect.js';
import devRegistry from './dev.registry.js';

const source = readFileSync(
  fileURLToPath(new URL('../dev.md', import.meta.url)),
  'utf8',
);
const gearsText = readFileSync(
  fileURLToPath(new URL('./dev.gears.md', import.meta.url)),
  'utf8',
);
const gears = parseGearsContract(gearsText);
const byId = new Map(gears.map((item) => [item.id, item]));

interface RawTransition {
  guard?: string;
  target?: string;
  actions?: string;
}

interface RawChildState {
  invoke?: {
    onDone?: readonly RawTransition[];
    onError?: readonly RawTransition[];
  };
}

const CHILD_FAILURE_OUTCOMES = [
  '- Any other nested-call error parks `dev` as failed and retains the control-plane error.',
];

function gearsSection(id: 'DEV-2' | 'DEV-3' | 'DEV-4'): string {
  const start = gearsText.indexOf(`### ${id}`);
  const nextHeading = gearsText.indexOf('### ', start + 1);
  return gearsText.slice(start, nextHeading === -1 ? undefined : nextHeading);
}

function route(transition: RawTransition | undefined) {
  return {
    guard: transition?.guard,
    target: transition?.target,
    actions: transition?.actions,
  };
}

const CONTEXT: DevContext = {
  runResults: '',
  developmentRequest: 'Plan the request.',
  discussionExchanges: [],
  planningResult: 'Proceed with code.',
  decideCommit: 'abc123',
  evaluatedRevision: 'def456',
};

describe('DEV Source, GEARS, and FSM agreement', () => {
  it('preserves every authored instruction of the protected source', () => {
    expect(checkSourceGearsContract(source, gearsText)).toEqual([]);
  });

  it('maps exactly DEV-1 through DEV-4 once', () => {
    expect(gears.map(({ id }) => id)).toEqual([
      'DEV-1',
      'DEV-2',
      'DEV-3',
      'DEV-4',
    ]);
    const stateItems = [
      ...enumeratePlayerStates(devMachine),
      ...enumerateNestedPlaybookStates(devMachine),
    ].map(({ sourceItem }) => sourceItem);
    expect(stateItems.sort()).toEqual(gears.map(({ id }) => id).sort());
  });

  it('declares exactly the one Analyst role with no alias', () => {
    const roleList = source.match(/Roles:\n\n((?:- .+\n)+)/)?.[1];
    expect(roleList).toBe('- Analyst\n');
    expect(gearsText).toContain('Roles:\n\n- Analyst\n');
    expect(devRegistry.requiredRoleIds).toEqual(['analyst']);
    expect(devRegistry.concurrentRoleSets).toEqual([]);
    expect(devRegistry.artifactSchema).toBe(3);
    expect(devRegistry.runtimeProfile).toEqual({
      kind: 'shared-factory',
      compat: { artifactSchema: 3, runtimeAbi: 1 },
    });
  });

  it('keeps the Analyst prompt and result contract verbatim', () => {
    const states = enumeratePlayerStates(devMachine);
    expect(states.map(({ stateId }) => stateId)).toEqual(['planAnalysis']);
    for (const state of states) {
      const item = byId.get(state.sourceItem);
      expect(item, state.sourceItem).toBeDefined();
      const input = state.getInput(CONTEXT);
      expect(item?.player).toBe('Analyst');
      expect(input.role).toBe('analyst');
      expect(input.prompt).toBe(item?.prompt.join('\n'));
      expect(Object.entries(input.result).slice(0, -1)).toEqual(
        item?.results.map(({ guard, description }) => [guard, description]),
      );
      expect(input.result.needsBossReply).toContain('question:');
    }
    expect([...verbatimFieldsFromGears(gearsText)]).toEqual(['planningResult']);
  });

  it('preserves the four semantic planning outcomes', () => {
    for (const clause of [
      'The planning result has four semantic outcomes: needs Boss reply, discussion complete, code, and decide then code.',
      "Each outcome requires affirmative support in Analyst's result; absence of a reason to choose another outcome is not support.",
      "No outcome depends on a fixed presentation format of Analyst's reply.",
      '`dev` shall act on the accepted outcome itself and shall not return to the session Captain for another routing decision.',
      'Discussion complete is available only after a Boss reply, when any useful analysis has already been presented through needs Boss reply.',
    ]) {
      expect(source).toContain(clause);
    }
    const item = byId.get('DEV-1');
    expect(item?.results.map(({ guard }) => guard)).toEqual([
      'discussionComplete',
      'code',
      'decideThenCode',
    ]);
  });

  it('compiles nested items as literal code and decide calls, never player calls', () => {
    const targets = new Map(
      enumerateNestedPlaybookStates(devMachine).map((state) => [
        state.sourceItem,
        state.getInput(CONTEXT).playbookId,
      ]),
    );
    expect(targets).toEqual(
      new Map([
        ['DEV-2', 'code'],
        ['DEV-3', 'decide'],
        ['DEV-4', 'code'],
      ]),
    );
    for (const id of ['DEV-2', 'DEV-3', 'DEV-4'] as const) {
      expect(byId.get(id)?.delegated).toBe(false);
      expect(byId.get(id)?.player).toBeUndefined();
    }
    expect(
      enumeratePlayerStates(devMachine).some(({ sourceItem }) =>
        sourceItem !== 'DEV-1',
      ),
    ).toBe(false);
  });

  it('pins every authored child outcome to its compiled route', () => {
    for (const clause of [
      '`dev` completes with the successful result of its final child call.',
      'If a child returns an authored abort or failure, or a terminal result that does not prove the success required for the selected path, `dev` shall start no later child and shall relay that canonical result.',
      'If a child call fails outside its authored result contract, `dev` shall park as failed and retain the control-plane error.',
      "`dev` shall consume commit identities only from each child's canonical structured result, never from player prose.",
      'Only after `decide` succeeds shall `dev` call playbook `code`',
      '`dev` shall not separately call `review` for the design scope already reviewed by `decide`.',
    ]) {
      expect(source).toContain(clause);
    }
    for (const id of ['DEV-2', 'DEV-3', 'DEV-4'] as const) {
      for (const outcome of CHILD_FAILURE_OUTCOMES) {
        expect(gearsSection(id)).toContain(outcome);
      }
    }
    expect(gearsSection('DEV-3')).toContain(
      '- `dev` does not separately call `review` for the design scope already reviewed by `decide`.',
    );

    const states = (devMachine as unknown as {
      config: { states: Record<string, RawChildState> };
    }).config.states;
    const callCode = states.callCode?.invoke;
    const callDecide = states.callDecide?.invoke;
    const callCodeAfterDecide = states.callCodeAfterDecide?.invoke;
    expect({
      codeSuccess: route(callCode?.onDone?.[0]),
      codeInsufficient: route(callCode?.onDone?.[1]),
      codeAuthoredFailure: route(callCode?.onError?.[0]),
      codeControlFailure: route(callCode?.onError?.[1]),
      decideSuccess: route(callDecide?.onDone?.[0]),
      decideInsufficient: route(callDecide?.onDone?.[1]),
      decideAuthoredFailure: route(callDecide?.onError?.[0]),
      decideControlFailure: route(callDecide?.onError?.[1]),
      finalSuccess: route(callCodeAfterDecide?.onDone?.[0]),
      finalInsufficient: route(callCodeAfterDecide?.onDone?.[1]),
      finalAuthoredFailure: route(callCodeAfterDecide?.onError?.[0]),
      finalControlFailure: route(callCodeAfterDecide?.onError?.[1]),
    }).toEqual({
      codeSuccess: {
        guard: 'isCodeSuccess',
        target: 'done',
        actions: 'completeWithChildSuccess',
      },
      codeInsufficient: {
        guard: undefined,
        target: 'reportedChildFailure',
        actions: 'completeWithInsufficientCodeResult',
      },
      codeAuthoredFailure: {
        guard: 'authoredCodeFailure',
        target: 'reportedChildFailure',
        actions: 'completeWithCodeFailure',
      },
      codeControlFailure: {
        guard: undefined,
        target: 'failed',
        actions: 'rememberActorError',
      },
      decideSuccess: {
        guard: 'isDecideSuccess',
        target: 'callCodeAfterDecide',
        actions: 'rememberDecideResult',
      },
      decideInsufficient: {
        guard: undefined,
        target: 'reportedChildFailure',
        actions: 'completeWithInsufficientDecideResult',
      },
      decideAuthoredFailure: {
        guard: 'authoredDecideFailure',
        target: 'reportedChildFailure',
        actions: 'completeWithDecideFailure',
      },
      decideControlFailure: {
        guard: undefined,
        target: 'failed',
        actions: 'rememberActorError',
      },
      finalSuccess: {
        guard: 'isCodeSuccess',
        target: 'done',
        actions: 'completeWithChildSuccess',
      },
      finalInsufficient: {
        guard: undefined,
        target: 'reportedChildFailure',
        actions: 'completeWithInsufficientCodeResult',
      },
      finalAuthoredFailure: {
        guard: 'authoredCodeFailure',
        target: 'reportedChildFailure',
        actions: 'completeWithCodeFailure',
      },
      finalControlFailure: {
        guard: undefined,
        target: 'failed',
        actions: 'rememberActorError',
      },
    });
  });

  it('publishes a distinct terminal meaning per authored outcome', () => {
    const states = (devMachine as unknown as {
      config: {
        states: Record<
          string,
          { type?: string; description?: string } & RawChildState
        >;
      };
    }).config.states;

    const finalIds = Object.entries(states)
      .filter(([, state]) => state.type === 'final')
      .map(([id]) => id)
      .sort();
    expect(finalIds).toEqual([
      'discussionComplete',
      'done',
      'reportedChildFailure',
    ]);

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
        if (arm.target === undefined || !finalIds.includes(arm.target)) {
          continue;
        }
        entering.set(arm.target, [
          ...(entering.get(arm.target) ?? []),
          String(arm.actions),
        ]);
      }
    }

    // Every arm entering a terminal state carries that state's own outcome,
    // so the description a host quotes holds however the run arrived there.
    expect(entering.get('done')).toEqual([
      'completeWithChildSuccess',
      'completeWithChildSuccess',
    ]);
    expect(
      entering
        .get('discussionComplete')
        ?.map((actions) => actions.includes('completeDiscussion')),
    ).toEqual([true]);
    expect(entering.get('reportedChildFailure')?.sort()).toEqual([
      'completeWithCodeFailure',
      'completeWithCodeFailure',
      'completeWithDecideFailure',
      'completeWithInsufficientCodeResult',
      'completeWithInsufficientCodeResult',
      'completeWithInsufficientDecideResult',
    ]);
    expect(states.discussionComplete?.description).toContain(
      'no repository work',
    );
    expect(states.done?.description).toContain('successful result');
    expect(states.reportedChildFailure?.description).toContain('relayed');
    expect(states.reportedChildFailure?.description).not.toContain(
      'successful result',
    );
  });

  it('publishes stable descriptions and the correct runtime tags', () => {
    const states = (devMachine as unknown as {
      config: {
        states: Record<
          string,
          { description?: string; tags?: readonly string[]; meta?: unknown }
        >;
      };
    }).config.states;
    expect(states.planAnalysis?.tags).toContain('playbook.busy');
    for (const id of ['callCode', 'callDecide', 'callCodeAfterDecide']) {
      expect(states[id]?.tags).toContain('playbook.suspended');
    }
    for (const id of ['ready', 'awaitBossReply', 'failed']) {
      expect(states[id]?.tags).toContain('playbook.parked');
    }
    const declaredRoles = new Map(
      enumeratePlayerStates(devMachine).map(({ stateId, sourceItem }) => [
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
        },
      });
    }
    expect(enumerateRootEvents(devMachine).startDev.target).toBe(
      'planAnalysis',
    );
  });
});
