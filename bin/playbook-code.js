#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Thin shim that resolves the bundled tmux-play.production.config.yaml
// relative to this script's own location and execs cligent's tmux-play
// CLI from inside @sublang/playbook's own node_modules tree. We resolve
// the CLI through cligent's `./tmux-play` subpath export instead of
// relying on `tmux-play` being on PATH — npm global installs only link
// bins from top-level packages, so a transitive cligent's bin won't
// reach the user's PATH but its files are still resolvable here.

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(here, '..', 'tmux-play.production.config.yaml');

// cligent's `./tmux-play` subpath export only declares "import"
// (no "require"/"default"), so createRequire(...).resolve trips
// ERR_PACKAGE_PATH_NOT_EXPORTED. import.meta.resolve uses ESM rules
// and follows the "import" condition — works from Node 20.6+.
const tmuxPlayIndexUrl = import.meta.resolve('@sublang/cligent/tmux-play');
const tmuxPlayBin = join(dirname(fileURLToPath(tmuxPlayIndexUrl)), 'cli.js');

const child = spawn(
  process.execPath,
  [tmuxPlayBin, '--config', configPath, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

child.on('error', (err) => {
  process.stderr.write(
    `playbook-code: failed to launch tmux-play (${tmuxPlayBin}): ${err.message}\n`,
  );
  process.exit(127);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
