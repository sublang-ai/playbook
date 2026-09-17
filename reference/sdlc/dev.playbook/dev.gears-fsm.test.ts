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
    onDone?: RawTransition | readonly RawTransition[];
    onError?: RawTransition | readonly RawTransition[];
  };
}

type NestedItemId = 'DEV-2' | 'DEV-3' | 'DEV-4' | 'DEV-5' | 'DEV-6';

const NESTED_ITEM_IDS: readonly NestedItemId[] = [
  'DEV-2',
  'DEV-3',
  'DEV-4',
  'DEV-5',
  'DEV-6',
];

const CHILD_FAILURE_OUTCOMES = [
  '- Any other nested-call error parks `dev` as failed and retains the control-plane error.',
];

// The DEV-2, DEV-3, and DEV-4 blockquotes as the pre-DR-050 artifact
// compiled them: DR-050 keeps the plain paths' prompts and templates
// byte-identical, so these literals are pinned rather than derived.
const PLANNING_RELAY_TEMPLATE = [
  '> Original request: <development-request>',
  '> Prior discussion: <discussion-context>',
  '> Planning result: <planning-result>',
];
const CODE_AFTER_DECIDE_TEMPLATE = [
  ...PLANNING_RELAY_TEMPLATE,
  '> DECIDE commit: <decide-commit>',
  '> Evaluated revision: <evaluated-revision>',
];

function gearsSection(id: NestedItemId): string {
  const start = gearsText.indexOf(`### ${id}`);
  const nextHeading = gearsText.indexOf('### ', start + 1);
  return gearsText.slice(start, nextHeading === -1 ? undefined : nextHeading);
}

function arms(value: unknown): readonly RawTransition[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as RawTransition[];
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
  deliveryViaPullRequest: false,
};

