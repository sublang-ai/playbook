// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// RELEASE-29: the release smoke's cligent guard (RELEASE-28 step 8) is itself
// under test here, because the guard it replaced could not fail for the
// regression it existed to catch. Each case below removes exactly one member
// from a fixture cligent and asserts two things: the guard goes red naming
// that member, and a substring scan over the very same tree stays green.
// The second half is the mutation proof — it pins the defect class rather
// than the defect, so a future guard that drifts back toward name matching
// fails these rows.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { checkCligentCaptainSurface } from '../scripts/cligent-captain-surface.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'cligent-surface-'));
  roots.push(root);
  return root;
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

interface FixtureShape {
  readonly emitReply?: string;
  readonly resumeToken?: string;
}

// A minimal stand-in for the published package: the same `exports` map entry
// the shell resolves, the same interface names, and — as in the real package —
// unrelated declarations that also spell `resumeToken` and `emitReply`, which
// is what made the substring scan unfalsifiable.
function fixtureCligent(root: string, shape: FixtureShape = {}): string {
  const {
    emitReply = 'emitReply(text: string): Promise<void>;',
    resumeToken = 'readonly resumeToken?: string;',
  } = shape;
  const packageRoot = join(root, 'cligent');
  write(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: '@sublang/cligent',
        version: '0.19.0',
        type: 'module',
        exports: {
          './tmux-play': {
            import: './dist/app/tmux-play/index.js',
            types: './dist/app/tmux-play/index.d.ts',
          },
        },
      },
      undefined,
      2,
    )}\n`,
  );
  const tmuxPlay = join(packageRoot, 'dist', 'app', 'tmux-play');
  write(join(tmuxPlay, 'index.js'), 'export {};\n');
  write(join(tmuxPlay, 'index.d.ts'), "export * from './contract.js';\n");
  write(join(tmuxPlay, 'contract.js'), 'export {};\n');
  write(
    join(tmuxPlay, 'contract.d.ts'),
    `export type RunStatus = 'ok' | 'aborted' | 'error';
export interface CaptainContext {
    readonly signal: AbortSignal;
    callCaptain(prompt: string): Promise<CaptainRunResult>;
    ${emitReply}
}
export interface CaptainRunResult {
    readonly status: RunStatus;
    readonly turnId: number;
    ${resumeToken}
    readonly finalText?: string;
}
`,
  );
  // The decoys. Both names live on other declarations in the real package
  // too — `resumeToken` on four of them, `emitReply` in record types and doc
  // comments — so their presence proves nothing about the two interfaces.
  write(join(packageRoot, 'dist', 'types.js'), 'export {};\n');
  write(
    join(packageRoot, 'dist', 'types.d.ts'),
    'export interface DonePayload {\n    readonly resumeToken?: string;\n}\n',
  );
  write(join(tmuxPlay, 'records.js'), 'export {};\n');
  write(
    join(tmuxPlay, 'records.d.ts'),
    '/** Emitted by `emitReply`. */\nexport interface CaptainReplyRecord {\n    readonly text: string;\n}\n',
  );
  return packageRoot;
}

// The guard this replaced, verbatim in behavior: does either name occur in any
// shipped declaration file?
function substringScanIsGreen(packageRoot: string): boolean {
  const declarations: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && path.endsWith('.d.ts')) declarations.push(path);
    }
  };
  walk(packageRoot);
  return ['emitReply', 'resumeToken'].every((name) =>
    declarations.some((path) => readFileSync(path, 'utf8').includes(name)),
  );
}

function check(packageRoot: string, root: string): ReturnType<typeof checkCligentCaptainSurface> {
  return checkCligentCaptainSurface({
    cligentRoot: packageRoot,
    workRoot: join(root, 'typecheck'),
  });
}

describe('the cligent Captain-surface guard', () => {
  it('proves both members against the installed dependency', () => {
    const root = scratch();
    const result = check(join(repoRoot, 'node_modules', '@sublang', 'cligent'), root);

    expect(result.otherDiagnostics).toEqual([]);
    expect(result.unproven).toEqual([]);
    expect(result.proven).toEqual([
      'CaptainContext.emitReply',
      'CaptainRunResult.resumeToken',
    ]);
    expect(result.ok).toBe(true);
    expect(result.specifier).toBe('@sublang/cligent/tmux-play');
  });

  it('passes a complete fixture', () => {
    const root = scratch();
    const result = check(fixtureCligent(root), root);

    expect(result.unproven).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fails when CaptainContext.emitReply is absent, where a name scan passes', () => {
    const root = scratch();
    const packageRoot = fixtureCligent(root, { emitReply: '' });
    const result = check(packageRoot, root);

    expect(result.ok).toBe(false);
    expect(result.unproven.map((member) => member.id)).toEqual([
      'CaptainContext.emitReply',
    ]);
    expect(result.unproven[0]?.diagnostics.join('\n')).toContain(
      "Property 'emitReply' does not exist on type 'CaptainContext'",
    );
    expect(result.proven).toEqual(['CaptainRunResult.resumeToken']);
    expect(substringScanIsGreen(packageRoot)).toBe(true);
  });

  it('fails when CaptainRunResult.resumeToken is absent, where a name scan passes', () => {
    const root = scratch();
    const packageRoot = fixtureCligent(root, { resumeToken: '' });
    const result = check(packageRoot, root);

    expect(result.ok).toBe(false);
    expect(result.unproven.map((member) => member.id)).toEqual([
      'CaptainRunResult.resumeToken',
    ]);
    expect(result.unproven[0]?.diagnostics.join('\n')).toContain(
      "Property 'resumeToken' does not exist on type 'CaptainRunResult'",
    );
    expect(result.proven).toEqual(['CaptainContext.emitReply']);
    expect(substringScanIsGreen(packageRoot)).toBe(true);
  });

  it('fails when a member survives under a shape the shell cannot call', () => {
    const root = scratch();
    // Kept, spelled the same, on the right interface — and unusable: the
    // shell awaits every `emitReply`, and a token that is not a string is not
    // a resume token. A member check that stopped at presence would pass this.
    const packageRoot = fixtureCligent(root, {
      emitReply: 'emitReply(text: string): void;',
      resumeToken: 'readonly resumeToken?: number;',
    });
    const result = check(packageRoot, root);

    expect(result.ok).toBe(false);
    expect(result.unproven.map((member) => member.id)).toEqual([
      'CaptainContext.emitReply',
      'CaptainRunResult.resumeToken',
    ]);
    expect(substringScanIsGreen(packageRoot)).toBe(true);
  });

  it('fails when the public specifier no longer resolves', () => {
    const root = scratch();
    const packageRoot = fixtureCligent(root);
    // The members are all still there; only the `exports` entry the shell
    // imports through is gone. A deep-path check would not notice.
    const manifest = join(packageRoot, 'package.json');
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      exports: Record<string, unknown>;
    };
    delete parsed.exports['./tmux-play'];
    writeFileSync(manifest, `${JSON.stringify(parsed, undefined, 2)}\n`);
    const result = check(packageRoot, root);

    expect(result.ok).toBe(false);
    expect(result.unproven.map((member) => member.id)).toEqual([
      'CaptainContext.emitReply',
      'CaptainRunResult.resumeToken',
    ]);
    expect(substringScanIsGreen(packageRoot)).toBe(true);
  });
});
