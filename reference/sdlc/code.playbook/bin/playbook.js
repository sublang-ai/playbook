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
  parse as parseYaml,
  parseDocument as parseYamlDocument,
  stringify as stringifyYaml,
} from 'yaml';
import {
  adapterSdkFailureLines,
  checkAdapterSdks,
  mappedSdksFor,
  probeAdapterSdk,
} from './adapter-sdk.js';

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = resolve(here, '..', 'playbook.config.template.yaml');

// PBCLI-1/8: the launcher composes a tmux-play config whose Captain is the
// Playbook Captain shell adapter module.
export const PLAYBOOK_CAPTAIN_MODULE = '@sublang/playbook/playbook-captain';
// PBCLI-12: known adapter shorthands — the adapters with readiness
// predicates.
const ADAPTER_SHORTHANDS = ['claude', 'codex'];
// PBCLI-8: launcher-owned keys inside a `playbooks.<id>` block; every other
// key belongs to that playbook's option slice.
const PLAYBOOK_LAUNCHER_KEYS = ['from', 'command', 'players'];
const RESERVED_CAPTAIN_PLAYBOOK_ID = 'captain';
// PBCLI-9: the bare `captain` id names the tmux-play host Captain, so no
// playbook-local role may take it.
const RESERVED_CAPTAIN_ROLE_ID = 'captain';
const READINESS_FAILURE_EXIT_CODE = 2;
const COMPOSITION_FAILURE_EXIT_CODE = 1;

