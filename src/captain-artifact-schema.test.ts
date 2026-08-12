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
  expect(source).toContain(
    'compat: { artifactSchema: 2, runtimeAbi: RUNTIME_ABI }',
  );
  expect(source).toContain('roleStates: {}');
  expect(source).not.toContain('playerStates:');
});
