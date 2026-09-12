// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ts from 'typescript';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const engineRoot = process.env.PLAYBOOK_MATERIALIZATION_ENGINE ?? packageRoot;
const cli = join(packageRoot, 'slc/materialize-link.mjs');

function fixture(player = true, actor = 'player'): string {
  return `import { assign, fromPromise, setup } from 'xstate';
const meta = (stateId, extra = {}) => ({ playbook: { stateId, description: stateId === 'work' ? 'Exact authored work description.' : stateId, ...extra } });
export const fixtureMachine = setup({ actors: { script: fromPromise(async () => ({})), ${actor}: fromPromise(async () => ({})) } }).createMachine({
  id: 'fixture', initial: 'ready', context: ({ input }) => ({ ...input, bossIntent: '' }),
  states: {
    ready: { id: 'ready', tags: ['playbook.parked'], meta: meta('ready'), on: { BOSS_TASK: { target: 'setup', actions: assign({ bossIntent: ({ event }) => event.bossIntent }) } } },
    setup: { id: 'setup', tags: ['playbook.busy'], meta: meta('setup'), invoke: {
      src: 'script', input: () => ({ stateId: 'setup', sourceItem: 'FIXTURE-1', command: 'printf materialized > materialized.txt', result: { ok: 'Exit status zero.', failed: 'Exit status nonzero.' } }),
      onDone: [{ guard: ({ event }) => event.output.guard === 'ok', target: '${player ? 'work' : 'done'}' }, { target: 'failed' }], onError: 'failed'
    } },
    ${player ? `work: { id: 'work', tags: ['playbook.busy'], meta: meta('work', { role: 'coder' }), invoke: {
      src: '${actor}', input: ({ context }) => ({ stateId: 'work', sourceItem: 'FIXTURE-2', role: 'coder', prompt: 'Perform <boss-intent>.', bossIntent: context.bossIntent, result: { done: 'Done.', needsBossReply: 'Output shall include question.' } }), onDone: 'done', onError: 'failed'
    } },` : ''}
    failed: { id: 'failed', tags: ['playbook.parked'], meta: meta('failed') },
    done: { id: 'done', type: 'final', meta: meta('done', { terminal: 'success' }) }
  }
});\n`;
}

function descriptor(player = true): Record<string, any> {
  return {
    schema: 'sublang.playbook.link.v1', profile: 'flat-defaults', machineExport: 'fixtureMachine', label: 'FIXTURE',
    options: { enabled: { type: 'boolean', required: true }, limit: { type: 'number', required: false } },
    inputMapping: { enabled: 'enabled', limit: 'limit' },
    entryEvent: { type: 'BOSS_TASK', textField: 'bossIntent', contextField: 'bossIntent' },
    bossEvents: [], outcomeAuthority: { governedPlayerStates: player ? {
      work: { done: { fields: {}, repositoryDisposition: 'one-descendant-commit' }, needsBossReply: { fields: { question: 'presentation' }, repositoryDisposition: 'deferred' } },
    } : {} },
    placeholderFields: {}, transitionEventFields: ['bossIntent', 'answer', 'questionId'],
    verbatimPayloadFields: [], resumableStateIds: player ? ['work'] : [], unfinishedFinalStateIds: [], controlContextFields: [],
  };
}

