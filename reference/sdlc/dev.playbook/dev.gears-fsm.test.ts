// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  checkSourceGearsContract,
  gearsActionItems,
  gearsItemBodies,
  gearsItemFor,
  verbatimFieldsFromGears,
} from '../../../scripts/check-slc-source-gears.mjs';
import {
  concurrentRoleSets,
  devMachine,
  type DevContext,
} from './dev.fsm.js';
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
// DR-108: the action items are the ones a machine state cites; the
// requirement and test items carry no prompt.
const gears = gearsActionItems(gearsText);
const byId = new Map(gears.map((item) => [item.id, item]));
const itemBodies = gearsItemBodies(gearsText);

interface RawTransition {
  guard?: string;
  target?: string;
  actions?: unknown;
}

interface RawChildState {
  invoke?: {
    onDone?: RawTransition | readonly RawTransition[];
    onError?: RawTransition | readonly RawTransition[];
  };
}

type NestedItemId = 'dev-2' | 'dev-3' | 'dev-4' | 'dev-5' | 'dev-6';

const NESTED_ITEM_IDS: readonly NestedItemId[] = [
  'dev-2',
  'dev-3',
  'dev-4',
  'dev-5',
  'dev-6',
];

// The child each nested item calls, which the rules below govern.
const NESTED_CHILD: Readonly<Record<NestedItemId, string>> = {
  'dev-2': 'code',
  'dev-3': 'decide',
  'dev-4': 'code',
  'dev-5': 'branch',
  'dev-6': 'pr',
};

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

// One GEARS item's own text, up to the next item or section heading.
function gearsSection(id: string): string {
  const item = itemBodies.find((candidate) => candidate.id === id);
  expect(item, id).toBeDefined();
  return item?.body ?? '';
}

// The inline citation of one item within the package (DR-108 §2).
const citation = (id: string): string => `[[${id}](#${id})]`;

function arms(value: unknown): readonly RawTransition[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as RawTransition[];
}

// An action list rendered as its names, each parameterized action with the
// playbook id its params name, so an arm's outcome reads at a glance.
function actionLabels(actions: unknown): string {
  const list = actions === undefined ? [] : Array.isArray(actions) ? actions : [actions];
  return list
    .map((action) => {
      if (typeof action === 'string') return action;
      const { type, params } = action as {
        type: string;
        params?: { playbookId?: string; childPlaybookId?: string };
      };
      const id = params?.playbookId ?? params?.childPlaybookId;
      return id === undefined ? type : `${type}(${id})`;
    })
    .join(',');
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
  discussionContext: '',
  planningResult: 'Proceed with code.',
  decideCommit: 'abc123',
  evaluatedRevision: 'def456',
};

