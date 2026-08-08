// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// RELEASE-28 step 8 / RELEASE-29: the standing guard that an installed
// `@sublang/cligent` really carries the two members the Playbook Captain
// shell's durable conversation calls.
//
// The obligation is a member on an interface, so the check is a type check,
// not a text search. Each member gets a one-line fixture that imports the
// interface through `@sublang/cligent/tmux-play` — the same public specifier
// the shell imports — and uses the member at its required type. The
// TypeScript compiler is the guard: a member that is absent, renamed, moved
// to another interface, or retyped fails its own fixture, and the failing
// fixture names which member is unproven.
//
// This replaced a substring scan over every `.d.ts` in the installed tree,
// which could not fail for the regression it existed to catch: in cligent
// 0.19.0, `resumeToken` names members of four unrelated declarations
// (`adapters/resume-token`, `cligent`, `protocol`, `types`) and `emitReply`
// survives in `app/tmux-play/records.d.ts` as a `{@link}` doc comment, so
// deleting both members from `CaptainContext` and `CaptainRunResult` left the
// scan reporting nothing absent.

import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import ts from 'typescript';

// The specifier the shell itself imports (`playbook-captain.ts`), so the check
// exercises the package's own `exports` map rather than a deep file path that
// a repackaging could move without breaking any consumer.
export const CAPTAIN_SURFACE_SPECIFIER = '@sublang/cligent/tmux-play';

// One fixture per member. `source` must use the member in a way that cannot
// type-check without it; the assignment to an explicitly annotated binding is
// what also pins the member's type, so a member kept under a changed shape
// (a synchronous `emitReply`, a numeric `resumeToken`) fails too.
export const CAPTAIN_SURFACE_MEMBERS = Object.freeze([
  Object.freeze({
    id: 'CaptainContext.emitReply',
    file: 'captain-context-emit-reply.ts',
    why: 'DR-029 §5 captain speech: every durable call is hidden, so validated Captain prose reaches Boss only through this surface.',
    source: `import type { CaptainContext } from '${CAPTAIN_SURFACE_SPECIFIER}';

export const emitCaptainReply: (
  context: CaptainContext,
  text: string,
) => Promise<void> = (context, text) => context.emitReply(text);
`,
  }),
  Object.freeze({
    id: 'CaptainRunResult.resumeToken',
    file: 'captain-run-result-resume-token.ts',
    why: "DR-029 §2 continuity: the shell pins this token after every session-Captain call, and its absence is what marks the conversation unsynchronized.",
    source: `import type { CaptainRunResult } from '${CAPTAIN_SURFACE_SPECIFIER}';

export const readResumeToken: (
  result: CaptainRunResult,
) => string | undefined = (result) => result.resumeToken;
`,
  }),
]);

function formatDiagnostic(diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return `TS${diagnostic.code}: ${message}`;
  }
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start,
  );
  const name = diagnostic.file.fileName.split('/').pop();
  return `${name}:${line + 1}:${character + 1} TS${diagnostic.code}: ${message}`;
}

/**
 * Type-check the member fixtures against one installed `@sublang/cligent`.
 *
 * @param {object} input
 * @param {string} input.cligentRoot Installed package root to prove.
 * @param {string} input.workRoot Scratch directory; created, and replaced if
 *   it already exists. The fixtures are left behind for inspection.
 * @returns {{
 *   ok: boolean,
 *   workRoot: string,
 *   specifier: string,
 *   proven: string[],
 *   unproven: { id: string, why: string, diagnostics: string[] }[],
 *   otherDiagnostics: string[],
 * }}
 */
export function checkCligentCaptainSurface({ cligentRoot, workRoot }) {
  const packageRoot = resolve(cligentRoot);
  if (!existsSync(join(packageRoot, 'package.json'))) {
    throw new Error(`no package.json under ${packageRoot}`);
  }
  const root = resolve(workRoot);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'node_modules', '@sublang'), { recursive: true });
  // Resolve the specifier the way Node does — through a `node_modules`
  // lookup that walks up from the importer — so the package's own `exports`
  // map and its `types` condition are what answer, exactly as they answer
  // for the shell.
  symlinkSync(
    packageRoot,
    join(root, 'node_modules', '@sublang', 'cligent'),
    'junction',
  );
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'cligent-captain-surface-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
      },
      undefined,
      2,
    )}\n`,
  );

  const fixtures = CAPTAIN_SURFACE_MEMBERS.map((member) => {
    const path = join(root, member.file);
    writeFileSync(path, member.source);
    return { member, path };
  });

  const program = ts.createProgram(
    fixtures.map((fixture) => fixture.path),
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      noEmit: true,
      // Declaration files are the subject, not the object: cligent's own
      // `.d.ts` graph reaches optional peer SDKs that a lean install does not
      // carry, and their absence is not this guard's business. The fixtures
      // are `.ts`, so their own checking is unaffected.
      skipLibCheck: true,
      types: [],
    },
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);

  const proven = [];
  const unproven = [];
  const attributed = new Set();
  for (const { member, path } of fixtures) {
    const own = diagnostics.filter(
      (diagnostic) => diagnostic.file?.fileName === path.split('\\').join('/'),
    );
    for (const diagnostic of own) attributed.add(diagnostic);
    if (own.length === 0) proven.push(member.id);
    else {
      unproven.push({
        id: member.id,
        why: member.why,
        diagnostics: own.map(formatDiagnostic),
      });
    }
  }
  const otherDiagnostics = diagnostics
    .filter((diagnostic) => !attributed.has(diagnostic))
    .map(formatDiagnostic);

  return {
    ok: unproven.length === 0 && otherDiagnostics.length === 0,
    workRoot: root,
    specifier: CAPTAIN_SURFACE_SPECIFIER,
    proven,
    unproven,
    otherDiagnostics,
  };
}
