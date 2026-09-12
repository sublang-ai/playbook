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
import { branchMachine, type BranchContext } from './branch.fsm.js';
import {
  enumeratePlayerStates,
  enumerateRootEvents,
} from './branch.fsm.introspect.js';
import branchRegistry from './branch.registry.js';

const source = readFileSync(
  fileURLToPath(new URL('../branch.md', import.meta.url)),
  'utf8',
);
const gearsText = readFileSync(
  fileURLToPath(new URL('./branch.gears.md', import.meta.url)),
  'utf8',
);
const gears = parseGearsContract(gearsText);
const byId = new Map(gears.map((item) => [item.id, item]));

interface RawTransition {
  guard?: string;
  target?: string;
  actions?: unknown;
}

interface RawState {
  type?: string;
  description?: string;
  tags?: readonly string[];
  meta?: unknown;
  invoke?: {
    onDone?: RawTransition | readonly RawTransition[];
    onError?: RawTransition | readonly RawTransition[];
  };
}

const states = (
  branchMachine as unknown as { config: { states: Record<string, RawState> } }
).config.states;

const CONTEXT: BranchContext = {
  callerInput: 'Fix #12: the retry loop never backs off.',
  branch: 'issue-12-fix-retry',
  baseRevision: '1111111111111111111111111111111111111111',
  issueSummary: 'Issue #12 asks for exponential backoff with jitter.',
};

const done = (output: unknown) => ({
  type: 'xstate.done.actor.player',
  output,
});

const guards = branchMachine.implementations.guards as unknown as Record<
  string,
  (args: { context: BranchContext; event: unknown }, params: unknown) => boolean
>;

