// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { createActor, createMachine } from 'xstate';
import { expect, it } from 'vitest';
import { activePlaybookStateMetadata } from './xstate-runtime.js';

const definition = readFileSync(new URL('../slc/gears2fsm.md', import.meta.url), 'utf8');
const namespaceRule = 'Public `meta.playbook` state metadata belongs only to nodes declared under `states`; the machine root shall omit `meta.playbook`, while its XState `id`, description, and metadata outside that namespace remain unrestricted.';

function machine(rootMeta: Record<string, unknown>) {
  return createMachine({
    id: 'diagnostic-machine-id',
    description: 'Root description remains legal.',
    meta: rootMeta,
    initial: 'ready',
    states: {
      ready: { id: 'ready', meta: { playbook: { stateId: 'ready', description: 'Ready.' } }, on: { NEXT: 'done' } },
      done: { id: 'done', type: 'final', meta: { playbook: { stateId: 'done', description: 'Done.' } } },
    },
  });
}

it('preserves unrestricted root identity and non-Playbook metadata without creating another public state', () => {
  expect(definition).toContain(namespaceRule);
  const actor = createActor(machine({ diagram: { color: 'blue' } })).start();
  try {
    expect(activePlaybookStateMetadata(actor.getSnapshot())).toEqual([{ stateId: 'ready', description: 'Ready.' }]);
    actor.send({ type: 'NEXT' });
    expect(activePlaybookStateMetadata(actor.getSnapshot())).toEqual([{ stateId: 'done', description: 'Done.' }]);
  } finally { actor.stop(); }
});

it('demonstrates why a root public identity is outside the producer contract', () => {
  const actor = createActor(machine({ playbook: { stateId: 'machine-root' } })).start();
  try {
    expect(activePlaybookStateMetadata(actor.getSnapshot()).map(({ stateId }) => stateId)).toEqual(['machine-root', 'ready']);
    actor.send({ type: 'NEXT' });
    expect(activePlaybookStateMetadata(actor.getSnapshot()).map(({ stateId }) => stateId)).toEqual(['done', 'machine-root']);
  } finally { actor.stop(); }
});

it('demonstrates why merely removing a root stateId leaves invalid public metadata', () => {
  const actor = createActor(machine({ playbook: {} })).start();
  try {
    expect(() => activePlaybookStateMetadata(actor.getSnapshot())).toThrow(/meta.playbook.stateId/);
  } finally { actor.stop(); }
});
