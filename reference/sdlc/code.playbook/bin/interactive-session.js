// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-49: the tmux pane process owns the durable interactive-session
// transaction. The outer launcher supplies a private immutable launch payload;
// this child acquires the writer lease, initializes or restores the shared
// Captain host, and brackets every visible reply with durable store updates.

import { randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runManagedTmuxPlaySession } from '@sublang/cligent/tmux-play';
import { shellQuote } from './adapter-sdk.js';
import {
  PLAYBOOK_CAPTAIN_MODULE,
  projectHostAgent,
} from './launch-config.js';
import {
  CaptainSessionHostCleanupError,
  captainOptionsFromConfig,
  createCaptainSessionHost,
  installRetainedGenerationsForLaunch,
  validateFrozenExecutionConfig,
} from './run.js';
import { prepareConfiguredRegistries } from './provision.js';
import {
  assertCaptainSessionExecutionCompatible,
  createCaptainSessionStore,
  projectCaptainSessionStructure,
  SESSION_ID_PATTERN,
  validateCaptainSessionExecutionProjection,
  validateCaptainSessionRecord,
} from './session-store.js';

export const MANAGED_INTERACTIVE_PAYLOAD_FILE =
  'playbook-managed-interactive.json';
export const MANAGED_INTERACTIVE_PAYLOAD_SCHEMA_VERSION = 1;
export const MANAGED_INTERACTIVE_PAYLOAD_KIND =
  'playbook-managed-interactive-launch';

const PAYLOAD_KEYS = [
  'schemaVersion',
  'kind',
  'mode',
  'sessionId',
  'cwd',
  'sessionsDir',
  'noProvision',
  'executionProjection',
  'workDir',
  'workDirOwnedByLauncher',
  'readinessPath',
  'inputGatePath',
  'inputActivePath',
  'shutdownRequestPath',
  'shutdownCompletePath',
];

export function validateManagedInteractivePayload(value) {
  if (!isPlainRecord(value)) {
    throw new Error('managed interactive launch payload must be a plain object');
  }
  assertExactKeys(value, PAYLOAD_KEYS, 'managed interactive launch payload');
  if (value.schemaVersion !== MANAGED_INTERACTIVE_PAYLOAD_SCHEMA_VERSION) {
    throw new Error('managed interactive launch payload schema is not supported');
  }
  if (value.kind !== MANAGED_INTERACTIVE_PAYLOAD_KIND) {
    throw new Error('managed interactive launch payload kind is not supported');
  }
  if (value.mode !== 'fresh' && value.mode !== 'selected') {
    throw new Error('managed interactive launch payload mode is not supported');
  }
  assertUuid(value.sessionId, 'managed interactive session id');
  assertCanonicalAbsolutePath(value.cwd, 'managed interactive working directory');
  assertCanonicalAbsolutePath(
    value.sessionsDir,
    'managed interactive sessions directory',
  );
  if (typeof value.noProvision !== 'boolean') {
    throw new Error('managed interactive noProvision must be a boolean');
  }
  if (typeof value.workDirOwnedByLauncher !== 'boolean') {
    throw new Error(
      'managed interactive workDirOwnedByLauncher must be a boolean',
    );
  }
  for (const key of [
    'workDir',
    'readinessPath',
    'inputGatePath',
    'inputActivePath',
    'shutdownRequestPath',
    'shutdownCompletePath',
  ]) {
    assertCanonicalAbsolutePath(
      value[key],
      `managed interactive launch payload ${key}`,
    );
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    mode: value.mode,
    sessionId: value.sessionId,
    cwd: value.cwd,
    sessionsDir: value.sessionsDir,
    noProvision: value.noProvision,
    workDir: value.workDir,
    workDirOwnedByLauncher: value.workDirOwnedByLauncher,
    readinessPath: value.readinessPath,
    inputGatePath: value.inputGatePath,
    inputActivePath: value.inputActivePath,
    shutdownRequestPath: value.shutdownRequestPath,
    shutdownCompletePath: value.shutdownCompletePath,
    executionProjection: validateCaptainSessionExecutionProjection(
      value.executionProjection,
      'managed interactive execution projection',
    ),
  });
}

