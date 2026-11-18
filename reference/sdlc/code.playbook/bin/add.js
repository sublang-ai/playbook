// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isKnownPlayerAdapter } from '@sublang/cligent/tmux-play';
import { isAlias, isMap, parseDocument, visit } from 'yaml';
import { parseRegisteredCommand } from '../registered-command.js';
import {
  canonicalizeRegistrySpecifier,
  invalidRegistryEntryReason,
  normalizeLaunchPlan,
  resolveFormerUserConfigPaths,
  snapshotRegistryEntry,
} from './launch-config.js';
import { prepareConfiguredRegistries } from './provision.js';

const usage = 'Usage: playbook add <entry.mjs> --agent <adapter> --model <name>';
const flagsHelp = '--agent and --model configure only the new workflow’s dedicated Captain and role bindings.';

function parseArgs(argv) {
  const flags = new Map();
  let entry;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--agent' || arg === '--model') {
      if (flags.has(arg)) throw new Error(`${arg} was repeated`);
      const value = argv[++index];
      if (!value || value.startsWith('-') || value.trim() !== value) {
        throw new Error(`${arg} requires a nonblank value`);
      }
      flags.set(arg, value);
    } else if (arg.startsWith('-') || entry !== undefined) {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    } else {
      entry = arg;
    }
  }
  if (!entry || !flags.has('--agent') || !flags.has('--model')) {
    throw new Error('expected one local .mjs entry, --agent and --model');
  }
  if (!isKnownPlayerAdapter(flags.get('--agent'))) {
    throw new Error(`unsupported --agent ${JSON.stringify(flags.get('--agent'))}`);
  }
  return { entry, adapter: flags.get('--agent'), model: flags.get('--model') };
}

function existingPath(path) {
  try {
    lstatSync(path);
    return realpathSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' && error.syscall === 'lstat') return undefined;
    throw error;
  }
}

function readConfig(path, env, homeDir) {
  const target = existingPath(path);
  if (target === undefined) {
    const former = resolveFormerUserConfigPaths(env, homeDir).find(existingPath);
    if (former !== undefined) {
      throw new Error(`config still exists at ${former}; run playbook --list to relocate it before registering`);
    }
    const template = new URL('../playbook.config.template.yaml', import.meta.url);
    return { target: path, text: readFileSync(template, 'utf8'), mode: 0o600 };
  }
  const info = statSync(target);
  if (!info.isFile()) throw new Error(`config must be a regular file: ${path}`);
  const bytes = readFileSync(target);
  return { target, bytes, text: bytes.toString('utf8'), mode: info.mode & 0o777 };
}

function assertUnchangedConfig(path, original) {
  const current = existingPath(path);
  if (
    original.bytes === undefined
      ? current !== undefined
      : current !== original.target || !readFileSync(current).equals(original.bytes)
  ) {
    throw new Error(`config changed during registration: ${path}; try again`);
  }
}