describe('DEV Source, GEARS, and FSM agreement', () => {
  it('preserves every authored instruction of the protected source', () => {
    expect(checkSourceGearsContract(source, gearsText)).toEqual([]);
  });

  it('maps exactly DEV-1 through DEV-6 once', () => {
    expect(gears.map(({ id }) => id)).toEqual([
      'DEV-1',
      'DEV-2',
      'DEV-3',
      'DEV-4',
      'DEV-5',
      'DEV-6',
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

  it('preserves the six semantic planning outcomes', () => {
    for (const clause of [
      'The planning result has six semantic outcomes: needs Boss reply, discussion complete, code, decide then code, code via pull request, and decide then code via pull request.',
      "Each outcome requires affirmative support in Analyst's result; absence of a reason to choose another outcome is not support.",
      "No outcome depends on a fixed presentation format of Analyst's reply.",
      '`dev` shall act on the accepted outcome itself and shall not return to the session Captain for another routing decision.',
      'Discussion complete is available only after a Boss reply, when that reply settles that no repository work should follow.',
    ]) {
      expect(source).toContain(clause);
    }
    const item = byId.get('DEV-1');
    expect(item?.results.map(({ guard }) => guard)).toEqual([
      'discussionComplete',
      'code',
      'decideThenCode',
      'codeViaPullRequest',
      'decideThenCodeViaPullRequest',
    ]);
    // DR-050: the pull-request planning choice reaches the Analyst verbatim,
    // in the DR-061 wording that bounds the reading it asks for.
    expect(item?.prompt).toContain(
      '- `code via pull request` or `decide then code via pull request`, in place of the two above, when the request names a GitHub issue (number or URL) or explicitly asks for pull-request delivery; read the issue and its comments (`gh issue view --comments` with the issue number) while choosing.',
    );
    expect(devRegistry.summaryPolicy.copyPasteGuardNames).toEqual([
      'code',
      'decideThenCode',
      'codeViaPullRequest',
      'decideThenCodeViaPullRequest',
    ]);
  });

  it('compiles nested items as literal code, decide, branch, and pr calls, never player calls', () => {
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
        ['DEV-5', 'branch'],
        ['DEV-6', 'pr'],
      ]),
    );
    for (const id of NESTED_ITEM_IDS) {
      expect(byId.get(id)?.delegated).toBe(false);
      expect(byId.get(id)?.player).toBeUndefined();
      expect(byId.get(id)?.results, id).toEqual([]);
    }
    expect(
      enumeratePlayerStates(devMachine).some(({ sourceItem }) =>
        sourceItem !== 'DEV-1',
      ),
    ).toBe(false);
  });

  it('keeps the plain paths byte-identical to the pre-DR-050 artifact', () => {
    expect(byId.get('DEV-2')?.prompt).toEqual(PLANNING_RELAY_TEMPLATE);
    expect(byId.get('DEV-3')?.prompt).toEqual(PLANNING_RELAY_TEMPLATE);
    expect(byId.get('DEV-4')?.prompt).toEqual(CODE_AFTER_DECIDE_TEMPLATE);
    // The `branch` call reuses the plain planning relay; the `pr` call is
    // the one template whose every placeholder is a typed child-owned field.
    expect(byId.get('DEV-5')?.prompt).toEqual(PLANNING_RELAY_TEMPLATE);
    expect(byId.get('DEV-6')?.prompt).toEqual([
      '> Original request: <development-request>',
      '> Issue summary: <issue-summary>',
      '> Branch: <branch>',
      '> Base revision: <base-revision>',
      '> CODE commit: <last-code-commit>',
      '> Evaluated revision: <final-evaluated-revision>',
    ]);

    const nested = new Map(
      enumerateNestedPlaybookStates(devMachine).map((state) => [
        state.stateId,
        state.getInput(CONTEXT),
      ]),
    );
    const planningRelay =
      '> Original request: Plan the request.\n> Planning result: Proceed with code.';
    expect(nested.get('callCode')).toEqual({
      stateId: 'callCode',
      sourceItem: 'DEV-2',
      playbookId: 'code',
      text: planningRelay,
    });
    expect(nested.get('callDecide')).toEqual({
      stateId: 'callDecide',
      sourceItem: 'DEV-3',
      playbookId: 'decide',
      text: planningRelay,
    });
    expect(nested.get('callCodeAfterDecide')).toEqual({
      stateId: 'callCodeAfterDecide',
      sourceItem: 'DEV-4',
      playbookId: 'code',
      text: `${planningRelay}\n> DECIDE commit: abc123\n> Evaluated revision: def456`,
    });

    // The plain edges: planning → callCode → done and planning → callDecide →
    // callCodeAfterDecide → done, each success arm still the plain one.
    const states = (devMachine as unknown as {
      config: { states: Record<string, RawChildState> };
    }).config.states;
    const planning = arms(states.planAnalysis?.invoke?.onDone);
    expect(planning.find((arm) => arm.guard === 'isCodePath')?.target).toBe(
      'callCode',
    );
    expect(
      planning.find((arm) => arm.guard === 'isDecideThenCode')?.target,
    ).toBe('callDecide');
    expect(
      arms(states.callCode?.invoke?.onDone).find(
        (arm) => arm.guard === 'isPlainCodeSuccess',
      ),
    ).toEqual({
      guard: 'isPlainCodeSuccess',
      target: 'done',
      actions: 'completeWithChildSuccess',
    });
    expect(
      arms(states.callDecide?.invoke?.onDone).find(
        (arm) => arm.guard === 'isDecideSuccess',
      ),
    ).toEqual({
      guard: 'isDecideSuccess',
      target: 'callCodeAfterDecide',
      actions: 'rememberDecideResult',
    });
    expect(
      arms(states.callCodeAfterDecide?.invoke?.onDone).find(
        (arm) => arm.guard === 'isPlainCodeSuccess',
      ),
    ).toEqual({
      guard: 'isPlainCodeSuccess',
      target: 'done',
      actions: 'completeWithChildSuccess',
    });
  });

  it('pins every authored child outcome to its compiled route', () => {
    for (const clause of [
      '`dev` completes with the successful result of its final child call.',
      'If a child returns an authored abort or failure, or a terminal result that does not prove the success required for the selected path, `dev` shall start no later child and shall relay that canonical result; a `branch` or `pr` failure ends `dev` under this same rule.',
      'If a child call fails outside its authored result contract, `dev` shall park as failed and retain the control-plane error.',
      "`dev` shall consume commit, revision, branch, and pull-request identities only from each child's canonical structured result, never from player prose.",
      'Only after `decide` succeeds shall `dev` call playbook `code`',
      '`dev` shall not separately call `review` for the design scope already reviewed by `decide`.',
      'For code via pull request and decide then code via pull request, `dev` shall first call playbook `branch`',
      'Only after `branch` succeeds shall `dev` continue with the `code` call for code via pull request, or the `decide` call and then the `code` call for decide then code via pull request, each with the same input as its plain path above.',
      'On a plain path, `code` success completes `dev`.',
      'On a pull-request path, only after `code` succeeds shall `dev` call playbook `pr`',
      'A plain request calls neither `branch` nor `pr`.',
    ]) {
      expect(source).toContain(clause);
    }
    for (const id of NESTED_ITEM_IDS) {
      for (const outcome of CHILD_FAILURE_OUTCOMES) {
        expect(gearsSection(id), id).toContain(outcome);
      }
    }
    expect(gearsSection('DEV-3')).toContain(
      '- `dev` does not separately call `review` for the design scope already reviewed by `decide`.',
    );
    for (const id of ['DEV-2', 'DEV-4'] as const) {
      expect(gearsSection(id)).toContain(
        '- On a plain path, `code` success completes `dev` with the successful `code` result.',
      );
      expect(gearsSection(id)).toContain(
        "- On a pull-request path, `code` success provides the exact last `code`-owned commit and the exact final evaluated repository revision from `code`'s canonical structured result and continues with the `pr` call.",
      );
    }
    expect(gearsSection('DEV-5')).toContain(
      '- A plain request calls neither `branch` nor `pr`.',
    );
    expect(gearsSection('DEV-6')).toContain(
      '- `pr` success completes `dev` with the successful `pr` result.',
    );

    const states = (devMachine as unknown as {
      config: { states: Record<string, RawChildState> };
    }).config.states;
    const createBranch = states.createBranch?.invoke;
    const callCode = states.callCode?.invoke;
    const callDecide = states.callDecide?.invoke;
    const callCodeAfterDecide = states.callCodeAfterDecide?.invoke;
    const openPullRequest = states.openPullRequest?.invoke;
    expect({
      branchForCode: route(arms(createBranch?.onDone)[0]),
      branchForDecide: route(arms(createBranch?.onDone)[1]),
      branchInsufficient: route(arms(createBranch?.onDone)[2]),
      branchAuthoredFailure: route(arms(createBranch?.onError)[0]),
      branchControlFailure: route(arms(createBranch?.onError)[1]),
      codeSuccessViaPullRequest: route(arms(callCode?.onDone)[0]),
      codeSuccess: route(arms(callCode?.onDone)[1]),
      codeInsufficient: route(arms(callCode?.onDone)[2]),
      codeAuthoredFailure: route(arms(callCode?.onError)[0]),
      codeControlFailure: route(arms(callCode?.onError)[1]),
      decideSuccess: route(arms(callDecide?.onDone)[0]),
      decideInsufficient: route(arms(callDecide?.onDone)[1]),
      decideAuthoredFailure: route(arms(callDecide?.onError)[0]),
      decideControlFailure: route(arms(callDecide?.onError)[1]),
      finalSuccessViaPullRequest: route(arms(callCodeAfterDecide?.onDone)[0]),
      finalSuccess: route(arms(callCodeAfterDecide?.onDone)[1]),
      finalInsufficient: route(arms(callCodeAfterDecide?.onDone)[2]),
      finalAuthoredFailure: route(arms(callCodeAfterDecide?.onError)[0]),
      finalControlFailure: route(arms(callCodeAfterDecide?.onError)[1]),
      prSuccess: route(arms(openPullRequest?.onDone)[0]),
      prAuthoredFailure: route(arms(openPullRequest?.onError)[0]),
      prControlFailure: route(arms(openPullRequest?.onError)[1]),
    }).toEqual({
      branchForCode: {
        guard: 'isBranchSuccessForCode',
        target: 'callCode',
        actions: 'rememberBranchResult',
      },
      branchForDecide: {
        guard: 'isBranchSuccessForDecide',
        target: 'callDecide',
        actions: 'rememberBranchResult',
      },
      branchInsufficient: {
        guard: undefined,
        target: 'reportedChildFailure',
        actions: 'completeWithInsufficientBranchResult',
      },
      branchAuthoredFailure: {
        guard: 'authoredBranchFailure',
        target: 'reportedChildFailure',
        actions: 'completeWithBranchFailure',
      },
      branchControlFailure: {
        guard: undefined,
        target: 'failed',
        actions: 'rememberActorError',
      },
      codeSuccessViaPullRequest: {
        guard: 'isCodeSuccessViaPullRequest',
        target: 'openPullRequest',
        actions: 'rememberCodeResult',
      },
      codeSuccess: {
        guard: 'isPlainCodeSuccess',
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
      finalSuccessViaPullRequest: {
        guard: 'isCodeSuccessViaPullRequest',
        target: 'openPullRequest',
        actions: 'rememberCodeResult',
      },
      finalSuccess: {
        guard: 'isPlainCodeSuccess',
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
      prSuccess: {
        guard: undefined,
        target: 'done',
        actions: 'completeWithChildSuccess',
      },
      prAuthoredFailure: {
        guard: 'authoredPrFailure',
        target: 'reportedChildFailure',
        actions: 'completeWithPrFailure',
      },
      prControlFailure: {
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
    // DR-050 adds no terminal: `branch` and `pr` failures relay through the
    // existing failure terminal and `pr` success completes the existing one.
    expect(finalIds).toEqual([
      'discussionComplete',
      'done',
      'reportedChildFailure',
    ]);

    const entering = new Map<string, string[]>();
    for (const state of Object.values(states)) {
      for (const arm of [
        ...arms(state.invoke?.onDone),
        ...arms(state.invoke?.onError),
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
      'completeWithChildSuccess',
    ]);
    expect(
      entering
        .get('discussionComplete')
        ?.map((actions) => actions.includes('completeDiscussion')),
    ).toEqual([true]);
    expect(entering.get('reportedChildFailure')?.sort()).toEqual([
      'completeWithBranchFailure',
      'completeWithCodeFailure',
      'completeWithCodeFailure',
      'completeWithDecideFailure',
      'completeWithInsufficientBranchResult',
      'completeWithInsufficientCodeResult',
      'completeWithInsufficientCodeResult',
      'completeWithInsufficientDecideResult',
      'completeWithPrFailure',
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
    // or failure. DEV's two completions are successes and its relayed child
    // failure is a failure, so DEV's own caller routes it mechanically.
    const terminalKinds: Readonly<Record<string, 'success' | 'failure'>> = {
      discussionComplete: 'success',
      done: 'success',
      reportedChildFailure: 'failure',
    };
    expect(
      Object.entries(states)
        .filter(([, state]) => state.type === 'final')
        .map(([id]) => id)
        .sort(),
    ).toEqual(Object.keys(terminalKinds).sort());
    expect(states.planAnalysis?.tags).toContain('playbook.busy');
    for (const id of [
      'createBranch',
      'callCode',
      'callDecide',
      'callCodeAfterDecide',
      'openPullRequest',
    ]) {
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
          ...(terminalKinds[id] === undefined
            ? {}
            : { terminal: terminalKinds[id] }),
        },
      });
    }
    expect(enumerateRootEvents(devMachine).startDev.target).toBe(
      'planAnalysis',
    );
  });
});
