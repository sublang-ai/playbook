// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = join(root, 'slc/scaffold-fsm.mjs');
const compiler = process.env.PLAYBOOK_EXPERIMENT_COMPILER;
const graph = compiler ?? root;
const requireGraph = createRequire(join(graph, 'package.json'));
const directories: string[] = [];
const prompt = 'Captain shall run: and Parallel group: are literal instruction text here.\nKeep ${literal}, `ticks`, \\<escaped> and <task>.\n> Keep this quoted line.\n\nFinal line.';
const source = [
  '<!-- SPDX-License-Identifier: Apache-2.0 -->',
  '<!-- SPDX-FileCopyrightText: 2026 Example -->',
  '# Original fixture', '', 'Roles:', '', '- Worker', '', '### CASE-1', '',
  'When a task arrives, Captain shall prompt Worker:', '',
  ...prompt.split('\n').map(line => line ? `> ${line}` : '>'), '',
  'Results:', '- `done`: Completed. Output shall include `answer`.',
  '- `__proto__`: The alternate answer was selected.', '',
  '### CASE-2', '', 'When work completes, Captain shall call playbook `inspect`:', '',
  '> Inspect the authored answer.', '',
  'When the inspection completes, the workflow completes.', '',
].join('\n');

function workspace(text = source) {
  const directory = mkdtempSync(join(tmpdir(), 'playbook-fsm-scaffold-'));
  directories.push(directory);
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(directory, 'node_modules/@sublang'), { recursive: true });
  symlinkSync(join(graph, 'node_modules/xstate'), join(directory, 'node_modules/xstate'));
  symlinkSync(graph === root ? root : join(graph, 'node_modules/@sublang/playbook'), join(directory, 'node_modules/@sublang/playbook'));
  const input = join(directory, 'source.md');
  const output = join(directory, 'sample.fsm.ts');
  writeFileSync(input, text);
  return { directory, input, output };
}

function initialize(input: string, output: string) {
  return spawnSync(process.execPath, [helper, '--source', input, '--out', output], { encoding: 'utf8' });
}

function strict(directory: string, path: string, emit = false) {
  return spawnSync(process.execPath, [requireGraph.resolve('typescript/bin/tsc'),
    emit ? '--noEmitOnError' : '--noEmit', '--strict', '--types', 'node', '--typeRoots', join(graph, 'node_modules/@types'), '--noUnusedLocals', '--noUnusedParameters',
    '--erasableSyntaxOnly', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', path,
  ], { cwd: directory, encoding: 'utf8' });
}