function publishConfig(path, original, text, stderr) {
  mkdirSync(dirname(original.target), { recursive: true });
  const lock = `${original.target}.add-lock`;
  const temporary = `${original.target}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`another registration holds the config lock: ${lock}`);
    }
    throw error;
  }
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: original.mode });
    assertUnchangedConfig(path, original);
    if (original.bytes === undefined) linkSync(temporary, original.target);
    else renameSync(temporary, original.target);
  } finally {
    for (const cleanup of [() => closeSync(descriptor), () => rmSync(temporary, { force: true }),
      () => rmSync(lock, { force: true })]) {
      try {
        cleanup();
      } catch (error) {
        stderr.write(`playbook add: config staging cleanup: ${error.message}\n`);
      }
    }
  }
}

function sameEntry(from, configPath, entryPath) {
  if (typeof from !== 'string') return false;
  const specifier = canonicalizeRegistrySpecifier(from, configPath);
  if (!specifier.startsWith('file:')) return false;
  try {
    const actual = existingPath(fileURLToPath(specifier));
    return process.platform === 'win32'
      ? actual?.toLowerCase() === entryPath.toLowerCase()
      : actual === entryPath;
  } catch {
    return false;
  }
}

function sameBindings(plan, entry, adapter, model) {
  const registered = plan.catalog[entry.id];
  const captain = registered.executionCaptain;
  return registered.command === entry.command &&
    captain?.adapter === adapter &&
    captain.model.kind === 'value' && captain.model.value === model &&
    entry.requiredRoleIds.every(role => {
    const binding = registered.roles[role];
    const player = plan.players.find(({ id }) => id === binding.playerId);
    return player.agent.adapter === adapter &&
      binding.model.kind === 'value' && binding.model.value === model;
  });
}

function allocatePlayers(doc, entry, adapter, model) {
  const occupied = new Set(Object.keys(doc.toJS().players ?? {}));
  const slug = value => value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return Object.fromEntries(entry.requiredRoleIds.map(role => {
    const base = `workflow-${slug(entry.id)}.role-${slug(role)}`;
    let player = base;
    for (let serial = 2; occupied.has(player); serial += 1) {
      player = `${base}-${serial}`;
    }
    occupied.add(player);
    doc.setIn(['players', player], { adapter, model });
    return [role, player];
  }));
}

function prepareEditableMaps(doc) {
  const original = doc.toJS();
  const edited = new Map();
  for (const name of ['players', 'playbooks', 'workflowCaptains']) {
    const node = doc.get(name, true);
    if (!doc.has(name)) doc.set(name, doc.createNode({}));
    else if (isAlias(node)) doc.set(name, doc.createNode(original[name]));
    if (!isMap(doc.get(name, true))) throw new Error(`config ${name} must be a map`);
    if (isMap(node) && node.anchor !== undefined) edited.set(node, name);
  }
  // A workflow option can refer to an anchored catalog or player map. Its
  // value must stay at the old map when a new registration extends the map.
  if (edited.size) visit(doc, {
    Alias(_key, alias) {
      const name = edited.get(alias.resolve(doc));
      if (name === undefined) return;
      const next = doc.createNode(original[name]);
      next.comment = alias.comment;
      next.commentBefore = alias.commentBefore;
      return next;
    },
  });
}

export async function runPlaybookAdd({ argv, cwd, configPath, env, homeDir, stdout, stderr }) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    stdout.write(`${usage}\n${flagsHelp}\nConfig: ${configPath}\n`);
    return { code: 0 };
  }
  try {
    const args = parseArgs(argv);
    const requested = resolve(cwd, args.entry);
    if (extname(requested) !== '.mjs') throw new Error('entry must be a local .mjs file');
    const entryPath = realpathSync(requested);
    if (!statSync(entryPath).isFile()) throw new Error(`entry is not a regular file: ${requested}`);
    const original = readConfig(configPath, env, homeDir);
    const doc = parseDocument(original.text);
    if (doc.errors.length || !isMap(doc.contents)) {
      throw new Error(`invalid YAML config at ${configPath}: ${doc.errors[0]?.message ?? 'expected a map'}`);
    }
    const prior = doc.toJS();
    const from = pathToFileURL(entryPath).href;
    const prepare = prepareConfiguredRegistries({ stderr, commandName: 'playbook add' });
    const prepared = await prepare({ from });
    const entry = snapshotRegistryEntry((await import(prepared)).default);
    const problem = invalidRegistryEntryReason(entry);
    if (problem !== undefined) throw new Error(`invalid entry ${entryPath}: ${problem}`);
    if (parseRegisteredCommand(`/${entry.command}`)?.command !== entry.command) {
      throw new Error(`invalid entry command ${JSON.stringify(entry.command)}: expected a routable slash command name without '/'`);
    }
    const validate = () => normalizeLaunchPlan(doc.toJS(), {
      configPath,
      prepareRegistryModule: input => input.from === from ? prepared : prepare(input),
      loadModule: specifier => specifier === prepared ? { default: entry } : import(specifier),
    });
    if (Object.hasOwn(prior.playbooks ?? {}, entry.id)) {
      const existing = prior.playbooks[entry.id];
      if (sameEntry(existing?.from, configPath, entryPath) &&
          sameBindings(await validate(), entry, args.adapter, args.model)) {
        assertUnchangedConfig(configPath, original);
        stdout.write(`playbook add: /${entry.command} is already registered in ${configPath}\n`);
        return { code: 0 };
      }
      throw new Error(`playbook id "${entry.id}" is already configured with a different entry or settings`);
    }

    prepareEditableMaps(doc);
    const roles = allocatePlayers(doc, entry, args.adapter, args.model);
    doc.setIn(['playbooks', entry.id], {
      from: entryPath,
      command: entry.command,
      roles,
    });
    doc.setIn(['workflowCaptains', entry.id], { adapter: args.adapter, model: args.model });
    await validate();
    const result = doc.toString();
    const saved = parseDocument(result);
    const projected = saved.toJS();
    for (const player of Object.values(roles)) delete projected.players[player];
    delete projected.playbooks[entry.id];
    delete projected.workflowCaptains[entry.id];
    if (!Object.hasOwn(prior, 'workflowCaptains')) delete projected.workflowCaptains;
    if (saved.errors.length || !isDeepStrictEqual(projected, {
      ...prior, players: prior.players ?? {}, playbooks: prior.playbooks ?? {},
    })) {
      throw new Error(`cannot preserve the existing config at ${configPath}`);
    }
    publishConfig(configPath, original, result, stderr);
    stdout.write(`playbook add: registered /${entry.command} in ${configPath}\n`);
    return { code: 0 };
  } catch (error) {
    stderr.write(`playbook add: ${error instanceof Error ? error.message : String(error)}\n`);
    return { code: 1 };
  }
}
