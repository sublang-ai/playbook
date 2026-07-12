// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// PBRT-36 rests on observable declaration evidence in the shipped
// `code.playbook.d.ts`, not on a structural assignability check (which
// a same-shaped local redefinition would also pass).
const dts = readFileSync(
  fileURLToPath(new URL('./code.playbook.d.ts', import.meta.url)),
  'utf8',
);

const SHARED_TYPES = [
  'JsonValue',
  'NormalizedError',
  'PlayerCallOptions',
  'PlayerResult',
  'PlaybookCallRequest',
  'PlaybookCallResult',
  'PlaybookCallStart',
  'PlaybookPendingCall',
  'PlaybookPorts',
  'PlaybookRunResult',
  'PlaybookRuntimeFactory',
  'PlaybookSession',
  'PlaybookState',
  'PlaybookStateValue',
  'PlaybookTraceEvent',
  'PlaybookTraceType',
  'PlaybookRuntime',
];

describe('CODE re-exports the shared runtime contract types (PBRT-36)', () => {
  it('imports every contract type from @sublang/playbook/runtime', () => {
    const importStatement = dts.match(
      /import type \{([\s\S]*?)\} from '@sublang\/playbook\/runtime';/,
    )?.[0];
    expect(
      importStatement,
      'no reference to @sublang/playbook/runtime',
    ).toBeDefined();
    for (const name of SHARED_TYPES) {
      expect(importStatement).toContain(name);
    }
  });

  it('declares none of the contract types locally', () => {
    for (const name of SHARED_TYPES) {
      expect(dts).not.toMatch(new RegExp(`\\b(?:interface|type)\\s+${name}\\b`));
    }
  });

  it('re-exports every contract type via one export statement', () => {
    const reexports = [
      ...dts.matchAll(/export type \{([\s\S]*?)\};/g),
    ].map((match) => match[0]);
    expect(
      reexports.some((statement) =>
        SHARED_TYPES.every((name) => statement.includes(name)),
      ),
      'no export {…} re-exporting every shared contract type',
    ).toBe(true);
  });
});