export async function writeManagedInteractivePayload(workDir, value) {
  assertCanonicalAbsolutePath(workDir, 'managed interactive work directory');
  const payload = validateManagedInteractivePayload(value);
  const path = join(workDir, MANAGED_INTERACTIVE_PAYLOAD_FILE);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.chmod(0o600);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600) {
      throw new Error(
        'managed interactive launch payload is not a private regular file',
      );
    }
    if (
      typeof process.getuid === 'function' &&
      stat.uid !== process.getuid()
    ) {
      throw new Error('managed interactive launch payload has a foreign owner');
    }
    await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

export async function readManagedInteractivePayload(path) {
  assertCanonicalAbsolutePath(path, 'managed interactive launch descriptor');
  assertManagedDescriptorPath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assertPrivateDescriptorStat(stat);
    return await readManagedInteractivePayloadHandle(handle);
  } finally {
    await handle.close();
  }
}

export async function createManagedInteractiveSessionCommand(
  context,
  payload,
  { selfBin = process.argv[1], execPath = process.execPath } = {},
) {
  if (typeof selfBin !== 'string' || selfBin.length === 0) {
    throw new Error('managed interactive child executable path is missing');
  }
  if (context.sessionId !== payload.sessionId || context.cwd !== payload.cwd) {
    throw new Error('managed interactive launch context is mismatched');
  }
  if (typeof context.workDirOwnedByLauncher !== 'boolean') {
    throw new Error(
      'managed interactive launch context work-directory ownership is missing',
    );
  }
  const descriptorPath = await writeManagedInteractivePayload(
    context.workDir,
    {
      ...payload,
      workDir: context.workDir,
      workDirOwnedByLauncher: context.workDirOwnedByLauncher,
      readinessPath: context.readinessPath,
      inputGatePath: context.inputGatePath,
      inputActivePath: context.inputActivePath,
      shutdownRequestPath: context.shutdownRequestPath,
      shutdownCompletePath: context.shutdownCompletePath,
    },
  );
  const args = [execPath, resolve(selfBin), descriptorPath];
  return args.map((value) => shellQuote(String(value))).join(' ');
}

export async function runManagedInteractiveSessionChild(options = {}) {
  const descriptorPath = parseManagedInteractiveChildArgs(options.argv ?? []);
  const payload = await consumeManagedInteractivePayload(descriptorPath, {
    ...(options.beforeDescriptorUnlink
      ? { beforeUnlink: options.beforeDescriptorUnlink }
      : {}),
  });
  if (options.startupSignal?.aborted) {
    throw options.startupSignal.reason ?? new Error('managed session startup aborted');
  }
  const lifecycle = createManagedInteractiveLifecycle(payload, options);
  await (options.runManagedSession ?? runManagedTmuxPlaySession)({
    sessionId: payload.sessionId,
    workDir: payload.workDir,
    workDirOwnedByLauncher: payload.workDirOwnedByLauncher,
    cwd: payload.cwd,
    readinessPath: payload.readinessPath,
    inputGatePath: payload.inputGatePath,
    inputActivePath: payload.inputActivePath,
    shutdownRequestPath: payload.shutdownRequestPath,
    shutdownCompletePath: payload.shutdownCompletePath,
    lifecycle,
    ...(options.input ? { input: options.input } : {}),
    ...(options.output ? { output: options.output } : {}),
    ...(options.signalTarget ? { signalTarget: options.signalTarget } : {}),
    ...(options.adapterImports
      ? { adapterImports: options.adapterImports }
      : {}),
  });
}

