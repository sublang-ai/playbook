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
  'PlayerResult',
  'PlaybookPorts',
  'PlaybookSession',
  'PlaybookRuntime',
];

describe('CODE re-exports the shared runtime contract types (PBRT-36)', () => {
  it('imports the four contract types from @sublang/playbook/runtime', () => {
    const importLine = dts
      .split('\n')
      .find((l) => l.includes('@sublang/playbook/runtime'));
    expect(importLine, 'no reference to @sublang/playbook/runtime').toBeDefined();
    for (const name of SHARED_TYPES) {
      expect(importLine).toContain(name);
    }
  });

  it('declares none of the contract types locally', () => {
    for (const name of SHARED_TYPES) {
      expect(dts).not.toMatch(new RegExp(`\\b(?:interface|type)\\s+${name}\\b`));
    }
  });

  it('re-exports all four via one export statement', () => {
    const reexport = dts
      .split('\n')
      .find(
        (l) =>
          /^\s*export\s+(?:type\s+)?\{/.test(l) &&
          SHARED_TYPES.every((n) => l.includes(n)),
      );
    expect(reexport, 'no export {…} re-exporting all four').toBeDefined();
  });
});
