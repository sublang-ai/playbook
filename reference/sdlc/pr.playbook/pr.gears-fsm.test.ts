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
import { prMachine, type PrContext } from './pr.fsm.js';
import {
  enumerateNestedPlaybookStates,
  enumeratePlayerStates,
  enumerateRootEvents,
  enumerateScriptStates,
} from './pr.fsm.introspect.js';
import prRegistry from './pr.registry.js';

const source = readFileSync(
  fileURLToPath(new URL('../pr.md', import.meta.url)),
  'utf8',
);
const gearsText = readFileSync(
  fileURLToPath(new URL('./pr.gears.md', import.meta.url)),
  'utf8',
);
const gears = parseGearsContract(gearsText);
const byId = new Map(gears.map((item) => [item.id, item]));

type ItemId = 'PR-1' | 'PR-2' | 'PR-3' | 'PR-4' | 'PR-5' | 'PR-6' | 'PR-7';
type ScriptItemId = 'PR-2' | 'PR-4' | 'PR-5' | 'PR-6' | 'PR-7';

interface RawTransition {
  guard?: string;
  target?: string;
  actions?: unknown;
}

interface RawInvokingState {
  invoke?: {
    src?: string;
    onDone?: RawTransition | readonly RawTransition[];
    onError?: RawTransition | readonly RawTransition[];
  };
}

const SCRIPT_ITEMS: readonly ScriptItemId[] = ['PR-2', 'PR-4', 'PR-5', 'PR-6', 'PR-7'];

// The optimize pass keeps every rewritten item's condition text unchanged and
// replaces only its acting clause with the script form.
const SCRIPT_CONDITIONS: Readonly<Record<ScriptItemId, string>> = {
  'PR-2': 'When the pull request is open and no fix has been attempted, Captain shall',
  'PR-4': 'When `code` succeeds, Captain shall',
  'PR-5': 'When the fix is published, Captain shall',
  'PR-6': 'When the checks pass, before or after the one fix attempt, Captain shall',
  'PR-7': 'When the pull request is merged, Captain shall',
};

function gearsSection(id: ItemId): string {
  const start = gearsText.indexOf(`### ${id}\n`);
  expect(start, id).toBeGreaterThanOrEqual(0);
  const nextHeading = gearsText.indexOf('\n## ', start + 1);
  const nextItem = gearsText.indexOf('\n### ', start + 1);
  const candidates = [nextHeading, nextItem].filter((index) => index !== -1);
  return gearsText.slice(
    start,
    candidates.length === 0 ? undefined : Math.min(...candidates),
  );
}

function route(transition: RawTransition | undefined) {
  return {
    guard: transition?.guard,
    target: transition?.target,
    actions: transition?.actions,
  };
}