export async function runManagedInteractiveSessionChildEntry(options = {}) {
  const signalTarget = options.signalTarget ?? process;
  const startupController = new AbortController();
  let receivedSignal;
  const handlers = {};
  const removeHandlers = () => {
    for (const [signal, handler] of Object.entries(handlers)) {
      signalTarget.off(signal, handler);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    handlers[signal] = () => {
      if (receivedSignal !== undefined) {
        removeHandlers();
        signalTarget.kill(signalTarget.pid, signal);
        return;
      }
      // Cligent owns the first signal and joins runtime disposal, lifecycle
      // shutdown, lease retirement, and pane cleanup. This listener only
      // remembers its identity so the private child can re-raise afterwards.
      receivedSignal = signal;
      startupController.abort(new Error(`received ${signal}`));
    };
  }
  for (const [signal, handler] of Object.entries(handlers)) {
    signalTarget.on(signal, handler);
  }
  try {
    try {
      await runManagedInteractiveSessionChild({
        ...options,
        startupSignal: startupController.signal,
      });
      return receivedSignal === undefined ? {} : { signal: receivedSignal };
    } catch (error) {
      if (receivedSignal === undefined) throw error;
      return { signal: receivedSignal, error };
    }
  } finally {
    removeHandlers();
  }
}

export function createManagedInteractiveLifecycle(payloadValue, options = {}) {
  const payload = validateManagedInteractivePayload(payloadValue);
  const store =
    options.sessionStore ??
    createCaptainSessionStore({
      sessionsDir: payload.sessionsDir,
      ...(options.now ? { now: options.now } : {}),
      ...(options.createSessionTempId
        ? { createTempId: options.createSessionTempId }
        : {}),
    });
  const loadModule = memoizedModuleLoader(
    options.loadModule ?? ((specifier) => import(specifier)),
  );
  const createSessionHost =
    options.createSessionHost ?? createCaptainSessionHost;
  const createAttemptId = options.createAttemptId ?? randomUUID;
  let lease;
  let shell;
  let initialized = false;
  let released = false;
  let leaseQuarantined = false;
  let activeTurn;
  let executionProjection;

  const release = async () => {
    if (released || lease === undefined) return;
    const owned = lease;
    await owned.release();
    if (lease === owned) lease = undefined;
    released = true;
  };

  return Object.freeze({
    async initializeRuntime(context) {
      if (initialized || lease !== undefined || released) {
        throw new Error('managed interactive lifecycle was already initialized');
      }
      if (context.sessionId !== payload.sessionId) {
        throw new Error('managed interactive runtime session id is mismatched');
      }
      if (context.cwd !== payload.cwd) {
        throw new Error('managed interactive runtime working directory is mismatched');
      }
      assertTmuxConfigMatchesExecution(
        context.config,
        payload.executionProjection,
      );

      let host;
      try {
        lease = await store.acquire(payload.sessionId);
        const authoritative = await lease.read();
        let retainedGenerations = {};
        let restoreSnapshot;
        const prepareRegistryModule =
          options.prepareRegistryModule ??
          (options.createRegistryPreparer ?? prepareConfiguredRegistries)({
            enabled: !payload.noProvision,
            stderr: options.stderr ?? process.stderr,
            hostRoots: options.hostRoots,
            commandName: 'playbook',
          });
        if (payload.mode === 'fresh') {
          if (authoritative !== undefined) {
            throw new Error('fresh managed interactive session already exists');
          }
          // Module and filesystem dependency state can drift after the outer
          // advisory plan. Repeat the complete transaction under ownership,
          // before host or turn-zero work.
          executionProjection = await validateFrozenExecutionConfig(
            projectCaptainSessionStructure(payload.executionProjection),
            payload.executionProjection,
            { loadModule, prepareRegistryModule },
          );
        } else {
          if (authoritative === undefined) {
            throw new Error(
              `Captain session ${JSON.stringify(payload.sessionId)} does not exist`,
            );
          }
          const record = validateCaptainSessionRecord(authoritative);
          if (record.state !== 'settled') {
            throw new Error(
              `Captain session ${JSON.stringify(payload.sessionId)} has an uncertain turn; recover it with playbook run before reopening interactively`,
            );
          }
          if (record.cwd !== payload.cwd) {
            throw new Error(
              'selected Captain session working directory changed before attachment',
            );
          }
          const compatibleExecution = assertCaptainSessionExecutionCompatible(
            record.structuralProjection,
            payload.executionProjection,
          );
          // PBCLI-22/49: the parent projection is advisory and data-only.
          // Once this child owns the canonical writer lease, prepare the
          // complete retained catalog transaction and verify its recorded
          // manifest identity before shell construction can import anything.
          executionProjection = await validateFrozenExecutionConfig(
            record.structuralProjection,
            compatibleExecution,
            { loadModule, prepareRegistryModule },
          );
          restoreSnapshot = record.snapshot;
          retainedGenerations = record.retainedGenerations ?? {};
        }

        const created = await createSessionHost({
          config: executionProjection,
          sessionId: payload.sessionId,
          cwd: payload.cwd,
          loadModule,
          observers: context.observers,
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
          ...(restoreSnapshot !== undefined ? { restoreSnapshot } : {}),
        });
        ({ host, shell } = created);
        if (payload.mode === 'fresh') {
          await lease.initializeSettled({
            cwd: payload.cwd,
            structuralProjection:
              projectCaptainSessionStructure(executionProjection),
            executionProjection,
            snapshot: created.snapshot,
          });
        }
        await installRetainedGenerationsForLaunch({
          lease,
          shell,
          fresh: payload.mode === 'fresh',
          retainedGenerations,
        });
        initialized = true;
        return {
          abortActiveTurn: (...args) => host.abortActiveTurn(...args),
          runBossTurn: (...args) => host.runBossTurn(...args),
          async dispose() {
            try {
              await host.dispose();
            } catch (error) {
              // Runtime disposal is the semantic ownership boundary. If it
              // cannot be proved, quarantine the writer lease until process
              // death rather than admitting another presentation.
              leaseQuarantined = true;
              throw error;
            }
          },
        };
      } catch (error) {
        const failures = [error];
        if (error instanceof CaptainSessionHostCleanupError) {
          leaseQuarantined = true;
        }
        if (host !== undefined) {
          try {
            await host.dispose();
          } catch (disposeError) {
            // A host that cannot prove disposal may still perform effects.
            // Keep its canonical writer lease until process death so another
            // presentation cannot start concurrently with that failed host.
            leaseQuarantined = true;
            failures.push(disposeError);
          }
        }
        shell = undefined;
        if (!leaseQuarantined) {
          try {
            await release();
          } catch (releaseError) {
            failures.push(releaseError);
          }
        }
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            `managed interactive initialization failed (${message(error)}) and cleanup could not prove complete host disposal and lease retirement`,
          );
        }
        throw error;
      }
    },

    async beforeNonEmptyTurn({ sessionId, prompt }) {
      assertActiveLifecycle(initialized, lease, released, sessionId, payload);
      if (activeTurn !== undefined) {
        throw new Error('managed interactive turn transaction is already active');
      }
      const attemptId = createAttemptId();
      assertUuid(attemptId, 'managed interactive turn attempt id');
      await lease.beginTurn({
        input: prompt,
        attemptId,
        attemptedExecutionProjection: executionProjection,
      });
      activeTurn = { attemptId, prompt };
      await lease.assertOwner();
    },

    async afterTurn({ sessionId, prompt, replies, terminal }) {
      assertActiveLifecycle(initialized, lease, released, sessionId, payload);
      if (activeTurn === undefined) {
        throw new Error('managed interactive turn has no write-ahead marker');
      }
      if (prompt !== activeTurn.prompt) {
        throw new Error('managed interactive turn prompt changed after write-ahead');
      }
      if (terminal.type !== 'turn_finished') {
        throw new Error(
          'managed interactive Captain turn aborted; durable state remains uncertain',
        );
      }
      if (
        replies.length !== 1 ||
        replies[0]?.type !== 'captain_reply' ||
        typeof replies[0]?.text !== 'string' ||
        replies[0].text.trim().length === 0 ||
        replies[0].turnId !== terminal.turnId
      ) {
        throw new Error(
          `managed interactive Captain turn produced ${replies.length} usable Boss-visible replies; expected exactly one`,
        );
      }
      const settlement = shell?.exportSettlement();
      if (settlement === undefined) {
        throw new Error(
          'managed interactive Captain turn settled without an exportable session settlement',
        );
      }
      await lease.settle({
        attemptId: activeTurn.attemptId,
        snapshot: settlement.snapshot,
        retentionUpdates: settlement.retentionUpdates,
      });
      activeTurn = undefined;
    },

    async shutdown() {
      // Cligent invokes lifecycle shutdown only after runtime disposal and the
      // complete turn transaction, so ownership retirement cannot race either.
      if (leaseQuarantined) return;
      await release();
    },
  });
}