describe('DEV Source, GEARS, and FSM agreement', () => {
  it('preserves every authored instruction of the protected source', () => {
    expect(checkSourceGearsContract(source, gearsText)).toEqual([]);
  });

  it('maps exactly DEV-1 through DEV-6 once', () => {
    expect(gears.map(({ id }) => id)).toEqual([
      'dev-1',
      'dev-2',
      'dev-3',
      'dev-4',
      'dev-5',
      'dev-6',
    ]);
    // Every other item is a requirement or test item: no prompt, no result
    // contract.
    for (const { id, body } of itemBodies) {
      if (byId.has(id)) continue;
      expect(body, id).not.toMatch(/^>/m);
      expect(body, id).not.toMatch(/^Results:/m);
    }
    const stateItems = [
      ...enumeratePlayerStates(devMachine),
      ...enumerateNestedPlaybookStates(devMachine),
    ].map(({ sourceItem }) => sourceItem);
    // A state cites its item ignoring ASCII letter case (DR-108 §4).
    expect(
      stateItems.map((sourceItem) => gearsItemFor(gears, sourceItem)?.id).sort(),
    ).toEqual(gears.map(({ id }) => id).sort());
  });

  it('declares exactly the one Analyst role with no alias', () => {
    const roleList = source.match(/Roles:\n\n((?:- .+\n)+)/)?.[1];
    expect(roleList).toBe('- Analyst\n');
    expect(gearsText).toContain('Roles:\n\n- Analyst\n');
    expect(devRegistry.requiredRoleIds).toEqual(['analyst']);
    expect(devRegistry.concurrentRoleSets).toEqual([]);
    // playbook-1: the FSM export and the manifest declare the same sets.
    expect(concurrentRoleSets).toEqual(devRegistry.concurrentRoleSets);
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
      const item = gearsItemFor(gears, state.sourceItem);
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
    // DR-108: each planning rule is a requirement item of its own; the
    // discussion-complete outcome stays attached to its own result.
    for (const [id, clause] of [
      [
        'dev-19',
        "`dev` shall recognize six semantic outcomes of Analyst's planning result [[dev-1](#dev-1)]:\n\n- needs Boss reply;\n- discussion complete;\n- code;\n- decide then code;\n- code via pull request;\n- decide then code via pull request.",
      ],
      [
        'dev-20',
        "`dev` shall accept an outcome [[dev-19](#dev-19)] only on affirmative support in Analyst's result, never on the absence of a reason to choose another outcome.",
      ],
      [
        'dev-21',
        "`dev` shall make no outcome [[dev-19](#dev-19)] depend on a fixed presentation format of Analyst's reply.",
      ],
      [
        'dev-23',
        '`dev` shall act on the accepted outcome [[dev-20](#dev-20)] itself and shall not return to the session Captain for another routing decision.',
      ],
      [
        'dev-12',
        "When Analyst's planning result needs a Boss reply [[dev-1](#dev-1)], `dev` shall use the standard Boss-question suspension with Analyst's complete response.",
      ],
      [
        'dev-1',
        '- `discussionComplete`: After a Boss reply that settles that no repository work should follow, Analyst concluded the discussion; dev completes without a child call or repository change.',
      ],
    ] as const) {
      expect(gearsSection(id), id).toContain(clause);
    }
    const item = byId.get('dev-1');
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
      expect(byId.get(id), id).toBeDefined();
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
    expect(byId.get('dev-2')?.prompt).toEqual(PLANNING_RELAY_TEMPLATE);
    expect(byId.get('dev-3')?.prompt).toEqual(PLANNING_RELAY_TEMPLATE);
    expect(byId.get('dev-4')?.prompt).toEqual(CODE_AFTER_DECIDE_TEMPLATE);
    // The `branch` call reuses the plain planning relay; the `pr` call is
    // the one template whose every placeholder is a typed child-owned field.
    expect(byId.get('dev-5')?.prompt).toEqual(PLANNING_RELAY_TEMPLATE);
    expect(byId.get('dev-6')?.prompt).toEqual([
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
    expect(planning.find((arm) => arm.guard === 'codePlanned')?.target).toBe(
      'callCode',
    );
    expect(
      planning.find((arm) => arm.guard === 'decideThenCodePlanned')?.target,
    ).toBe('callDecide');
    const plainCodeSuccess = {
      guard: 'codeSucceededOnPlainPath',
      target: 'done',
      actions: {
        type: 'completeWithChildSuccess',
        params: { childPlaybookId: 'code' },
      },
    };
    expect(
      arms(states.callCode?.invoke?.onDone).find(
        (arm) => arm.guard === 'codeSucceededOnPlainPath',
      ),
    ).toEqual(plainCodeSuccess);
    expect(
      arms(states.callDecide?.invoke?.onDone).find(
        (arm) => arm.guard === 'decideSucceeded',
      ),
    ).toEqual({
      guard: 'decideSucceeded',
      target: 'callCodeAfterDecide',
      actions: 'rememberDecideResult',
    });
    expect(
      arms(states.callCodeAfterDecide?.invoke?.onDone).find(
        (arm) => arm.guard === 'codeSucceededOnPlainPath',
      ),
    ).toEqual(plainCodeSuccess);
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
    // DR-108: the source's relay, park and identity rules are requirement
    // items stated once, each citing every nested item it governs.
    expect(gearsSection('dev-9')).toContain(
      'returns an authored abort or failure, or a terminal result that does not prove the success required for the selected path [[dev-35](#dev-35)], `dev` shall start no later child and shall end by relaying that canonical result, a `branch` or `pr` failure included.',
    );
    expect(gearsSection('dev-10')).toContain(
      'fails outside its authored result contract, `dev` shall park as failed and retain the control-plane error.',
    );
    expect(gearsSection('dev-26')).toContain(
      "`dev` shall consume commit, revision, branch, and pull-request identities only from each child's canonical structured result, never from player prose:",
    );
    for (const id of NESTED_ITEM_IDS) {
      expect(gearsSection(id), id).toContain(
        `Captain shall call playbook \`${NESTED_CHILD[id]}\`:`,
      );
      for (const rule of ['dev-9', 'dev-10', 'dev-26']) {
        expect(gearsSection(rule), `${rule} cites ${id}`).toContain(citation(id));
      }
    }
    expect(gearsSection('dev-25')).toContain(
      '`dev` shall not separately call `review` for the design scope [[dev-4](#dev-4)] already reviewed by `decide` [[dev-3](#dev-3)].',
    );
    // Only after `decide` succeeds does `dev` call `code`, with the
    // `decide`-owned commit and evaluated revision from `decide`'s result.
    expect(gearsSection('dev-4')).toContain(
      'When `decide` succeeds [[dev-3](#dev-3)] [[dev-35](#dev-35)], Captain shall call playbook `code`:',
    );
    expect(gearsSection('dev-26')).toContain(
      '- the `decide`-owned commit and exact evaluated repository revision passed to `code` [[dev-4](#dev-4)], from the result of `decide` [[dev-3](#dev-3)];',
    );
    // On the plain paths `code` success completes `dev`, which calls neither
    // `branch` nor `pr`; on the pull-request paths `pr` success does.
    expect(gearsSection('dev-8')).toContain(
      "When the final child call of the selected path succeeds [[dev-35](#dev-35)], `dev` shall complete with that call's successful result:\n\n- `code` on the code path [[dev-2](#dev-2)] and on the decide then code path [[dev-4](#dev-4)];\n- `pr` on the code via pull request path and on the decide then code via pull request path [[dev-6](#dev-6)].",
    );
    expect(gearsSection('dev-24')).toContain(
      'While the selected path is code or decide then code, `dev` shall call neither `branch` [[dev-5](#dev-5)] nor `pr` [[dev-6](#dev-6)].',
    );
    // On a pull-request path, only after `code` succeeds does `dev` call `pr`.
    expect(gearsSection('dev-6')).toContain(
      'While the selected path is code via pull request or decide then code via pull request, when `code` succeeds [[dev-2](#dev-2)] [[dev-4](#dev-4)] [[dev-35](#dev-35)], Captain shall call playbook `pr`:',
    );
    // Only after `branch` succeeds does `dev` continue with `code`, or with
    // `decide` and then `code`, through the plain path's own call.
    expect(gearsSection('dev-2')).toContain(
      'When Analyst chooses the code path [[dev-1](#dev-1)] or `branch` succeeds on the code via pull request path [[dev-5](#dev-5)] [[dev-35](#dev-35)], Captain shall call playbook `code`:',
    );
    expect(gearsSection('dev-3')).toContain(
      'When Analyst chooses the decide then code path [[dev-1](#dev-1)] or `branch` succeeds on the decide then code via pull request path [[dev-5](#dev-5)] [[dev-35](#dev-35)], Captain shall call playbook `decide`:',
    );
    // The `pr` call's identities come from the `branch` and `code` results.
    expect(gearsSection('dev-26')).toContain(
      '- the issue summary, branch and base revision passed to `pr` [[dev-6](#dev-6)], from the result of `branch` [[dev-5](#dev-5)];\n- the last `code`-owned commit and exact final evaluated repository revision passed to `pr` [[dev-6](#dev-6)], from the result of `code` [[dev-2](#dev-2)] [[dev-4](#dev-4)].',
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
        guard: 'branchSucceededForCode',
        target: 'callCode',
        actions: 'rememberBranchResult',
      },
      branchForDecide: {
        guard: 'branchSucceededForDecide',
        target: 'callDecide',
        actions: 'rememberBranchResult',
      },
      branchInsufficient: {
        guard: undefined,
        target: 'reportedChildFailure',
        actions: {
          type: 'completeWithInsufficientResult',
          params: { playbookId: 'branch' },
        },
      },
      branchAuthoredFailure: {
        guard: 'authoredBranchResult',
        target: 'reportedChildFailure',
        actions: {
          type: 'completeWithAuthoredChildResult',
          params: { playbookId: 'branch' },
        },
      },
      branchControlFailure: {
        guard: undefined,
        target: 'failed',
        actions: 'rememberActorError',
      },
      codeSuccessViaPullRequest: {
        guard: 'codeSucceededOnPullRequestPath',
        target: 'openPullRequest',
        actions: 'rememberCodeResult',
      },
      codeSuccess: {
        guard: 'codeSucceededOnPlainPath',
        target: 'done',
        actions: {
          type: 'completeWithChildSuccess',
          params: { childPlaybookId: 'code' },
        },
      },
      codeInsufficient: {
        guard: undefined,
        target: 'reportedChildFailure',
        actions: {
          type: 'completeWithInsufficientResult',
          params: { playbookId: 'code' },
        },
      },
      codeAuthoredFailure: {
        guard: 'authoredCodeResult',
        target: 'reportedChildFailure',
        actions: {
          type: 'completeWithAuthoredChildResult',
          params: { playbookId: 'code' },
        },
      },
      codeControlFailure: {
        guard: undefined,
        target: 'failed',
        actions: 'rememberActorError',
      },
      decideSuccess: {
        guard: 'decideSucceeded',
        target: 'callCodeAfterDecide',
        actions: 'rememberDecideResult',
      },
      decideInsufficient: {
        guard: undefined,
        target: 'reportedChildFailure',
        actions: {
          type: 'completeWithInsufficientResult',
          params: { playbookId: 'decide' },
        },
      },
      decideAuthoredFailure: {
        guard: 'authoredDecideResult',
        target: 'reportedChildFailure',
        actions: {
          type: 'completeWithAuthoredChildResult',
          params: { playbookId: 'decide' },
        },
      },
      decideControlFailure: {
        guard: undefined,
        target: 'failed',
        actions: 'rememberActorError',
      },
      finalSuccessViaPullRequest: {
        guard: 'codeSucceededOnPullRequestPath',
        target: 'openPullRequest',
        actions: 'rememberCodeResult',
      },
      finalSuccess: {
        guard: 'codeSucceededOnPlainPath',
        target: 'done',
        actions: {
          type: 'completeWithChildSuccess',
          params: { childPlaybookId: 'code' },
        },
      },
      finalInsufficient: {
        guard: undefined,
        target: 'reportedChildFailure',
        actions: {
          type: 'completeWithInsufficientResult',
          params: { playbookId: 'code' },
        },
      },
      finalAuthoredFailure: {
        guard: 'authoredCodeResult',
        target: 'reportedChildFailure',
        actions: {
          type: 'completeWithAuthoredChildResult',
          params: { playbookId: 'code' },
        },
      },
      finalControlFailure: {
        guard: undefined,
        target: 'failed',
        actions: 'rememberActorError',
      },
      prSuccess: {
        guard: undefined,
        target: 'done',
        actions: {
          type: 'completeWithChildSuccess',
          params: { childPlaybookId: 'pr' },
        },
      },
      prAuthoredFailure: {
        guard: 'authoredPrResult',
        target: 'reportedChildFailure',
        actions: {
          type: 'completeWithAuthoredChildResult',
          params: { playbookId: 'pr' },
        },
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
          actionLabels(arm.actions),
        ]);
      }
    }

    // Every arm entering a terminal state carries that state's own outcome,
    // so the description a host quotes holds however the run arrived there.
    expect(entering.get('done')).toEqual([
      'completeWithChildSuccess(code)',
      'completeWithChildSuccess(code)',
      'completeWithChildSuccess(pr)',
    ]);
    expect(
      entering
        .get('discussionComplete')
        ?.map((actions) => actions.includes('completeDiscussion')),
    ).toEqual([true]);
    expect(entering.get('reportedChildFailure')?.sort()).toEqual([
      'completeWithAuthoredChildResult(branch)',
      'completeWithAuthoredChildResult(code)',
      'completeWithAuthoredChildResult(code)',
      'completeWithAuthoredChildResult(decide)',
      'completeWithAuthoredChildResult(pr)',
      'completeWithInsufficientResult(branch)',
      'completeWithInsufficientResult(code)',
      'completeWithInsufficientResult(code)',
      'completeWithInsufficientResult(decide)',
    ]);
    expect(states.discussionComplete?.description).toContain(
      'no child call or repository change',
    );
    expect(states.done?.description).toContain('successful result');
    expect(states.reportedChildFailure?.description).toContain('relaying');
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
        gearsItemFor(gears, sourceItem)?.player?.toLowerCase(),
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
