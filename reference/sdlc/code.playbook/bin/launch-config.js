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
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  parse as parseYaml,
  parseDocument as parseYamlDocument,
  stringify as stringifyYaml,
} from 'yaml';
import { loadTmuxPlayConfig } from '@sublang/cligent/tmux-play';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE_PATH = resolve(
  here,
  '..',
  'playbook.config.template.yaml',
);

// PBCLI-1/8: the tmux projection uses the Playbook Captain shell adapter.
export const PLAYBOOK_CAPTAIN_MODULE =
  '@sublang/playbook/playbook-captain';
const PLAYBOOK_LAUNCHER_KEYS = ['from', 'command', 'roles'];
const HOST_CAPABILITIES_OPTION_KEY = 'hostCapabilities';
const PLAYBOOK_TOP_LEVEL_KEYS = new Set([
  'captain',
  'players',
  'playbooks',
  'layout',
  'notifications',
  'theme',
]);
const RESERVED_CAPTAIN_PLAYBOOK_ID = 'captain';
const RESERVED_CAPTAIN_ROLE_ID = 'captain';
const PLAYER_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;
const ROLE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

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

// PBCLI-22/46: ordinary reopen must merge only durable catalog members.
// A selected member may first appear in an overlay, so each layer is pruned
// permissively before merge and the final strict projection below owns the
// missing-member diagnostic. Unselected accessors are never observed.
export function mergeSelectedConfigs(base, overlay, selectedMembers) {
  const selected = validateSelectedMembers(selectedMembers);
  return mergeConfigs(
    projectSelectedLayer(base, selected, 'config'),
    projectSelectedLayer(overlay, selected, 'overlay'),
  );
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
// `prepareRegistryModule` is the single provision-before-import seam used by
// both front ends, so filesystem registry handling cannot drift by presenter.
export async function loadLaunchPlan({
  userConfigPath,
  overlayPaths = [],
  loadModule = (specifier) => import(specifier),
  prepareRegistryModule,
  templatePath = DEFAULT_TEMPLATE_PATH,
  onNotice = () => {},
  selectedMembers,
}) {
  seedUserConfigIfMissing(userConfigPath, templatePath, onNotice);
  // PBCLI-22/46: a reopen must not rewrite, validate, or otherwise inspect
  // config members outside the stored projection.
  if (selectedMembers === undefined) {
    migrateUserConfigIfRetired(userConfigPath, onNotice);
  }

  let top = parseYaml(readFileSync(userConfigPath, 'utf8')) ?? {};
  if (overlayPaths.length > 0 && !isObject(top)) {
    throw new Error(
      `the top-level config at ${userConfigPath} must be a YAML map before --with can overlay it`,
    );
  }
  for (const overlayPath of overlayPaths) {
    const overlay = loadOverlayFragment(overlayPath);
    top =
      selectedMembers === undefined
        ? mergeConfigs(top, overlay)
        : mergeSelectedConfigs(top, overlay, selectedMembers);
  }
  return await normalizeLaunchPlan(top, {
    loadModule,
    configPath: userConfigPath,
    prepareRegistryModule,
    selectedMembers,
  });
}

// PBCLI-22/49: an interactive selected launch may project current tuning and
// presentation before its pane child owns the writer lease, but it must not
// prepare or import a registry from an unlocked advisory read. Rebuild the
// durable catalog from the validated stored structural projection and use the
// current config only for compatible Captain/player tuning and presentation.
export async function loadSelectedLaunchPlanDataOnly({
  userConfigPath,
  overlayPaths = [],
  structuralProjection,
  templatePath = DEFAULT_TEMPLATE_PATH,
  onNotice = () => {},
}) {
  const stored = validateStoredStructuralProjection(structuralProjection);
  const selectedMembers = selectedMembersFromStoredStructure(stored);
  seedUserConfigIfMissing(userConfigPath, templatePath, onNotice);

  let top = parseYaml(readFileSync(userConfigPath, 'utf8')) ?? {};
  if (overlayPaths.length > 0 && !isObject(top)) {
    throw new Error(
      `the top-level config at ${userConfigPath} must be a YAML map before --with can overlay it`,
    );
  }
  top = projectSelectedLayer(
    top,
    validateSelectedMembers(selectedMembers),
    'config',
  );
  for (const overlayPath of overlayPaths) {
    top = mergeSelectedConfigs(
      top,
      loadOverlayFragment(overlayPath),
      selectedMembers,
    );
  }
  return await normalizeSelectedLaunchPlanDataOnly(top, {
    configPath: userConfigPath,
    stored,
    selectedMembers,
  });
}

export async function normalizeSelectedLaunchPlanDataOnly(
  top,
  { configPath, stored, selectedMembers } = {},
) {
  stored = validateStoredStructuralProjection(stored);
  const expectedMembers = selectedMembersFromStoredStructure(stored);
  if (selectedMembers !== undefined) {
    const supplied = validateSelectedMembers(selectedMembers);
    if (
      !isDeepStrictEqual(supplied.playbookIds, expectedMembers.playbookIds) ||
      !isDeepStrictEqual(supplied.playerIds, expectedMembers.playerIds)
    ) {
      throw new Error(
        'selected launch members do not match the stored structural projection',
      );
    }
  }
  top = projectSelectedMembers(top, expectedMembers);
  top = cloneJson(top, 'config');
  assertNoRetiredProfiles(top, configPath);
  if (hasOwn(top, 'run')) {
    throw new Error(
      'top-level "run" was removed: configure the shared Captain under ' +
        'captain, top-level players, and playbooks.<id>.roles instead',
    );
  }
  const unknownTopLevel = Object.keys(top).filter(
    (key) => !PLAYBOOK_TOP_LEVEL_KEYS.has(key),
  );
  if (unknownTopLevel.length > 0) {
    throw new Error(
      `config has unknown top-level ${formatKeyList(unknownTopLevel)}`,
    );
  }
  if (top.layout !== undefined && !isObject(top.layout)) {
    throw new Error('layout must be a map');
  }

  const playersCfg = requireObject(top.players, 'players');
  const configuredAgents = new Map();
  for (const playerId of expectedMembers.playerIds) {
    assertPlayerId(playerId, `players.${playerId}`);
    const agent = resolveAgent(playersCfg[playerId], `players.${playerId}`, [
      'id',
    ]);
    configuredAgents.set(playerId, agent);
  }
  let captain = resolveAgent(top.captain, 'captain', ['from', 'options']);

  const playbooksCfg = requireObject(top.playbooks, 'playbooks');
  const tuningChecks = [];
  let tuningCheckIndex = 0;
  const authored = new Map();
  for (const id of expectedMembers.playbookIds) {
    const storedItem = stored.catalog[id];
    const block = requireObject(playbooksCfg[id], `playbooks.${id}`);
    if (hasOwn(block, 'players')) {
      throw legacyPlayersError(`playbooks.${id}.players`, configPath);
    }
    rejectConfiguredHostCapabilities(block, `playbooks.${id}`);
    if (
      typeof block.from !== 'string' ||
      block.from.trim().length === 0 ||
      block.from !== block.from.trim()
    ) {
      throw new Error(
        `playbooks.${id}.from must be a canonical trimmed module specifier`,
      );
    }
    const configuredFrom = canonicalizeRegistrySpecifier(block.from, configPath);
    if (configuredFrom !== storedItem.from) {
      throw new Error(
        `playbooks.${id}.from changed from the stored structural projection`,
      );
    }
    const command = block.command ?? storedItem.manifestCommand;
    if (command !== storedItem.command) {
      throw new Error(
        `playbooks.${id}.command changed from the stored structural projection`,
      );
    }
    const rolesMap = requireObject(block.roles, `playbooks.${id}.roles`);
    assertExactRoleBindings(
      id,
      Object.keys(rolesMap),
      storedItem.requiredRoleIds,
    );
    const bindings = {};
    for (const role of storedItem.requiredRoleIds) {
      const binding = resolveRoleBinding(
        rolesMap[role],
        `playbooks.${id}.roles.${role}`,
      );
      if (binding.playerId !== storedItem.roles[role].playerId) {
        throw new Error(
          `playbooks.${id}.roles.${role} changed its stored player binding`,
        );
      }
      bindings[role] = binding;
      if (binding.model !== undefined || binding.effort !== undefined) {
        let checkId;
        do {
          checkId = `binding-check-${tuningCheckIndex}`;
          tuningCheckIndex += 1;
        } while (configuredAgents.has(checkId));
        tuningChecks.push({
          id: checkId,
          agent: applyTuningOverrides(
            configuredAgents.get(binding.playerId),
            binding,
          ),
        });
      }
    }
    const optionSlice = Object.fromEntries(
      Object.entries(block).filter(
        ([key]) => !PLAYBOOK_LAUNCHER_KEYS.includes(key),
      ),
    );
    if (!isDeepStrictEqual(optionSlice, storedItem.options)) {
      throw new Error(
        `playbooks.${id} options changed from the stored structural projection`,
      );
    }
    authored.set(id, { bindings });
  }

  const firstRoleful = expectedMembers.playbookIds
    .map((id) => stored.catalog[id])
    .find((item) => item.requiredRoleIds.length > 0);
  const initialVisible =
    firstRoleful === undefined
      ? []
      : distinct(
          firstRoleful.requiredRoleIds.map(
            (role) => firstRoleful.roles[role].playerId,
          ),
        );
  const validationVisible =
    initialVisible.length === 0
      ? expectedMembers.playerIds.slice(0, 1)
      : initialVisible;
  const provisional = {
    captain: { ...captain, from: PLAYBOOK_CAPTAIN_MODULE, options: {} },
    players: [
      ...expectedMembers.playerIds.map((id) => ({
        id,
        ...configuredAgents.get(id),
      })),
      ...tuningChecks.map(({ id, agent }) => ({ id, ...agent })),
    ],
    layout: {
      ...(isObject(top.layout) ? top.layout : {}),
      initialVisible: validationVisible,
    },
    ...(top.notifications === undefined
      ? {}
      : { notifications: top.notifications }),
    ...(top.theme === undefined ? {} : { theme: top.theme }),
  };
  const normalizedHost = await normalizeHostConfig(provisional);
  const normalizedPresentationHost =
    initialVisible.length === 0 && expectedMembers.playerIds.length > 0
      ? await normalizeHostConfig({
          ...provisional,
          players: [],
          layout: { ...provisional.layout, initialVisible: [] },
        })
      : normalizedHost;
  const { from: _captainFrom, options: _captainOptions, ...normalizedCaptain } =
    normalizedHost.captain;
  captain = sessionAgentFromHostAgent(normalizedCaptain, 'captain');
  const hostAgents = new Map(
    normalizedHost.players.map(({ id, ...agent }) => [id, agent]),
  );
  const normalizedPlayerAgents = new Map(
    expectedMembers.playerIds.map((id) => [
      id,
      sessionAgentFromHostAgent(hostAgents.get(id), `players.${id}`),
    ]),
  );

  const catalog = Object.fromEntries(
    expectedMembers.playbookIds.map((id) => {
      const storedItem = stored.catalog[id];
      const bindings = authored.get(id).bindings;
      return [
        id,
        {
          ...cloneJson(storedItem, `stored catalog.${id}`),
          roles: Object.fromEntries(
            storedItem.requiredRoleIds.map((role) => {
              const binding = bindings[role];
              const agent = normalizedPlayerAgents.get(binding.playerId);
              return [
                role,
                {
                  playerId: binding.playerId,
                  model:
                    binding.model === undefined
                      ? agent.model
                      : overrideTuningSelection(binding.model),
                  effort:
                    binding.effort === undefined
                      ? agent.effort
                      : overrideTuningSelection(binding.effort),
                },
              ];
            }),
          ),
        },
      ];
    }),
  );
  const candidateStructure = {
    schemaVersion: stored.schemaVersion,
    captain: fixedAgentProjection(captain),
    players: expectedMembers.playerIds.map((id) => ({
      id,
      ...fixedAgentProjection(normalizedPlayerAgents.get(id)),
    })),
    catalog: Object.fromEntries(
      Object.entries(catalog).map(([id, item]) => [
        id,
        {
          ...cloneJson(stored.catalog[id], `stored catalog.${id}`),
          roles: Object.fromEntries(
            Object.entries(item.roles).map(([role, binding]) => [
              role,
              { playerId: binding.playerId },
            ]),
          ),
        },
      ]),
    ),
  };
  if (!isDeepStrictEqual(candidateStructure, stored)) {
    throw new Error(
      'current selected config does not reproduce the stored structural projection',
    );
  }

  return deepFreeze(
    cloneJson(
      {
        schemaVersion: 1,
        captain,
        players: expectedMembers.playerIds.map((id) => ({
          id,
          agent: normalizedPlayerAgents.get(id),
        })),
        catalog,
        presentation: {
          layout: {
            ...normalizedPresentationHost.layout,
            initialVisible,
          },
          notifications: normalizedPresentationHost.notifications,
          ...(normalizedPresentationHost.theme === undefined
            ? {}
            : { theme: normalizedPresentationHost.theme }),
        },
      },
      'selected launch config',
    ),
  );
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

function rejectConfiguredHostCapabilities(value, path) {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    hasOwn(value, HOST_CAPABILITIES_OPTION_KEY)
  ) {
    throw new Error(
      `${path}.${HOST_CAPABILITIES_OPTION_KEY} is host-owned and cannot be configured`,
    );
  }
}

// PBCLI-46: normalize into a detached, deeply frozen JSON plan. The plan has
// only execution data and presentation data; imported registry functions are
// consulted for validation and then discarded.
export async function normalizeLaunchPlan(
  top,
  { loadModule, configPath, prepareRegistryModule, selectedMembers } = {},
) {
  const importModule = loadModule ?? ((specifier) => import(specifier));
  top = projectSelectedMembers(top, selectedMembers);
  top = cloneJson(top, 'config');
  assertNoRetiredProfiles(top, configPath);
  if (hasOwn(top, 'run')) {
    throw new Error(
      'top-level "run" was removed: configure the shared Captain under ' +
        'captain, top-level players, and playbooks.<id>.roles instead',
    );
  }
  const unknownTopLevel = Object.keys(top).filter(
    (key) => !PLAYBOOK_TOP_LEVEL_KEYS.has(key),
  );
  if (unknownTopLevel.length > 0) {
    throw new Error(
      `config has unknown top-level ${formatKeyList(unknownTopLevel)}`,
    );
  }
  if (top.layout !== undefined && !isObject(top.layout)) {
    throw new Error('layout must be a map');
  }

  const playersCfg = requireObject(top.players, 'players');
  const allPlayerIds = Object.keys(playersCfg);
  const configuredAgents = new Map();
  for (const playerId of allPlayerIds) {
    assertPlayerId(playerId, `players.${playerId}`);
    const agent = resolveAgent(playersCfg[playerId], `players.${playerId}`, [
      'id',
    ]);
    if (
      typeof agent.adapter !== 'string' ||
      agent.adapter.trim().length === 0
    ) {
      throw new Error(`players.${playerId} must resolve an adapter`);
    }
    configuredAgents.set(playerId, agent);
  }

  const playbooksCfg = requireObject(top.playbooks, 'playbooks');
  const ids = Object.keys(playbooksCfg);
  if (ids.length === 0) {
    throw new Error('playbooks must enable at least one playbook');
  }
  if (ids.some((id) => id.trim().length === 0 || id !== id.trim())) {
    throw new Error('playbooks keys must be canonical trimmed nonblank ids');
  }

  let captain = resolveAgent(top.captain, 'captain', ['from', 'options']);
  if (
    typeof captain.adapter !== 'string' ||
    captain.adapter.trim().length === 0
  ) {
    throw new Error('captain must resolve an adapter');
  }

  // Validate and detach every retained config-owned value before provisioning
  // or importing any registry. That keeps malformed config side-effect free.
  const configuredPlaybooks = [];
  const tuningChecks = [];
  let tuningCheckIndex = 0;
  for (const id of ids) {
    if (id === RESERVED_CAPTAIN_PLAYBOOK_ID) {
      throw new Error(
        `playbooks.${id} collides with the reserved internal Captain id`,
      );
    }
    const block = requireObject(playbooksCfg[id], `playbooks.${id}`);
    if (hasOwn(block, 'players')) {
      throw legacyPlayersError(`playbooks.${id}.players`, configPath);
    }
    rejectConfiguredHostCapabilities(block, `playbooks.${id}`);
    const from = block.from;
    if (
      typeof from !== 'string' ||
      from.trim().length === 0 ||
      from !== from.trim()
    ) {
      throw new Error(
        `playbooks.${id}.from must be a canonical trimmed module specifier`,
      );
    }
    if (
      block.command !== undefined &&
      (typeof block.command !== 'string' ||
        block.command.trim().length === 0 ||
        block.command !== block.command.trim())
    ) {
      throw new Error(
        `playbooks.${id}.command must be a canonical trimmed nonblank string`,
      );
    }
    if (block.command === RESERVED_CAPTAIN_PLAYBOOK_ID) {
      throw new Error(
        `playbooks.${id}.command collides with the reserved internal Captain command`,
      );
    }
    const rolesMap = requireObject(block.roles, `playbooks.${id}.roles`);
    const roles = Object.keys(rolesMap);
    if (roles.some((role) => role.trim().length === 0)) {
      throw new Error(`playbooks.${id}.roles keys must be nonblank role ids`);
    }
    if (roles.includes(RESERVED_CAPTAIN_ROLE_ID)) {
      throw new Error(
        `playbooks.${id}.roles.${RESERVED_CAPTAIN_ROLE_ID} binds local ` +
          `role "${RESERVED_CAPTAIN_ROLE_ID}", which is reserved for the ` +
          'tmux-play Captain',
      );
    }
    const bindings = Object.create(null);
    for (const role of roles) {
      assertRoleId(role, `playbooks.${id}.roles.${role}`);
      const binding = resolveRoleBinding(
        rolesMap[role],
        `playbooks.${id}.roles.${role}`,
      );
      const agent = configuredAgents.get(binding.playerId);
      if (agent === undefined) {
        throw new Error(
          `playbooks.${id}.roles.${role} names unknown player ` +
            JSON.stringify(binding.playerId),
        );
      }
      bindings[role] = binding;
      if (binding.model !== undefined || binding.effort !== undefined) {
        let checkId;
        do {
          checkId = `binding-check-${tuningCheckIndex}`;
          tuningCheckIndex += 1;
        } while (configuredAgents.has(checkId));
        tuningChecks.push({
          id: checkId,
          agent: applyTuningOverrides(agent, binding),
        });
      }
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
      bindings,
      optionSlice,
    });
  }

  // Both front ends consume the exact installed cligent schema. Normalize a
  // detached provisional projection before any registry preparation/import,
  // then feed its agent and presentation fields back into the authoritative
  // plan. The interactive child will only revalidate these same values.
  const firstRoleful = configuredPlaybooks.find(
    (configured) => configured.roles.length > 0,
  );
  const provisionalVisible =
    firstRoleful === undefined
      ? []
      : distinct(
          firstRoleful.roles.map(
            (role) => firstRoleful.bindings[role].playerId,
          ),
        );
  // An all-roleless catalog still validates every authored player through
  // cligent, but the validation-only projection must respect tmux-play's
  // invariant that a nonempty roster has at least one visible pane.
  const validationVisible =
    provisionalVisible.length === 0
      ? allPlayerIds.slice(0, 1)
      : provisionalVisible;
  const provisional = {
    captain: {
      ...captain,
      from: PLAYBOOK_CAPTAIN_MODULE,
      options: {},
    },
    players: [
      ...allPlayerIds.map((id) => ({
        id,
        ...configuredAgents.get(id),
      })),
      ...tuningChecks.map(({ id, agent }) => ({ id, ...agent })),
    ],
    layout: {
      ...(isObject(top.layout) ? top.layout : {}),
      initialVisible: validationVisible,
    },
    ...(top.notifications === undefined
      ? {}
      : { notifications: top.notifications }),
    ...(top.theme === undefined ? {} : { theme: top.theme }),
  };
  const normalizedHost = await normalizeHostConfig(provisional);
  // The authoritative all-roleless projection is Boss-only. Normalize that
  // exact empty host shape separately so derived presentation aliases (most
  // notably active `columnWeights`) match zero visible player panes rather
  // than the temporary validation pane above.
  const normalizedPresentationHost =
    provisionalVisible.length === 0 && allPlayerIds.length > 0
      ? await normalizeHostConfig({
          ...provisional,
          players: [],
          layout: { ...provisional.layout, initialVisible: [] },
        })
      : normalizedHost;
  const { from: _captainFrom, options: _captainOptions, ...normalizedCaptain } =
    normalizedHost.captain;
  captain = sessionAgentFromHostAgent(normalizedCaptain, 'captain');
  const hostAgents = new Map(
    normalizedHost.players.map(({ id, ...agent }) => [id, agent]),
  );
  const normalizedPlayerAgents = new Map(
    allPlayerIds.map((id) => [
      id,
      sessionAgentFromHostAgent(hostAgents.get(id), `players.${id}`),
    ]),
  );

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
    preparedFrom = canonicalizePreparedRegistrySpecifier(
      preparedFrom,
      `playbooks.${id}.from`,
    );
    preparedPlaybooks.push({ ...configured, preparedFrom });
  }

  const catalogEntries = [];
  const seenCommands = new Map();
  const seenIds = new Set();

  for (const {
    id,
    from,
    preparedFrom,
    commandOverride,
    roles,
    bindings,
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
    const entry = snapshotRegistryEntry(mod?.default);
    const registryProblem = invalidRegistryEntryReason(entry);
    if (registryProblem !== undefined) {
      throw new Error(
        `playbooks.${id}.from "${from}" exposes no valid registry entry: ` +
          registryProblem,
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

    assertExactRoleBindings(id, roles, entry.requiredRoleIds);
    const resolvedRoles = Object.fromEntries(
      entry.requiredRoleIds.map((role) => {
        const binding = bindings[role];
        const agent = normalizedPlayerAgents.get(binding.playerId);
        return [
          role,
          {
            playerId: binding.playerId,
            model:
              binding.model === undefined
                ? agent.model
                : overrideTuningSelection(binding.model),
            effort:
              binding.effort === undefined
                ? agent.effort
                : overrideTuningSelection(binding.effort),
          },
        ];
      }),
    );
    assertConcurrentPlayers(id, entry.concurrentRoleSets, resolvedRoles);

    catalogEntries.push([
      id,
      {
        id,
        from: preparedFrom,
        // Keep the registry-authored default even when launcher config
        // overrides the effective command. Durable continuation validates
        // this manifest identity but still executes the frozen command.
        manifestCommand: entry.command,
        command,
        ...(commandOverride === undefined ? {} : { commandOverride }),
        intent: entry.intent,
        artifactSchema: entry.artifactSchema,
        requiredRoleIds: [...entry.requiredRoleIds],
        concurrentRoleSets: entry.concurrentRoleSets.map((set) => [...set]),
        roles: resolvedRoles,
        options: optionSlice,
      },
    ]);
  }

  // Registry role order is the canonical role order. Derive the one roster
  // union only after every exact role map is closed against its manifest.
  const referencedPlayerIds = distinct(
    catalogEntries.flatMap(([, item]) =>
      Object.values(item.roles).map((binding) => binding.playerId),
    ),
  );

  const firstVisibleCatalog = catalogEntries.find(
    ([, item]) => Object.keys(item.roles).length > 0,
  );
  const initialVisible =
    firstVisibleCatalog === undefined
      ? []
      : distinct(
          Object.values(firstVisibleCatalog[1].roles).map(
            (binding) => binding.playerId,
          ),
        );
  const presentation = {
    layout: {
      ...normalizedPresentationHost.layout,
      initialVisible,
    },
    notifications: normalizedPresentationHost.notifications,
    ...(normalizedPresentationHost.theme === undefined
      ? {}
      : { theme: normalizedPresentationHost.theme }),
  };

  return deepFreeze(
    cloneJson(
      {
        schemaVersion: 1,
        captain,
        players: referencedPlayerIds.map((id) => ({
          id,
          agent: normalizedPlayerAgents.get(id),
        })),
        catalog: Object.fromEntries(catalogEntries),
        presentation,
      },
      'launch config',
    ),
  );
}

// Run cligent's public explicit-config loader over an isolated projection so
// generic launch planning tracks the installed host schema without importing
// or duplicating cligent's private validators.
export async function normalizeHostConfig(config) {
  const dir = mkdtempSync(join(tmpdir(), 'playbook-host-config-'));
  const path = join(dir, 'tmux-play.config.yaml');
  try {
    writeFileSync(path, stringifyYaml(config));
    return (await loadTmuxPlayConfig({ configPath: path })).config;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// PBCLI-8/9/10/46: tmux is one projection of the host-neutral plan. The
// projection is detached so cligent normalization cannot mutate the plan.
export function projectTmuxConfig(plan) {
  const playbooks = Object.fromEntries(
    Object.entries(plan.catalog).map(([id, item]) => [
      id,
      {
        from: item.from,
        command: item.command,
        roles: cloneJson(item.roles, `catalog.${id}.roles`),
        options: cloneJson(item.options, `catalog.${id}.options`),
      },
    ]),
  );
  const captain = {
    ...projectHostAgent(plan.captain, 'captain'),
    from: PLAYBOOK_CAPTAIN_MODULE,
  };
  captain.options = {
    playbooks,
    sessionAgents: {
      captain: cloneJson(plan.captain, 'captain'),
      players: Object.fromEntries(
        plan.players.map(({ id, agent }) => [
          id,
          cloneJson(agent, `players.${id}.agent`),
        ]),
      ),
    },
    ...(typeof captain.adapter === 'string' && captain.adapter.length > 0
      ? { captainAdapter: captain.adapter }
      : {}),
  };
  const config = {
    captain,
    players: plan.players.map(({ id, agent }) => ({
      ...projectHostAgent(agent, `players.${id}.agent`),
      id,
    })),
    layout: projectHostLayout(plan.presentation.layout),
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

function projectHostLayout(layout) {
  const projected = cloneJson(layout, 'presentation.layout');
  // cligent's normalized runtime shape carries `columnWeights` as the
  // derived active-shape value alongside both canonical shape fields. The
  // authored schema deliberately rejects that alias/canonical combination,
  // so the interactive child projection must serialize canonical authority
  // only; its loader deterministically derives the same alias again.
  if (
    Array.isArray(projected.singlePlayerColumnWeights) &&
    Array.isArray(projected.multiPlayerColumnWeights)
  ) {
    delete projected.columnWeights;
  }
  return projected;
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
    if (error?.code === 'PLAYBOOK_LEGACY_PLAYERS') {
      throw legacyPlayersError(error.legacyPath, userConfigPath);
    }
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
  const playbooks = doc.get('playbooks');
  if (playbooks && Array.isArray(playbooks.items)) {
    for (const entry of playbooks.items) {
      const id = String(entry.key);
      if (doc.getIn(['playbooks', id, 'players']) !== undefined) {
        throw legacyPlayersError(`playbooks.${id}.players`);
      }
    }
  }
  const profiles = doc.get('profiles');
  const agentPaths = [['captain']];
  const players = doc.get('players');
  if (players && Array.isArray(players.items)) {
    for (const player of players.items) {
      agentPaths.push(['players', String(player.key)]);
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
        'inline under captain and each top-level players.<player-id> ' +
        '(adapter, model, effort, permissions)',
    );
  }
  const legacyPath = findLegacyPlayersPath(top);
  if (legacyPath !== undefined) throw legacyPlayersError(legacyPath, configPath);
  const blocks = [['captain', top.captain]];
  const playersCfg = isObject(top.players) ? top.players : {};
  for (const [playerId, agent] of Object.entries(playersCfg)) {
    blocks.push([`players.${playerId}`, agent]);
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

// Imported manifests remain live JavaScript objects. Capture every member this
// host consumes once, then validate and project only the detached record so a
// getter or later mutation cannot make those two phases observe different
// compatibility declarations or identities.
export function snapshotRegistryEntry(value) {
  if (!isObject(value)) return value;
  return {
    id: value.id,
    command: value.command,
    intent: value.intent,
    artifactSchema: value.artifactSchema,
    runtimeProfile: value.runtimeProfile,
    requiredRoleIds: value.requiredRoleIds,
    concurrentRoleSets: value.concurrentRoleSets,
    validateOptions: value.validateOptions,
    createRuntime: value.createRuntime,
  };
}

export function invalidRegistryEntryReason(value) {
  if (!isObject(value)) return 'the default export must be an object';
  if (
    typeof value.id !== 'string' ||
    value.id.trim().length === 0 ||
    value.id !== value.id.trim()
  ) {
    return 'id must be a canonical trimmed nonblank string';
  }
  if (
    typeof value.command !== 'string' ||
    value.command.trim().length === 0 ||
    value.command !== value.command.trim()
  ) {
    return 'command must be a canonical trimmed nonblank string';
  }
  if (typeof value.intent !== 'string') return 'intent must be a string';
  if (value.artifactSchema !== 3) {
    return 'artifactSchema must be 3';
  }
  const runtimeProfileProblem = invalidRuntimeProfileReason(
    value.runtimeProfile,
    value.artifactSchema,
  );
  if (runtimeProfileProblem !== undefined) return runtimeProfileProblem;
  const roleProblem = invalidManifestRoles(value.requiredRoleIds);
  if (roleProblem !== undefined) return `requiredRoleIds ${roleProblem}`;
  const concurrentProblem = invalidConcurrentRoleSets(
    value.concurrentRoleSets,
    value.requiredRoleIds,
  );
  if (concurrentProblem !== undefined) {
    return `concurrentRoleSets ${concurrentProblem}`;
  }
  if (typeof value.validateOptions !== 'function') {
    return 'validateOptions must be a function';
  }
  if (typeof value.createRuntime !== 'function') {
    return 'createRuntime must be a function';
  }
  return undefined;
}

function invalidRuntimeProfileReason(value, advertisedArtifactSchema) {
  if (!isPlainObject(value)) {
    return 'runtimeProfile must be a plain object';
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (
    kindDescriptor === undefined ||
    kindDescriptor.get !== undefined ||
    kindDescriptor.set !== undefined ||
    kindDescriptor.enumerable !== true
  ) {
    return 'runtimeProfile.kind must be an enumerable data property';
  }
  const kind = kindDescriptor.value;
  if (kind === 'shared-factory') {
    const profile = exactPlainDataRecord(value, ['kind', 'compat']);
    if (profile === undefined) {
      return 'shared-factory runtimeProfile must contain exactly kind and compat data properties';
    }
    const compat = exactPlainDataRecord(profile.compat, [
      'artifactSchema',
      'runtimeAbi',
    ]);
    if (compat === undefined) {
      return 'shared-factory runtimeProfile.compat must contain exactly artifactSchema and runtimeAbi data properties';
    }
    if (!Number.isSafeInteger(compat.artifactSchema)) {
      return 'shared-factory runtimeProfile.compat.artifactSchema must be an integer';
    }
    if (!Number.isSafeInteger(compat.runtimeAbi)) {
      return 'shared-factory runtimeProfile.compat.runtimeAbi must be an integer';
    }
    if (compat.artifactSchema !== advertisedArtifactSchema) {
      return 'artifactSchema must match runtimeProfile.compat.artifactSchema';
    }
    return undefined;
  }
  if (kind === 'bespoke') {
    const profile = exactPlainDataRecord(value, ['kind', 'artifactSchema']);
    if (profile === undefined) {
      return 'bespoke runtimeProfile must contain exactly kind and artifactSchema data properties';
    }
    if (!Number.isSafeInteger(profile.artifactSchema)) {
      return 'bespoke runtimeProfile.artifactSchema must be an integer';
    }
    if (profile.artifactSchema !== advertisedArtifactSchema) {
      return 'artifactSchema must match runtimeProfile.artifactSchema';
    }
    return undefined;
  }
  return 'runtimeProfile.kind must be shared-factory or bespoke';
}

function exactPlainDataRecord(value, expectedKeys) {
  if (!isPlainObject(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some(
      (key) => typeof key !== 'string' || !expectedKeys.includes(key),
    )
  ) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    expectedKeys.some((key) => {
      const descriptor = descriptors[key];
      return (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      );
    })
  ) {
    return undefined;
  }
  return Object.fromEntries(
    expectedKeys.map((key) => [key, descriptors[key].value]),
  );
}

function validateStoredStructuralProjection(value) {
  const stored = cloneJson(value, 'stored structural projection');
  if (!isPlainObject(stored) || stored.schemaVersion !== 1) {
    throw new Error('stored structural projection schema 1 is required');
  }
  const captain = requireObject(stored.captain, 'stored structural captain');
  if (typeof captain.adapter !== 'string' || captain.adapter.length === 0) {
    throw new Error('stored structural captain must name an adapter');
  }
  if (!Array.isArray(stored.players) || !isPlainObject(stored.catalog)) {
    throw new Error(
      'stored structural projection must contain players and catalog',
    );
  }
  const playerIds = stored.players.map((player, index) => {
    const record = requireObject(player, `stored structural players.${index}`);
    assertPlayerId(record.id, `stored structural players.${index}.id`);
    if (typeof record.adapter !== 'string' || record.adapter.length === 0) {
      throw new Error(
        `stored structural players.${index} must name an adapter`,
      );
    }
    return record.id;
  });
  if (new Set(playerIds).size !== playerIds.length) {
    throw new Error('stored structural player ids must be unique');
  }
  for (const [id, itemValue] of Object.entries(stored.catalog)) {
    const item = requireObject(itemValue, `stored structural catalog.${id}`);
    if (item.id !== id || id === RESERVED_CAPTAIN_PLAYBOOK_ID) {
      throw new Error(`stored structural catalog.${id}.id is invalid`);
    }
    for (const field of [
      'from',
      'manifestCommand',
      'command',
      'intent',
    ]) {
      if (typeof item[field] !== 'string') {
        throw new Error(`stored structural catalog.${id}.${field} is invalid`);
      }
    }
    if (
      !Array.isArray(item.requiredRoleIds) ||
      !Array.isArray(item.concurrentRoleSets) ||
      !isPlainObject(item.roles) ||
      !isPlainObject(item.options)
    ) {
      throw new Error(`stored structural catalog.${id} is malformed`);
    }
    if (item.artifactSchema !== 3) {
      throw new Error(
        `stored structural catalog.${id}.artifactSchema must be 3`,
      );
    }
    rejectConfiguredHostCapabilities(
      item.options,
      `stored structural catalog.${id}.options`,
    );
    if (
      JSON.stringify(Object.keys(item.roles)) !==
      JSON.stringify(item.requiredRoleIds)
    ) {
      throw new Error(
        `stored structural catalog.${id}.roles must follow requiredRoleIds`,
      );
    }
    for (const role of item.requiredRoleIds) {
      assertRoleId(role, `stored structural catalog.${id}.roles.${role}`);
      const binding = requireObject(
        item.roles[role],
        `stored structural catalog.${id}.roles.${role}`,
      );
      if (!playerIds.includes(binding.playerId)) {
        throw new Error(
          `stored structural catalog.${id}.roles.${role} names an absent player`,
        );
      }
    }
  }
  return stored;
}

function selectedMembersFromStoredStructure(stored) {
  return {
    playbookIds: Object.keys(stored.catalog),
    playerIds: stored.players.map((player) => player.id),
  };
}

function fixedAgentProjection(agent) {
  return {
    adapter: agent.adapter,
    ...(agent.instruction === undefined
      ? {}
      : { instruction: agent.instruction }),
    ...(agent.permissions === undefined
      ? {}
      : { permissions: agent.permissions }),
  };
}

function projectSelectedMembers(top, selectedMembers) {
  if (selectedMembers === undefined) return top;
  const { playbookIds, playerIds } = validateSelectedMembers(selectedMembers);
  if (!isPlainObject(top)) {
    throw new Error('config must contain only plain JSON objects');
  }

  const descriptors = Object.getOwnPropertyDescriptors(top);
  const keys = Reflect.ownKeys(top);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      typeof key === 'symbol' ||
      descriptor?.get !== undefined ||
      descriptor?.set !== undefined ||
      descriptor?.enumerable !== true
    ) {
      throw new Error(
        `config.${String(key)} must be an enumerable data property`,
      );
    }
  }
  const projected = Object.fromEntries(
    keys.map((key) => [key, descriptors[key].value]),
  );
  projected.playbooks = projectSelectedMap(
    projected.playbooks,
    playbookIds,
    'playbooks',
  );
  projected.players = projectSelectedMap(
    projected.players,
    playerIds,
    'players',
  );
  return projected;
}

function validateSelectedMembers(selectedMembers) {
  const selected = cloneJson(selectedMembers, 'selectedMembers');
  const unknownSelectionKeys = Object.keys(selected).filter(
    (key) => !['playbookIds', 'playerIds'].includes(key),
  );
  if (unknownSelectionKeys.length > 0) {
    throw new Error(
      `selectedMembers has unknown ${formatKeyList(unknownSelectionKeys)}`,
    );
  }
  return {
    playbookIds: selectedIdList(
      selected.playbookIds,
      'selectedMembers.playbookIds',
    ),
    playerIds: selectedIdList(
      selected.playerIds,
      'selectedMembers.playerIds',
    ),
  };
}

function projectSelectedLayer(value, selected, path) {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must contain only plain JSON objects`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = descriptors[key];
    if (
      typeof key === 'symbol' ||
      descriptor?.get !== undefined ||
      descriptor?.set !== undefined ||
      descriptor?.enumerable !== true
    ) {
      throw new Error(
        `${path}.${String(key)} must be an enumerable data property`,
      );
    }
    if (key === 'playbooks' || key === 'players') {
      entries.push([
        key,
        projectOptionalSelectedMap(
          descriptor.value,
          key === 'playbooks' ? selected.playbookIds : selected.playerIds,
          `${path}.${key}`,
        ),
      ]);
    } else {
      entries.push([key, descriptor.value]);
    }
  }
  return Object.fromEntries(entries);
}

function projectOptionalSelectedMap(value, ids, path) {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must contain only plain JSON objects`);
  }
  const entries = [];
  for (const id of ids) {
    const descriptor = Object.getOwnPropertyDescriptor(value, id);
    if (descriptor === undefined) continue;
    if (
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw new Error(`${path}.${id} must be an enumerable data property`);
    }
    entries.push([id, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function projectSelectedMap(value, ids, path) {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must contain only plain JSON objects`);
  }
  return Object.fromEntries(
    ids.map((id) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, id);
      if (descriptor === undefined) {
        throw new Error(
          `selected ${path} member ${JSON.stringify(id)} is missing`,
        );
      }
      if (
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        throw new Error(`${path}.${id} must be an enumerable data property`);
      }
      return [id, descriptor.value];
    }),
  );
}

function selectedIdList(value, path) {
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== 'string' || id.trim().length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${path} must be a duplicate-free array of nonblank ids`);
  }
  return value;
}

function resolveRoleBinding(value, path) {
  if (typeof value === 'string') {
    assertPlayerId(value, path);
    return { playerId: value };
  }
  const block = requireObject(value, path);
  const unknown = Object.keys(block).filter(
    (key) => !['player', 'model', 'effort'].includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(`${path} has unknown ${formatKeyList(unknown)}`);
  }
  assertPlayerId(block.player, `${path}.player`);
  for (const field of ['model', 'effort']) {
    if (
      block[field] !== undefined &&
      block[field] !== false &&
      (typeof block[field] !== 'string' || block[field].trim().length === 0)
    ) {
      throw new Error(
        `${path}.${field} must be a nonblank string or false for provider-default`,
      );
    }
  }
  return {
    playerId: block.player,
    ...(block.model === undefined ? {} : { model: block.model }),
    ...(block.effort === undefined ? {} : { effort: block.effort }),
  };
}

function applyTuningOverrides(agent, binding) {
  const effective = { ...agent };
  if (binding.model === false) delete effective.model;
  else if (binding.model !== undefined) effective.model = binding.model;
  if (binding.effort !== undefined) {
    delete effective.reasoningEffort;
    if (binding.effort === false) delete effective.effort;
    else effective.effort = binding.effort;
  }
  return effective;
}

function sessionAgentFromHostAgent(agent, path) {
  if (!isObject(agent)) {
    throw new Error('installed cligent omitted a retained agent');
  }
  return {
    adapter: agent.adapter,
    model: tuningSelection(agent.model, `${path}.model`),
    effort: tuningSelection(agent.effort, `${path}.effort`),
    ...(agent.instruction === undefined
      ? {}
      : { instruction: agent.instruction }),
    ...(agent.permissions === undefined
      ? {}
      : { permissions: agent.permissions }),
  };
}

// Shared by the interactive and headless host projections. A tagged
// provider-default is represented to cligent by omitting that configured
// default; the complete tagged selection remains in sessionAgents.
export function projectHostAgent(agent, path = 'agent') {
  const normalized = cloneJson(agent, path);
  return {
    adapter: normalized.adapter,
    ...(normalized.model?.kind === 'value'
      ? { model: normalized.model.value }
      : {}),
    ...(normalized.effort?.kind === 'value'
      ? { effort: normalized.effort.value }
      : {}),
    ...(normalized.instruction === undefined
      ? {}
      : { instruction: normalized.instruction }),
    ...(normalized.permissions === undefined
      ? {}
      : { permissions: normalized.permissions }),
  };
}

function tuningSelection(value, path) {
  if (
    value !== undefined &&
    (typeof value !== 'string' || value.trim().length === 0)
  ) {
    throw new Error(`${path} must be a nonblank string`);
  }
  return value === undefined
    ? { kind: 'provider-default' }
    : { kind: 'value', value };
}

function overrideTuningSelection(value) {
  return value === false
    ? { kind: 'provider-default' }
    : tuningSelection(value, 'role tuning override');
}

function canonicalizePreparedRegistrySpecifier(value, path) {
  if (value !== value.trim()) {
    throw new Error(
      `${path} preparation must return a canonical trimmed module specifier`,
    );
  }
  if (
    isAbsolute(value) ||
    /^(?:\.{1,2}(?:[\\/]|$)|[\\/]|[A-Za-z]:[\\/])/.test(value)
  ) {
    throw new Error(
      `${path} preparation must return a canonical module specifier`,
    );
  }
  if (value.startsWith('file:')) {
    let canonical;
    try {
      canonical = pathToFileURL(fileURLToPath(value)).href;
    } catch {
      throw new Error(`${path} preparation must return a canonical file URL`);
    }
    if (canonical !== value) {
      throw new Error(`${path} preparation must return a canonical file URL`);
    }
  }
  return value;
}

function assertPlayerId(value, path) {
  if (typeof value !== 'string' || !PLAYER_ID_PATTERN.test(value)) {
    throw new Error(
      `${path} must name a player matching ${PLAYER_ID_PATTERN.source}`,
    );
  }
  if (value === RESERVED_CAPTAIN_ROLE_ID) {
    throw new Error(`${path} uses reserved player id "captain"`);
  }
}

function assertRoleId(value, path) {
  if (typeof value !== 'string' || !ROLE_ID_PATTERN.test(value)) {
    throw new Error(`${path} must use a canonical lowercase local role id`);
  }
  if (value === RESERVED_CAPTAIN_ROLE_ID) {
    throw new Error(`${path} uses reserved local role id "captain"`);
  }
}

function invalidManifestRoles(value) {
  if (!Array.isArray(value)) return 'must be an array';
  if (value.some((role) => typeof role !== 'string')) {
    return 'must contain only strings';
  }
  const canonical = value.map((role) => role.toLowerCase());
  if (new Set(canonical).size !== canonical.length) {
    return 'contains roles that collide after canonical lowercase derivation';
  }
  const invalid = value.find((role) => !ROLE_ID_PATTERN.test(role));
  if (invalid !== undefined) {
    return `contains noncanonical role ${JSON.stringify(invalid)}`;
  }
  if (value.includes(RESERVED_CAPTAIN_ROLE_ID)) {
    return 'contains reserved local role "captain"';
  }
  return undefined;
}

function invalidConcurrentRoleSets(value, requiredRoleIds) {
  if (!Array.isArray(value)) return 'must be an array';
  const required = new Set(requiredRoleIds);
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const set = value[index];
    if (!Array.isArray(set) || set.length < 2) {
      return `[${index}] must contain at least two roles`;
    }
    if (
      set.some(
        (role) =>
          typeof role !== 'string' ||
          !ROLE_ID_PATTERN.test(role) ||
          role === RESERVED_CAPTAIN_ROLE_ID ||
          !required.has(role),
      )
    ) {
      return `[${index}] must contain only required canonical local roles`;
    }
    if (new Set(set).size !== set.length) {
      return `[${index}] must contain pairwise-distinct roles`;
    }
    const signature = JSON.stringify(set);
    if (seen.has(signature)) return `contains duplicate set ${signature}`;
    seen.add(signature);
  }
  return undefined;
}

function assertExactRoleBindings(id, configured, required) {
  const missing = required.filter((role) => !configured.includes(role));
  const extra = configured.filter((role) => !required.includes(role));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `playbooks.${id}.roles must exactly cover requiredRoleIds` +
        `${missing.length === 0 ? '' : `; missing ${missing.map(JSON.stringify).join(', ')}`}` +
        `${
          extra.length === 0
            ? ''
            : `; extra ${extra.map(JSON.stringify).join(', ')}`
        }`,
    );
  }
}

function assertConcurrentPlayers(id, sets, roles) {
  for (const set of sets) {
    const playerIds = set.map((role) => roles[role].playerId);
    if (new Set(playerIds).size !== playerIds.length) {
      throw new Error(
        `playbooks.${id}.concurrentRoleSets ${JSON.stringify(set)} must bind ` +
          'to pairwise-distinct player ids',
      );
    }
  }
}

function distinct(values) {
  return [...new Set(values)];
}

function findLegacyPlayersPath(top) {
  const playbooks = isObject(top?.playbooks) ? top.playbooks : {};
  for (const [id, block] of Object.entries(playbooks)) {
    if (isObject(block) && hasOwn(block, 'players')) {
      return `playbooks.${id}.players`;
    }
  }
  return undefined;
}

function legacyPlayersError(path, configPath) {
  const where = configPath ? ` in ${configPath}` : '';
  const error = new Error(
    `${path} was removed in the explicit-session-player major release${where}: ` +
      'define stable ids in top-level players and bind them explicitly under ' +
      'playbooks.<id>.roles; automatic migration would choose which prior ' +
      'conversations share a session',
  );
  error.code = 'PLAYBOOK_LEGACY_PLAYERS';
  error.legacyPath = path;
  return error;
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

function isPlainObject(value) {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireObject(value, path) {
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  return value;
}

function formatKeyList(keys) {
  return `${keys.length === 1 ? 'key' : 'keys'} ${keys
    .map((key) => JSON.stringify(key))
    .join(', ')}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