export function parseManagedInteractiveChildArgs(argv) {
  if (argv.length !== 1) {
    throw new Error(
      'managed interactive child requires exactly one launch descriptor',
    );
  }
  assertCanonicalAbsolutePath(argv[0], 'managed interactive launch descriptor');
  return argv[0];
}

export async function validateManagedInteractiveControlBoundary(
  args,
  descriptorPath,
) {
  const coordinatePaths = [
    ['readinessPath', 'status.json'],
    ['inputGatePath', 'input-ready'],
    ['inputActivePath', 'input-active'],
    ['shutdownRequestPath', 'shutdown-request'],
    ['shutdownCompletePath', 'shutdown-complete'],
  ];
  const coordinationDir = dirname(args.readinessPath);
  if (
    descriptorPath !== join(args.workDir, MANAGED_INTERACTIVE_PAYLOAD_FILE)
  ) {
    throw new Error('managed interactive launch descriptor is outside its work directory');
  }
  for (const [key, expectedName] of coordinatePaths) {
    if (
      dirname(args[key]) !== coordinationDir ||
      basename(args[key]) !== expectedName
    ) {
      throw new Error(
        'managed interactive coordination paths are not one exact Cligent boundary',
      );
    }
  }
  const [workStat, coordinationStat] = await Promise.all([
    lstat(args.workDir),
    lstat(coordinationDir),
  ]);
  if (!workStat.isDirectory()) {
    throw new Error('managed interactive work directory is not a real directory');
  }
  if ((workStat.mode & 0o7777) !== 0o700) {
    throw new Error('managed interactive work directory is not private');
  }
  if (
    !coordinationStat.isDirectory() ||
    (coordinationStat.mode & 0o7777) !== 0o700
  ) {
    throw new Error('managed interactive coordination directory is not private');
  }
  const currentUid =
    typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (
    currentUid !== undefined &&
    (workStat.uid !== currentUid || coordinationStat.uid !== currentUid)
  ) {
    throw new Error('managed interactive control directories have a foreign owner');
  }
  const [workRealPath, coordinationRealPath, sessionsRealPath] =
    await Promise.all([
      realpath(args.workDir),
      realpath(coordinationDir),
      realpathAllowMissing(args.sessionsDir),
    ]);
  if (pathsOverlap(workRealPath, coordinationRealPath)) {
    throw new Error(
      'managed interactive work and coordination directories overlap',
    );
  }
  if (
    pathsOverlap(sessionsRealPath, workRealPath) ||
    pathsOverlap(sessionsRealPath, coordinationRealPath)
  ) {
    throw new Error(
      'durable Captain session storage overlaps managed interactive ephemeral cleanup',
    );
  }
}