function complete(scaffold: string) {
  const replacements: Record<string, string> = {
    __AUTHOR_CONTEXT__: '{ task: string; answer: string }',
    __AUTHOR_EVENTS__: "{ type: 'RETRY' } | { type: 'START'; task: string }",
    __AUTHOR_MACHINE_INPUT__: '{ task: string }',
    __AUTHOR_MACHINE_OUTPUT__: '{ answer: string }',
    __AUTHOR_PLAYER_FIELDS__: '{ task: string }',
    __AUTHOR_PLAYER_OUTPUT__: "{ guard: 'done'; answer: string } | { guard: '__proto__'; answer: string } | { guard: 'needsBossReply'; question: string }",
    __AUTHOR_CONTEXT_UPDATE_FROM_OUTPUT__: "typeof output === 'object' && output !== null && 'answer' in output && typeof output.answer === 'string' ? { answer: output.answer } : {}",
    __AUTHOR_MACHINE_CONFIG__: `{
      id: 'sample', initial: 'work',
      context: ({ input }) => ({ task: input.task, answer: '' }),
      output: ({ context }) => ({ answer: context.answer }),
      ...machineSetup.createStateConfig({ on: { RETRY: { target: '.work' } } }),
      states: {
        work: { invoke: { src: 'player', input: ({ context }) => ({
          stateId: 'work', sourceItem: 'CASE-1', role: 'worker',
          prompt: GEARS_ITEMS['CASE-1'].prompt,
          result: { ...GEARS_ITEMS['CASE-1'].result, needsBossReply: 'A question for Boss.' },
          task: context.task,
        }), onDone: { target: 'inspect', actions: 'rememberResult' }, onError: 'failed' } },
        inspect: { invoke: { src: 'playbook', input: ({ context }) => ({
          stateId: 'inspect', sourceItem: 'CASE-2', playbookId: 'inspect',
          text: GEARS_ITEMS['CASE-2'].prompt + '\\n' + context.answer,
        }), onDone: 'done', onError: 'failed' } },
        done: { type: 'final' }, failed: {},
      },
    }`,
  };
  for (const [marker, text] of Object.entries(replacements)) scaffold = scaffold.replaceAll(marker, text);
  return scaffold;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('initializes an original two-actor workflow with exact constants, then preserves strict actor typing and real execution after authoring', async () => {
  const { directory, input, output } = workspace();
  const initialized = initialize(input, output);
  expect(initialized.status, initialized.stderr).toBe(0);
  const raw = readFileSync(output, 'utf8');
  expect(strict(directory, output).status).not.toBe(0);
  expect(raw).toContain('__AUTHOR_CONTEXT__');
  expect(raw.startsWith('// SPDX-License-Identifier: Apache-2.0\n// SPDX-FileCopyrightText: 2026 Example\n')).toBe(true);
  expect(raw).not.toContain('captain: fromPromise');
  expect(raw).not.toContain('script: fromPromise');
  expect(raw.match(/from ['"][^'"]+['"]/g)).toEqual(["from 'xstate'", "from '@sublang/playbook/xstate-runtime'", "from '@sublang/playbook/runtime'"]);
  const authored = complete(raw);
  writeFileSync(output, authored);
  const checked = strict(directory, output, true);
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  const probe = `
    import assert from 'node:assert/strict';
    import { createActor, fromPromise, waitFor } from 'xstate';
    import { machine, GEARS_ITEMS } from './sample.fsm.js';
    const inputs = [];
    const actor = createActor(machine.provide({ actors: {
      player: fromPromise(async ({ input }) => { inputs.push(input); return { guard: 'done', answer: 'Exact answer.' }; }),
      playbook: fromPromise(async ({ input }) => { inputs.push(input); return { reviewed: true }; }),
    } }), { input: { task: 'Exact task.' } }).start();
    await waitFor(actor, value => value.status === 'done');
    assert.equal(inputs[0].task, 'Exact task.');
    assert.equal(inputs[0].prompt, GEARS_ITEMS['CASE-1'].prompt);
    assert.equal(inputs[1].text, 'Inspect the authored answer.\\nExact answer.');
    assert.deepEqual(actor.getSnapshot().output, { answer: 'Exact answer.' });
    assert.equal(Object.hasOwn(GEARS_ITEMS['CASE-1'].result, '__proto__'), true);
    assert.deepEqual(Object.keys(GEARS_ITEMS['CASE-1'].result), ['done', '__proto__']);
    actor.stop();
    console.log(JSON.stringify(GEARS_ITEMS));
  `;
  const executed = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: directory, encoding: 'utf8' });
  const items = JSON.parse(executed);
  expect(items['CASE-1'].prompt).toBe(prompt);
  expect(items['CASE-2']).not.toHaveProperty('result');
  if (compiler) {
    const { parseGearsItems, checkGearsResultContract } = await import(pathToFileURL(join(compiler, 'dist/verify.js')).href);
    expect(checkGearsResultContract(source)).toEqual([]);
    for (const item of parseGearsItems(source)) {
      expect(items[item.id].prompt).toBe(item.prompt);
      expect(items[item.id].result).toEqual(item.result);
    }
  }
  const noBootstrap = authored
    .replace('export type MachineInput = { task: string };', 'export type MachineInput = undefined;')
    .replace('export type MachineOutput = { answer: string };', 'export type MachineOutput = void;')
    .replace("context: ({ input }) => ({ task: input.task, answer: '' })", "context: () => ({ task: '', answer: '' })")
    .replace('output: ({ context }) => ({ answer: context.answer })', 'output: () => {}');
  writeFileSync(output, noBootstrap);
  const optional = strict(directory, output);
  expect(optional.status, optional.stdout + optional.stderr).toBe(0);
  writeFileSync(output, authored.replace('task: context.task,', 'task: 123,'));
  const invalid = strict(directory, output);
  expect(invalid.status).not.toBe(0);
  expect(invalid.stdout).toMatch(/number.*string/s);
  expect(readFileSync(input, 'utf8')).toBe(source);
  expect(initialized.stdout).not.toContain('Exact');
  expect(initialized.stdout).not.toContain(prompt);
}, 30_000);

it.each([
  ['default acting result', '### A-1\nCaptain shall inspect:\n> Inspect now.\n', 'captain'],
  ['static child', '### A-1\nCaptain shall call playbook child:\n> Inspect now.\nAfter the child returns, continue.\n', 'playbook'],
])('supports %s without inventing Results or unused actors', (_name, text, actor) => {
  const { input, output } = workspace(text);
  const result = initialize(input, output);
  expect(result.status, result.stderr).toBe(0);
  const target = readFileSync(output, 'utf8');
  expect(target).toContain('result: undefined');
  expect(target).toContain(`${actor}: fromPromise`);
  expect((target.match(/: fromPromise</g) ?? []).length).toBe(1);
  expect(target).not.toContain("guard: 'done'");
  expect(readFileSync(input, 'utf8')).toBe(text);
});

