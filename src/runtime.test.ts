// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve files relative to this test (src/runtime.test.ts).
const sibling = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const fromRepo = (rel: string) =>
  fileURLToPath(new URL(`../${rel}`, import.meta.url));

const linkSpec = readFileSync(fromRepo('slc/link.md'), 'utf8');
const runtimeSource = readFileSync(sibling('runtime.ts'), 'utf8');
const runtimeDts = readFileSync(sibling('runtime.d.ts'), 'utf8');
const runtimeJs = readFileSync(sibling('runtime.js'), 'utf8');
const pkg = JSON.parse(readFileSync(fromRepo('package.json'), 'utf8')) as {
  files: string[];
  exports: Record<string, unknown>;
};

// The members of `PlayerResult.status` (the first such field declared).
function statusMembers(src: string): string[] {
  const m = src.match(/status\??:\s*([^;]+);/);
  if (!m) throw new Error('PlayerResult.status not found');
  return m[1]
    .split('|')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .sort();
}

// The method names declared on the `PlaybookPorts` interface.
function portsMembers(src: string): string[] {
  const names = [
    ...interfaceBody(src, 'PlaybookPorts').matchAll(/^\s*(\w+)\s*\(/gm),
  ].map((x) => x[1]);
  return [...new Set(names)].sort();
}

function interfaceBody(src: string, name: string): string {
  const block = src.match(
    new RegExp(`interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  if (!block) throw new Error(`${name} interface not found`);
  return block[1];
}

function interfaceProperties(src: string, name: string): string[] {
  return [
    ...interfaceBody(src, name).matchAll(
      /^\s*(\w+)(\??):\s*([^;]+);/gm,
    ),
  ]
    .map((match) => `${match[1]}${match[2]}:${normalizeType(match[3])}`)
    .sort();
}

function normalizeType(type: string): string {
  return type.replace(/\s+/g, '');
}

function unionMembers(src: string, name: string): string[] {
  const alias = src.match(
    new RegExp(`(?:export\\s+)?type ${name}\\s*=([\\s\\S]*?);`),
  );
  if (!alias) throw new Error(`${name} type alias not found`);
  return [...alias[1].matchAll(/['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .sort();
}

function callPlayerParameters(src: string): string {
  const signature = interfaceBody(src, 'PlaybookPorts').match(
    /callPlayer\s*\(([\s\S]*?)\)\s*:\s*Promise<PlayerResult>/,
  );
  if (!signature) throw new Error('PlaybookPorts.callPlayer not found');
  return normalizeType(signature[1]).replace(/,$/, '');
}

function initParameters(src: string): string {
  const signature = interfaceBody(src, 'PlaybookRuntime').match(
    /init\s*\(([\s\S]*?)\)\s*:\s*Promise<void>/,
  );
  if (!signature) throw new Error('PlaybookRuntime.init not found');
  return normalizeType(signature[1]);
}

const TRACE_TYPES = [
  'boss.input.received',
  'boss.input.settled',
  'fsm.transition',
  'judge.call.finished',
  'judge.call.started',
  'player.call.finished',
  'player.call.started',
  'session.disposed',
  'session.started',
  'status.emitted',
];

describe('@sublang/playbook/runtime contract module (PBRT-34/35)', () => {
  // PBRT-35: consistency with the authored slc/link.md contract.
  it('matches slc/link.md on result, resume, session, trace, and runtime shapes', () => {
    expect(statusMembers(runtimeDts)).toEqual(['aborted', 'error', 'ok']);
    expect(portsMembers(runtimeDts)).toEqual([
      'callJudge',
      'callPlayer',
      'emitStatus',
      'emitTelemetry',
    ]);
    expect(statusMembers(runtimeDts)).toEqual(statusMembers(linkSpec));
    expect(portsMembers(runtimeDts)).toEqual(portsMembers(linkSpec));
    expect(interfaceProperties(runtimeDts, 'PlayerResult')).toEqual(
      interfaceProperties(linkSpec, 'PlayerResult'),
    );
    expect(interfaceProperties(runtimeDts, 'PlayerResult')).toContain(
      'resumeToken?:string',
    );
    expect(interfaceProperties(runtimeDts, 'PlayerCallOptions')).toEqual([
      'resume:string|false',
    ]);
    expect(interfaceProperties(runtimeDts, 'PlayerCallOptions')).toEqual(
      interfaceProperties(linkSpec, 'PlayerCallOptions'),
    );
    expect(callPlayerParameters(runtimeDts)).toBe(
      'playerId:string,prompt:string,signal:AbortSignal,options:PlayerCallOptions',
    );
    expect(callPlayerParameters(runtimeDts)).toBe(
      callPlayerParameters(linkSpec),
    );
    expect(interfaceProperties(runtimeDts, 'PlaybookSession')).toEqual([
      'playbookId:string',
      'ports:PlaybookPorts',
      'sessionId:string',
    ]);
    expect(interfaceProperties(runtimeDts, 'PlaybookSession')).toEqual(
      interfaceProperties(linkSpec, 'PlaybookSession'),
    );
    expect(unionMembers(runtimeDts, 'PlaybookTraceType')).toEqual(TRACE_TYPES);
    expect(unionMembers(runtimeDts, 'PlaybookTraceType')).toEqual(
      unionMembers(linkSpec, 'PlaybookTraceType'),
    );
    expect(interfaceProperties(runtimeDts, 'PlaybookTraceEvent')).toEqual([
      'callId?:string',
      'payload:unknown',
      'playbookId:string',
      'schemaVersion:1',
      'sequence:number',
      'sessionId:string',
      'timestamp:number',
      'turnId?:number',
      'type:PlaybookTraceType',
    ]);
    expect(interfaceProperties(runtimeDts, 'PlaybookTraceEvent')).toEqual(
      interfaceProperties(linkSpec, 'PlaybookTraceEvent'),
    );
    expect(initParameters(runtimeDts)).toBe('session:PlaybookSession');
    expect(initParameters(runtimeDts)).toBe(initParameters(linkSpec));
  });

  // PBRT-34/35: every authored contract type is exported.
  it('exports every shared contract type', () => {
    for (const name of [
      'PlayerResult',
      'PlayerCallOptions',
      'PlaybookPorts',
      'PlaybookSession',
      'PlaybookTraceEvent',
      'PlaybookRuntime',
    ]) {
      expect(runtimeDts).toMatch(new RegExp(`export interface ${name}\\b`));
    }
    for (const name of ['PlaybookTraceType', 'PlaybookRuntimeFactory']) {
      expect(runtimeDts).toMatch(new RegExp(`export type ${name}\\b`));
    }
  });

  // PBRT-34/35: the module imports nothing at all, which strictly
  // implies it reaches no CODE or FSM type, directly or transitively.
  // (Substring matching on names like `code.playbook` is avoided: the
  // header comment legitimately mentions them as prose.)
  it('is standalone: imports no module, so reaches no CODE or FSM type', () => {
    for (const src of [runtimeSource, runtimeDts, runtimeJs]) {
      expect(src).not.toMatch(/\bfrom\s+['"]/); // `... from '...'`
      expect(src).not.toMatch(/^\s*import\s+['"]/m); // side-effect import
      expect(src).not.toMatch(/\bimport\s*\(/); // dynamic import()
      expect(src).not.toMatch(/\brequire\s*\(/); // require()
    }
    expect(runtimeSource).not.toMatch(
      /^\s*(?:export\s+)?(?:const|let|var|function|class)\b/m,
    );
  });

  // RELEASE-15: a downstream consumer's `./runtime` import resolves to
  // committed type + value artifacts listed in `files`.
  it('is wired as a public ./runtime export over committed artifacts', () => {
    expect(pkg.exports['./runtime']).toEqual({
      types: './src/runtime.d.ts',
      default: './src/runtime.js',
    });
    expect(pkg.files).toContain('src/runtime.js');
    expect(pkg.files).toContain('src/runtime.d.ts');
    expect(existsSync(sibling('runtime.d.ts'))).toBe(true);
    expect(existsSync(sibling('runtime.js'))).toBe(true);
  });

  // The default artifact is a valid, loadable ESM module.
  it('ships a valid, loadable ESM module', async () => {
    const mod = await import(new URL('runtime.js', import.meta.url).href);
    expect(typeof mod).toBe('object');
  });
});
