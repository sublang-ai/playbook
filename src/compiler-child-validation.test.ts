// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const graph = process.env.PLAYBOOK_EXPERIMENT_COMPILER ?? root;
const requireGraph = createRequire(join(graph, 'package.json'));

it('emits strict standalone canonical validation and agrees with the real nested bridge across public envelopes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'playbook-child-validator-'));
  try {
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(directory, 'node_modules/@sublang'), { recursive: true });
    symlinkSync(join(graph, 'node_modules/xstate'), join(directory, 'node_modules/xstate'));
    symlinkSync(graph === root ? root : join(graph, 'node_modules/@sublang/playbook'), join(directory, 'node_modules/@sublang/playbook'));
    const source = '### CASE-1\nWhen inspection is due, Captain shall call playbook inspect:\n> Inspect this work.\nAfter an authored failure, report it.\n';
    const sourcePath = join(directory, 'source.md');
    const target = join(directory, 'example.fsm.ts');
    writeFileSync(sourcePath, source);
    execFileSync(process.execPath, [join(root, 'slc/scaffold-fsm.mjs'), '--source', sourcePath, '--out', target]);
    const scaffold = readFileSync(target, 'utf8');
    const prefix = scaffold.indexOf('export function authoredChildResult(');
    const suffix = scaffold.indexOf('\nfunction invocationOutput(', prefix);
    expect(prefix).toBeGreaterThan(0);
    expect(suffix).toBeGreaterThan(prefix);
    const helper = scaffold.slice(prefix, suffix).trim();
    const imports = scaffold.split('\n').filter(line => /^import .*@sublang\/playbook\//.test(line));
    expect(imports).toEqual([
      "import { validatePlaybookCallResult } from '@sublang/playbook/xstate-runtime';",
      "import type { PlaybookCallResult } from '@sublang/playbook/runtime';",
    ]);
    const recipe = readFileSync(join(root, 'slc/gears2fsm.md'), 'utf8');
    expect(recipe).toContain(imports.join('\n') + '\n\n' + helper);
    expect(recipe).toContain('do not fabricate a request or child-session identity');
    const modulePath = join(directory, 'authored-child.ts');
    writeFileSync(modulePath, imports.join('\n') + '\n\n' + helper + '\n');
    const strict = spawnSync(process.execPath, [requireGraph.resolve('typescript/bin/tsc'),
      '--noEmitOnError', '--strict', '--types', 'node', '--typeRoots', join(graph, 'node_modules/@types'), '--noUnusedLocals', '--noUnusedParameters', '--noImplicitOverride',
      '--verbatimModuleSyntax', '--erasableSyntaxOnly', '--isolatedModules', '--skipLibCheck',
      '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', modulePath,
    ], { cwd: directory, encoding: 'utf8' });
    expect(strict.status, strict.stdout + strict.stderr).toBe(0);
    const probe = `
      import assert from 'node:assert/strict';
      import { createActor, toPromise } from 'xstate';
      import { createNestedPlaybookBridge, validatePlaybookCallResult } from '@sublang/playbook/xstate-runtime';
      import { authoredChildResult } from './authored-child.js';
      const base = { playbookId: 'inspect', childSessionId: 'child-1' };
      const state = { value: 'done', activeStateIds: ['done'], tags: [], status: 'done', quiescent: true, stateId: 'done' };
      const error = { name: 'InspectionFailure', message: 'Inspection stopped.', stack: 'synthetic stack' };
      const cases = [
        ['failure-terminal', { ...base, status: 'ok', terminal: { stateId: 'done', kind: 'failure' }, output: { detail: 'failed' } }, true],
        ['failure-description', { ...base, status: 'ok', terminal: { stateId: 'done', kind: 'failure', description: 'Inspection failed.' }, output: {} }, true],
        ['abort-without-state', { ...base, status: 'aborted', error }, true],
        ['abort-with-state', { ...base, status: 'aborted', state, error }, true],
        ['abort-without-error', { ...base, status: 'aborted' }, true],
        ['error', { ...base, status: 'error', error }, true],
        ['success', { ...base, status: 'ok', terminal: { stateId: 'done', kind: 'success' }, output: { done: true } }, false],
        ['wrong-target', { ...base, playbookId: 'other', status: 'error', error }, false],
        ['terminal-missing-state', { ...base, status: 'ok', terminal: { kind: 'failure' }, output: {} }, false],
        ['state-missing-fields', { ...base, status: 'aborted', state: { stateId: 'done', tags: [] }, error }, false],
        ['error-missing-name', { ...base, status: 'error', error: { message: 'bad' } }, false],
        ['aborted-with-output', { ...base, status: 'aborted', output: {} }, false],
        ['error-without-error', { ...base, status: 'error' }, false],
        ['success-without-session', { playbookId: 'inspect', status: 'ok', terminal: { stateId: 'done', kind: 'failure' } }, false],
      ];
      const cyclic = { ...base, status: 'error', error }; cyclic.self = cyclic;
      cases.push(['cyclic-result', cyclic, false]);
      const records = [];
      for (const [id, result, expected] of cases) {
        const outer = Object.assign(new Error('wrapper'), { result });
        const captured = authoredChildResult(outer, 'inspect');
        assert.equal(captured !== undefined, expected, id);
        if (expected) {
          const canonical = validatePlaybookCallResult(result, 'inspect');
          assert.deepEqual(captured, canonical);
          assert.notEqual(captured, result);
          assert(Object.isFrozen(captured));
          assert.equal(authoredChildResult(outer, 'wrong-target'), undefined);
        }
        const events = [];
        const bridge = createNestedPlaybookBridge({
          nextCallId: () => 'call-1',
          callPlaybook: async request => { assert.equal(request.playbookId, 'inspect'); return { state: 'settled', result }; },
          emitStarted: async () => { events.push('start'); },
          emitFinished: async () => { events.push('finish'); },
          drain: async () => {},
        });
        const actor = createActor(bridge.actorLogic, { input: { stateId: 'invoking', playbookId: 'inspect', text: 'Exact inspection scope.' } });
        const completion = toPromise(actor);
        actor.start();
        let bridgeError;
        try { await completion; } catch (error) { bridgeError = error; }
        assert.equal(authoredChildResult(bridgeError, 'inspect') !== undefined, expected, id + ': actual bridge');
        actor.stop(); await bridge.dispose();
        records.push({ id, expectedAuthoredFailure: expected, matchesActualBridge: true });
      }
      assert.equal(authoredChildResult({ result: cases[0][1] }, 'inspect'), undefined);
      assert.equal(authoredChildResult(new Error('ordinary transport error'), 'inspect'), undefined);
      const throwing = new Error('getter'); Object.defineProperty(throwing, 'result', { get() { throw new Error('unreadable'); } });
      assert.equal(authoredChildResult(throwing, 'inspect'), undefined);
      console.log(JSON.stringify({ cases: records, outerLookalikesRejected: true }));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: directory, encoding: 'utf8', timeout: 20_000 }));
    expect(result.cases).toHaveLength(15);
    expect(result.cases.every((row: { matchesActualBridge: boolean }) => row.matchesActualBridge)).toBe(true);
    expect(result.outerLookalikesRejected).toBe(true);
    expect(readFileSync(sourcePath, 'utf8')).toBe(source);
    expect(readFileSync(target, 'utf8')).toBe(scaffold);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
