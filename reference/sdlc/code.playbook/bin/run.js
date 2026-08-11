// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-18/20 (DR-031): `playbook run [input]` is the non-interactive
// presentation of the same configured Captain session that `playbook` hosts
// in tmux. The core below uses cligent's ordinary tmux-play runtime without a
// presenter; it does not construct a registry runtime or PlaybookPorts itself.

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createTmuxPlayRuntime } from '@sublang/cligent/tmux-play';
import { snapshotJsonValue } from '../../../../src/xstate-runtime.js';
import { createPlaybookCaptainShell } from '../playbook-captain.js';
import {
  adapterSdkFailureLines,
  checkAdapterSdks,
  mappedSdksFor,
  probeAdapterSdk,
} from './adapter-sdk.js';
import {
  checkReadiness,
  loadLaunchPlan,
  normalizeHostConfig,
  PLAYBOOK_CAPTAIN_MODULE,
  resolveUserConfigPath,
} from './launch-config.js';
import { prepareConfiguredRegistries } from './provision.js';
import {
  createCaptainSessionStore,
  SESSION_ID_PATTERN,
  validateCaptainSessionRecord,
} from './session-store.js';

const EXIT = { ok: 0, argument: 1, turn: 2 };
const UUID_PATTERN = SESSION_ID_PATTERN;
class HeadlessHostSetupError extends Error {
  constructor(cause) {
    super(message(cause));
    this.name = 'HeadlessHostSetupError';
    this.cause = cause;
  }
}
const RETIRED_FLAGS = new Set([
  '--player',
  '--captain',
  '--option',
  '--cwd',
  '--last',
  '--config',
]);

