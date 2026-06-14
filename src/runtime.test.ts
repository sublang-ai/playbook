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
  const block = src.match(/interface PlaybookPorts\s*\{([\s\S]*?)\n\}/);
  if (!block) throw new Error('PlaybookPorts interface not found');
  const names = [...block[1].matchAll(/^\s*(\w+)\s*\(/gm)].map((x) => x[1]);
  return [...new Set(names)].sort();
}

describe('@sublang/playbook/runtime contract module (PBRT-34/35)', () => {
  // PBRT-35: consistency with the authored slc/link.md contract.
  it('matches slc/link.md on PlayerResult.status and PlaybookPorts members', () => {
    expect(statusMembers(runtimeDts)).toEqual(['aborted', 'error', 'ok']);
    expect(portsMembers(runtimeDts)).toEqual([
      'callJudge',
      'callPlayer',
      'emitStatus',
      'emitTelemetry',
    ]);
    expect(statusMembers(runtimeDts)).toEqual(statusMembers(linkSpec));
    expect(portsMembers(runtimeDts)).toEqual(portsMembers(linkSpec));
  });

  // PBRT-34/35: the four contract types are exported.
  it('exports the four contract types', () => {
    expect(runtimeDts).toMatch(/export interface PlayerResult\b/);
    expect(runtimeDts).toMatch(/export interface PlaybookPorts\b/);
    expect(runtimeDts).toMatch(/export interface PlaybookRuntime\b/);
    expect(runtimeDts).toMatch(/export type PlaybookRuntimeFactory\b/);
  });

  // PBRT-34/35: the module imports nothing at all, which strictly
  // implies it reaches no CODE or FSM type, directly or transitively.
  // (Substring matching on names like `code.playbook` is avoided: the
  // header comment legitimately mentions them as prose.)
  it('is standalone: imports no module, so reaches no CODE or FSM type', () => {
    for (const src of [runtimeDts, runtimeJs]) {
      expect(src).not.toMatch(/\bfrom\s+['"]/); // `... from '...'`
      expect(src).not.toMatch(/^\s*import\s+['"]/m); // side-effect import
      expect(src).not.toMatch(/\bimport\s*\(/); // dynamic import()
      expect(src).not.toMatch(/\brequire\s*\(/); // require()
    }
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
