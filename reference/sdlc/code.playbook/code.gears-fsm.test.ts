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

const CONTEXT: CodingContext = {
  coderPlayer: 'GPT-5.6 Sol',
  runResults: '',
  callerInput: 'Implement the request.',
  coderOutput: 'Committed abc123.',
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
    for (const [id, state] of Object.entries(states)) {
      expect(state.description, id).toBeTruthy();
      expect(state.meta, id).toEqual({
        playbook: { stateId: id, description: state.description },
      });
    }
  });
});
