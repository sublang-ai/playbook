#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Thin shim that resolves the bundled tmux-play.production.config.yaml
// relative to this script's own location and execs `tmux-play` against
// it. Extra argv is forwarded verbatim, so callers can pass flags like
// --window or override the config with a later --config of their own
// (tmux-play uses the last --config wins).
//
// `tmux-play` is provided by the @sublang/cligent peer; this shim
// expects it to be discoverable on PATH (npm install -g or a project's
// node_modules/.bin).

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(here, '..', 'tmux-play.production.config.yaml');

const child = spawn(
  'tmux-play',
  ['--config', configPath, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

child.on('error', (err) => {
  const reason = err && err.code === 'ENOENT' ? 'not found on PATH' : err.message;
  process.stderr.write(
    `playbook-code: failed to launch tmux-play: ${reason}\n` +
      "Install @sublang/cligent (which provides 'tmux-play') alongside @sublang/playbook.\n",
  );
  process.exit(127);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
