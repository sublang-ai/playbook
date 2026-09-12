// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { anchorsOf, linksOf } from '../scripts/check-links.mjs';
import { rebaseContract } from '../scripts/compact-link-definition.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

it('ships the compact recipe with the exact helper and reversibly relocated complete contract', () => {
  const cache = mkdtempSync(join(tmpdir(), 'playbook-compact-pack-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_cache: cache },
      stdio: ['ignore', 'pipe', 'ignore'],
    }))[0].files.map((file: { path: string }) => file.path);
    for (const file of ['slc/link.md', 'slc/materialize-link.mjs', 'slc/references/link-contract.md', 'slc/slc.pin-inputs.json']) {
      expect(packed).toContain(file);
    }
    const recipe = read('slc/link.md');
    const full = read('slc/references/link-contract.md');
    // These hashes are the committed helper v2 and full definition at 1e74eb4.
    expect(sha(read('slc/materialize-link.mjs'))).toBe('fe7336bc4c1511c4170ac3cdaeda4ffc30f3848b40ae7301f6660c20067e58e0');
    expect(sha(rebaseContract(full, true))).toBe('75e2e6e51a49a8621dd713d4d081db001a6256b28fc565a2ca192471ad084043');
    const entryAnchors = anchorsOf(recipe);
    for (const anchor of anchorsOf(full)) expect(entryAnchors.has(anchor), anchor).toBe(true);
    for (const { target } of linksOf(recipe).filter(({ target }: { target: string }) => target.startsWith('references/link-contract.md#'))) {
      expect(anchorsOf(full).has(target.split('#')[1]), target).toBe(true);
    }
    for (const member of ['schema', 'profile', 'machineExport', 'label', 'options', 'inputMapping', 'entryEvent', 'bossEvents', 'outcomeAuthority', 'placeholderFields', 'transitionEventFields', 'verbatimPayloadFields', 'resumableStateIds', 'unfinishedFinalStateIds', 'controlContextFields']) {
      expect(recipe).toContain(`\`${member}\``);
    }
    expect(recipe).toContain('Existing compiler source/FSM/link conformance checks remain mandatory');
    expect(recipe).toContain('parallel/compound states');
    expect(recipe).toContain('custom classification/composition/extraction/status requirements');
    expect(recipe).toContain('does not mean `unchanged`');
    expect(Buffer.byteLength(recipe)).toBeLessThan(16_000);
    const closure = JSON.parse(read('slc/slc.pin-inputs.json')).closures.link;
    expect(closure).toContain('materialize-link.mjs');
    expect(closure).toContain('references/link-contract.md');
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}, 120_000);
