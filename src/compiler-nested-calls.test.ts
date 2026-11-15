// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync, readdirSync } from 'node:fs';
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

it('joins the paths that share one nested call in one item, as the maintained DEV GEARS does', () => {
  const definition = readFileSync(
    new URL('../slc/text2gears.md', import.meta.url),
    'utf8',
  ).replace(/\s+/g, ' ');
  expect(definition).toContain('do not split by trigger alone');
  expect(definition).toContain(
    'text2gears shall emit one item whose condition joins the triggers and shall keep each path\'s continuation as that item\'s prose',
  );
  const gears = readFileSync(
    new URL('../reference/sdlc/dev.playbook/dev.gears.md', import.meta.url),
    'utf8',
  );
  const items = [...gears.matchAll(/^### (DEV-\d+)$/gm)].map((match) => match[1]);
  expect(items).toEqual(['DEV-1', 'DEV-2', 'DEV-3', 'DEV-4', 'DEV-5', 'DEV-6']);
  const conditions = gears.split(/^### DEV-\d+$/m).slice(1).map((section) =>
    section.split('\n').find((line) => /Captain shall call playbook/.test(line)) ?? '',
  );
  // DEV-2 (`code`), DEV-3 (`decide`), and DEV-5 (`branch`) each name both
  // paths that enter the call in one condition.
  expect(conditions[1]).toMatch(
    /^When the accepted planning result is code, or when `branch` has succeeded on the code via pull request path, Captain shall call playbook `code`:$/,
  );
  expect(conditions[2]).toMatch(
    /^When the accepted planning result is decide then code, or when `branch` has succeeded on the decide then code via pull request path, Captain shall call playbook `decide`:$/,
  );
  expect(conditions[4]).toMatch(
    /^When the accepted planning result is code via pull request or decide then code via pull request and no child call has started yet, Captain shall call playbook `branch`:$/,
  );
});

it('keeps every maintained nested-call target immediately before its colon', () => {
  const root = new URL('../reference/sdlc/', import.meta.url);
  const workflows = readdirSync(root)
    .filter((name) => name.endsWith('.playbook'))
    .sort();
  for (const directory of workflows) {
    const name = directory.slice(0, -'.playbook'.length);
    const gears = readFileSync(
      new URL(`${directory}/${name}.gears.md`, root),
      'utf8',
    );
    const clauses = gears.split('\n').filter((line) =>
      /Captain shall\b.*\bcall playbook\b/.test(line),
    );
    for (const line of clauses) {
      expect(line, `${directory}: ${line}`).toMatch(
        /Captain shall call playbook (?:`[^`\n]+`|selected by `[^`\n]+`):$/,
      );
    }
  }
  const code = readFileSync(
    new URL('code.playbook/code.gears.md', root),
    'utf8',
  );
  expect(code).toContain(
    'Captain calls `review` once over every `code`-owned commit of this run, oldest first',
  );
});
