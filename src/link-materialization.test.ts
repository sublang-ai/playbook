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

  it('preserves Boss-reply resumption independently of interrupt targets', () => {
    const source = fixture().replace("    failed: {", "    awaitBossReply: { id: 'awaitBossReply', tags: ['playbook.parked'], meta: meta('awaitBossReply'), on: { BOSS_REPLY: { target: '#work' } } },\n    failed: {");
    expect(source).not.toContain('BOSS_INTERRUPT');
    writeFileSync(fsm, source);
    const result = emit();
    expect(result.status, result.stderr).toBe(0);
    execute(`
      import assert from 'node:assert/strict';
      import { _internal } from ${JSON.stringify(pathToFileURL(out).href)};
      import { fixtureMachine } from ${JSON.stringify(pathToFileURL(fsm).href)};
      import { resumableStateIdsFromMachine } from '@sublang/playbook/xstate-runtime';
      assert.deepEqual([...resumableStateIdsFromMachine(fixtureMachine)], ['work']);
      assert.deepEqual([..._internal.RESUMABLE_STATE_IDS], ['work']);
    `);
    const accepted = readFileSync(out, 'utf8');
    const incomplete = descriptor();
    incomplete.resumableStateIds = [];
    const refused = emit(incomplete);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('must be registered in resumableStateIds');
    expect(readFileSync(out, 'utf8')).toBe(accepted);
  });

  it.each(['flat-defaults', 'flat-quoted-relays'])('emits, loads, and type-checks %s with exact metadata and strict options', (profile) => {
    const source = readFileSync(fsm, 'utf8');
    const result = emit({ ...descriptor(), profile });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('ok');
    const generated = readFileSync(out, 'utf8');
    expect(generated).toContain('Exact authored work description.');
    expect(generated).toContain('snapshotOptions: validateOptions,');
    expect(generated).not.toContain('from "./materialize-link');
    expect(readFileSync(fsm, 'utf8')).toBe(source);
    const observation = execute(`
      import assert from 'node:assert/strict';
      import createRuntime, { _internal, validateOptions } from ${JSON.stringify(pathToFileURL(out).href)};
      import { emptyPlaybookEffectLedger } from '@sublang/playbook/xstate-runtime';
      assert.throws(() => validateOptions(undefined), /enabled.*required/);
      for (const value of [null, [], true, 'x', {enabled: true, stray: 1}, {enabled: true, limit: Infinity}, {enabled: true, cwd: () => {}}]) assert.throws(() => validateOptions(value));
      const original = {enabled: true, limit: 0};
      const validated = validateOptions(original);
      assert.deepEqual(validated, original);
      assert.notEqual(validated, original);
      assert(Object.isFrozen(validated));
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

  it('renders quoted relays literally and preserves the installed continuation contract', () => {
    const mappings = { 'task-text': 'payload', 'empty-block': 'emptyValue', 'second-field': 'nextValue' };
    const result = emit({ ...descriptor(), profile: 'flat-quoted-relays', placeholderFields: mappings });
    expect(result.status, result.stderr).toBe(0);
    const dollar = '$& $$ $' + String.fromCharCode(96) + " $'";
    const cases = [
      { prompt: 'Lead <run-id>.\n> <task-text>\nBetween\n> <empty-block>\n> <second-field>\nIR <#>; <missing>.', fields: { runId: 'R', payload: `first\n\nsecond <run-id> ${dollar}`, emptyValue: '', nextValue: '$&\nlast', irNumber: '042', missing: 7 }, expected: `Lead R.\n> first\n\n> second <run-id> ${dollar}\nBetween\n> $&\n> last\nIR 042; <missing>.` },
      ...[['> <empty-block>\nNext', 'Next'], ['Before\n> <empty-block>\nNext', 'Before\nNext'], ['Before\n> <empty-block>', 'Before\n'], ['> <empty-block>', '']].map(([prompt, expected]) => ({ prompt, fields: { emptyValue: '' }, expected })),
      { prompt: 'Header\r\n> <task-text>\r\nEnd', fields: { payload: 'one\r\n\r\ntwo\r\n' }, expected: 'Header\r\n> one\r\n\r\n> two\r\n\r\nEnd' },
      { prompt: '> <unknown>\n> <task-text>\nEnd', fields: { payload: 7 }, expected: '> <unknown>\n> <task-text>\nEnd' },
    ];
    execute(`
      import assert from 'node:assert/strict';
      import { _internal } from ${JSON.stringify(pathToFileURL(out).href)};
      import * as engine from '@sublang/playbook/xstate-runtime';
      const input = (prompt, fields = {}) => ({ stateId: 'work', sourceItem: 'FIXTURE-2', role: 'coder', prompt, result: { done: 'Done.' }, ...fields });
      for (const { prompt, fields, expected } of ${JSON.stringify(cases)}) {
        const value = input(prompt, fields);
        const before = structuredClone(value);
        assert.equal(_internal.composePlayerPrompt(value, () => { throw new Error('invented identity lookup'); }), expected);
        assert.deepEqual(value, before);
      }
      const value = input('> <task-text>', {
        payload: 'one\\ntwo <task-text> $&',
        pendingBossQuestion: { questionId: 'work', resumeStateId: 'work', sourceItem: 'FIXTURE-2', asker: { kind: 'role', roleId: 'coder' }, question: 'Use <task-text>?' },
        bossReply: 'Keep <task-text> and $&.',
      });
      const mapping = ${JSON.stringify(mappings)};
      const before = structuredClone(value);
      for (const resuming of [false, true]) {
        const prefix = engine.defaultComposePlayerPrompt({ ...value, prompt: '' }, mapping, resuming);
        assert(prefix.endsWith('\\n\\n'));
        assert.equal(_internal.composePlayerPrompt(value, undefined, resuming), prefix + '> one\\n> two <task-text> $&');
        assert.deepEqual(value, before);
      }
      if (typeof engine.composePlayerContinuation === 'function') {
        assert(_internal.composePlayerPrompt(value, undefined, false).includes('Your previous question:'));
        assert(!_internal.composePlayerPrompt(value, undefined, true).includes('Your previous question:'));
      }
    `);
  });

  it('preserves the frozen v2 default profile except the explicit public-validator delta', () => {
    const result = emit();
    expect(result.status, result.stderr).toBe(0);
    execute(`
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import * as engine from '@sublang/playbook/xstate-runtime';
      import { fixtureMachine as machine } from ${JSON.stringify(pathToFileURL(fsm).href)};
      import { materializeLink } from ${JSON.stringify(pathToFileURL(join(packageRoot, 'scripts/experiments/materialize-link-v2.mjs')).href)};
      const expected = materializeLink({ machine, descriptor: ${JSON.stringify(descriptor())}, fsmSpecifier: './fixture.fsm.js', engine });
      assert.equal(readFileSync(${JSON.stringify(out)}, 'utf8'), expected
        .replace('function snapshotOptions(value: unknown)', 'export function validateOptions(value: unknown)')
        .replace('snapshotJsonValue(value,', 'snapshotJsonValue(value === undefined ? {} : value,')
        .replace('  snapshotOptions,', '  snapshotOptions: validateOptions,'));
    `);
  });

  it('validates an absent optional-only slice without runtime construction (compiler-entry-options-4)', () => {
    const value = descriptor();
    value.options.enabled.required = false;
    expect(emit(value).status).toBe(0);
    execute(`
      import assert from 'node:assert/strict';
      import { validateOptions } from ${JSON.stringify(pathToFileURL(out).href)};
      assert.deepEqual(validateOptions(undefined), {});
      assert(Object.isFrozen(validateOptions(undefined)));
      assert.throws(() => validateOptions(null));
    `);
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