function armList(value: unknown): readonly RawTransition[] {
  return value === undefined
    ? []
    : ((Array.isArray(value) ? value : [value]) as RawTransition[]);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const CONTEXT: PrContext = {
  callerInput: 'Deliver the reviewed branch for issue #12.',
  pullRequest: '12',
  pullRequestUrl: 'https://github.com/acme/widgets/pull/12',
};

const rawStates = (prMachine as unknown as {
  config: {
    states: Record<
      string,
      {
        type?: string;
        description?: string;
        tags?: readonly string[];
        meta?: unknown;
      } & RawInvokingState
    >;
  };
}).config.states;

describe('PR Source, GEARS, and FSM agreement', () => {
  it('preserves every authored instruction and command of the protected source', () => {
    expect(checkSourceGearsContract(source, gearsText)).toEqual([]);
  });

  it('maps exactly PR-1 through PR-7 once, across the player, playbook, and script actor kinds', () => {
    expect(gears.map(({ id }) => id)).toEqual([
      'PR-1',
      'PR-2',
      'PR-3',
      'PR-4',
      'PR-5',
      'PR-6',
      'PR-7',
    ]);
    const stateItems = [
      ...enumeratePlayerStates(prMachine),
      ...enumerateNestedPlaybookStates(prMachine),
      ...enumerateScriptStates(prMachine),
    ].map(({ sourceItem }) => sourceItem);
    expect(stateItems.sort()).toEqual(gears.map(({ id }) => id).sort());
    const actorKinds = new Set(
      Object.values(rawStates)
        .map((state) => state.invoke?.src)
        .filter((src): src is string => src !== undefined),
    );
    expect([...actorKinds].sort()).toEqual(['playbook', 'player', 'script']);
  });

  it('declares exactly the one Coder role with no alias', () => {
    const roleList = source.match(/Roles:\n\n((?:- .+\n)+)/)?.[1];
    expect(roleList).toBe('- Coder\n');
    expect(gearsText).toContain('Roles:\n\n- Coder\n');
    expect(prRegistry.requiredRoleIds).toEqual(['coder']);
    expect(prRegistry.concurrentRoleSets).toEqual([]);
    expect(prRegistry.artifactSchema).toBe(3);
    expect(prRegistry.runtimeProfile).toEqual({
      kind: 'shared-factory',
      compat: { artifactSchema: 3, runtimeAbi: 1 },
    });
  });

  it('keeps the Coder prompt and result contract verbatim', () => {
    const states = enumeratePlayerStates(prMachine);
    expect(states.map(({ stateId }) => stateId)).toEqual(['openPullRequest']);
    for (const state of states) {
      const item = byId.get(state.sourceItem);
      expect(item, state.sourceItem).toBeDefined();
      const input = state.getInput(CONTEXT);
      expect(item?.player).toBe('Coder');
      expect(item?.delegated).toBe(true);
      expect(input.role).toBe('coder');
      expect(input.prompt).toBe(item?.prompt.join('\n'));
      expect(Object.entries(input.result).slice(0, -1)).toEqual(
        item?.results.map(({ guard, description }) => [guard, description]),
      );
      expect(input.result.needsBossReply).toContain('question:');
    }
    expect([...verbatimFieldsFromGears(gearsText)]).toEqual(['coderOutput']);
  });

  it('preserves the two semantic publication outcomes and their invariants', () => {
    for (const clause of [
      'The result has two semantic outcomes: opened and not published.',
      "Each outcome requires affirmative support in Coder's result, and no outcome depends on a fixed presentation format of Coder's reply.",
      "Every outcome keeps the repository exact: pushing a branch and opening a pull request change neither HEAD's commit nor the working tree.",
      "For not published, `pr` fails and reports Coder's complete result with its reason to its caller.",
    ]) {
      expect(source).toContain(clause);
      expect(gearsSection('PR-1')).toContain(clause);
    }
    const item = byId.get('PR-1');
    expect(item?.results.map(({ guard }) => guard)).toEqual([
      'opened',
      'notPublished',
    ]);
    // `opened` is the declared producer of the `<pull-request-url>` PR-3 reads.
    expect(item?.results[0]?.fields.map(({ name }) => name)).toEqual([
      'pullRequest',
      'pullRequestUrl',
    ]);
    expect(byId.get('PR-3')?.prompt).toContain('> Pull request: <pull-request-url>');
    expect(item?.results[1]?.fields).toEqual([
      { name: 'coderOutput', verbatim: true },
    ]);
  });

  it('compiles the five mechanical items as script states with their source commands verbatim', () => {
    const scripts = enumerateScriptStates(prMachine);
    expect(
      scripts.map(({ stateId, sourceItem }) => ({ stateId, sourceItem })),
    ).toEqual([
      { stateId: 'waitForChecks', sourceItem: 'PR-2' },
      { stateId: 'publishFix', sourceItem: 'PR-4' },
      { stateId: 'waitForChecksAfterFix', sourceItem: 'PR-5' },
      { stateId: 'mergePullRequest', sourceItem: 'PR-6' },
      { stateId: 'updateLocalDefault', sourceItem: 'PR-7' },
    ]);
    for (const script of scripts) {
      const id = script.sourceItem as ScriptItemId;
      const item = byId.get(id);
      expect(item, id).toBeDefined();
      // The optimize pass rewrote a direct-Captain item: no role, no player.
      expect(item?.delegated).toBe(false);
      expect(item?.player).toBeUndefined();
      expect(gearsSection(id)).toContain(`${SCRIPT_CONDITIONS[id]} run:\n`);
      expect(source).toContain(SCRIPT_CONDITIONS[id]);
      const input = script.getInput(CONTEXT);
      expect(rawStates[script.stateId]?.invoke?.src).toBe('script');
      expect(input.command).toBe(item?.prompt.join('\n'));
      expect(input.command).not.toMatch(/<[A-Za-z_$#][A-Za-z0-9_$#-]*>/);
      // Exactly two guards, zero-exit first, nonzero second; no needsBossReply.
      expect(item?.results).toHaveLength(2);
      expect(Object.entries(input.result)).toEqual(
        item?.results.map(({ guard, description }) => [guard, description]),
      );
      expect(item?.results[0]?.description).toContain('exited with status zero');
      expect(item?.results[1]?.description).toContain('exited with a nonzero status');
      expect(input.result).not.toHaveProperty('needsBossReply');
      expect(input).not.toHaveProperty('prompt');
      expect(input).not.toHaveProperty('role');
      for (const guard of Object.keys(input.result)) {
        expect(guard).toMatch(/^[a-z][A-Za-z0-9]*$/);
      }
    }
    // The source states the mechanical invariant once and authors each step
    // as one fixed command; the two waits carry the same command text.
    expect(source).toContain(
      'The check waits, the fix publication, the merge, and the local update are mechanical steps: each runs one fixed command whose exit status alone decides its two outcomes, reads no conversation, and produces no prose.',
    );
    expect(
      occurrences(
        source,
        'running exactly the following command in the repository, with no other action and without reading its output:',
      ),
    ).toBe(4);
    expect(
      occurrences(
        source,
        'running exactly the same command as the first wait in the repository, with no other action and without reading its output:',
      ),
    ).toBe(1);
    const commands = new Map(
      scripts.map((script) => [script.sourceItem, script.getInput(CONTEXT).command]),
    );
    expect(commands.get('PR-2')).toBe(commands.get('PR-5'));
    expect(commands.get('PR-2')).toContain("grep -q 'no checks reported'");
    expect(commands.get('PR-2')).toContain(
      'gh pr checks --watch --fail-fast >/dev/null 2>&1',
    );
    expect(commands.get('PR-4')).toContain('git push || exit 1');
    expect(commands.get('PR-4')).toContain(
      'gh pr view --json headRefOid --jq .headRefOid',
    );
    expect(commands.get('PR-6')).toBe(
      "pr=$(gh pr view --json url --jq .url) || exit 1\nbase=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name) || exit 1\n[ -n \"$pr\" ] && [ -n \"$base\" ] || exit 1\n[ \"$(gh pr view \"$pr\" --json baseRefName --jq .baseRefName)\" = \"$base\" ] || exit 1\ngh pr merge --merge --delete-branch --match-head-commit \"$(git rev-parse HEAD)\" || exit 1\n[ \"$(gh pr view \"$pr\" --json state --jq .state)\" = MERGED ] || exit 1\n[ \"$(git branch --show-current)\" = \"$base\" ]",
    );
    expect(commands.get('PR-7')).toBe('git pull --ff-only');
  });

  it('lists exactly the five mechanical items as captain → script optimizations', () => {
    const marker = '## Optimizations';
    const start = gearsText.indexOf(marker);
    expect(start).toBeGreaterThan(gearsText.lastIndexOf('### PR-7'));
    expect(gearsText.indexOf(marker, start + 1)).toBe(-1);
    const bullets = gearsText
      .slice(start + marker.length)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(bullets).toEqual(
      SCRIPT_ITEMS.map((id) => `- ${id}: captain → script`),
    );
    // Neither the governed Coder item nor the nested call was rewritten.
    expect(gearsSection('PR-1')).toContain('Captain shall relay the complete caller input in quotes (`>`) to Coder');
    expect(gearsSection('PR-3')).toContain('Captain shall call playbook `code`:');
    expect(occurrences(gearsText, 'Captain shall run:')).toBe(SCRIPT_ITEMS.length);
  });

  it('compiles PR-3 as a literal code call with no result contract, never a player call', () => {
    const nested = enumerateNestedPlaybookStates(prMachine);
    expect(
      nested.map(({ stateId, sourceItem }) => ({ stateId, sourceItem })),
    ).toEqual([{ stateId: 'fixChecks', sourceItem: 'PR-3' }]);
    expect(nested[0]?.getInput(CONTEXT).playbookId).toBe('code');
    expect(rawStates.fixChecks?.invoke?.src).toBe('playbook');
    const item = byId.get('PR-3');
    expect(item?.delegated).toBe(false);
    expect(item?.player).toBeUndefined();
    expect(item?.results).toEqual([]);
    expect(gearsSection('PR-3')).not.toContain('Results:');
    expect(item?.prompt).toEqual([
      '> Original request: <caller-input>',
      '> Pull request: <pull-request-url>',
      "> Coding request: The pull request's checks are red on the checked-out branch. Inspect the failing checks with `gh pr checks` and `gh run view --log-failed`, fix their cause on this branch with a minimal change, and make the checks pass.",
    ]);
    expect(
      enumeratePlayerStates(prMachine).some(
        ({ sourceItem }) => sourceItem !== 'PR-1',
      ),
    ).toBe(false);
  });

  it('pins every authored child outcome to its compiled route', () => {
    for (const clause of [
      '`pr` makes no more than one fix attempt.',
      'Only after `code` succeeds shall `pr` publish the fix and wait for the checks again.',
      'When `code` returns an authored abort or failure, or a terminal result that does not prove its success, `pr` shall fail relaying that canonical result and shall leave the pull request open.',
      'When the nested `code` call fails outside that authored result contract, `pr` shall park as failed and retain the control-plane error instead of reporting an authored outcome.',
    ]) {
      expect(source).toContain(clause);
    }
    for (const outcome of [
      '- `pr` makes no more than one fix attempt.',
      '- Only after `code` succeeds does `pr` publish the fix and wait for the checks again.',
      '- An authored `code` abort or failure, or a terminal `code` result that does not prove its success, terminates `pr` with that canonical result relayed and the pull request left open.',
      '- Any other nested-call error parks `pr` as failed and retains the control-plane error.',
    ]) {
      expect(gearsSection('PR-3')).toContain(outcome);
    }
    const fixChecks = rawStates.fixChecks?.invoke;
    expect({
      success: route(armList(fixChecks?.onDone)[0]),
      insufficient: route(armList(fixChecks?.onDone)[1]),
      authoredFailure: route(armList(fixChecks?.onError)[0]),
      controlFailure: route(armList(fixChecks?.onError)[1]),
    }).toEqual({
      success: { guard: 'isCodeSuccess', target: 'publishFix', actions: undefined },
      insufficient: {
        guard: undefined,
        target: 'fixFailed',
        actions: 'completeWithInsufficientCodeResult',
      },
      authoredFailure: {
        guard: 'authoredCodeFailure',
        target: 'fixFailed',
        actions: 'completeWithCodeFailure',
      },
      controlFailure: {
        guard: undefined,
        target: 'failed',
        actions: 'rememberActorError',
      },
    });
  });

  it('routes every script outcome to its authored continuation with a structural one-fix bound', () => {
    const scriptRoutes = Object.fromEntries(
      SCRIPT_ITEMS.map((id) => {
        const stateId = enumerateScriptStates(prMachine).find(
          ({ sourceItem }) => sourceItem === id,
        )!.stateId;
        const invoke = rawStates[stateId]?.invoke;
        return [
          id,
          {
            onDone: armList(invoke?.onDone).map((arm) => ({
              guard: arm.guard,
              target: arm.target,
            })),
            onError: route(armList(invoke?.onError)[0]),
          },
        ];
      }),
    );
    const controlFailure = {
      guard: undefined,
      target: 'failed',
      actions: 'rememberActorError',
    };
    expect(scriptRoutes).toEqual({
      'PR-2': {
        onDone: [
          { guard: 'checksPassed', target: 'mergePullRequest' },
          { guard: 'checksFailed', target: 'fixChecks' },
          { guard: undefined, target: 'failed' },
        ],
        onError: controlFailure,
      },
      'PR-4': {
        onDone: [
          { guard: 'fixPublished', target: 'waitForChecksAfterFix' },
          { guard: 'fixNotPublished', target: 'fixNotPublished' },
          { guard: undefined, target: 'failed' },
        ],
        onError: controlFailure,
      },
      'PR-5': {
        onDone: [
          { guard: 'checksPassed', target: 'mergePullRequest' },
          { guard: 'checksStillFailing', target: 'checksStillFailing' },
          { guard: undefined, target: 'failed' },
        ],
        onError: controlFailure,
      },
      'PR-6': {
        onDone: [
          { guard: 'merged', target: 'updateLocalDefault' },
          { guard: 'mergeRefused', target: 'mergeRefused' },
          { guard: undefined, target: 'failed' },
        ],
        onError: controlFailure,
      },
      'PR-7': {
        onDone: [
          { guard: 'localDefaultUpdated', target: 'merged' },
          { guard: 'localDefaultNotUpdated', target: 'mergedLocalBehind' },
          { guard: undefined, target: 'failed' },
        ],
        onError: controlFailure,
      },
    });
    // The one-fix bound is structural: only the first wait can reach the
    // CODE call, and nothing after the fix targets it again.
    const targetsOfFixChecks = Object.entries(rawStates).filter(([, state]) =>
      [...armList(state.invoke?.onDone), ...armList(state.invoke?.onError)].some(
        (arm) => arm.target === 'fixChecks',
      ),
    );
    expect(targetsOfFixChecks.map(([id]) => id)).toEqual(['waitForChecks']);
    for (const clause of [
      'Checks still failing is an authored failure that leaves the pull request open; there is no second fix attempt.',
      'A pull request whose repository still reports no checks after a brief wait for them to register counts as passed.',
      'Both complete `pr`: the pull request is merged either way, and the result states whether the local default branch was fast-forwarded to the merged head.',
    ]) {
      expect(source).toContain(clause);
      expect(gearsText).toContain(`- ${clause}`);
    }
  });

  it('publishes a distinct terminal meaning per authored outcome', () => {
    const finalIds = Object.entries(rawStates)
      .filter(([, state]) => state.type === 'final')
      .map(([id]) => id)
      .sort();
    expect(finalIds).toEqual([
      'checksStillFailing',
      'fixFailed',
      'fixNotPublished',
      'mergeRefused',
      'merged',
      'mergedLocalBehind',
      'notPublished',
    ]);

    const entering = new Map<string, string[]>();
    for (const state of Object.values(rawStates)) {
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
    expect(entering.get('merged')).toEqual(['completeMerged']);
    expect(entering.get('mergedLocalBehind')).toEqual([
      'completeMergedLocalBehind',
    ]);
    expect(
      entering
        .get('notPublished')
        ?.map((actions) => actions.includes('completeNotPublished')),
    ).toEqual([true]);
    expect(entering.get('fixFailed')?.sort()).toEqual([
      'completeWithCodeFailure',
      'completeWithInsufficientCodeResult',
    ]);
    expect(entering.get('fixNotPublished')).toEqual(['completeFixNotPublished']);
    expect(entering.get('checksStillFailing')).toEqual([
      'completeChecksStillFailing',
    ]);
    expect(entering.get('mergeRefused')).toEqual(['completeMergeRefused']);

    expect(rawStates.merged?.description).toContain('fast-forwarded to the merged head');
    expect(rawStates.mergedLocalBehind?.description).toContain(
      'could not be fast-forwarded',
    );
    expect(rawStates.notPublished?.description).toContain(
      'no pull request is guaranteed to exist',
    );
    for (const id of ['fixFailed', 'fixNotPublished', 'checksStillFailing']) {
      expect(rawStates[id]?.description, id).toContain('the pull request remains open');
    }
    expect(rawStates.mergeRefused?.description).toContain(
      'the state GitHub reports',
    );
    for (const id of finalIds) {
      if (id === 'merged' || id === 'mergedLocalBehind') continue;
      expect(rawStates[id]?.description, id).not.toContain('is merged');
    }
  });

  it('publishes stable descriptions and the correct runtime tags', () => {
    // DR-048: every final state declares whether its outcome means success
    // or failure. The pull request is merged either way on both success
    // terminals; each failure leaves it in the state GitHub reports.
    const terminalKinds: Readonly<Record<string, 'success' | 'failure'>> = {
      merged: 'success',
      mergedLocalBehind: 'success',
      notPublished: 'failure',
      fixFailed: 'failure',
      fixNotPublished: 'failure',
      checksStillFailing: 'failure',
      mergeRefused: 'failure',
    };
    expect(
      Object.entries(rawStates)
        .filter(([, state]) => state.type === 'final')
        .map(([id]) => id)
        .sort(),
    ).toEqual(Object.keys(terminalKinds).sort());
    for (const id of [
      'openPullRequest',
      'waitForChecks',
      'publishFix',
      'waitForChecksAfterFix',
      'mergePullRequest',
      'updateLocalDefault',
    ]) {
      expect(rawStates[id]?.tags, id).toContain('playbook.busy');
    }
    expect(rawStates.fixChecks?.tags).toContain('playbook.suspended');
    for (const id of ['ready', 'awaitBossReply', 'failed']) {
      expect(rawStates[id]?.tags, id).toContain('playbook.parked');
    }
    const declaredRoles = new Map(
      enumeratePlayerStates(prMachine).map(({ stateId, sourceItem }) => [
        stateId,
        byId.get(sourceItem)?.player?.toLowerCase(),
      ]),
    );
    for (const [id, state] of Object.entries(rawStates)) {
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
    expect(enumerateRootEvents(prMachine).startPr.target).toBe(
      'openPullRequest',
    );
  });
});