describe('optional link materialization integration', () => {
  let root: string;
  let fsm: string;
  let out: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'playbook-materialization-'));
    mkdirSync(join(root, 'node_modules/@sublang'), { recursive: true });
    symlinkSync(engineRoot, join(root, 'node_modules/@sublang/playbook'), 'dir');
    const engineRequire = createRequire(join(engineRoot, 'package.json'));
    symlinkSync(dirname(engineRequire.resolve('xstate/package.json')), join(root, 'node_modules/xstate'), 'dir');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    fsm = join(root, 'fixture.fsm.js');
    out = join(root, 'fixture.playbook.ts');
    writeFileSync(fsm, fixture());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function emit(value = descriptor()) {
    return spawnSync(process.execPath, [cli, '--fsm', fsm, '--out', out], { cwd: root, input: JSON.stringify(value), encoding: 'utf8' });
  }
  function execute(code: string) {
    // Execute the normal compiled-JavaScript host profile too, including on
    // Node 20 where the CLI supports .fsm.js but native .ts loading does not.
    const compiled = join(root, 'fixture.playbook.compiled.js');
    writeFileSync(compiled, ts.transpileModule(readFileSync(out, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code.replaceAll(pathToFileURL(out).href, pathToFileURL(compiled).href)], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    return result.stdout;
  }

  it('emits, loads, and type-checks a real factory with exact metadata and strict options', () => {
    const source = readFileSync(fsm, 'utf8');
    const result = emit();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('ok');
    const generated = readFileSync(out, 'utf8');
    expect(generated).toContain('Exact authored work description.');
    expect(generated).not.toContain('from "./materialize-link');
    expect(readFileSync(fsm, 'utf8')).toBe(source);
    const observation = execute(`
      import assert from 'node:assert/strict';
      import createRuntime, { _internal } from ${JSON.stringify(pathToFileURL(out).href)};
      import { emptyPlaybookEffectLedger } from '@sublang/playbook/xstate-runtime';
      const forbid = () => { throw new Error('unexpected host effect'); };
      const capabilities = { authority: {}, repository: { runExclusive: forbid, runDeferred: forbid }, effectLedger: { snapshot: emptyPlaybookEffectLedger, writeAhead: forbid } };
      const construct = configuredOptions => createRuntime({ configuredOptions, hostCapabilities: capabilities });
      assert.throws(() => construct({}), /enabled.*required/);
      assert.throws(() => construct({ enabled: 'yes' }), /enabled.*boolean/);
      assert.throws(() => construct({ enabled: true, stray: 1 }), /stray.*declared/);
      assert.throws(() => construct({ enabled: true, limit: Infinity }), /finite|JSON|number/);
      assert.throws(() => construct({ enabled: true, cwd: 2 }), /cwd.*string/);
      assert.throws(() => construct({ enabled: true, get limit() { throw new Error('getter ran'); } }), /accessor|data propert/);
      const options = { enabled: true, limit: 4, cwd: ${JSON.stringify(root)} };
      const runtime = construct(options);
      options.enabled = false;
      options.limit = 99;
      await runtime.init({ sessionId: 'fixture-session', playbookId: 'fixture', rootSessionId: 'fixture-session', depth: 0,
        roleBindings: { coder: { playerId: 'fixture.coder', promptIdentity: 'Fixture Coder' } },
        ports: { callPlayer: forbid, callCaptain: forbid, callJudge: forbid, callPlaybook: forbid, emitStatus: async () => {}, emitTelemetry: async () => {} } });
      const saved = runtime.exportSnapshot();
      assert.equal(saved.machine.context.enabled, true);
      assert.equal(saved.machine.context.limit, 4);
      assert.equal(Object.hasOwn(saved.machine.context, 'cwd'), false);
      await runtime.dispose();
      assert.equal(_internal.composePlayerPrompt({ prompt: 'Perform <boss-intent>.', bossIntent: 'one\\ntwo <other>', result: {} }), 'Perform one\\ntwo <other>.');
      assert.deepEqual([..._internal.RESUMABLE_STATE_IDS], ['work']);
      assert.equal(Object.hasOwn(_internal, 'composeCaptainPrompt'), false);
      console.log(JSON.stringify(createRuntime.compat));
    `);
    expect(JSON.parse(observation)).toEqual({ artifactSchema: 3, runtimeAbi: 1 });
    writeFileSync(join(root, 'consumer.ts'), `import createRuntime, { type PlaybookRuntimeOptions, type PlaybookHostCapabilities } from './fixture.playbook.ts';
const options: PlaybookRuntimeOptions = { enabled: true, limit: 2, cwd: '.' };
declare const hostCapabilities: PlaybookHostCapabilities;
createRuntime({ configuredOptions: options, hostCapabilities });
// @ts-expect-error required option is typed
const missing: PlaybookRuntimeOptions = {};
// @ts-expect-error authority is required in the construction type
createRuntime({ configuredOptions: options, hostCapabilities: { repository: hostCapabilities.repository, effectLedger: hostCapabilities.effectLedger } });
void missing;
`);
    const checked = spawnSync(process.execPath, [join(packageRoot, 'node_modules/typescript/lib/tsc.js'), '--noEmit', '--allowImportingTsExtensions', '--allowJs', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--strict', '--skipLibCheck', '--typeRoots', join(packageRoot, 'node_modules/@types'), join(root, 'consumer.ts')], { cwd: root, encoding: 'utf8' });
    expect(checked.status, checked.stderr + checked.stdout).toBe(0);
  });

  it('runs an emitted script-only workflow through the real shared engine', () => {
    writeFileSync(fsm, fixture(false));
    const result = emit(descriptor(false));
    expect(result.status, result.stderr).toBe(0);
    execute(`
      import assert from 'node:assert/strict';
      import createRuntime, { _internal } from ${JSON.stringify(pathToFileURL(out).href)};
      import { emptyPlaybookEffectLedger } from '@sublang/playbook/xstate-runtime';
      const forbid = () => { throw new Error('unexpected host boundary'); };
      const events = [];
      const runtime = createRuntime({ configuredOptions: { enabled: true, cwd: ${JSON.stringify(root)} }, hostCapabilities: { authority: {}, repository: {}, effectLedger: { snapshot: emptyPlaybookEffectLedger, writeAhead: forbid } } });
      await runtime.init({ sessionId: 'fixture-session', playbookId: 'fixture', rootSessionId: 'fixture-session', depth: 0,
        ports: { callPlayer: forbid, callCaptain: forbid, callJudge: forbid, callPlaybook: forbid, emitStatus: () => {}, emitTelemetry: ({ topic }) => events.push(topic) } });
      const result = await runtime.handleBossInput({ text: 'run script', signal: new AbortController().signal });
      assert.equal(result.outcome, 'terminal');
      assert.equal(result.terminal.kind, 'success');
      assert(events.includes('playbook.script'));
      assert.equal(Object.hasOwn(_internal, 'composePlayerPrompt'), false);
      await runtime.dispose();
    `);
    expect(readFileSync(join(root, 'materialized.txt'), 'utf8')).toBe('materialized');
  });

  it('loads native TypeScript FSMs without evaluating invocation input', () => {
    fsm = join(root, 'native.fsm.ts');
    writeFileSync(fsm, fixture().replace("input: ({ context }) => ({ stateId: 'work'", "input: ({ context }) => { throw new Error('invocation input was evaluated'); return ({ stateId: 'work'")
      .replace("needsBossReply: 'Output shall include question.' } }), onDone", "needsBossReply: 'Output shall include question.' } }); }, onDone") + '\nexport const typed: number = 1;\n');
    const result = emit();
    if (!(process.features as { typescript?: unknown }).typescript) {
      expect(result.status, result.stderr).toBe(2);
      expect(JSON.parse(result.stderr).message).toContain('native type stripping');
      return;
    }
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('./native.fsm.ts');
  });

  it('preserves the target when native TypeScript loading is disabled', () => {
    fsm = join(root, 'native.fsm.ts');
    writeFileSync(fsm, fixture());
    writeFileSync(out, 'existing target\n');
    const flags = (process.features as { typescript?: unknown }).typescript ? ['--no-experimental-strip-types'] : [];
    const result = spawnSync(process.execPath, [...flags, cli, '--fsm', fsm, '--out', out], { cwd: root, input: JSON.stringify(descriptor()), encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stderr).message).toContain('native type stripping');
    expect(readFileSync(out, 'utf8')).toBe('existing target\n');
  });

  it.each(['profile', 'parallel', 'compound', 'captain', 'playbook', 'option'])('refuses unsupported %s and preserves the target', (mode) => {
    const value = descriptor();
    if (mode === 'profile') value.profile = 'custom-strategies';
    if (mode === 'parallel') writeFileSync(fsm, fixture().replace("id: 'fixture', initial:", "id: 'fixture', type: 'parallel', initial:"));
    if (mode === 'compound') writeFileSync(fsm, fixture().replace("failed: { id: 'failed',", "failed: { id: 'failed', initial: 'child', states: { child: {} },"));
    if (mode === 'captain' || mode === 'playbook') writeFileSync(fsm, fixture(true, mode));
    if (mode === 'option') value.options.enabled.type = 'object';
    writeFileSync(out, 'existing target\n');
    const result = emit(value);
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stderr).status).toBe('unsupported');
    expect(readFileSync(out, 'utf8')).toBe('existing target\n');
    expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it.each(['unknown', 'authority', 'final', 'options'])('refuses invalid %s before replacing a target', (mode) => {
    const value = descriptor();
    if (mode === 'unknown') value.hiddenStrategy = {};
    if (mode === 'authority') value.outcomeAuthority.governedPlayerStates = {};
    if (mode === 'final') value.unfinishedFinalStateIds = ['ready'];
    if (mode === 'options') value.options.enabled.required = 'true';
    writeFileSync(out, 'existing target\n');
    const result = emit(value);
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stderr).status).toBe('error');
    expect(readFileSync(out, 'utf8')).toBe('existing target\n');
    expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('cleans staging files when an output directory cannot be replaced', () => {
    mkdirSync(out);
    writeFileSync(join(out, 'preserved'), 'yes');
    const result = emit();
    expect(result.status, result.stderr).toBe(1);
    expect(readFileSync(join(out, 'preserved'), 'utf8')).toBe('yes');
    expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
