// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import ts from 'typescript';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'playbook-labelled-materialization-'));
const engineRequire = createRequire(join(packageRoot, 'package.json'));
mkdirSync(join(root, 'node_modules/@sublang'), { recursive: true });
symlinkSync(packageRoot, join(root, 'node_modules/@sublang/playbook'), 'dir');
for (const name of ['xstate', 'vitest']) symlinkSync(dirname(engineRequire.resolve(`${name}/package.json`)), join(root, 'node_modules', name), 'dir');
writeFileSync(join(root, 'package.json'), '{"type":"module"}');
writeFileSync(join(root, 'vitest.config.mjs'), 'export default { test: { include: ["*.acceptance.test.ts"] } };\n');
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Read only literal metadata from maintained modules. These are local integration
// fixtures; this extractor is neither shipped nor exposed to compiling agents.
function literal(node: ts.Node): any {
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) throw new Error('fixture metadata is not a literal property');
    const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
    if (key === undefined) throw new Error('fixture metadata has a computed key');
    return [key, literal(property.initializer)];
  }));
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isStringLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  throw new Error('fixture metadata is not JSON literal');
}
function fixture(name: 'code' | 'dev') {
  const originalDir = join(packageRoot, `reference/sdlc/${name}.playbook`);
  const module = ts.createSourceFile('fixture.ts', readFileSync(join(originalDir, `${name}.playbook.ts`), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = module.statements.flatMap((s) => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : []).find((d) => d.name.getText(module) === 'runtimeSpec')!;
  const spec = (declaration.initializer as ts.SatisfiesExpression).expression as ts.ObjectLiteralExpression;
  const member = (key: string) => literal((spec.properties.find((p) => p.name?.getText(module) === key) as ts.PropertyAssignment).initializer);
  // Execute the compiled input on every supported Node version; its unchanged
  // TypeScript sibling supplies the erased player-input type to strict checks.
  const typedSource = readFileSync(join(originalDir, `${name}.fsm.ts`), 'utf8');
  writeFileSync(join(root, `${name}.fsm.ts`), typedSource);
  const fsm = join(root, `${name}.fsm.js`);
  const source = ts.transpileModule(typedSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(fsm, source);
  const output = join(root, `${name}.playbook.ts`);
  const descriptor: Record<string, any> = {
    schema: 'sublang.playbook.link.v1', profile: 'flat-labelled-relays',
    machineExport: name === 'code' ? 'codingMachine' : 'devMachine', label: name.toUpperCase(),
    options: { runResults: { type: 'string', required: false } }, inputMapping: { runResults: 'runResults' },
    entryEvent: member('entryEvent'), bossEvents: [], outcomeAuthority: member('outcomeAuthority'),
    placeholderFields: {}, transitionEventFields: member('transitionEventFields'),
    verbatimPayloadFields: [name === 'code' ? 'coderOutput' : 'planningResult'],
    resumableStateIds: name === 'code' ? ['runFirstPhase', 'runIrTask'] : ['planAnalysis'],
    unfinishedFinalStateIds: [name === 'code' ? 'reportedReviewFailure' : 'reportedChildFailure'],
    controlContextFields: member('controlContextFields'), playerInputExport: 'PlayerInput',
    omitEmptyRelayLines: ['> Run results: <run-results>', ...(name === 'dev' ? ['> Prior discussion: <discussion-context>'] : [])],
    identityPlaceholders: name === 'code' ? { 'coder-llm': 'coder' } : {},
  };
  const emit = (value = descriptor) => spawnSync(process.execPath, [join(packageRoot, 'slc/materialize-link.mjs'), '--fsm', fsm, '--out', output], { cwd: root, input: JSON.stringify(value), encoding: 'utf8' });
  return { originalDir, fsm, source, output, descriptor, emit };
}
const code = fixture('code');
const dev = fixture('dev');

it.each([['code', code], ['dev', dev]] as const)('emits and strictly checks the unchanged maintained %s machine', (_name, value) => {
  const emitted = value.emit();
  expect(emitted.status, emitted.stderr).toBe(0);
  expect(readFileSync(value.fsm, 'utf8')).toBe(value.source);
  const checked = spawnSync(process.execPath, [engineRequire.resolve('typescript/lib/tsc.js'), '--noEmit', '--allowImportingTsExtensions', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--strict', '--skipLibCheck', '--typeRoots', join(packageRoot, 'node_modules/@types'), value.output], { cwd: root, encoding: 'utf8' });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
});

it('renders labelled strings and identities literally through the actual emitted canonical seam', () => {
  const result = code.emit();
  expect(result.status, result.stderr).toBe(0);
  const compiled = join(root, 'code.playbook.js');
  writeFileSync(compiled, ts.transpileModule(readFileSync(code.output, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { _internal } from ${JSON.stringify(pathToFileURL(compiled).href)};
    const value = { stateId: 'runFirstPhase', sourceItem: 'CODE-1', role: 'coder', result: {},
      prompt: '> Original request: <caller-input>\\r\\n> Run results: <run-results>\\r\\n> Other: <empty>\\r\\nCoder is <coder-llm>; missing <missing>.',
      callerInput: 'one\\r\\n\\r\\ntwo <coder-llm> $&', runResults: '', empty: '',
      pendingBossQuestion: { questionId: 'q', resumeStateId: 'runFirstPhase', sourceItem: 'CODE-1', asker: { kind: 'role', roleId: 'coder' }, question: 'Original question?' }, bossReply: 'Exact reply $&',
    };
    const original = structuredClone(value), identities = [];
    const identity = role => { identities.push(role); return 'Actual bound model'; };
    const body = '> Original request: one\\r\\n> \\r\\n> two <coder-llm> $&\\r\\n> Other: \\r\\nCoder is Actual bound model; missing <missing>.';
    for (const resumed of [undefined, false, true]) {
      const actual = _internal.composePlayerPrompt(value, identity, resumed);
      assert(actual.endsWith(body));
      assert.equal(actual.includes('Your previous question:'), resumed !== true);
      assert(actual.includes('Boss reply:\\nExact reply $&'));
      assert.deepEqual(value, original);
    }
    assert.deepEqual(identities, ['coder', 'coder', 'coder']);
    assert.equal(_internal.composePlayerPrompt({ stateId: 'runFirstPhase', sourceItem: 'CODE-1', role: 'coder', result: {}, prompt: 'Value: <toString>', toString: 'literal value' }, identity), 'Value: literal value');
    const missing = { ...value, runResults: undefined };
    assert(_internal.composePlayerPrompt(missing, identity).includes('> Run results: <run-results>'));
  `], { cwd: root, encoding: 'utf8' });
  expect(probe.status, probe.stderr + probe.stdout).toBe(0);
});

it('refuses unsupported strategies and metadata without replacing an accepted target', () => {
  const accepted = code.emit();
  expect(accepted.status, accepted.stderr).toBe(0);
  const bytes = readFileSync(code.output, 'utf8');
  const cases = [
    { ...code.descriptor, identityPlaceholders: { 'coder-llm': 'invented' } },
    { ...code.descriptor, placeholderFields: { 'coder-llm': 'model' } },
    { ...code.descriptor, omitEmptyRelayLines: ['> Model: <coder-llm>'] },
    { ...code.descriptor, omitEmptyRelayLines: ['> Context: <caller-input> and <run-results>'] },
    { ...code.descriptor, omitEmptyRelayLines: ['> Run results: <run-results>', '> Run results: <run-results>'] },
    { ...code.descriptor, profile: 'flat-quoted-relays' },
  ];
  for (const descriptor of cases) {
    const result = code.emit(descriptor);
    expect(result.status).not.toBe(0);
    expect(readFileSync(code.output, 'utf8')).toBe(bytes);
    expect(readFileSync(code.fsm, 'utf8')).toBe(code.source);
  }
  const legacy: Record<string, any> = { ...code.descriptor, profile: 'flat-defaults' };
  for (const key of ['identityPlaceholders', 'omitEmptyRelayLines', 'playerInputExport']) delete legacy[key];
  expect(code.emit(legacy).status).toBe(2); // Nested actors remain outside legacy profiles.
  const badType = code.emit({ ...code.descriptor, playerInputExport: 'DoesNotExist' });
  expect(badType.status, badType.stderr).toBe(0); // Erased exports require the independent type check.
  const checked = spawnSync(process.execPath, [engineRequire.resolve('typescript/lib/tsc.js'), '--noEmit', '--allowImportingTsExtensions', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--strict', '--skipLibCheck', '--typeRoots', join(packageRoot, 'node_modules/@types'), code.output], { cwd: root, encoding: 'utf8' });
  expect(checked.status).not.toBe(0);
  expect(checked.stdout).toContain('DoesNotExist');
});

it('passes maintained CODE/DEV real-Git and nested-boundary suites with only their factory wiring replaced', () => {
  for (const [name, value] of [['code', code], ['dev', dev]] as const) {
    const emitted = value.emit();
    expect(emitted.status, emitted.stderr).toBe(0);
    // Keep each maintained registry connected to the emitted factory too; its
    // compatibility object must be that factory's exact object, not an equal
    // object from the original linked module. All assertions remain unchanged.
    const registry = readFileSync(join(value.originalDir, `${name}.registry.ts`), 'utf8')
      .replace(`'./${name}.playbook.js'`, JSON.stringify(value.output))
      .replace(`type ${name === 'code' ? 'Code' : 'Dev'}PlaybookHostCapabilities`, `type PlaybookHostCapabilities as ${name === 'code' ? 'Code' : 'Dev'}PlaybookHostCapabilities`);
    writeFileSync(join(root, `${name}.registry.ts`), registry);
    for (const suite of ['playbook', 'prompt-contract']) {
      const testPath = join(value.originalDir, `${name}.${suite}.test.ts`);
      const text = readFileSync(testPath, 'utf8').replace(/from (['"])(\.[^'"]+)\1/g, (_match, _quote, specifier: string) => {
        let target = specifier === `./${name}.playbook.js` ? value.output
          : specifier === `./${name}.registry.js` ? join(root, `${name}.registry.ts`)
            : resolve(value.originalDir, specifier);
        if (target.endsWith('.js') && existsSync(target.slice(0, -3) + '.ts')) target = target.slice(0, -3) + '.ts';
        return `from ${JSON.stringify(target)}`;
      });
      writeFileSync(join(root, `${name}.${suite}.acceptance.test.ts`), text);
    }
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')));
  const checked = spawnSync(process.execPath, [join(packageRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--root', root, '--config', join(root, 'vitest.config.mjs')], { cwd: root, env, encoding: 'utf8', timeout: 90_000 });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  for (const value of [code, dev]) expect(readFileSync(value.fsm, 'utf8')).toBe(value.source);
}, 100_000);
