// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import createCaptainPlaybookRuntime from '../reference/sdlc/captain.playbook/captain.playbook.js';
import { SUPPORTED_ARTIFACT_SCHEMAS } from './xstate-runtime.js';

it('loads the roleless Captain as an artifact-schema-2 module', () => {
  const source = readFileSync(
    fileURLToPath(
      new URL(
        '../reference/sdlc/captain.playbook/captain.playbook.ts',
        import.meta.url,
      ),
    ),
    'utf8',
  );
  expect(SUPPORTED_ARTIFACT_SCHEMAS).toEqual([2]);
  expect(typeof createCaptainPlaybookRuntime).toBe('function');
  // DR-022 / slc/link.md: the compat declaration is the link-time literal.
  // Importing the loading engine's RUNTIME_ABI would make the factory's
  // skew check compare that engine with itself.
  expect(source).toContain('compat: { artifactSchema: 2, runtimeAbi: 1 }');
  expect(source).not.toContain('  RUNTIME_ABI,');
  // slc/link.md §Output / playbook-cli-35: the Captain is the one module
  // the front ends import statically, so its factory call defers to the
  // first runtime request — an eager module-scope call would turn a future
  // compat mismatch into an uncaught ESM-load error that takes even
  // `--help` down, instead of the caught setup diagnostic. A re-link that
  // restores the eager call fails here rather than at the next ABI bump.
  expect(source).toContain('??= createXStatePlaybookRuntime(');
  expect(source).not.toMatch(/ =\s*\n?\s*createXStatePlaybookRuntime\(/);
  expect(source).toContain('roleStates: {}');
  expect(source).not.toContain('playerStates:');
});
