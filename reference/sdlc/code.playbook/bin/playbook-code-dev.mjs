#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Dev counterpart to the published `playbook-code` bin. On each launch it
// rebuilds both local checkouts — cligent (`dist/`: the tmux-play CLI and
// runtime) and playbook (in-place `code.*.js`: the CODE adapter modules
// loaded at runtime) — then dispatches to the same `runPlaybookCodeCli`.
// Edits in either repo land in the next invocation without a manual
// `npm run build` in either tree. Mirrors cligent's `tmux-play` vs
// `tmux-play-dev` split, one level up.
//
// Local-only: excluded from the published tarball (playbook
// `package.json#files` lists `playbook-code.js`, not the `bin` dir) and
// exposed globally by a hand-made symlink (root `link-dev-bin.mjs`),
// never `npm link` — which would also replace the stable global
// `playbook-code`.
//
// The boss-pane subprocess re-execs the same cligent `cli.js` this
// launcher points at (launcher.ts buildSessionCommand), so a single
// pre-launch rebuild of both trees propagates into the in-tmux session;
// no per-subprocess rebuild is needed.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// .../reference/sdlc/code.playbook/bin -> playbook repo root (up 4).
const playbookRoot = resolve(here, '..', '..', '..', '..');

// Resolve the local cligent checkout via the link-local symlink rather
// than `import.meta.resolve('@sublang/cligent/tmux-play')`: realpath of
// the symlink works even before cligent's `dist/` exists (first build),
// and pins the launched bin to the exact tree we rebuild below.
const cligentLink = join(playbookRoot, 'node_modules', '@sublang', 'cligent');
if (!existsSync(cligentLink)) {
  process.stderr.write(
    `playbook-code-dev: ${cligentLink} not found. Run \`npm install\` at the ` +
      `workspace root so link-local wires the local cligent checkout.\n`,
  );
  process.exit(1);
}
const cligentRoot = realpathSync(cligentLink);
const tmuxPlayBin = join(cligentRoot, 'dist', 'app', 'tmux-play', 'cli.js');

// Build cligent first (playbook's CODE modules import its types/runtime),
// then playbook.
build('cligent', cligentRoot, join(cligentRoot, 'tsconfig.json'));
build('playbook', playbookRoot, join(playbookRoot, 'tsconfig.json'));

if (!existsSync(tmuxPlayBin)) {
  process.stderr.write(
    `playbook-code-dev: ${tmuxPlayBin} not found after build.\n`,
  );
  process.exit(1);
}

// Import AFTER the builds, not as a static top-level import: a static
// import is hoisted ahead of all top-level code, so it would bind
// `playbook-code.js` — and its transitive `@sublang/cligent/tmux-play`
// composer dependency — to the pre-build cligent `dist/`. Loading here
// resolves both against the freshly rebuilt trees.
const { runPlaybookCodeCli } = await import('./playbook-code.js');

const result = await runPlaybookCodeCli({ tmuxPlayBin });
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.code ?? 0);

function build(label, cwd, project) {
  const tsc = resolve(cwd, 'node_modules', '.bin', 'tsc');
  if (!existsSync(tsc)) {
    process.stderr.write(
      `playbook-code-dev: tsc not found in ${label} (${tsc}). Run ` +
        `\`npm install\` in that repo so devDependencies are present.\n`,
    );
    process.exit(1);
  }
  const built = spawnSync(tsc, ['-p', project], { stdio: 'inherit', cwd });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
