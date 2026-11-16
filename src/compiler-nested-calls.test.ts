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
    'or `finally` between `shall` and `call`, and no other words between the target and the colon;',
  );
  expect(text2gears).toContain(
    '`When` or `While` clause or in a requirement item that cites the call.',
  );
  // Every maintained nested call ends at its target: no word stands between
  // the target and the colon.
  for (const name of ['branch', 'captain', 'code', 'decide', 'dev', 'inspect', 'pr', 'review']) {
    const gears = readFileSync(
      new URL(`../reference/sdlc/${name}.playbook/${name}.gears.md`, import.meta.url),
      'utf8',
    );
    for (const line of gears.split('\n').filter((l) => l.includes('Captain shall call playbook'))) {
      expect(line, name).toMatch(/Captain shall call playbook (?:`[^`]+`|selected by `[^`]+`):$/);
    }
  }
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
    'text2gears shall emit one action item whose one `When` clause lists the entry paths and shall state each path\'s continuation as a requirement item citing it',
  );
  const gears = readFileSync(
    new URL('../reference/sdlc/dev.playbook/dev.gears.md', import.meta.url),
    'utf8',
  );
  const sections = gears
    .split(/^(?=### )/m)
    .slice(1)
    .map((section) => {
      const [heading, ...body] = section.split('\n');
      const statement = body.find((line) => line.trim() !== '') ?? '';
      return { id: /^### (\S+)$/.exec(heading)?.[1] ?? '', statement, section };
    });
  const actions = sections.filter((item) => /\bCaptain shall\b/.test(item.statement));
  expect(actions.map((item) => item.id)).toEqual([
    'dev-1', 'dev-2', 'dev-3', 'dev-4', 'dev-5', 'dev-6',
  ]);
  const statement = (id: string): string =>
    actions.find((item) => item.id === id)?.statement ?? '';
  // dev-2 (`code`), dev-3 (`decide`), and dev-5 (`branch`) each list both
  // paths that enter the call in one `When` clause.
  expect(statement('dev-2')).toBe(
    'When Analyst chooses the code path [[dev-1](#dev-1)] or `branch` succeeds on the code via pull request path [[dev-5](#dev-5)] [[dev-35](#dev-35)], Captain shall call playbook `code`:',
  );
  expect(statement('dev-3')).toBe(
    'When Analyst chooses the decide then code path [[dev-1](#dev-1)] or `branch` succeeds on the decide then code via pull request path [[dev-5](#dev-5)] [[dev-35](#dev-35)], Captain shall call playbook `decide`:',
  );
  expect(statement('dev-5')).toBe(
    'When Analyst chooses the code via pull request path or the decide then code via pull request path [[dev-1](#dev-1)], Captain shall call playbook `branch`:',
  );
  // Each path's continuation is a requirement item citing the call, never
  // prose on the call item itself.
  const requirements = sections.filter(
    (item) => !/\bCaptain shall\b/.test(item.section) && !item.section.includes('\n> '),
  );
  for (const id of ['dev-2', 'dev-3', 'dev-5']) {
    expect(
      requirements.some((item) => item.statement.includes(`[[${id}](#${id})]`)),
      id,
    ).toBe(true);
    const call = actions.find((item) => item.id === id)?.section ?? '';
    expect(call.trimEnd().split('\n').at(-1)).toMatch(/^> /);
  }
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
    '`code` shall call `review` [[code-3](#code-3)] once over every `code`-owned commit of this run [[code-19](#code-19)], oldest first.',
  );
});