export async function runPlaybookCli(options = {}) {
  const argv = [...(options.argv ?? process.argv.slice(2))];
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const loadModule = options.loadModule ?? ((specifier) => import(specifier));
  const home = options.homeDir ?? env.HOME ?? homedir();
  const userConfigPath =
    options.userConfigPath ?? resolveUserConfigPath(env, home);

  // PBCLI-18: `playbook run ...` is the non-interactive one-shot path; it
  // never seeds, composes, resolves tmux-play, or launches it.
  if (argv[0] === 'run') {
    const { runPlaybookRun } = await import('./run.js');
    return await runPlaybookRun({
      argv: argv.slice(1),
      stdout,
      stderr,
      // PBCLI-29: the run host reads the same user config as the launcher,
      // honoring any injected env, home, or explicit path.
      userConfigPath,
      ...(options.loadModule ? { loadModule: options.loadModule } : {}),
      ...(options.createAgent ? { createAgent: options.createAgent } : {}),
      ...(options.readStdin ? { readStdin: options.readStdin } : {}),
      ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
      ...(options.hostRoots ? { hostRoots: options.hostRoots } : {}),
      // PBCLI-39: the run path gates on SDK availability too.
      ...(options.probeAdapterSdk
        ? { probeAdapterSdk: options.probeAdapterSdk }
        : {}),
      ...(options.ephemeralNpx !== undefined
        ? { ephemeralNpx: options.ephemeralNpx }
        : {}),
    });
  }

  const spawnFn = options.spawn ?? spawn;
  const tmuxPlayBin = options.tmuxPlayBin ?? resolveTmuxPlayBin();

  // PBCLI-6: `--help` / `-h` print help and exit 0 without seeding,
  // composing, or launching.
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(helpText({ userConfigPath }));
    return { code: 0 };
  }

  // PBCLI-25/26: `--with <path>` overlays are launcher-owned — consumed
  // here, never forwarded to tmux-play, and incompatible with a raw
  // `--config` launch, which bypasses the composition they target.
  let withPaths;
  let forwardArgv;
  try {
    ({ withPaths, rest: forwardArgv } = extractWithFlags(argv));
  } catch (error) {
    stderr.write(`playbook: ${errorMessage(error)}\n`);
    return { code: COMPOSITION_FAILURE_EXIT_CODE };
  }
  if (withPaths.length > 0 && hasExplicitConfig(argv)) {
    stderr.write(
      'playbook: --with overlays the top-level config and cannot combine ' +
        'with a raw --config launch\n',
    );
    return { code: COMPOSITION_FAILURE_EXIT_CODE };
  }

  // PBCLI-1: explicit `--config <path>` launches that raw tmux-play config
  // directly, bypassing seeding, composition, and the readiness gate.
  if (hasExplicitConfig(argv)) {
    return await launchTmuxPlay(spawnFn, [tmuxPlayBin, ...argv], stderr);
  }

  seedUserConfigIfMissing(userConfigPath, stderr);

  // DR-021 §3: an existing profiles-based config is rewritten in place once,
  // with the original kept beside it, so the user launches without editing.
  try {
    migrateUserConfigIfRetired(userConfigPath, stderr);
  } catch (error) {
    stderr.write(`playbook: ${errorMessage(error)}\n`);
    return { code: COMPOSITION_FAILURE_EXIT_CODE };
  }

  let composed;
  try {
    let top = parseYaml(readFileSync(userConfigPath, 'utf8')) ?? {};
    if (withPaths.length > 0 && !isObject(top)) {
      throw new Error(
        `the top-level config at ${userConfigPath} must be a YAML map before --with can overlay it`,
      );
    }
    for (const overlayPath of withPaths) {
      top = mergeConfigs(top, loadOverlayFragment(overlayPath));
    }
    composed = await composeGenericConfig(top, loadModule, userConfigPath);
  } catch (error) {
    stderr.write(`playbook: ${errorMessage(error)}\n`);
    return { code: COMPOSITION_FAILURE_EXIT_CODE };
  }

  // PBCLI-5: `--list` prints each configured playbook's id, effective
  // command, and intent without launching tmux-play.
  if (argv.includes('--list')) {
    for (const pb of composed.playbooks) {
      stdout.write(`/${pb.command}  ${pb.id}  —  ${pb.intent}\n`);
    }
    return { code: 0 };
  }

  // PBCLI-12: readiness reads the adapters of the composed config.
  const declaredAdapters = adaptersFromComposedConfig(composed.config);
  const readiness = checkReadiness(declaredAdapters, env, home);
  // PBCLI-39/40: SDK availability is an independent check with its own
  // remedy — a credential and an SDK can be missing at once, and reporting
  // only the first would send the user round the loop twice.
  const { missingAdapters } = await checkAdapterSdks(
    declaredAdapters,
    options.probeAdapterSdk ?? probeAdapterSdk,
  );
  for (const adapter of readiness.unknownAdapters) {
    stderr.write(
      `playbook: warning: no readiness check for adapter "${adapter}"\n`,
    );
  }
  if (readiness.failingAdapters.length > 0 || missingAdapters.length > 0) {
    stderr.write(
      helpText({
        userConfigPath,
        failingAdapters: readiness.failingAdapters,
        // PBCLI-40: the ephemeral re-run must carry the lineup's full mapped
        // SDK set and the user's own arguments, so it completes in one hop
        // and is executable exactly as printed.
        sdkFailureLines: adapterSdkFailureLines(missingAdapters, {
          requiredSdks: mappedSdksFor(declaredAdapters),
          invocation: argv,
          ...(options.ephemeralNpx !== undefined
            ? { ephemeralNpx: options.ephemeralNpx }
            : {}),
        }),
      }),
    );
    return { code: READINESS_FAILURE_EXIT_CODE };
  }

  const { dir: tempDir, path: composedPath } = writeComposedConfig(
    composed.config,
  );
  try {
    return await launchTmuxPlay(
      spawnFn,
      [tmuxPlayBin, '--config', composedPath, ...forwardArgv],
      stderr,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// PBCLI-26: split `--with <path>` pairs out of the argument vector so
// they are consumed by the launcher rather than forwarded to tmux-play.
function extractWithFlags(argv) {
  const withPaths = [];
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--with') {
      const value = argv[i + 1];
      if (value === undefined || value === '') {
        throw new Error('--with needs a value');
      }
      withPaths.push(value);
      i += 1;
    } else if (arg.startsWith('--with=')) {
      const value = arg.slice('--with='.length);
      if (!value) throw new Error('--with needs a value');
      withPaths.push(value);
    } else {
      rest.push(arg);
    }
  }
  return { withPaths, rest };
}

