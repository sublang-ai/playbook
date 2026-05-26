#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = resolve(here, '..', 'playbook-code.config.template.yaml');
const READINESS_FAILURE_EXIT_CODE = 2;

export async function runPlaybookCodeCli(options = {}) {
  const argv = [...(options.argv ?? process.argv.slice(2))];
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const spawnFn = options.spawn ?? spawn;
  const tmuxPlayBin = options.tmuxPlayBin ?? resolveTmuxPlayBin();
  const home = options.homeDir ?? env.HOME ?? homedir();
  const userConfigPath = resolveUserConfigPath(env, home);

  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(helpText({ userConfigPath }));
    return { code: 0 };
  }

  const explicitConfig = hasExplicitConfig(argv);
  const configPath = explicitConfig ? undefined : userConfigPath;

  if (!explicitConfig) {
    seedUserConfigIfMissing(userConfigPath, stderr);
    const readiness = checkReadiness(userConfigPath, env, home);
    for (const adapter of readiness.unknownAdapters) {
      stderr.write(
        `playbook-code: warning: no readiness check for adapter "${adapter}"\n`,
      );
    }
    if (readiness.failingAdapters.length > 0) {
      stderr.write(
        helpText({
          userConfigPath,
          failingAdapters: readiness.failingAdapters,
        }),
      );
      return { code: READINESS_FAILURE_EXIT_CODE };
    }
  }

  const childArgs = explicitConfig
    ? [tmuxPlayBin, ...argv]
    : [tmuxPlayBin, '--config', configPath, ...argv];
  return await launchTmuxPlay(spawnFn, childArgs, stderr);
}

export function resolveUserConfigPath(env = process.env, home = homedir()) {
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(configHome, 'playbook', 'playbook-code.config.yaml');
}

export function collectAdaptersFromConfig(source) {
  const adapters = new Set();
  let section = '';
  let captainChildIndent;
  let roleItemIndent;
  let roleChildIndent;

  for (const line of source.split(/\r?\n/)) {
    const uncommented = stripYamlComment(line);
    if (uncommented.trim() === '') continue;

    const indent = leadingSpaceCount(uncommented);
    const trimmed = uncommented.trim();

    if (indent === 0) {
      if (trimmed === 'captain:') section = 'captain';
      else if (trimmed === 'roles:') section = 'roles';
      else section = '';
      captainChildIndent = undefined;
      roleItemIndent = undefined;
      roleChildIndent = undefined;
      continue;
    }

    if (section === 'captain') {
      captainChildIndent ??= indent;
      if (indent === captainChildIndent) {
        collectAdapterValue(trimmed, adapters);
      }
      continue;
    }

    if (section === 'roles') {
      if (trimmed.startsWith('- ')) {
        roleItemIndent = indent;
        roleChildIndent = undefined;
        collectAdapterValue(trimmed.slice(2).trim(), adapters);
        continue;
      }
      if (roleItemIndent !== undefined && indent > roleItemIndent) {
        roleChildIndent ??= indent;
        if (indent === roleChildIndent) {
          collectAdapterValue(trimmed, adapters);
        }
      }
    }
  }
  return [...adapters];
}

export function checkReadiness(configPath, env = process.env, home = homedir()) {
  const config = readFileSync(configPath, 'utf8');
  const adapters = collectAdaptersFromConfig(config);
  const failingAdapters = [];
  const unknownAdapters = [];

  for (const adapter of adapters) {
    if (adapter === 'claude') {
      if (!env.ANTHROPIC_API_KEY && !existsSync(join(home, '.claude'))) {
        failingAdapters.push(adapter);
      }
      continue;
    }
    if (adapter === 'codex') {
      if (!env.OPENAI_API_KEY && !existsSync(join(home, '.codex'))) {
        failingAdapters.push(adapter);
      }
      continue;
    }
    unknownAdapters.push(adapter);
  }

  return { failingAdapters, unknownAdapters };
}

function seedUserConfigIfMissing(userConfigPath, stderr) {
  if (existsSync(userConfigPath)) return;
  mkdirSync(dirname(userConfigPath), { recursive: true });
  copyFileSync(templatePath, userConfigPath, constants.COPYFILE_EXCL);
  stderr.write(`playbook-code: created config at ${userConfigPath}\n`);
}

function hasExplicitConfig(argv) {
  return argv.some((arg) => arg === '--config' || arg.startsWith('--config='));
}

function helpText({ userConfigPath, failingAdapters = [] }) {
  const failures =
    failingAdapters.length > 0
      ? [
          `Adapters not ready: ${failingAdapters.join(', ')}`,
          '',
        ]
      : [];
  return [
    ...failures,
    'Usage:',
    '  playbook-code [--config <path>] [tmux-play options]',
    '  playbook-code --help',
    '',
    `Default config: ${userConfigPath}`,
    '',
    'Adapter setup:',
    '  claude: run Claude Code once or set ANTHROPIC_API_KEY.',
    '  codex: run Codex CLI once or set OPENAI_API_KEY.',
    '',
    'Agent swap recipe:',
    '  - change captain.adapter and captain.model for the Captain/Judge',
    '  - change each role adapter for the Coder and Reviewer',
    '  - tune captain.options.coderPlayer / reviewerPlayer to match',
    '  - keep captain.from and roles[].id fixed',
    '',
  ].join('\n');
}

async function launchTmuxPlay(spawnFn, childArgs, stderr) {
  return await new Promise((resolveResult) => {
    let child;
    try {
      child = spawnFn(process.execPath, childArgs, { stdio: 'inherit' });
    } catch (error) {
      stderr.write(`playbook-code: failed to launch tmux-play: ${errorMessage(error)}\n`);
      resolveResult({ code: 127 });
      return;
    }

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };

    child.on('error', (err) => {
      stderr.write(
        `playbook-code: failed to launch tmux-play: ${errorMessage(err)}\n`,
      );
      settle({ code: 127 });
    });

    child.on('exit', (code, signal) => {
      if (signal) settle({ signal });
      else settle({ code: code ?? 0 });
    });
  });
}

function resolveTmuxPlayBin() {
  const tmuxPlayIndexUrl = import.meta.resolve('@sublang/cligent/tmux-play');
  return join(dirname(fileURLToPath(tmuxPlayIndexUrl)), 'cli.js');
}

function stripYamlComment(line) {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== '\\') {
      quote = quote === char ? '' : quote || char;
      continue;
    }
    if (char === '#' && !quote) {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function collectAdapterValue(trimmedLine, adapters) {
  const match = trimmedLine.match(/^adapter\s*:\s*(.+?)\s*$/);
  if (!match) return;
  const value = unquoteYamlScalar(match[1].trim());
  if (value) adapters.add(value);
}

function leadingSpaceCount(line) {
  return line.length - line.trimStart().length;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isCliEntry(
  argv1 = process.argv[1],
  moduleUrl = import.meta.url,
) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  const result = await runPlaybookCodeCli();
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exit(result.code ?? 0);
}