describe('BRANCH Source, GEARS, and FSM agreement', () => {
  it('preserves every authored instruction of the protected source', () => {
    expect(checkSourceGearsContract(source, gearsText)).toEqual([]);
  });

  it('maps exactly BRANCH-1 once', () => {
    expect(gears.map(({ id }) => id)).toEqual(['BRANCH-1']);
    expect(
      enumeratePlayerStates(branchMachine).map(({ sourceItem }) => sourceItem),
    ).toEqual(['BRANCH-1']);
  });

  it('declares exactly the one Coder role with no alias', () => {
    const roleList = source.match(/Roles:\n\n((?:- .+\n)+)/)?.[1];
    expect(roleList).toBe('- Coder\n');
    expect(gearsText).toContain('Roles:\n\n- Coder\n');
    expect(branchRegistry.requiredRoleIds).toEqual(['coder']);
    expect(branchRegistry.concurrentRoleSets).toEqual([]);
    expect(branchRegistry.artifactSchema).toBe(3);
    expect(branchRegistry.runtimeProfile).toEqual({
      kind: 'shared-factory',
      compat: { artifactSchema: 3, runtimeAbi: 1 },
    });
  });

  it('keeps the Coder prompt and result contract verbatim', () => {
    const playerStates = enumeratePlayerStates(branchMachine);
    expect(playerStates.map(({ stateId }) => stateId)).toEqual([
      'createBranch',
    ]);
    for (const state of playerStates) {
      const item = byId.get(state.sourceItem);
      expect(item, state.sourceItem).toBeDefined();
      const input = state.getInput(CONTEXT);
      expect(item?.delegated).toBe(true);
      expect(item?.player).toBe('Coder');
      expect(input.role).toBe('coder');
      expect(input.prompt).toBe(item?.prompt.join('\n'));
      expect(Object.entries(input.result).slice(0, -1)).toEqual(
        item?.results.map(({ guard, description }) => [guard, description]),
      );
      expect(input.result.needsBossReply).toContain('question:');
    }
    expect([...verbatimFieldsFromGears(gearsText)]).toEqual(['coderOutput']);
  });

  it('preserves the authored outcomes and the base-revision authority', () => {
    for (const clause of [
      'The result has two semantic outcomes: branched and refused, plus the Boss question when the request is ambiguous about the issue or work it means.',
      "Each outcome requires affirmative support in Coder's result; the absence of a reported obstacle is not support for branched, and no outcome depends on a fixed presentation format of Coder's reply.",
      "Every outcome keeps the repository exact: a new branch at the current commit changes neither HEAD's commit nor the working tree.",
      "Captain shall take the base revision from repository authority, not from Coder's prose.",
      'For branched, `branch` is complete and returns the exact branch name, the exact base revision, and the issue summary to its caller.',
      "For refused, `branch` fails and reports Coder's complete result with its reason to its caller; no branch was created.",
    ]) {
      expect(source).toContain(clause);
    }
    const item = byId.get('BRANCH-1');
    expect(item?.results.map(({ guard }) => guard)).toEqual([
      'branched',
      'refused',
    ]);
    expect(item?.prompt[0]).toBe('> Original request: <caller-input>');
    // The base revision is annotated as a repository revision, not verbatim
    // player text: it is receipt-owned effect evidence (DR-045).
    expect(gearsText).toContain('`baseRevision: <repository revision>`');
    expect(gearsText).not.toContain('`baseRevision: <verbatim final text>`');
    expect(gearsText).toContain('`coderOutput: <verbatim final text>`');
    expect(gearsText).toContain('`branch: <exact branch name>`');
    expect(gearsText).toContain('`issueSummary: <concise summary>`');
    expect(gearsText).not.toContain('Captain shall run:');
    expect(gearsText).not.toContain('## Optimizations');
  });

  it('requires the receipt-observed base revision before accepting branched', () => {
    const branched = {
      guard: 'branched',
      branch: 'issue-12-fix-retry',
      issueSummary: 'Issue #12 asks for backoff.',
    };
    expect(
      guards.isBranched({ context: CONTEXT, event: done(branched) }, undefined),
    ).toBe(false);
    expect(
      guards.isBranched(
        { context: CONTEXT, event: done({ ...branched, baseRevision: '   ' }) },
        undefined,
      ),
    ).toBe(false);
    expect(
      guards.isBranched(
        {
          context: CONTEXT,
          event: done({ ...branched, baseRevision: CONTEXT.baseRevision }),
        },
        undefined,
      ),
    ).toBe(true);
    expect(
      guards.isRefused(
        { context: CONTEXT, event: done({ guard: 'refused' }) },
        undefined,
      ),
    ).toBe(false);
  });

  it('derives the terminal result from typed context only', () => {
    const output = (
      branchMachine as unknown as {
        config: { output: (args: { context: BranchContext }) => unknown };
      }
    ).config.output;
    expect(output({ context: { ...CONTEXT, completion: 'branched' } })).toEqual({
      status: 'branched',
      branch: 'issue-12-fix-retry',
      baseRevision: '1111111111111111111111111111111111111111',
      issueSummary: 'Issue #12 asks for exponential backoff with jitter.',
    });
    expect(
      output({
        context: {
          callerInput: CONTEXT.callerInput,
          coderOutput: 'The working tree is not clean.',
          completion: 'refused',
        },
      }),
    ).toEqual({
      status: 'refused',
      coderOutput: 'The working tree is not clean.',
    });
    // DR-045: completion without a receipt-observed base revision is guarded
    // out; the output derivation refuses to fabricate one.
    expect(() =>
      output({
        context: {
          ...CONTEXT,
          baseRevision: undefined,
          completion: 'branched',
        },
      }),
    ).toThrow(/receipt-observed base revision/);
    expect(() => output({ context: { callerInput: 'Fix #12.' } })).toThrow(
      /without a recorded completion/,
    );
  });

  it('publishes a distinct terminal meaning per authored outcome', () => {
    const finalIds = Object.entries(states)
      .filter(([, state]) => state.type === 'final')
      .map(([id]) => id)
      .sort();
    expect(finalIds).toEqual(['branched', 'refused']);

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
    expect(
      entering.get('branched')?.map((actions) => actions.includes('rememberBranched')),
    ).toEqual([true]);
    expect(
      entering.get('refused')?.map((actions) => actions.includes('rememberRefused')),
    ).toEqual([true]);
    expect(states.branched?.description).toContain('checked out');
    expect(states.branched?.description).toContain('no commit was made');
    expect(states.refused?.description).toContain('No branch was created');
    expect(states.refused?.description).not.toContain('checked out');
  });

  it('publishes stable descriptions and the correct runtime tags', () => {
    // DR-048: every final state declares whether its outcome means success
    // or failure. BRANCH's completion is a success and its refusal is a
    // failure, so BRANCH's own caller routes it mechanically.
    const terminalKinds: Readonly<Record<string, 'success' | 'failure'>> = {
      branched: 'success',
      refused: 'failure',
    };
    expect(
      Object.entries(states)
        .filter(([, state]) => state.type === 'final')
        .map(([id]) => id)
        .sort(),
    ).toEqual(Object.keys(terminalKinds).sort());
    expect(states.createBranch?.tags).toContain('playbook.busy');
    for (const id of ['ready', 'awaitBossReply', 'failed']) {
      expect(states[id]?.tags).toContain('playbook.parked');
    }
    expect(states.failed?.type).not.toBe('final');
    const declaredRoles = new Map(
      enumeratePlayerStates(branchMachine).map(({ stateId, sourceItem }) => [
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
    expect(enumerateRootEvents(branchMachine).startBranch.target).toBe(
      'createBranch',
    );
  });
});