async function consumeManagedInteractivePayload(path, options = {}) {
  assertCanonicalAbsolutePath(path, 'managed interactive launch descriptor');
  assertManagedDescriptorPath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    assertPrivateDescriptorStat(openedStat);
    const payload = await readManagedInteractivePayloadHandle(handle);
    await validateManagedInteractiveControlBoundary(payload, path);
    await options.beforeUnlink?.({ path, payload });

    const pathStat = await lstat(path);
    assertPrivateDescriptorStat(pathStat);
    if (
      pathStat.dev !== openedStat.dev ||
      pathStat.ino !== openedStat.ino
    ) {
      throw new Error(
        'managed interactive launch descriptor changed during validation',
      );
    }
    // The exact execution projection may contain private instructions and
    // permissions. Unlink only the inode that survived the complete private
    // Cligent boundary check, while the O_NOFOLLOW handle is still open.
    await unlink(path);
    const consumedStat = await handle.stat();
    if (consumedStat.nlink !== 0) {
      throw new Error(
        'managed interactive launch descriptor was not consumed exactly once',
      );
    }
    return payload;
  } finally {
    await handle.close();
  }
}

async function readManagedInteractivePayloadHandle(handle) {
  const text = await handle.readFile('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `managed interactive launch payload is not valid JSON: ${message(cause)}`,
    );
  }
  return validateManagedInteractivePayload(parsed);
}