// PBCLI-25: an overlay fragment is a top-level-format YAML map.
function loadOverlayFragment(overlayPath) {
  const resolved = resolve(overlayPath);
  let text;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read --with overlay ${overlayPath}: ${errorMessage(error)}`,
    );
  }
  let fragment;
  try {
    fragment = parseYaml(text);
  } catch (error) {
    throw new Error(
      `cannot parse --with overlay ${overlayPath}: ${errorMessage(error)}`,
    );
  }
  if (!isObject(fragment)) {
    throw new Error(`--with overlay ${overlayPath} must be a YAML map`);
  }
  return fragment;
}

// PBCLI-25/26: recursive merge for plain maps, replacement for every
// other value; neither input is mutated. Object.fromEntries defines own
// data properties, so a hostile fragment key such as __proto__ cannot
// reach the prototype.
function mergeConfigs(base, overlay) {
  return Object.fromEntries([
    ...Object.entries(base),
    ...Object.entries(overlay).map(([key, value]) => [
      key,
      isObject(base[key]) && isObject(value)
        ? mergeConfigs(base[key], value)
        : value,
    ]),
  ]);
}

export function resolveConfigHome(env = process.env, home = homedir()) {
  return env.XDG_CONFIG_HOME || join(home, '.config');
}

export function resolveUserConfigPath(env = process.env, home = homedir()) {
  return join(resolveConfigHome(env, home), 'playbook', 'playbook.config.yaml');
}

// PBCLI-8 (DR-021): a scalar `captain` / `players.<role>` value is an
// adapter shorthand; a full block is a self-contained tmux-play agent block
// carrying its own adapter/model/effort/permissions. There is no profile
// indirection, so retuning one agent cannot change another.
export function resolveAgent(value, path) {
  if (typeof value === 'string') return { adapter: value };
  if (isObject(value)) return { ...value };
  throw new Error(`${path} must be an adapter shorthand or an agent block`);
}

// DR-021 §3: migrate the user's config on disk, once, keeping the original.
// The backup is written before the rewrite and never overwrites an existing
// file, so a prior backup — or a user's own .bak — cannot be lost.
function migrateUserConfigIfRetired(userConfigPath, stderr) {
  let text;
  try {
    text = readFileSync(userConfigPath, 'utf8');
  } catch {
    return;
  }
  let migrated;
  try {
    migrated = migrateRetiredProfiles(text);
  } catch (error) {
    throw new Error(
      `cannot migrate the retired profiles config at ${userConfigPath}: ` +
        `${errorMessage(error)} — edit it by hand: each agent takes its own ` +
        'adapter, model, effort, and permissions',
    );
  }
  if (migrated === undefined) return;
  const backupPath = freeBackupPath(userConfigPath);
  writeFileSync(backupPath, text, { mode: 0o600 });
  writeFileSync(userConfigPath, migrated);
  stderr.write(
    `playbook: migrated ${userConfigPath} to inline agent settings ` +
      `(the top-level "profiles" map was removed in 3.0.0); ` +
      `the original is at ${backupPath}\n`,
  );
}

function freeBackupPath(userConfigPath) {
  const first = `${userConfigPath}.bak`;
  if (!existsSync(first)) return first;
  for (let n = 2; ; n += 1) {
    const candidate = `${userConfigPath}.bak.${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}

// DR-021 §3: rewrite a config written for the retired profiles model in
// place, inlining each agent's settings and keeping the original beside it.
// Edits go through the YAML Document API so the user's comments survive;
// only the profiles block and its own commentary are removed. Returns the
// migrated text, or undefined when there is nothing to migrate.
export function migrateRetiredProfiles(text) {
  const doc = parseYamlDocument(text);
  const contents = doc.contents;
  if (!contents || !Array.isArray(contents.items)) return undefined;
  const profiles = doc.get('profiles');
  const agentPaths = [['captain']];
  const playbooks = doc.get('playbooks');
  if (playbooks && Array.isArray(playbooks.items)) {
    for (const entry of playbooks.items) {
      const id = String(entry.key);
      const players = doc.getIn(['playbooks', id, 'players']);
      if (!players || !Array.isArray(players.items)) continue;
      for (const player of players.items) {
        agentPaths.push(['playbooks', id, 'players', String(player.key)]);
      }
    }
  }

  const profileSettings = (name) =>
    profiles && typeof profiles.get === 'function'
      ? profiles.get(name)
      : undefined;

  let changed = false;
  for (const path of agentPaths) {
    const node = doc.getIn(path, true);
    if (node && typeof node.value === 'string' && !Array.isArray(node.items)) {
      // A scalar that named a profile; a bare adapter shorthand stays.
      const settings = profileSettings(node.value);
      if (settings === undefined) continue;
      const inlined = settings.clone();
      // The scalar carried any comment on that line, and replacing the node
      // would drop it. Re-attach it above the block that replaces it.
      carryScalarComment(node, inlined);
      doc.setIn(path, inlined);
      changed = true;
    } else if (node && Array.isArray(node.items)) {
      const named = node.get?.('profile');
      if (named === undefined) continue;
      const settings = profileSettings(named);
      if (settings === undefined) {
        throw new Error(
          `${path.join('.')}.profile names "${String(named)}", which no ` +
            'profiles entry defines',
        );
      }
      // Fill the block from its profile in place — never rebuild it — so
      // the user's own keys, ordering, and comments survive untouched. The
      // block's own fields stay authoritative, so only absent keys are added.
      node.delete('profile');
      for (const item of settings.items) {
        if (node.has(String(item.key))) continue;
        // Append the whole pair, not a rebuilt key/value: a comment above a
        // setting rides on that setting's key node, so stringifying the key
        // would drop it.
        node.add(item.clone());
      }
      changed = true;
    }
  }

  if (profiles !== undefined) {
    // The comment block above `profiles` usually carries the file's own
    // header, which must outlive the removed section: keep every paragraph
    // except the last, which documents profiles themselves.
    const index = contents.items.findIndex(
      (item) => String(item.key) === 'profiles',
    );
    const lead = index === -1 ? undefined : contents.items[index]?.key
      ?.commentBefore;
    doc.delete('profiles');
    const header = keptHeaderComment(lead);
    const next = contents.items[0];
    if (header !== undefined && next?.key) {
      next.key.commentBefore =
        next.key.commentBefore === undefined
          ? header
          : `${header}\n\n${next.key.commentBefore}`;
    }
    changed = true;
  }
  if (!changed) return undefined;
  // Say what happened at the top of the file the user will open next:
  // some of their remaining comments describe the retired model.
  doc.commentBefore = MIGRATION_NOTE;
  return doc.toString();
}

const MIGRATION_NOTE =
  ' Migrated by playbook 3.0.0: the top-level `profiles` map was removed and\n' +
  ' each agent now carries its settings inline. The pre-migration file is\n' +
  ' kept beside this one as a .bak. Comments below may still describe the\n' +
  ' retired profiles model.';

// Move a scalar agent's own comments onto the block that replaces it, so
// `captain: base # the judge` keeps its note. The pair's key comments are
// untouched by the replacement and need no carrying.
function carryScalarComment(node, inlined) {
  const parts = [node.commentBefore, node.comment].filter(
    (part) => typeof part === 'string' && part.trim() !== '',
  );
  if (parts.length === 0) return;
  const first = inlined.items?.[0]?.key;
  if (!first) return;
  // A flow map carrying a comment renders as a multi-line brace block; the
  // ordinary block form is what the rest of the config looks like.
  inlined.flow = false;
  const carried = parts.join('\n');
  first.commentBefore =
    first.commentBefore === undefined
      ? carried
      : `${carried}\n${first.commentBefore}`;
}

// Drop the trailing paragraph — the one describing the profiles block —
// and keep the rest of the leading comment (SPDX header, file overview).
function keptHeaderComment(comment) {
  if (typeof comment !== 'string' || comment.trim() === '') return undefined;
  const paragraphs = comment.split('\n\n');
  const kept = paragraphs.slice(0, -1).join('\n\n');
  return kept.trim() === '' ? undefined : kept;
}

// A `profile` key that survives migration — introduced by a `--with`
// overlay rather than the user's own config — is still rejected.
function assertNoRetiredProfiles(top, configPath) {
  const where = configPath ? ` in ${configPath}` : '';
  if (top.profiles !== undefined) {
    throw new Error(
      `top-level "profiles" was removed${where}: write each agent's settings ` +
        'inline under captain and each playbooks.<id>.players.<role> ' +
        '(adapter, model, effort, permissions)',
    );
  }
  const blocks = [['captain', top.captain]];
  const playbooksCfg = isObject(top.playbooks) ? top.playbooks : {};
  for (const [id, block] of Object.entries(playbooksCfg)) {
    const playersMap = isObject(block) && isObject(block.players)
      ? block.players
      : {};
    for (const [role, agent] of Object.entries(playersMap)) {
      blocks.push([`playbooks.${id}.players.${role}`, agent]);
    }
  }
  for (const [path, block] of blocks) {
    if (isObject(block) && block.profile !== undefined) {
      throw new Error(
        `${path}.profile was removed${where}: write the agent's settings ` +
          'inline in that block (adapter, model, effort, permissions)',
      );
    }
  }
}

function isValidRegistryEntry(value) {
  if (!isObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.command === 'string' &&
    typeof value.intent === 'string' &&
    Array.isArray(value.requiredRoleIds) &&
    typeof value.validateOptions === 'function' &&
    typeof value.createRuntime === 'function'
  );
}

// PBCLI-8/9/10: normalize the top-level `playbooks` config into
// a tmux-play config (Captain = the shell adapter; `captain.options.playbooks`
// the normalized enablement; a launch-time namespaced `<id>-<role>` roster;
// launcher-owned `layout.initialVisible`).
export async function composeGenericConfig(top, loadModule, configPath) {
  assertNoRetiredProfiles(top, configPath);

  const playbooksCfg = requireObject(top.playbooks, 'playbooks');
  const ids = Object.keys(playbooksCfg);
  if (ids.length === 0) {
    throw new Error('playbooks must enable at least one playbook');
  }

  const captain = {
    from: PLAYBOOK_CAPTAIN_MODULE,
    ...resolveAgent(top.captain, 'captain'),
  };
  if (captain.adapter === undefined) {
    throw new Error('captain must resolve an adapter');
  }

  const optionsPlaybooks = {};
  const roster = [];
  const listing = [];
  const seenCommands = new Map();
  const seenIds = new Set();
  let firstVisible;

  for (const id of ids) {
    if (id === RESERVED_CAPTAIN_PLAYBOOK_ID) {
      throw new Error(
        `playbooks.${id} collides with the reserved internal Captain id`,
      );
    }
    const block = requireObject(playbooksCfg[id], `playbooks.${id}`);
    const from = block.from;
    if (typeof from !== 'string' || from.length === 0) {
      throw new Error(`playbooks.${id}.from must be a module specifier`);
    }
    let mod;
    try {
      mod = await loadModule(from);
    } catch (cause) {
      throw new Error(
        `playbooks.${id}.from "${from}" failed to import: ${errorMessage(cause)}`,
      );
    }
    const entry = mod?.default;
    if (!isValidRegistryEntry(entry)) {
      throw new Error(
        `playbooks.${id}.from "${from}" exposes no valid registry entry`,
      );
    }
    if (entry.id !== id) {
      throw new Error(
        `playbooks.${id} key must equal the module manifest id "${entry.id}"`,
      );
    }
    if (seenIds.has(entry.id)) {
      throw new Error(`duplicate playbook id "${entry.id}"`);
    }
    seenIds.add(entry.id);

    const command =
      typeof block.command === 'string' && block.command.length > 0
        ? block.command
        : entry.command;
    if (command === RESERVED_CAPTAIN_PLAYBOOK_ID) {
      throw new Error(
        `playbooks.${id}.command collides with the reserved internal Captain command`,
      );
    }
    if (seenCommands.has(command)) {
      throw new Error(`duplicate effective command "${command}"`);
    }
    seenCommands.set(command, id);

    // PBCLI-9: reject the reserved role before the coverage checks below, so
    // an entry requiring `captain` names the real fault rather than a missing
    // players entry.
    if (entry.requiredRoleIds.includes(RESERVED_CAPTAIN_ROLE_ID)) {
      throw new Error(
        `playbooks.${id} requires local role "${RESERVED_CAPTAIN_ROLE_ID}", ` +
          'which is reserved for the tmux-play Captain',
      );
    }

    const playersMap = requireObject(block.players, `playbooks.${id}.players`);
    const roles = Object.keys(playersMap);
    if (roles.includes(RESERVED_CAPTAIN_ROLE_ID)) {
      throw new Error(
        `playbooks.${id}.players.${RESERVED_CAPTAIN_ROLE_ID} binds local ` +
          `role "${RESERVED_CAPTAIN_ROLE_ID}", which is reserved for the ` +
          'tmux-play Captain',
      );
    }
    if (roles.length === 0) {
      throw new Error(`playbooks.${id} resolves no visible local role`);
    }
    for (const required of entry.requiredRoleIds) {
      if (!roles.includes(required)) {
        throw new Error(
          `playbooks.${id} required role "${required}" has no players entry`,
        );
      }
    }
    const generated = [];
    for (const role of roles) {
      const agent = resolveAgent(
        playersMap[role],
        `playbooks.${id}.players.${role}`,
      );
      if (agent.adapter === undefined) {
        throw new Error(
          `playbooks.${id}.players.${role} must resolve an adapter`,
        );
      }
      const hostId = `${id}-${role}`;
      roster.push({ id: hostId, ...agent });
      generated.push(hostId);
    }
    if (firstVisible === undefined) firstVisible = generated;

    const optionSlice = {};
    for (const key of Object.keys(block)) {
      if (!PLAYBOOK_LAUNCHER_KEYS.includes(key)) {
        optionSlice[key] = block[key];
      }
    }
    optionsPlaybooks[id] = {
      from,
      ...(typeof block.command === 'string' && block.command.length > 0
        ? { command: block.command }
        : {}),
      options: optionSlice,
    };
    listing.push({ id, command, intent: entry.intent });
  }

  // DR-013 A1: the shell cannot see its own captain's adapter through the
  // tmux-play CaptainContext, so the launcher — which resolved it — passes it
  // through. The shell needs it to decide whether an explicit empty tool
  // allowlist can be enforced or must degrade to prompt-level restriction.
  captain.options = {
    playbooks: optionsPlaybooks,
    ...(typeof captain.adapter === 'string' && captain.adapter.length > 0
      ? { captainAdapter: captain.adapter }
      : {}),
  };
  const config = { captain, players: roster };
  // PBCLI-10: carry the user's tmux-play layout window/weight fields through;
  // the launcher owns `layout.initialVisible` (first enabled playbook).
  const layout = isObject(top.layout) ? { ...top.layout } : {};
  layout.initialVisible = firstVisible;
  config.layout = layout;
  if (top.notifications !== undefined) config.notifications = top.notifications;
  if (top.theme !== undefined) config.theme = top.theme;
  return { config, playbooks: listing };
}

export function adaptersFromComposedConfig(config) {
  const adapters = new Set();
  if (config?.captain?.adapter) adapters.add(config.captain.adapter);
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
  const dir = mkdtempSync(join(tmpdir(), 'playbook-'));
  const path = join(dir, 'tmux-play.config.yaml');
  writeFileSync(path, stringifyYaml(composed));
  return { dir, path };
}

function seedUserConfigIfMissing(userConfigPath, stderr) {
  if (existsSync(userConfigPath)) return;
  mkdirSync(dirname(userConfigPath), { recursive: true });
  copyFileSync(templatePath, userConfigPath, constants.COPYFILE_EXCL);
  stderr.write(`playbook: created config at ${userConfigPath}\n`);
}

function hasExplicitConfig(argv) {
  return argv.some((arg) => arg === '--config' || arg.startsWith('--config='));
}

function helpText({
  userConfigPath,
  failingAdapters = [],
  sdkFailureLines = [],
}) {
  const failures =
    failingAdapters.length > 0
      ? [`Adapters not ready: ${failingAdapters.join(', ')}`, '']
      : [];
  return [
    // PBCLI-40: the SDK remedy leads, because an unusable adapter cannot be
    // fixed by the credential advice further down.
    ...sdkFailureLines,
    ...failures,
    'Usage:',
    '  playbook [--list] [--with <path>]... [--config <path>] [tmux-play options]',
    '  playbook run <from> [task] [options]   # non-interactive one-shot',
    '  playbook run resume <session-id> [reply]   # answer a parked run',
    '  playbook --help',
    '',
    `Default config: ${userConfigPath}`,
    '',
    '  --with <path> overlays a top-level config fragment (same format as',
    '  the default config) over the default config for this launch only —',
    '  maps merge recursively, other values replace, later files win. The',
    '  default config file is never modified.',
    '',
    'Adapter setup:',
    '  claude: npm install -g @anthropic-ai/claude-agent-sdk, then run',
    '    Claude Code once or set ANTHROPIC_API_KEY.',
    '  codex: npm install -g @openai/codex-sdk, then run Codex CLI once',
    '    or set OPENAI_API_KEY.',
    '  Each SDK is an optional peer dependency, so you install only the',
    '  vendors your config actually names.',
    '',
    'Agent swap recipe:',
    '  - set each agent inline: the top-level captain and every',
    '    playbooks.<id>.players.<role> takes an adapter shorthand',
    '    (claude, codex) or a block with adapter/model/effort/permissions',
    '  - the launcher injects captain.from and the namespaced <id>-<role>',
    '    host players',
    '',
  ].join('\n');
}

async function launchTmuxPlay(spawnFn, childArgs, stderr) {
  return await new Promise((resolveResult) => {
    let child;
    try {
      child = spawnFn(process.execPath, childArgs, { stdio: 'inherit' });
    } catch (error) {
      stderr.write(
        `playbook: failed to launch tmux-play: ${errorMessage(error)}\n`,
      );
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
        `playbook: failed to launch tmux-play: ${errorMessage(err)}\n`,
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

function isCliEntry(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  const result = await runPlaybookCli();
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exit(result.code ?? 0);
}