export async function runPlaybookRun(options = {}) {
  const argv = [...(options.argv ?? [])];
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  let args;
  try {
    args = parseRunArgs(argv);
  } catch (error) {
    await writeStream(stderr, `playbook run: ${message(error)}\n`);
    return { code: EXIT.argument };
  }
  if (args.help) {
    const env = options.env ?? process.env;
    const home = options.homeDir ?? env.HOME ?? homedir();
    const userConfigPath =
      options.userConfigPath ?? resolveUserConfigPath(env, home);
    await writeStream(stdout, runHelpText(userConfigPath));
    return { code: EXIT.ok };
  }

  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? homedir();
  const recovering = args.retryUncertain || args.discardUncertain;
  const continuing = args.continue || args.sessionId !== undefined;
  let input = args.input;

  // PBCLI-18/40: a fresh piped producer is drained before config,
  // preparation, import, or readiness. Continuations first inspect the
  // selected record so an uncertain turn never blocks waiting for input;
  // explicit recovery never reads input at all.
  if (!continuing && !recovering) {
    const resolvedInput = await resolveBossInput(input, options, stderr);
    if (!resolvedInput.ok) return { code: EXIT.argument };
    input = resolvedInput.input;
  }

  let store;
  try {
    store =
      options.sessionStore ??
      createCaptainSessionStore({
        env,
        homeDir: home,
        ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.createSessionTempId
          ? { createTempId: options.createSessionTempId }
          : {}),
      });
  } catch (error) {
    await writeStream(stderr, `playbook run: ${message(error)}\n`);
    return { code: EXIT.argument };
  }

  let priorRecord;
  let lease;
  let sessionId;
  let config;
  let cwd;
  let restoreSnapshot;
  const loadModule = memoizedModuleLoader(
    options.loadModule ?? ((specifier) => import(specifier)),
  );
  const prepareRegistryModule = registryPreparer(args, options, stderr);

  if (continuing) {
    try {
      if (args.sessionId === undefined) {
        const selected = validateCaptainSessionRecord(
          await awaitWithAbort(store.latest(), options.signal),
        );
        sessionId = selected.sessionId;
      } else {
        sessionId = args.sessionId;
      }
      throwIfAborted(options.signal);
      lease = await store.acquire(sessionId);
      throwIfAborted(options.signal);
      const authoritative = await lease.read();
      throwIfAborted(options.signal);
      if (authoritative === undefined) {
        throw new Error(
          `Captain session ${JSON.stringify(sessionId)} does not exist`,
        );
      }
      priorRecord = validateCaptainSessionRecord(authoritative);
      assertLogicalSessionIdDistinct(priorRecord);
    } catch (error) {
      const releaseError = await releaseLease(lease);
      await writeStream(stderr, `playbook run: ${message(error)}\n`);
      if (releaseError !== undefined) {
        await writeStream(
          stderr,
          `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
        );
        return { code: EXIT.turn };
      }
      return { code: EXIT.argument };
    }

    if (priorRecord.state === 'uncertain') {
      if (args.discardUncertain) {
        try {
          throwIfAborted(options.signal);
          const record = await lease.discard({
            attemptId: priorRecord.uncertain.attemptId,
          });
          throwIfAborted(options.signal);
          const releaseError = await releaseLease(lease);
          lease = undefined;
          if (releaseError !== undefined) throw releaseError;
          await writeStream(
            stderr,
            `playbook run: discarded uncertain turn for Captain session ${JSON.stringify(sessionId)}\n`,
          );
          return { code: EXIT.ok, sessionId, record };
        } catch (error) {
          const releaseError = await releaseLease(lease);
          await writeStream(
            stderr,
            `playbook run: cannot discard uncertain Captain turn: ${message(error)}\n`,
          );
          if (releaseError !== undefined) {
            await writeStream(
              stderr,
              `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
            );
          }
          return { code: EXIT.turn };
        }
      }
      if (!args.retryUncertain) {
        const releaseError = await releaseLease(lease);
        lease = undefined;
        await reportUncertainSession(stderr, sessionId);
        if (releaseError !== undefined) {
          await writeStream(
            stderr,
            `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
          );
          return { code: EXIT.turn };
        }
        return { code: EXIT.argument };
      }
      input = priorRecord.uncertain.input;
    } else if (recovering) {
      const releaseError = await releaseLease(lease);
      lease = undefined;
      await writeStream(
        stderr,
        `playbook run: Captain session ${JSON.stringify(sessionId)} has no uncertain turn to recover\n`,
      );
      if (releaseError !== undefined) {
        await writeStream(
          stderr,
          `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
        );
        return { code: EXIT.turn };
      }
      return { code: EXIT.argument };
    } else {
      const resolvedInput = await resolveBossInput(input, options, stderr);
      if (!resolvedInput.ok) {
        const releaseError = await releaseLease(lease);
        if (releaseError !== undefined) {
          await writeStream(
            stderr,
            `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
          );
          return { code: EXIT.turn };
        }
        return { code: EXIT.argument };
      }
      input = resolvedInput.input;
    }

    cwd = priorRecord.cwd;
    restoreSnapshot = priorRecord.snapshot;
  } else {
    const userConfigPath =
      options.userConfigPath ?? resolveUserConfigPath(env, home);
    let plan;
    const configNotices = [];
    try {
      throwIfAborted(options.signal);
      plan = await loadLaunchPlan({
        userConfigPath,
        overlayPaths: args.withPaths,
        loadModule,
        prepareRegistryModule,
        onNotice: (line) => configNotices.push(line),
      });
      throwIfAborted(options.signal);
    } catch (error) {
      for (const line of configNotices) await writeStream(stderr, line);
      await writeStream(stderr, `playbook run: ${message(error)}\n`);
      return { code: EXIT.argument };
    }
    for (const line of configNotices) await writeStream(stderr, line);

    try {
      sessionId = (options.createLogicalSessionId ?? randomUUID)();
      if (typeof sessionId !== 'string' || !UUID_PATTERN.test(sessionId)) {
        throw new Error(
          `logical session id generator returned a non-UUID value: ${JSON.stringify(sessionId)}`,
        );
      }
      config = executionConfigFromPlan(plan);
      cwd = resolve(options.cwd ?? process.cwd());
    } catch (error) {
      const releaseError = await releaseLease(lease);
      await writeStream(stderr, `playbook run: ${message(error)}\n`);
      if (releaseError !== undefined) {
        await writeStream(
          stderr,
          `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
        );
        return { code: EXIT.turn };
      }
      return { code: EXIT.argument };
    }
  }

  if (continuing) {
    try {
      throwIfAborted(options.signal);
      config = await validateFrozenExecutionConfig(priorRecord.config, {
        loadModule,
        prepareRegistryModule,
      });
      throwIfAborted(options.signal);
    } catch (error) {
      const releaseError = await releaseLease(lease);
      await writeStream(stderr, `playbook run: ${message(error)}\n`);
      if (releaseError !== undefined) {
        await writeStream(
          stderr,
          `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
        );
        return { code: EXIT.turn };
      }
      return { code: EXIT.argument };
    }
  }

  const adapters = adaptersFromExecutionConfig(config);
  const readiness = checkReadiness(adapters, env, home);
  let sdkReadiness;
  try {
    sdkReadiness = await awaitWithAbort(
      checkAdapterSdks(
        adapters,
        options.probeAdapterSdk ?? probeAdapterSdk,
        ...(options.classifyRuntime ? [options.classifyRuntime] : []),
      ),
      options.signal,
    );
  } catch (error) {
    const releaseError = await releaseLease(lease);
    await writeStream(
      stderr,
      `playbook run: adapter readiness failed: ${message(error)}\n`,
    );
    if (releaseError !== undefined) {
      await writeStream(
        stderr,
        `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
      );
      return { code: EXIT.turn };
    }
    return { code: EXIT.argument };
  }
  for (const adapter of readiness.unknownAdapters) {
    await writeStream(
      stderr,
      `playbook run: warning: no readiness check for adapter "${adapter}"\n`,
    );
  }
  if (
    readiness.failingAdapters.length > 0 ||
    sdkReadiness.unusableAdapters.length > 0
  ) {
    await reportReadinessFailure({
      stderr,
      adapters,
      failingAdapters: readiness.failingAdapters,
      unusableAdapters: sdkReadiness.unusableAdapters,
      invocation: replayInvocation(argv, args, input),
      ephemeralNpx: options.ephemeralNpx,
    });
    const releaseError = await releaseLease(lease);
    if (releaseError !== undefined) {
      await writeStream(
        stderr,
        `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
      );
      return { code: EXIT.turn };
    }
    return { code: EXIT.argument };
  }

  if (lease === undefined) {
    try {
      throwIfAborted(options.signal);
      lease = await store.acquire(sessionId);
      throwIfAborted(options.signal);
    } catch (error) {
      const releaseError = await releaseLease(lease);
      await writeStream(stderr, `playbook run: ${message(error)}\n`);
      if (releaseError !== undefined) {
        await writeStream(
          stderr,
          `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
        );
        return { code: EXIT.turn };
      }
      return { code: EXIT.argument };
    }
  }

  let attemptId;
  try {
    attemptId = createAttemptId(options);
  } catch (error) {
    const releaseError = await releaseLease(lease);
    await writeStream(stderr, `playbook run: ${message(error)}\n`);
    if (releaseError !== undefined) {
      await writeStream(
        stderr,
        `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
      );
      return { code: EXIT.turn };
    }
    return { code: EXIT.argument };
  }

  let settled;
  try {
    settled = await driveHeadlessCaptainTurn({
      config,
      input,
      sessionId,
      cwd,
      loadModule,
      stderr,
      verbose: args.verbose,
      ...(options.adapterImports
        ? { adapterImports: options.adapterImports }
        : {}),
      ...(options.createCaptainRuntime
        ? { createCaptainRuntime: options.createCaptainRuntime }
        : {}),
      ...(options.createCaptainSessionId
        ? { createCaptainSessionId: options.createCaptainSessionId }
        : {}),
      ...(options.createHostRuntime
        ? { createHostRuntime: options.createHostRuntime }
        : {}),
      ...(restoreSnapshot !== undefined
        ? { restoreSnapshot }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      beforeBossTurn: async (baselineSnapshot) => {
        throwIfAborted(options.signal);
        return args.retryUncertain
          ? lease.beginRetry({
              expectedAttemptId: priorRecord.uncertain.attemptId,
              nextAttemptId: attemptId,
            })
          : lease.beginTurn({
              input,
              attemptId,
              ...(priorRecord === undefined
                ? {
                    fresh: {
                      cwd,
                      config,
                      snapshot: baselineSnapshot,
                    },
                  }
                : {}),
            });
      },
      assertBeforeBossTurn: () => lease.assertOwner(),
    });
  } catch (error) {
    const releaseError = await releaseLease(lease);
    await writeStream(stderr, `playbook run: ${message(error)}\n`);
    if (releaseError !== undefined) {
      await writeStream(
        stderr,
        `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
      );
    }
    return {
      code:
        error instanceof HeadlessHostSetupError && releaseError === undefined
          ? EXIT.argument
          : EXIT.turn,
    };
  }

  let durableRecord;
  try {
    throwIfAborted(options.signal);
    durableRecord = await lease.settle({
      attemptId: settled.uncertainRecord.uncertain.attemptId,
      snapshot: settled.snapshot,
    });
  } catch (error) {
    try {
      await settled.dispose();
    } catch {
      // Preserve the failed durable hand-off as the primary diagnostic.
    }
    await writeStream(
      stderr,
      `playbook run: cannot persist Captain session: ${message(error)}\n`,
    );
    const releaseError = await releaseLease(lease);
    if (releaseError !== undefined) {
      await writeStream(
        stderr,
        `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
      );
    }
    return { code: EXIT.turn };
  }

  const releaseError = await releaseLease(lease);
  lease = undefined;
  if (releaseError !== undefined) {
    await writeStream(
      stderr,
      `playbook run: cannot release Captain session lease: ${message(releaseError)}\n`,
    );
    return { code: EXIT.turn };
  }
  if (options.signal?.aborted) {
    await writeStream(
      stderr,
      'playbook run: Captain turn was interrupted; reply withheld\n',
    );
    return { code: EXIT.turn, sessionId, record: durableRecord };
  }

  // Durable hand-off transfers semantic ownership to the logical session.
  // Process exit owns ephemeral transport teardown; semantic disposal here
  // would end the session that `--continue` must restore.
  try {
    await presentHeadlessCaptainTurn(settled, {
      stdout,
      json: args.json,
    });
  } catch (error) {
    await writeStream(
      stderr,
      `playbook run: cannot write Captain reply: ${message(error)}\n`,
    );
    return { code: EXIT.turn };
  }
  return {
    code: EXIT.ok,
    sessionId,
    reply: settled.reply,
    snapshot: settled.snapshot,
    config: settled.config,
    cwd: settled.cwd,
    record: durableRecord,
  };
}

// PBCLI-20: run exactly one Boss boundary and capture its one accepted reply
// plus the complete shell snapshot. No stdout presentation occurs here.
export async function driveHeadlessCaptainTurn({
  config,
  input,
  sessionId,
  cwd,
  loadModule,
  stderr,
  verbose = false,
  adapterImports,
  createCaptainRuntime,
  createCaptainSessionId,
  createHostRuntime = createTmuxPlayRuntime,
  restoreSnapshot,
  beforeBossTurn,
  assertBeforeBossTurn,
  signal,
}) {
  const replies = [];
  let shell;
  let host;
  let baselineSnapshot;
  let uncertainRecord;
  try {
    try {
      shell = createPlaybookCaptainShell(captainOptionsFromConfig(config), {
        loadModule,
        ...(createCaptainRuntime ? { createCaptainRuntime } : {}),
        ...(createCaptainSessionId
          ? { createSessionId: createCaptainSessionId }
          : {}),
      });
      const captain = captainHostBoundary(shell, restoreSnapshot);
      host = await createHostRuntime({
        captain,
        captainConfig: cloneJson(config.captain),
        players: cloneJson(config.players),
        cwd,
        ...(signal ? { signal } : {}),
        ...(adapterImports ? { adapterImports } : {}),
        observers: [
          {
            async onRecord(record) {
              if (record.type === 'captain_reply') {
                replies.push(record.text);
              } else if (record.type === 'captain_status') {
                await writeStream(stderr, `${record.message}\n`);
              } else if (verbose && record.type === 'captain_telemetry') {
                await writeStream(stderr, `\u00b7 ${record.topic}\n`);
              }
            },
          },
        ],
      });
      if (shell === undefined) {
        throw new Error('Captain shell host initialized without a shell');
      }
      baselineSnapshot = shell.exportSnapshot();
      if (baselineSnapshot === undefined) {
        throw new Error(
          'Captain shell initialized without an exportable session snapshot',
        );
      }
      if (
        restoreSnapshot !== undefined &&
        !isDeepStrictEqual(baselineSnapshot, restoreSnapshot)
      ) {
        throw new Error('restored Captain snapshot changed before the Boss turn');
      }
      assertLogicalSessionIdDistinct({
        sessionId,
        snapshot: baselineSnapshot,
      });
      uncertainRecord = await beforeBossTurn?.(baselineSnapshot);
    } catch (error) {
      throw new HeadlessHostSetupError(error);
    }
    await assertBeforeBossTurn?.();
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Captain turn aborted');
    }
    await host.runBossTurn(input);
    throwIfAborted(signal);
    if (
      replies.length !== 1 ||
      typeof replies[0] !== 'string' ||
      replies[0].trim().length === 0
    ) {
      throw new Error(
        `Captain turn produced ${replies.length} usable Boss-visible replies; expected exactly one`,
      );
    }
    if (shell === undefined) {
      throw new Error('Captain shell host initialized without a shell');
    }
    const snapshot = shell.exportSnapshot();
    if (snapshot === undefined) {
      throw new Error('Captain turn settled without an exportable session snapshot');
    }
    if (
      snapshot.captain?.sessionId === sessionId ||
      snapshot.issuedSessionIds?.includes(sessionId)
    ) {
      throw new Error(
        'logical session id collided with an internal Captain session id',
      );
    }
    return {
      sessionId,
      reply: replies[0],
      snapshot,
      config: cloneJson(config),
      cwd,
      uncertainRecord,
      dispose: () => host.dispose(),
    };
  } catch (error) {
    if (host !== undefined) {
      try {
        await host.dispose();
      } catch {
        // Preserve the turn/capture failure as the primary diagnostic.
      }
    }
    throw error;
  }
}

// Task 7's restore path must enter through the host's one init boundary: a
// restored shell is fresh and receives restore instead of init, never both.
function captainHostBoundary(shell, restoreSnapshot) {
  return {
    init: (session) =>
      restoreSnapshot === undefined
        ? shell.init(session)
        : shell.restore(session, restoreSnapshot),
    handleBossTurn: (turn, context) => shell.handleBossTurn(turn, context),
    prepareDispose: () => shell.prepareDispose?.(),
    dispose: () => shell.dispose?.(),
  };
}

// Host-neutral execution-only projection. It is detached from the frozen
// launch plan and intentionally excludes layout, theme, and notifications.
export function executionConfigFromPlan(plan) {
  return cloneJson({
    schemaVersion: 1,
    captain: plan.captain,
    players: plan.players.map(({ id, agent }) => ({ id, ...agent })),
    // Keep the complete normalized catalog. Task 7 can freeze and validate
    // the same identities instead of silently accepting changed module
    // defaults while restoring a chat-only session.
    catalog: plan.catalog,
  });
}

// PBCLI-22/23: a continuation consumes only the detached execution projection
// captured at session creation. The current registry code must still expose
// the recorded manifest identity, while the stored effective command remains
// authoritative even when launcher configuration originally overrode it.
export async function validateFrozenExecutionConfig(
  value,
  { loadModule, prepareRegistryModule },
) {
  const config = requireRecord(
    snapshotJsonValue(value, 'Captain execution config'),
    'Captain execution config',
  );
  requireExactKeys(
    config,
    ['schemaVersion', 'captain', 'players', 'catalog'],
    'Captain execution config',
  );
  if (config.schemaVersion !== 1) {
    throw new Error(
      `Captain execution config schema ${JSON.stringify(config.schemaVersion)} is not supported`,
    );
  }
  requireRecord(config.captain, 'Captain execution config.captain');
  if (!Array.isArray(config.players)) {
    throw new Error('Captain execution config.players must be an array');
  }
  const catalog = requireRecord(
    config.catalog,
    'Captain execution config.catalog',
  );
  const catalogItems = Object.entries(catalog);
  if (catalogItems.length === 0) {
    throw new Error('Captain execution config.catalog must not be empty');
  }

  const expectedPlayerIds = [];
  const seenCommands = new Set();
  for (const [key, itemValue] of catalogItems) {
    const item = requireRecord(
      itemValue,
      `Captain execution config.catalog.${key}`,
    );
    const allowed = [
      'id',
      'from',
      'manifestCommand',
      'command',
      'intent',
      'requiredRoleIds',
      'playerIds',
      'options',
      ...(Object.hasOwn(item, 'commandOverride') ? ['commandOverride'] : []),
    ];
    requireExactKeys(
      item,
      allowed,
      `Captain execution config.catalog.${key}`,
    );
    if (requireNonblank(item.id, `catalog.${key}.id`) !== key) {
      throw new Error(
        `Captain execution config catalog key must equal id ${JSON.stringify(item.id)}`,
      );
    }
    if (item.id === 'captain') {
      throw new Error('Captain execution config uses the reserved playbook id "captain"');
    }
    const from = requireNonblank(item.from, `catalog.${key}.from`);
    if (
      isAbsolute(from) ||
      /^(?:\.{1,2}(?:[\\/]|$)|[\\/]|[A-Za-z]:[\\/])/.test(from)
    ) {
      throw new Error(
        `Captain execution config catalog.${key}.from is not a canonical module specifier`,
      );
    }
    requireNonblank(item.manifestCommand, `catalog.${key}.manifestCommand`);
    const command = requireNonblank(item.command, `catalog.${key}.command`);
    if (typeof item.intent !== 'string') {
      throw new Error(`catalog.${key}.intent must be a string`);
    }
    if (command === 'captain') {
      throw new Error(
        `Captain execution config catalog.${key} uses the reserved command "captain"`,
      );
    }
    if (seenCommands.has(command)) {
      throw new Error(
        `Captain execution config has duplicate effective command ${JSON.stringify(command)}`,
      );
    }
    seenCommands.add(command);
    if (Object.hasOwn(item, 'commandOverride')) {
      if (
        requireNonblank(item.commandOverride, `catalog.${key}.commandOverride`) !==
        command
      ) {
        throw new Error(`Captain execution config catalog.${key} command override is not frozen`);
      }
    } else if (command !== item.manifestCommand) {
      throw new Error(
        `Captain execution config catalog.${key} changed its manifest command without an override`,
      );
    }
    if (
      !Array.isArray(item.requiredRoleIds) ||
      item.requiredRoleIds.some(
        (role) => typeof role !== 'string' || role.trim().length === 0,
      ) ||
      new Set(item.requiredRoleIds).size !== item.requiredRoleIds.length
    ) {
      throw new Error(`Captain execution config catalog.${key}.requiredRoleIds is invalid`);
    }
    const playerIds = requireRecord(
      item.playerIds,
      `Captain execution config catalog.${key}.playerIds`,
    );
    if (Object.keys(playerIds).length === 0) {
      throw new Error(`Captain execution config catalog.${key}.playerIds must not be empty`);
    }
    for (const required of item.requiredRoleIds) {
      if (!Object.hasOwn(playerIds, required)) {
        throw new Error(
          `Captain execution config catalog.${key} has no mapped player for required role ${JSON.stringify(required)}`,
        );
      }
    }
    for (const [role, playerId] of Object.entries(playerIds)) {
      requireNonblank(role, `catalog.${key}.playerIds role`);
      if (role === 'captain') {
        throw new Error(`Captain execution config catalog.${key} uses the reserved role "captain"`);
      }
      requireNonblank(playerId, `catalog.${key}.playerIds.${role}`);
      if (playerId !== `${key}-${role}`) {
        throw new Error(
          `Captain execution config catalog.${key}.playerIds.${role} is not canonical`,
        );
      }
      expectedPlayerIds.push(playerId);
    }
    requireRecord(item.options, `Captain execution config catalog.${key}.options`);
  }
  if (new Set(expectedPlayerIds).size !== expectedPlayerIds.length) {
    throw new Error('Captain execution config maps a host player more than once');
  }
  const actualPlayerIds = config.players.map((player, index) =>
    requireNonblank(
      requireRecord(player, `Captain execution config.players[${index}]`).id,
      `Captain execution config.players[${index}].id`,
    ),
  );
  if (!isDeepStrictEqual(actualPlayerIds, expectedPlayerIds)) {
    throw new Error('Captain execution config players do not match the frozen catalog mapping');
  }

  // Round-trip the stored agents through the installed cligent validator. No
  // user config participates, and equality prevents defaults or coercions
  // from silently changing the frozen lineup.
  const firstVisible = Object.values(catalogItems[0][1].playerIds);
  const normalizedHost = await normalizeHostConfig({
    captain: {
      ...config.captain,
      from: PLAYBOOK_CAPTAIN_MODULE,
      options: {},
    },
    players: config.players,
    layout: { initialVisible: firstVisible },
  });
  const {
    from: _captainFrom,
    options: _captainOptions,
    ...normalizedCaptain
  } = normalizedHost.captain;
  if (
    !isDeepStrictEqual(normalizedCaptain, config.captain) ||
    !isDeepStrictEqual(normalizedHost.players, config.players)
  ) {
    throw new Error('Captain execution config agents are not canonical for this cligent host');
  }

  // Preserve the complete-catalog preparation transaction: prepare every
  // stored canonical module before importing any. A hook may provision the
  // module's dependencies but cannot rewrite the frozen module identity.
  for (const [id, item] of catalogItems) {
    if (prepareRegistryModule === undefined) continue;
    let prepared;
    try {
      prepared = await prepareRegistryModule({
        id,
        from: item.from,
        authoredFrom: item.from,
      });
    } catch (cause) {
      throw new Error(`stored playbook ${JSON.stringify(id)} failed to prepare: ${message(cause)}`);
    }
    if (prepared !== undefined && prepared !== item.from) {
      throw new Error(
        `stored playbook ${JSON.stringify(id)} preparation changed its frozen module identity`,
      );
    }
  }

  for (const [id, item] of catalogItems) {
    let entry;
    try {
      entry = (await loadModule(item.from))?.default;
    } catch (cause) {
      throw new Error(`stored playbook ${JSON.stringify(id)} failed to import: ${message(cause)}`);
    }
    if (!isValidRegistryEntry(entry)) {
      throw new Error(`stored playbook ${JSON.stringify(id)} exposes no valid registry entry`);
    }
    if (
      entry.id !== id ||
      entry.command !== item.manifestCommand ||
      entry.intent !== item.intent ||
      !isDeepStrictEqual(entry.requiredRoleIds, item.requiredRoleIds)
    ) {
      throw new Error(
        `stored playbook ${JSON.stringify(id)} no longer matches its recorded manifest identity`,
      );
    }
    try {
      entry.validateOptions(cloneJson(item.options));
    } catch (cause) {
      throw new Error(
        `stored playbook ${JSON.stringify(id)} options are no longer compatible: ${message(cause)}`,
      );
    }
  }
  return config;
}

function adaptersFromExecutionConfig(config) {
  return [
    ...new Set([
      config.captain.adapter,
      ...config.players.map((player) => player.adapter),
    ]),
  ];
}

function assertLogicalSessionIdDistinct(record) {
  if (
    record.snapshot.captain?.sessionId === record.sessionId ||
    (Array.isArray(record.snapshot.issuedSessionIds) &&
      record.snapshot.issuedSessionIds.includes(record.sessionId))
  ) {
    throw new Error(
      'logical session id collides with an internal Captain session id',
    );
  }
}

function memoizedModuleLoader(loadModule) {
  const modules = new Map();
  return (specifier) => {
    if (!modules.has(specifier)) {
      modules.set(specifier, Promise.resolve().then(() => loadModule(specifier)));
    }
    return modules.get(specifier);
  };
}

function isValidRegistryEntry(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
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

function requireRecord(value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function requireExactKeys(value, expected, path) {
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  const unknown = keys.find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`${path} has unknown field ${JSON.stringify(unknown)}`);
  }
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) {
    throw new Error(`${path} is missing field ${JSON.stringify(missing)}`);
  }
}

function requireNonblank(value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a nonblank string`);
  }
  return value;
}