function assertPrivateDescriptorStat(stat) {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o7777) !== 0o600
  ) {
    throw new Error(
      'managed interactive launch payload is not a singly linked private regular file',
    );
  }
  if (
    typeof process.getuid === 'function' &&
    stat.uid !== process.getuid()
  ) {
    throw new Error('managed interactive launch payload has a foreign owner');
  }
}

async function realpathAllowMissing(path) {
  const suffix = [];
  let cursor = path;
  for (;;) {
    try {
      return join(await realpath(cursor), ...suffix.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

function pathsOverlap(left, right) {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function isPathWithin(parent, candidate) {
  const remainder = relative(parent, candidate);
  return (
    remainder === '' ||
    (!isAbsolute(remainder) &&
      remainder !== '..' &&
      !remainder.startsWith(`..${sep}`))
  );
}

function assertTmuxConfigMatchesExecution(tmuxConfig, execution) {
  const expectedCaptain = {
    ...projectHostAgent(execution.captain, 'execution captain'),
    from: PLAYBOOK_CAPTAIN_MODULE,
    options: captainOptionsFromConfig(execution),
  };
  const expectedPlayers = execution.players.map(({ id, ...agent }) => ({
    id,
    ...projectHostAgent(agent, `execution player ${id}`),
  }));
  if (!isDeepStrictEqual(tmuxConfig.captain, expectedCaptain)) {
    throw new Error(
      'managed interactive tmux Captain config does not match its durable execution projection',
    );
  }
  if (!isDeepStrictEqual(tmuxConfig.players, expectedPlayers)) {
    throw new Error(
      'managed interactive tmux player roster does not match its durable execution projection',
    );
  }
}

function assertActiveLifecycle(initialized, lease, released, sessionId, payload) {
  if (!initialized || lease === undefined || released) {
    throw new Error('managed interactive lifecycle is not active');
  }
  if (sessionId !== payload.sessionId) {
    throw new Error('managed interactive turn session id is mismatched');
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

function assertUuid(value, path) {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new Error(`${path} must be a canonical lowercase UUID`);
  }
}

function assertCanonicalAbsolutePath(value, path) {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new Error(`${path} must be a normalized absolute path`);
  }
}

function assertManagedDescriptorPath(path) {
  if (basename(path) !== MANAGED_INTERACTIVE_PAYLOAD_FILE) {
    throw new Error(
      'managed interactive launch descriptor has an invalid basename',
    );
  }
}

function assertExactKeys(value, keys, path) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${path} has unknown or missing fields`);
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function message(error) {
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
  try {
    const result = await runManagedInteractiveSessionChildEntry({
      argv: process.argv.slice(2),
    });
    if (result.signal) {
      if (result.error) {
        process.stderr.write(
          `playbook: managed session failed during ${result.signal}: ${message(result.error)}\n`,
        );
      }
      process.kill(process.pid, result.signal);
    }
  } catch (error) {
    process.stderr.write(`playbook: managed session failed: ${message(error)}\n`);
    process.exitCode = 1;
  }
}
