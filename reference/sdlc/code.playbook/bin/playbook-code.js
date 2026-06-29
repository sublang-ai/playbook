#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findTmuxPlayConfig,
  loadTmuxPlayConfig,
} from '@sublang/cligent/tmux-play';
import {
  parse as parseYaml,
  parseDocument as parseYamlDocument,
  stringify as stringifyYaml,
} from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = resolve(here, '..', 'playbook-code.config.template.yaml');
const READINESS_FAILURE_EXIT_CODE = 2;
const COMPOSITION_FAILURE_EXIT_CODE = 1;
const DEFAULT_NOTIFICATION_BLOCK = [
  '',
  '# tmux-play host notifications. Omitted turn_aborted resolves to off.',
  'notifications:',
  '  player_finished: bell',
  '  turn_finished: desktop',
  '',
].join('\n');

// PBCODE-16: the composer injects `captain.from` (the Playbook
// Captain shell adapter module) and the `coder` / `reviewer` player
// ids, so the user-edited overlay carries neither.
export const PLAYBOOK_CAPTAIN_MODULE = '@sublang/playbook/playbook-captain';
export const CODE_ADAPTER_MODULE = PLAYBOOK_CAPTAIN_MODULE;
const CODE_ROLES = ['coder', 'reviewer'];
// Accepted `players` keys: the two fixed CODE roles plus the optional
// `committer` alias (a string naming one of the roles); PBCODE-17.
const CODE_PLAYER_KEYS = [...CODE_ROLES, 'committer'];
// Captain-judge fields inherited from a base config when the overlay
// leaves them unset (PBCODE-16); `adapter` is handled separately
// because it is required in the composed config.
const CAPTAIN_INHERITED_FIELDS = ['model', 'reasoningEffort', 'permissions'];
const PLAYER_FIELDS = ['model', 'reasoningEffort', 'permissions'];