function captainOptionsFromConfig(config) {
  return {
    playbooks: Object.fromEntries(
      Object.entries(config.catalog).map(([id, item]) => [
        id,
        {
          from: item.from,
          command: item.command,
          options: cloneJson(item.options),
        },
      ]),
    ),
    captainAdapter: config.captain.adapter,
  };
}

export async function presentHeadlessCaptainTurn(
  { sessionId, reply },
  { stdout, json = false },
) {
  await writeStream(
    stdout,
    `${json ? JSON.stringify({ sessionId, reply }) : reply}\n`,
  );
}

export function parseRunArgs(argv) {
  const parsed = {
    input: undefined,
    withPaths: [],
    noProvision: false,
    json: false,
    verbose: false,
    continue: false,
    sessionId: undefined,
    retryUncertain: false,
    discardUncertain: false,
    help: false,
    terminated: false,
  };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      parsed.terminated = true;
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--verbose') parsed.verbose = true;
    else if (arg === '--no-provision') parsed.noProvision = true;
    else if (arg === '--retry-uncertain') {
      if (parsed.retryUncertain) {
        throw new Error('--retry-uncertain may be specified only once');
      }
      parsed.retryUncertain = true;
    } else if (arg === '--discard-uncertain') {
      if (parsed.discardUncertain) {
        throw new Error('--discard-uncertain may be specified only once');
      }
      parsed.discardUncertain = true;
    }
    else if (arg === '--continue') {
      if (parsed.continue) throw new Error('--continue may be specified only once');
      parsed.continue = true;
    } else if (arg === '--session') {
      const value = argv[index + 1];
      if (value === undefined || value === '') {
        throw new Error('--session needs a UUID value');
      }
      if (parsed.sessionId !== undefined) {
        throw new Error('--session may be specified only once');
      }
      parsed.sessionId = value;
      index += 1;
    } else if (arg.startsWith('--session=')) {
      const value = arg.slice('--session='.length);
      if (value === '') throw new Error('--session needs a UUID value');
      if (parsed.sessionId !== undefined) {
        throw new Error('--session may be specified only once');
      }
      parsed.sessionId = value;
    } else if (arg === '--with') {
      const value = argv[index + 1];
      if (value === undefined || value === '') {
        throw new Error('--with needs a value');
      }
      parsed.withPaths.push(value);
      index += 1;
    } else if (arg.startsWith('--with=')) {
      const value = arg.slice('--with='.length);
      if (value === '') throw new Error('--with needs a value');
      parsed.withPaths.push(value);
    } else if (
      RETIRED_FLAGS.has(arg) ||
      [...RETIRED_FLAGS].some((flag) => arg.startsWith(`${flag}=`))
    ) {
      throw new Error(
        `${arg.split('=')[0]} was removed; configure the shared Captain session in playbook.config.yaml or a --with overlay`,
      );
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) {
    throw new Error(
      'expected at most one [input] argument; quote multi-word input as one shell argument',
    );
  }
  if (parsed.continue && parsed.sessionId !== undefined) {
    throw new Error('--continue and --session are mutually exclusive');
  }
  if (parsed.retryUncertain && parsed.discardUncertain) {
    throw new Error(
      '--retry-uncertain and --discard-uncertain are mutually exclusive',
    );
  }
  if (
    (parsed.retryUncertain || parsed.discardUncertain) &&
    parsed.sessionId === undefined
  ) {
    throw new Error(
      '--retry-uncertain and --discard-uncertain require --session <id>',
    );
  }
  if (
    (parsed.retryUncertain || parsed.discardUncertain) &&
    (parsed.continue || positionals.length > 0)
  ) {
    throw new Error(
      'uncertain-turn recovery accepts only an explicit --session and no input',
    );
  }
  if (
    parsed.discardUncertain &&
    (parsed.json || parsed.verbose || parsed.noProvision)
  ) {
    throw new Error(
      '--discard-uncertain does not accept --json, --verbose, or --no-provision',
    );
  }
  if (
    (parsed.continue || parsed.sessionId !== undefined) &&
    parsed.withPaths.length > 0
  ) {
    throw new Error('--with cannot change a frozen continued Captain session');
  }
  if (
    parsed.sessionId !== undefined &&
    !SESSION_ID_PATTERN.test(parsed.sessionId)
  ) {
    throw new Error('--session needs a canonical UUID value');
  }
  parsed.input = positionals[0];
  return parsed;
}

