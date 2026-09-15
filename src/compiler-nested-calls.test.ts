// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const text2gears = readFileSync(
  new URL('../slc/text2gears.md', import.meta.url),
  'utf8',
);
const gears2fsm = readFileSync(
  new URL('../slc/gears2fsm.md', import.meta.url),
  'utf8',
);

it('defines exact nested call syntax without sequencing inside the verb phrase', () => {
  expect(text2gears).toContain(
    'In both literal and dynamic nested-call forms, the behavior\'s verb phrase shall\nbe exact: `Captain shall call playbook ...:`.',
  );
  expect(text2gears).toContain(
    'Text2gears shall not insert sequencing words such as `first`, `then`, `next`,\nor `finally` between `shall` and `call`',
  );
  expect(text2gears).toContain(
    '`When` or `While` clause or in continuation prose around the item',
  );
  expect(text2gears).toContain('`Captain shall call playbook <playbook-id>:`');
  expect(text2gears).toContain(
    '``Captain shall call playbook selected by `<playbook-id-context>`:``',
  );
  expect(text2gears).not.toContain('Captain shall first call playbook');
  expect(text2gears).not.toContain('Captain shall then call playbook');
  expect(text2gears).not.toContain('Captain shall next call playbook');
  expect(text2gears).not.toContain('Captain shall finally call playbook');
});

it('defines unreachable nested onDone omission without dropping authored failure paths', () => {
  expect(gears2fsm).toContain(
    'After preserving Source-authored success acceptance and recovery cases plus the\npublic control-error `onError` fallback, omit an `onDone` transition whose guard\ncannot be reached from any legal predecessor/context after the prior ordered\n`onDone` arms.',
  );
  expect(gears2fsm).toContain(
    'This rule does not require arbitrary finite enumeration, drop valid failure\nbehavior, or relax verifier obligations.',
  );
  expect(gears2fsm).toContain(
    'When Source explicitly continues one downstream behavior after a child\nsuccess, abort, or failure, both `invoke.onDone` and `invoke.onError` shall\nrecord the corresponding JSON-safe child result',
  );
  expect(gears2fsm).toContain(
    'An invalid result returns no authored outcome and takes the existing\ncontrol-error fallback.',
  );
});