it.each([
  ['CRLF', source.replaceAll('\n', '\r\n')],
  ['top-level fence', '```markdown\n' + source + '\n```'],
  ['duplicate id', source + '\n### CASE-1\n'],
  ['malformed heading', source.replace('### CASE-1', '### CASE-1 title')],
  ['fenced body', source.replace('When a task arrives', '```ts\n```\nWhen a task arrives')],
  ['script', '### A-1\nCaptain shall run:\n> pwd\nResults:\n- `ok`: Zero.\n- `failed`: Nonzero.\n'],
  ['dynamic child', '### A-1\nCaptain shall call playbook selected by `id`:\n> <text>\n'],
  ['parallel', source.replace('### CASE-1', '### CASE-1\nParallel group: workers')],
  ['split quote', source.replace('> Final line.', '\nprose\n> Final line.')],
  ['duplicate result', source.replace('- `__proto__`:', '- `done`:')],
  ['misplaced result', source.replace('Results:', 'Extra invariant.\nResults:')],
  ['result trailing prose', source.replace('### CASE-2', 'Extra invariant.\n### CASE-2')],
  ['empty results', '### A-1\nCaptain shall inspect:\n> Inspect.\nResults:\n'],
  ['nested results', '### A-1\nCaptain shall call playbook child:\n> Inspect.\nResults:\n- `done`: Done.\n'],
  ['unknown delegate spelling', '### A-1\nCaptain shall prompt worker:\n> Inspect.\n'],
])('refuses %s without changing existing target or Source', (_name, text) => {
  const { input, output } = workspace(text);
  writeFileSync(output, 'existing target');
  const result = initialize(input, output);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain(prompt);
  expect(readFileSync(input, 'utf8')).toBe(text);
  expect(readFileSync(output, 'utf8')).toBe('existing target');
});

it('refuses an existing target, including a source hardlink, and exposes only the optional package surface', () => {
  const { directory, input, output } = workspace();
  // A source alias is already an existing target, so exclusive publication refuses it.
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { linkSync } from 'node:fs'; linkSync(${JSON.stringify(input)}, ${JSON.stringify(output)});`]);
  const result = initialize(input, output);
  expect(result.status).not.toBe(0);
  expect(readFileSync(input, 'utf8')).toBe(source);
  expect(readFileSync(output, 'utf8')).toBe(source);
  const help = execFileSync(process.execPath, [helper, '--help'], { cwd: directory, encoding: 'utf8' });
  expect(help).toContain('incomplete');
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json', '--cache', join(directory, 'npm-cache')], { cwd: root, encoding: 'utf8' }));
  const paths = packed[0].files.map((file: { path: string }) => file.path);
  expect(paths).toContain('slc/scaffold-fsm.mjs');
  expect(paths).toContain('slc/experiments/fsm-scaffold-guidance.md');
  expect(readFileSync(resolve(root, 'slc/gears2fsm.md'), 'utf8')).not.toContain('scaffold-fsm.mjs');
}, 15_000);

it('refuses a target graph without the required typed XState API', () => {
  const { directory, input, output } = workspace();
  rmSync(join(directory, 'node_modules/xstate'));
  mkdirSync(join(directory, 'node_modules/xstate'), { recursive: true });
  writeFileSync(join(directory, 'node_modules/xstate/package.json'), '{"main":"index.cjs"}');
  writeFileSync(join(directory, 'node_modules/xstate/index.cjs'), 'exports.setup = () => ({ createMachine() {} });');
  const result = initialize(input, output);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('target dependencies must supply XState setup.extend and createStateConfig');
  expect(readFileSync(input, 'utf8')).toBe(source);
});

it.runIf(compiler !== undefined)('keeps optional guidance out of ordinary SLC phase discovery', async () => {
  const { discoverPhaseFiles } = await import(pathToFileURL(join(compiler!, 'dist/pipeline.js')).href);
  const discovered = await discoverPhaseFiles(join(root, 'slc'));
  expect([...discovered.phaseFiles, discovered.linkFile].map((file: string) => file.split('/').at(-1)).sort()).toEqual(['gears2fsm.md', 'link.md', 'optimize.md', 'text2gears.md']);
});