async function reportReadinessFailure({
  stderr,
  adapters,
  failingAdapters,
  unusableAdapters,
  invocation,
  ephemeralNpx,
}) {
  if (unusableAdapters.length > 0) {
    const lines = adapterSdkFailureLines(unusableAdapters, {
      requiredSdks: mappedSdksFor(adapters),
      invocation,
      ...(ephemeralNpx !== undefined ? { ephemeralNpx } : {}),
    });
    const [first, ...rest] = lines;
    await writeStream(
      stderr,
      [
        ...(first ? [`playbook run: ${first}`] : []),
        ...rest,
      ]
        .map((line) => `${line}\n`)
        .join(''),
    );
  }
  if (failingAdapters.length > 0) {
    await writeStream(
      stderr,
      `playbook run: adapters not ready: ${failingAdapters.join(', ')}\n`,
    );
  }
}

async function resolveBossInput(input, options, stderr) {
  let resolved = input;
  if (resolved === undefined) {
    try {
      resolved = await awaitWithAbort(
        (options.readStdin ?? readAllStdin)(),
        options.signal,
      );
    } catch (error) {
      await writeStream(
        stderr,
        `playbook run: cannot read stdin: ${message(error)}\n`,
      );
      return { ok: false };
    }
  }
  if (resolved.trim().length === 0) {
    await writeStream(
      stderr,
      'playbook run: empty input; pass one argument or pipe a Boss message on stdin\n',
    );
    return { ok: false };
  }
  return { ok: true, input: resolved };
}