export async function runPlaybookCodeCli(options = {}) {
  const argv = [...(options.argv ?? process.argv.slice(2))];
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const spawnFn = options.spawn ?? spawn;
  const tmuxPlayBin = options.tmuxPlayBin ?? resolveTmuxPlayBin();
  const home = options.homeDir ?? env.HOME ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const configHome = resolveConfigHome(env, home);
  const userConfigPath = resolveUserConfigPath(env, home);

  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(helpText({ userConfigPath }));
    return { code: 0 };
  }

  // PBCODE-1: explicit `--config <path>` bypasses seeding, readiness,
  // and composition — the path is launched verbatim.
  if (hasExplicitConfig(argv)) {
    return await launchTmuxPlay(spawnFn, [tmuxPlayBin, ...argv], stderr);
  }

  seedUserConfigIfMissing(userConfigPath, stderr);
  migrateUserConfigNotificationsIfMissing(userConfigPath, stderr);

  // PBCODE-16/17: compose the launched config from the overlay plus an
  // optional base tmux-play config. Composition failures (missing role,
  // non-CODE role id, missing `captain.adapter`) surface a path-named
  // error and abort before launch.
  let composed;
  try {
    composed = await composeLaunchConfig({
      overlayPath: userConfigPath,
      cwd,
      configHome,
    });
  } catch (error) {
    stderr.write(`playbook-code: ${errorMessage(error)}\n`);
    return { code: COMPOSITION_FAILURE_EXIT_CODE };
  }

  // PBCODE-8: readiness reads the adapters of the composed config —
  // including a captain adapter that may have been inherited from the
  // base — not the raw overlay.
  const readiness = checkReadiness(
    adaptersFromComposedConfig(composed),
    env,
    home,
  );
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

  // PBCODE-16: materialize the composed config to a temp file, launch
  // against it, and remove it before the shim exits — on normal exit,
  // on non-zero child exit, and before re-raising a forwarded signal.
  const { dir: tempDir, path: composedPath } = writeComposedConfig(composed);
  try {
    return await launchTmuxPlay(
      spawnFn,
      [tmuxPlayBin, '--config', composedPath, ...argv],
      stderr,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function resolveConfigHome(env = process.env, home = homedir()) {
  return env.XDG_CONFIG_HOME || join(home, '.config');
}

export function resolveUserConfigPath(env = process.env, home = homedir()) {
  return join(resolveConfigHome(env, home), 'playbook', 'playbook-code.config.yaml');
}

// PBCODE-17: read the overlay, locate an optional base tmux-play config
// with cligent's exported `findTmuxPlayConfig` (never the bare
// `loadTmuxPlayConfig`, which writes a default config when none is
// found), load the base only when a path is located, and compose.
async function composeLaunchConfig({ overlayPath, cwd, configHome }) {
  const overlay = parseYaml(readFileSync(overlayPath, 'utf8')) ?? {};
  const basePath = findTmuxPlayConfig(cwd, configHome);
  let base;
  if (basePath) {
    base = (await loadTmuxPlayConfig({ configPath: basePath })).config;
  }
  return composeRuntimeConfig(overlay, base);
}

/**
 * Compose the launched tmux-play config (PBCODE-16/17) from the CODE
 * overlay and an optional base tmux-play config.
 *
 * @returns {import('@sublang/cligent/tmux-play').TmuxPlayConfig}
 */
export function composeRuntimeConfig(
  overlay,
  base,
  adapterModule = PLAYBOOK_CAPTAIN_MODULE,
) {
  const overlayConfig = requireObject(overlay, 'config');
  const overlayPlayers = requireObject(overlayConfig.players, 'players');

  // Reject any players key other than the two fixed CODE roles and the
  // optional `committer` alias.
  for (const key of Object.keys(overlayPlayers)) {
    if (!CODE_PLAYER_KEYS.includes(key)) {
      throw new Error(`Unknown config field players.${key}`);
    }
  }

  // PBCODE-17: `players.committer` is an optional string naming `coder`
  // or `reviewer`. The composer resolves it into the composed
  // `captain.options.code.committer` below and emits no extra
  // `players[]` entry, so the roster stays coder + reviewer.
  let committerAlias;
  if (overlayPlayers.committer !== undefined) {
    const value = overlayPlayers.committer;
    if (!CODE_ROLES.includes(value)) {
      throw new Error(
        `players.committer must name one of: ${CODE_ROLES.join(', ')}`,
      );
    }
    committerAlias = value;
  }

  // One composed `players[]` entry per role, with `id` = the role key
  // and that role's required `adapter` plus optional fields.
  const players = CODE_ROLES.map((role) => {
    if (overlayPlayers[role] === undefined) {
      throw new Error(`Missing required field players.${role}`);
    }
    const block = requireObject(overlayPlayers[role], `players.${role}`);
    if (block.adapter === undefined) {
      throw new Error(`Missing required field players.${role}.adapter`);
    }
    const entry = { id: role, adapter: block.adapter };
    for (const field of PLAYER_FIELDS) {
      if (block[field] !== undefined) entry[field] = block[field];
    }
    return entry;
  });

  const overlayCaptain =
    overlayConfig.captain === undefined
      ? {}
      : requireObject(overlayConfig.captain, 'captain');
  const baseCaptain = isObject(base?.captain) ? base.captain : {};

  // `captain.adapter` comes from the overlay when present, else the
  // base; composition fails with a path-named error when neither
  // supplies it. Role adapters are required in the overlay and are not
  // inherited.
  const captainAdapter = overlayCaptain.adapter ?? baseCaptain.adapter;
  if (captainAdapter === undefined) {
    throw new Error('Missing required field captain.adapter');
  }

  const captain = { from: adapterModule, adapter: captainAdapter };
  for (const field of CAPTAIN_INHERITED_FIELDS) {
    const value = overlayCaptain[field] ?? baseCaptain[field];
    if (value !== undefined) captain[field] = value;
  }

  // PBCODE-17: the shim is the sole writer of the composed
  // `captain.options.code.committer`. Read the overlay's
  // `captain.options.code` (carried through unchanged), reject a
  // directly-set `committer` there, then layer the resolved
  // `players.committer` alias on top.
  let overlayCode;
  if (overlayCaptain.options !== undefined) {
    const captainOptions = requireObject(
      overlayCaptain.options,
      'captain.options',
    );
    if (captainOptions.code !== undefined) {
      overlayCode = requireObject(captainOptions.code, 'captain.options.code');
      if (overlayCode.committer !== undefined) {
        throw new Error(
          'captain.options.code.committer is composer-owned; ' +
            'set players.committer instead',
        );
      }
    }
  }
  if (overlayCode !== undefined || committerAlias !== undefined) {
    const code = { ...(overlayCode ?? {}) };
    if (committerAlias !== undefined) code.committer = committerAlias;
    captain.options = { code };
  }

  // Inherit host-owned top-level fields from the base when the overlay
  // omits them; never the base `players[]` roster.
  const composed = {};
  const theme = overlayConfig.theme ?? base?.theme;
  if (theme !== undefined) composed.theme = theme;
  // PBCODE-16/17: an overlay `layout` is the user's own tmux-play layout
  // and is carried through verbatim; a base-inherited `layout` is
  // reconciled so it round-trips onto the composed coder + reviewer roster
  // (cligent normalizes the base layout to the base config's own roster).
  if (overlayConfig.layout !== undefined) {
    composed.layout = overlayConfig.layout;
  } else if (base?.layout !== undefined) {
    composed.layout = composeInheritedLayout(base.layout);
  }
  const notifications = overlayConfig.notifications ?? base?.notifications;
  if (notifications !== undefined) composed.notifications = notifications;
  composed.captain = captain;
  composed.players = players;
  return composed;
}

// PBCODE-17: reconcile a base-inherited `layout` so it round-trips onto
// the composed `coder` + `reviewer` roster. cligent's loaded base `layout`
// is normalized to the base config's own roster and shape: `initialVisible`
// names the base config's players (cligent rejects ids outside the composed
// roster) and the normalized output carries both the `columnWeights` alias
// and the canonical `singlePlayerColumnWeights` / `multiPlayerColumnWeights`
// (cligent emits the pair on load but rejects it on reload). Drop
// `initialVisible` — CODE shows its full composed roster, which cligent
// restores when the field is omitted — and drop the `columnWeights` alias
// whenever the canonical field for the alias's shape is present, carrying
// window and weights through otherwise. An overlay `layout` is the user's
// own and is not reconciled.
function composeInheritedLayout(layout) {
  if (!isObject(layout)) return layout;
  const result = { ...layout };
  delete result.initialVisible;
  const alias = result.columnWeights;
  if (Array.isArray(alias)) {
    const conflictsSingle =
      alias.length === 2 && result.singlePlayerColumnWeights !== undefined;
    const conflictsMulti =
      alias.length === 3 && result.multiPlayerColumnWeights !== undefined;
    if (conflictsSingle || conflictsMulti) delete result.columnWeights;
  }
  return result;
}

export function adaptersFromComposedConfig(config) {
  const adapters = new Set();
  const captainAdapter = config?.captain?.adapter;
  if (captainAdapter) adapters.add(captainAdapter);
  for (const player of config?.players ?? []) {
    if (player?.adapter) adapters.add(player.adapter);
  }
  return [...adapters];
}

export function checkReadiness(adapters, env = process.env, home = homedir()) {
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

function writeComposedConfig(composed) {
  const dir = mkdtempSync(join(tmpdir(), 'playbook-code-'));
  // cligent's loader only accepts a `.yaml` extension; name the temp
  // file accordingly.
  const path = join(dir, 'tmux-play.config.yaml');
  writeFileSync(path, stringifyYaml(composed));
  return { dir, path };
}

function seedUserConfigIfMissing(userConfigPath, stderr) {
  if (existsSync(userConfigPath)) return;
  mkdirSync(dirname(userConfigPath), { recursive: true });
  copyFileSync(templatePath, userConfigPath, constants.COPYFILE_EXCL);
  stderr.write(`playbook-code: created config at ${userConfigPath}\n`);
}

function migrateUserConfigNotificationsIfMissing(userConfigPath, stderr) {
  const source = readFileSync(userConfigPath, 'utf8');
  let parsed;
  try {
    const document = parseYamlDocument(source);
    if (document.errors.length > 0) return;
    parsed = document.contents === null ? {} : document.toJS();
  } catch {
    return;
  }
  if (!isObject(parsed) || hasOwn(parsed, 'notifications')) return;
  const separator = source.endsWith('\n') ? '' : '\n';
  writeFileSync(
    userConfigPath,
    `${source}${separator}${DEFAULT_NOTIFICATION_BLOCK}`,
  );
  stderr.write(
    `playbook-code: added notifications defaults to config at ${userConfigPath}\n`,
  );
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
    '  - change adapter and model under players.coder and players.reviewer',
    '    for the Coder and Reviewer; model when pinned, else adapter, is',
    '    substituted into <coder-llm>/<reviewer-llm> player prompts (PBRT-4)',
    '  - the composer injects captain.from; the role keys coder and',
    '    reviewer are fixed',
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

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireObject(value, path) {
  if (!isObject(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
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
