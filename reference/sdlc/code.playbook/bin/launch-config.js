// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-46: this module owns the host-neutral launch-configuration path used
// by both presentation front ends. It deliberately contains no tmux process
// control and stores no imported registry functions in the normalized plan.

import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parse as parseYaml,
  parseDocument as parseYamlDocument,
} from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE_PATH = resolve(
  here,
  '..',
  'playbook.config.template.yaml',
);

// PBCLI-1/8: the tmux projection uses the Playbook Captain shell adapter.
export const PLAYBOOK_CAPTAIN_MODULE =
  '@sublang/playbook/playbook-captain';
const PLAYBOOK_LAUNCHER_KEYS = ['from', 'command', 'players'];
const RESERVED_CAPTAIN_PLAYBOOK_ID = 'captain';
const RESERVED_CAPTAIN_ROLE_ID = 'captain';

// PBCLI-26: split ordered `--with <path>` pairs out of an argument vector.
// The returned arrays are new values; the caller's vector is never changed.
export function extractWithFlags(argv) {
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
export function loadOverlayFragment(overlayPath) {
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

// PBCLI-25/46: recursively merge maps and replace every other value without
// mutating either input. Object.fromEntries also makes __proto__ a data key.
export function mergeConfigs(base, overlay) {
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

// PBCLI-46: configured filesystem modules are anchored once to the primary
// config, including paths introduced by overlays. Bare/custom specifiers and
// already-authored file URLs retain their module semantics.
export function canonicalizeRegistrySpecifier(from, configPath) {
  if (configPath === undefined || from.startsWith('file:')) return from;
  if (
    isAbsolute(from) ||
    from.startsWith('./') ||
    from.startsWith('../') ||
    from.startsWith('.\\') ||
    from.startsWith('..\\')
  ) {
    return pathToFileURL(resolve(dirname(configPath), from)).href;
  }
  return from;
}

// PBCLI-46: seed, migrate, overlay, validate, and normalize through one path.
// `prepareRegistryModule` is the single provision-before-import seam. It is
// absent for today's interactive path, so this extraction changes no launch
// behavior; the shared headless host can attach the existing provisioner.
export async function loadLaunchPlan({
  userConfigPath,
  overlayPaths = [],
  loadModule = (specifier) => import(specifier),
  prepareRegistryModule,
  templatePath = DEFAULT_TEMPLATE_PATH,
  onNotice = () => {},
}) {
  seedUserConfigIfMissing(userConfigPath, templatePath, onNotice);
  migrateUserConfigIfRetired(userConfigPath, onNotice);

  let top = parseYaml(readFileSync(userConfigPath, 'utf8')) ?? {};
  if (overlayPaths.length > 0 && !isObject(top)) {
    throw new Error(
      `the top-level config at ${userConfigPath} must be a YAML map before --with can overlay it`,
    );
  }
  for (const overlayPath of overlayPaths) {
    top = mergeConfigs(top, loadOverlayFragment(overlayPath));
  }
  return await normalizeLaunchPlan(top, {
    loadModule,
    configPath: userConfigPath,
    prepareRegistryModule,
  });
}

// PBCLI-8 (DR-021): scalar agents are adapter shorthands and full blocks
// carry their own settings without profile indirection.
export function resolveAgent(value, path, reservedKeys = []) {
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      throw new Error(`${path} must name an adapter`);
    }
    return { adapter: value };
  }
  if (isObject(value)) {
    for (const key of reservedKeys) {
      if (hasOwn(value, key)) {
        throw new Error(`${path}.${key} is launcher-owned`);
      }
    }
    return cloneJson(value, path);
  }
  throw new Error(`${path} must be an adapter shorthand or an agent block`);
}

// PBCLI-46: normalize into a detached, deeply frozen JSON plan. The plan has
// only execution data and presentation data; imported registry functions are
// consulted for validation and then discarded.
export async function normalizeLaunchPlan(
  top,
  { loadModule, configPath, prepareRegistryModule } = {},
) {
  const importModule = loadModule ?? ((specifier) => import(specifier));
  top = cloneJson(top, 'config');
  assertNoRetiredProfiles(top, configPath);

  const playbooksCfg = requireObject(top.playbooks, 'playbooks');
  const ids = Object.keys(playbooksCfg);
  if (ids.length === 0) {
    throw new Error('playbooks must enable at least one playbook');
  }
  if (ids.some((id) => id.trim().length === 0)) {
    throw new Error('playbooks keys must be nonblank ids');
  }

  const captain = resolveAgent(top.captain, 'captain', ['from', 'options']);
  if (
    typeof captain.adapter !== 'string' ||
    captain.adapter.trim().length === 0
  ) {
    throw new Error('captain must resolve an adapter');
  }

  // Validate and detach every config-owned value before provisioning or
  // importing any registry. That keeps malformed config side-effect free.
  const configuredPlaybooks = [];
  const seenHostIds = new Set();
  for (const id of ids) {
    if (id === RESERVED_CAPTAIN_PLAYBOOK_ID) {
      throw new Error(
        `playbooks.${id} collides with the reserved internal Captain id`,
      );
    }
    const block = requireObject(playbooksCfg[id], `playbooks.${id}`);
    const from = block.from;
    if (typeof from !== 'string' || from.trim().length === 0) {
      throw new Error(`playbooks.${id}.from must be a module specifier`);
    }
    if (
      block.command !== undefined &&
      (typeof block.command !== 'string' || block.command.trim().length === 0)
    ) {
      throw new Error(`playbooks.${id}.command must be a nonblank string`);
    }
    if (block.command === RESERVED_CAPTAIN_PLAYBOOK_ID) {
      throw new Error(
        `playbooks.${id}.command collides with the reserved internal Captain command`,
      );
    }
    const playersMap = requireObject(block.players, `playbooks.${id}.players`);
    const roles = Object.keys(playersMap);
    if (roles.length === 0) {
      throw new Error(`playbooks.${id} resolves no visible local role`);
    }
    if (roles.some((role) => role.trim().length === 0)) {
      throw new Error(`playbooks.${id}.players keys must be nonblank role ids`);
    }
    const normalizedPlayers = [];
    const generated = [];
    const playerIdEntries = [];
    for (const role of roles) {
      const agent = resolveAgent(
        playersMap[role],
        `playbooks.${id}.players.${role}`,
        ['id'],
      );
      if (
        typeof agent.adapter !== 'string' ||
        agent.adapter.trim().length === 0
      ) {
        throw new Error(
          `playbooks.${id}.players.${role} must resolve an adapter`,
        );
      }
      const hostId = `${id}-${role}`;
      if (seenHostIds.has(hostId)) {
        throw new Error(`generated host player id "${hostId}" is not unique`);
      }
      seenHostIds.add(hostId);
      normalizedPlayers.push({
        id: hostId,
        playbookId: id,
        roleId: role,
        agent,
      });
      playerIdEntries.push([role, hostId]);
      generated.push(hostId);
    }
    const optionSlice = Object.fromEntries(
      Object.entries(block).filter(
        ([key]) => !PLAYBOOK_LAUNCHER_KEYS.includes(key),
      ),
    );
    const configuredFrom = canonicalizeRegistrySpecifier(from, configPath);
    configuredPlaybooks.push({
      id,
      from,
      configuredFrom,
      commandOverride: block.command,
      roles,
      normalizedPlayers,
      generated,
      playerIds: Object.fromEntries(playerIdEntries),
      optionSlice,
    });
  }

  // Preparation is a transaction-like pre-import phase across the complete
  // configured catalog. A provisioning failure therefore cannot leave some
  // registry modules evaluated and others untouched.
  const preparedPlaybooks = [];
  for (const configured of configuredPlaybooks) {
    const { id, from, configuredFrom } = configured;
    let preparedFrom = configuredFrom;
    if (prepareRegistryModule !== undefined) {
      try {
        const prepared = await prepareRegistryModule({
          id,
          from: configuredFrom,
          authoredFrom: from,
          configPath,
        });
        if (prepared !== undefined) preparedFrom = prepared;
      } catch (cause) {
        throw new Error(
          `playbooks.${id}.from "${from}" failed to prepare: ${errorMessage(cause)}`,
        );
      }
      if (
        typeof preparedFrom !== 'string' ||
        preparedFrom.trim().length === 0
      ) {
        throw new Error(
          `playbooks.${id}.from "${from}" preparation must return a module specifier`,
        );
      }
    }
    preparedPlaybooks.push({ ...configured, preparedFrom });
  }

  const catalogEntries = [];
  const players = [];
  const seenCommands = new Map();
  const seenIds = new Set();
  let firstVisible;

  for (const {
    id,
    from,
    preparedFrom,
    commandOverride,
    roles,
    normalizedPlayers,
    generated,
    playerIds,
    optionSlice,
  } of preparedPlaybooks) {
    let mod;
    try {
      mod = await importModule(preparedFrom);
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

    const command = commandOverride ?? entry.command;
    if (command === RESERVED_CAPTAIN_PLAYBOOK_ID) {
      throw new Error(
        `playbooks.${id}.command collides with the reserved internal Captain command`,
      );
    }
    if (seenCommands.has(command)) {
      throw new Error(`duplicate effective command "${command}"`);
    }
    seenCommands.set(command, id);

    if (entry.requiredRoleIds.includes(RESERVED_CAPTAIN_ROLE_ID)) {
      throw new Error(
        `playbooks.${id} requires local role "${RESERVED_CAPTAIN_ROLE_ID}", ` +
          'which is reserved for the tmux-play Captain',
      );
    }
    if (roles.includes(RESERVED_CAPTAIN_ROLE_ID)) {
      throw new Error(
        `playbooks.${id}.players.${RESERVED_CAPTAIN_ROLE_ID} binds local ` +
          `role "${RESERVED_CAPTAIN_ROLE_ID}", which is reserved for the ` +
          'tmux-play Captain',
      );
    }

    for (const required of entry.requiredRoleIds) {
      if (!roles.includes(required)) {
        throw new Error(
          `playbooks.${id} required role "${required}" has no players entry`,
        );
      }
    }

    players.push(...normalizedPlayers);
    if (firstVisible === undefined) firstVisible = generated;
    catalogEntries.push([
      id,
      {
        id,
        from: preparedFrom,
        command,
        ...(commandOverride === undefined ? {} : { commandOverride }),
        intent: entry.intent,
        requiredRoleIds: [...entry.requiredRoleIds],
        playerIds,
        options: optionSlice,
      },
    ]);
  }

  const layout = isObject(top.layout) ? { ...top.layout } : {};
  layout.initialVisible = firstVisible;
  const presentation = { layout };
  if (top.notifications !== undefined) {
    presentation.notifications = top.notifications;
  }
  if (top.theme !== undefined) presentation.theme = top.theme;

  return deepFreeze(
    cloneJson(
      {
        schemaVersion: 1,
        captain,
        players,
        catalog: Object.fromEntries(catalogEntries),
        presentation,
      },
      'launch config',
    ),
  );
}

// PBCLI-8/9/10/46: tmux is one projection of the host-neutral plan. The
// projection is detached so cligent normalization cannot mutate the plan.
export function projectTmuxConfig(plan) {
  const playbooks = Object.fromEntries(
    Object.entries(plan.catalog).map(([id, item]) => [
      id,
      {
        from: item.from,
        ...(item.commandOverride === undefined
          ? {}
          : { command: item.commandOverride }),
        options: cloneJson(item.options, `catalog.${id}.options`),
      },
    ]),
  );
  const captain = {
    ...cloneJson(plan.captain, 'captain'),
    from: PLAYBOOK_CAPTAIN_MODULE,
  };
  captain.options = {
    playbooks,
    ...(typeof captain.adapter === 'string' && captain.adapter.length > 0
      ? { captainAdapter: captain.adapter }
      : {}),
  };
  const config = {
    captain,
    players: plan.players.map(({ id, agent }) => ({
      ...cloneJson(agent, `players.${id}.agent`),
      id,
    })),
    layout: cloneJson(plan.presentation.layout, 'presentation.layout'),
  };
  if (hasOwn(plan.presentation, 'notifications')) {
    config.notifications = cloneJson(
      plan.presentation.notifications,
      'presentation.notifications',
    );
  }
  if (hasOwn(plan.presentation, 'theme')) {
    config.theme = cloneJson(plan.presentation.theme, 'presentation.theme');
  }
  return config;
}

// Compatibility surface used by existing integrations and tests. New hosts
// consume normalizeLaunchPlan/loadLaunchPlan and choose their projection.
export async function composeGenericConfig(top, loadModule, configPath) {
  const plan = await normalizeLaunchPlan(top, { loadModule, configPath });
  return {
    config: projectTmuxConfig(plan),
    playbooks: Object.values(plan.catalog).map(({ id, command, intent }) => ({
      id,
      command,
      intent,
    })),
  };
}

export function adaptersFromLaunchPlan(plan) {
  const adapters = new Set();
  if (plan?.captain?.adapter) adapters.add(plan.captain.adapter);
  for (const player of plan?.players ?? []) {
    if (player?.agent?.adapter) adapters.add(player.agent.adapter);
  }
  return [...adapters];
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

export function deriveLaunchReadiness(
  plan,
  env = process.env,
  home = homedir(),
) {
  const adapters = adaptersFromLaunchPlan(plan);
  return { adapters, ...checkReadiness(adapters, env, home) };
}

function seedUserConfigIfMissing(userConfigPath, templatePath, onNotice) {
  if (existsSync(userConfigPath)) return;
  mkdirSync(dirname(userConfigPath), { recursive: true });
  copyFileSync(templatePath, userConfigPath, constants.COPYFILE_EXCL);
  onNotice(`playbook: created config at ${userConfigPath}\n`);
}

// DR-021 §3: migrate once, keeping the original before any rewrite.
function migrateUserConfigIfRetired(userConfigPath, onNotice) {
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
  onNotice(
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

// DR-021 §3: rewrite through YAML's Document API so comments survive.
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
      const settings = profileSettings(node.value);
      if (settings === undefined) continue;
      const inlined = settings.clone();
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
      node.delete('profile');
      for (const item of settings.items) {
        if (node.has(String(item.key))) continue;
        node.add(item.clone());
      }
      changed = true;
    }
  }

  if (profiles !== undefined) {
    const index = contents.items.findIndex(
      (item) => String(item.key) === 'profiles',
    );
    const lead =
      index === -1 ? undefined : contents.items[index]?.key?.commentBefore;
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
  doc.commentBefore = MIGRATION_NOTE;
  return doc.toString();
}

const MIGRATION_NOTE =
  ' Migrated by playbook 3.0.0: the top-level `profiles` map was removed and\n' +
  ' each agent now carries its settings inline. The pre-migration file is\n' +
  ' kept beside this one as a .bak. Comments below may still describe the\n' +
  ' retired profiles model.';

function carryScalarComment(node, inlined) {
  const parts = [node.commentBefore, node.comment].filter(
    (part) => typeof part === 'string' && part.trim() !== '',
  );
  if (parts.length === 0) return;
  const first = inlined.items?.[0]?.key;
  if (!first) return;
  inlined.flow = false;
  const carried = parts.join('\n');
  first.commentBefore =
    first.commentBefore === undefined
      ? carried
      : `${carried}\n${first.commentBefore}`;
}

function keptHeaderComment(comment) {
  if (typeof comment !== 'string' || comment.trim() === '') return undefined;
  const paragraphs = comment.split('\n\n');
  const kept = paragraphs.slice(0, -1).join('\n\n');
  return kept.trim() === '' ? undefined : kept;
}

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
    const playersMap =
      isObject(block) && isObject(block.players) ? block.players : {};
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
    value.id.trim().length > 0 &&
    typeof value.command === 'string' &&
    value.command.trim().length > 0 &&
    typeof value.intent === 'string' &&
    Array.isArray(value.requiredRoleIds) &&
    value.requiredRoleIds.every(
      (role) => typeof role === 'string' && role.trim().length > 0,
    ) &&
    new Set(value.requiredRoleIds).size === value.requiredRoleIds.length &&
    typeof value.validateOptions === 'function' &&
    typeof value.createRuntime === 'function'
  );
}

function cloneJson(value, path, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new Error(`${path} must contain only finite JSON numbers`);
  }
  if (typeof value !== 'object') {
    throw new Error(`${path} must contain only JSON values`);
  }
  if (seen.has(value)) throw new Error(`${path} must not contain a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (
        keys.some(
          (key) =>
            typeof key === 'symbol' ||
            (key !== 'length' &&
              (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)),
        )
      ) {
        throw new Error(`${path} must be a plain JSON array`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const cloned = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index];
        if (descriptor === undefined) {
          throw new Error(`${path} must not contain sparse array slots`);
        }
        if (
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          descriptor.enumerable !== true
        ) {
          throw new Error(
            `${path}[${index}] must be an enumerable data property`,
          );
        }
        cloned.push(
          cloneJson(descriptor.value, `${path}[${index}]`, seen),
        );
      }
      return cloned;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) {
      throw new Error(`${path} must not contain symbol keys`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor?.get !== undefined ||
        descriptor?.set !== undefined ||
        descriptor?.enumerable !== true
      ) {
        throw new Error(`${path}.${key} must be an enumerable data property`);
      }
    }
    return Object.fromEntries(
      keys.map((key) => [
        key,
        cloneJson(descriptors[key].value, `${path}.${key}`, seen),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireObject(value, path) {
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