async function awaitWithAbort(value, signal) {
  if (signal === undefined) return value;
  if (signal.aborted) throw signal.reason ?? new Error('operation aborted');
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('operation aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([value, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('operation aborted');
  }
}

function registryPreparer(args, options, stderr) {
  return (
    options.prepareRegistryModule ??
    prepareConfiguredRegistries({
      enabled: !args.noProvision,
      stderr,
      hostRoots: options.hostRoots,
      commandName: 'playbook run',
    })
  );
}

function createAttemptId(options) {
  const attemptId = (options.createAttemptId ?? randomUUID)();
  if (typeof attemptId !== 'string' || !UUID_PATTERN.test(attemptId)) {
    throw new Error(
      `uncertain turn attempt id generator returned a non-UUID value: ${JSON.stringify(attemptId)}`,
    );
  }
  return attemptId;
}

async function releaseLease(lease) {
  if (lease === undefined) return undefined;
  try {
    await lease.release();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function reportUncertainSession(stderr, sessionId) {
  await writeStream(
    stderr,
    [
      `playbook run: Captain session ${JSON.stringify(sessionId)} has an uncertain turn and will not be replayed automatically`,
      'Retry may duplicate external effects from the interrupted attempt; discard abandons that attempted turn.',
      `playbook run --session ${sessionId} --retry-uncertain`,
      `playbook run --session ${sessionId} --discard-uncertain`,
      '',
    ].join('\n'),
  );
}

function replayInvocation(argv, args, input) {
  if (args.retryUncertain || args.discardUncertain) {
    return ['run', ...argv];
  }
  if (args.input !== undefined) return ['run', ...argv];
  return args.terminated
    ? ['run', ...argv, input]
    : ['run', ...argv, '--', input];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function writeStream(stream, text) {
  const ready = stream.write(text);
  if (ready !== false || typeof stream.once !== 'function') return;
  await new Promise((resolvePromise, rejectPromise) => {
    const onDrain = () => {
      stream.off?.('error', onError);
      resolvePromise();
    };
    const onError = (error) => {
      stream.off?.('drain', onDrain);
      rejectPromise(error);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

function runHelpText(userConfigPath) {
  return [
    'Usage:',
    '  playbook run [--with <path>]... [--no-provision] [--json]',
    '               [--verbose] [--] [input]',
    '  playbook run (--continue | --session <id>) [--no-provision]',
    '               [--json] [--verbose] [--] [reply]',
    '  playbook run --session <id> --retry-uncertain [--no-provision]',
    '  playbook run --session <id> --discard-uncertain',
    '',
    '  [input]  one exact Boss message; read verbatim from stdin when omitted',
    '  --        end options so a flag-shaped input remains Boss text',
    '',
    `Default config: ${userConfigPath}`,
    '',
    'A new run uses the same configured Captain, enabled playbooks, players,',
    'options, overlays, provisioning, and readiness gate as interactive',
    '`playbook`. Enable an external registry in that config, then invoke its',
    'effective /command through Captain. The former positional registry,',
    'resume, and run-only binding surfaces have been removed.',
    'A continued run restores the stored execution config and working',
    'directory; it never re-reads current config or --with overlays.',
    '',
    'Options:',
    '  --with <path>    overlay a generic config fragment (repeatable)',
    '  --no-provision   do not provision thin filesystem registry engines',
    '  --continue       reply to the latest durable Captain session',
    '  --session <id>   reply to one durable Captain session UUID',
    '  --retry-uncertain retry that session\'s exact recorded uncertain input',
    '  --discard-uncertain discard that session\'s uncertain attempt',
    '  --json           print exactly {"sessionId", "reply"}',
    '  --verbose        print Captain telemetry topics to stderr',
    '  -h, --help       print this help without reading input or config',
    '',
  ].join('\n');
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
