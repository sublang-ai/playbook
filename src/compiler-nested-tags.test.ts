// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { createActor, createMachine } from 'xstate';
import { expect, it } from 'vitest';

import { normalizePlaybookSnapshot } from './xstate-runtime.js';

const pendingCall = {
  callId: 'playbook-1',
  playbookId: 'child',
  childSessionId: 'child-session-1',
};

function meta(stateId: string) {
  return { playbook: { stateId, description: `${stateId} state` } };
}

it('keeps nested call suspension separate from busy working tags', () => {
  const definition = readFileSync(
    new URL('../slc/gears2fsm.md', import.meta.url),
    'utf8',
  );
  expect(definition).toContain(
    'Every direct-Captain, delegated-player, or script working leaf',
  );
  expect(definition).toContain('shall carry the tag `playbook.busy`');
  expect(definition).toContain(
    'The call state and every ancestor state, including the machine root, shall omit\ntag `playbook.busy`.',
  );
  expect(definition).toContain(
    'An independently active sibling Captain, player, or script leaf may carry\n`playbook.busy`.',
  );
  expect(definition).not.toContain(
    'Every invoking working leaf — sequential or parallel, whatever its actor\nkind — shall carry the tag `playbook.busy`',
  );

  const suspendedOnly = createActor(
    createMachine({
      id: 'suspended-only',
      initial: 'call',
      states: {
        call: { tags: ['playbook.suspended'], meta: meta('call') },
      },
    }),
  ).start();
  expect(
    normalizePlaybookSnapshot(suspendedOnly.getSnapshot(), {
      pendingCall,
    }),
  ).toMatchObject({ quiescent: true, tags: ['playbook.suspended'] });
  suspendedOnly.stop();

  const rootBusy = createActor(
    createMachine({
      id: 'root-busy',
      tags: ['playbook.busy'],
      initial: 'call',
      states: {
        call: { tags: ['playbook.suspended'], meta: meta('call') },
      },
    }),
  ).start();
  expect(
    normalizePlaybookSnapshot(rootBusy.getSnapshot(), {
      pendingCall,
    }),
  ).toMatchObject({
    quiescent: false,
    tags: ['playbook.busy', 'playbook.suspended'],
  });
  rootBusy.stop();

  const ancestorBusy = createActor(
    createMachine({
      id: 'ancestor-busy',
      initial: 'parent',
      states: {
        parent: {
          tags: ['playbook.busy'],
          initial: 'call',
          states: {
            call: { tags: ['playbook.suspended'], meta: meta('call') },
          },
        },
      },
    }),
  ).start();
  expect(
    normalizePlaybookSnapshot(ancestorBusy.getSnapshot(), {
      pendingCall,
    }),
  ).toMatchObject({
    quiescent: false,
    tags: ['playbook.busy', 'playbook.suspended'],
  });
  ancestorBusy.stop();

  const activeSiblingBusy = createActor(
    createMachine({
      id: 'active-sibling-busy',
      type: 'parallel',
      states: {
        child: {
          initial: 'call',
          states: {
            call: { tags: ['playbook.suspended'], meta: meta('child.call') },
          },
        },
        sibling: {
          initial: 'work',
          states: {
            work: { tags: ['playbook.busy'], meta: meta('sibling.work') },
          },
        },
      },
    }),
  ).start();
  expect(
    normalizePlaybookSnapshot(activeSiblingBusy.getSnapshot(), {
      pendingCall,
    }),
  ).toMatchObject({
    quiescent: false,
    tags: ['playbook.busy', 'playbook.suspended'],
  });
  activeSiblingBusy.stop();
});
