#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchManagedTmuxPlay } from '@sublang/cligent/tmux-play';
import { stringify as stringifyYaml } from 'yaml';
import {
  adapterSdkFailureLines,
  checkAdapterSdks,
  mappedSdksFor,
  probeAdapterSdk,
} from './adapter-sdk.js';
import {
  adaptersFromLaunchPlan,
  extractWithFlags,
  loadLaunchPlan,
  loadSelectedLaunchPlanDataOnly,
  projectTmuxConfig,
  resolveUserConfigPath,
  checkReadiness,
} from './launch-config.js';
import {
  createManagedInteractiveSessionCommand,
  MANAGED_INTERACTIVE_PAYLOAD_KIND,
  MANAGED_INTERACTIVE_PAYLOAD_SCHEMA_VERSION,
} from './interactive-session.js';
import { prepareConfiguredRegistries } from './provision.js';
import {
  executionConfigFromPlan,
} from './run.js';
import {
  assertCaptainSessionExecutionCompatible,
  createCaptainSessionStore,
  SESSION_ID_PATTERN,
  validateCaptainSessionRecord,
} from './session-store.js';

// Preserve the established import surface while the CLI itself delegates to
// the host-neutral launch-config module.
export {
  PLAYBOOK_CAPTAIN_MODULE,
  adaptersFromComposedConfig,
  adaptersFromLaunchPlan,
  canonicalizeRegistrySpecifier,
  checkReadiness,
  composeGenericConfig,
  deriveLaunchReadiness,
  extractWithFlags,
  loadLaunchPlan,
  loadOverlayFragment,
  mergeConfigs,
  migrateRetiredProfiles,
  normalizeLaunchPlan,
  projectTmuxConfig,
  resolveAgent,
  resolveConfigHome,
  resolveUserConfigPath,
} from './launch-config.js';

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

  // PBCLI-18: `playbook run ...` is the non-interactive presentation of the
  // same generic-config Captain session. It never resolves or launches the
  // tmux presenter, but it receives the launch inputs shared with this host.
  if (argv[0] === 'run') {
    const { runPlaybookRun } = await import('./run.js');
    return await runPlaybookRun({
      argv: argv.slice(1),
      stdout,
      stderr,
      env,
      homeDir: home,
      userConfigPath,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.loadModule ? { loadModule: options.loadModule } : {}),
      ...(options.readStdin ? { readStdin: options.readStdin } : {}),
      ...(options.hostRoots ? { hostRoots: options.hostRoots } : {}),
      ...(options.prepareRegistryModule
        ? { prepareRegistryModule: options.prepareRegistryModule }
        : {}),
      ...(options.adapterImports
        ? { adapterImports: options.adapterImports }
        : {}),
      ...(options.createCaptainRuntime
        ? { createCaptainRuntime: options.createCaptainRuntime }
        : {}),
      ...(options.createCaptainSessionId
        ? { createCaptainSessionId: options.createCaptainSessionId }
        : {}),
      ...(options.createLogicalSessionId
        ? { createLogicalSessionId: options.createLogicalSessionId }
        : {}),
      ...(options.createHostRuntime
        ? { createHostRuntime: options.createHostRuntime }
        : {}),
      ...(options.sessionStore
        ? { sessionStore: options.sessionStore }
        : {}),
      ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.createSessionTempId
        ? { createSessionTempId: options.createSessionTempId }
        : {}),
      ...(options.createAttemptId
        ? { createAttemptId: options.createAttemptId }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      // PBCLI-39: the run path gates on SDK availability too.
      ...(options.probeAdapterSdk
        ? { probeAdapterSdk: options.probeAdapterSdk }
        : {}),
      ...(options.classifyRuntime
        ? { classifyRuntime: options.classifyRuntime }
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
  const noProvision = forwardArgv.includes('--no-provision');
  forwardArgv = forwardArgv.filter((arg) => arg !== '--no-provision');
  if (noProvision && hasExplicitConfig(argv)) {
    stderr.write(
      'playbook: --no-provision applies to configured registry preparation ' +
        'and cannot combine with a raw --config launch\n',
    );
    return { code: COMPOSITION_FAILURE_EXIT_CODE };
  }

  // PBCLI-1: explicit `--config <path>` launches that raw tmux-play config
  // directly, bypassing seeding, composition, and the readiness gate.
  if (hasExplicitConfig(argv)) {
    try {
      assertRawConfigHasNoManagedSelector(argv);
    } catch (error) {
      stderr.write(`playbook: ${errorMessage(error)}\n`);
      return { code: COMPOSITION_FAILURE_EXIT_CODE };
    }
    return await launchTmuxPlay(spawnFn, [tmuxPlayBin, ...argv], stderr);
  }

  let interactiveArgs;
  try {
    interactiveArgs = parseInteractiveArgs(forwardArgv);
  } catch (error) {
    stderr.write(`playbook: ${errorMessage(error)}\n`);
    return { code: COMPOSITION_FAILURE_EXIT_CODE };
  }

  const launchCwd = resolve(
    options.cwd ?? process.cwd(),
    interactiveArgs.cwd ?? '.',
  );
  // PBCLI-49: selected planning is deliberately provisional. It narrows the
  // current config before preparation; the pane child later acquires the
  // lease and repeats the authoritative read before any host/import work.
  let store;
  let selectedRecord;
  if (interactiveArgs.sessionId !== undefined) {
    try {
      store = createInteractiveStore(options, env, home);
      selectedRecord = validateCaptainSessionRecord(
        await store.read(interactiveArgs.sessionId),
      );
      if (selectedRecord.state !== 'settled') {
        throw new Error(
          `Captain session ${JSON.stringify(interactiveArgs.sessionId)} has an uncertain turn; recover it with playbook run before reopening interactively`,
        );
      }
    } catch (error) {
      stderr.write(`playbook: ${errorMessage(error)}\n`);
      return { code: COMPOSITION_FAILURE_EXIT_CODE };
    }
  }

  let plan;
  try {
    plan = selectedRecord
      ? await loadSelectedLaunchPlanDataOnly({
          userConfigPath,
          overlayPaths: withPaths,
          structuralProjection: selectedRecord.structuralProjection,
          onNotice: (line) => stderr.write(line),
        })
      : await loadLaunchPlan({
          userConfigPath,
          overlayPaths: withPaths,
          loadModule,
          prepareRegistryModule:
            options.prepareRegistryModule ??
            prepareConfiguredRegistries({
              enabled: !noProvision,
              stderr,
              hostRoots: options.hostRoots,
              commandName: 'playbook',
            }),
          onNotice: (line) => stderr.write(line),
        });
  } catch (error) {
    stderr.write(`playbook: ${errorMessage(error)}\n`);
    return { code: COMPOSITION_FAILURE_EXIT_CODE };
  }

  // PBCLI-5: `--list` prints each configured playbook's id, effective
  // command, and intent without launching tmux-play.
  if (interactiveArgs.list) {
    for (const pb of Object.values(plan.catalog)) {
      stdout.write(`/${pb.command}  ${pb.id}  —  ${pb.intent}\n`);
    }
    return { code: 0 };
  }

  // PBCLI-12/46: readiness derives from the same normalized execution plan
  // that both front ends consume, independent of its tmux projection.
  const declaredAdapters = adaptersFromLaunchPlan(plan);
  const readiness = checkReadiness(declaredAdapters, env, home);
  // PBCLI-39/40: SDK availability is an independent check with its own
  // remedy — a credential and an SDK can be missing at once, and reporting
  // only the first would send the user round the loop twice.
  const { unusableAdapters } = await checkAdapterSdks(
    declaredAdapters,
    options.probeAdapterSdk ?? probeAdapterSdk,
    ...(options.classifyRuntime ? [options.classifyRuntime] : []),
  );
  for (const adapter of readiness.unknownAdapters) {
    stderr.write(
      `playbook: warning: no readiness check for adapter "${adapter}"\n`,
    );
  }
  if (readiness.failingAdapters.length > 0 || unusableAdapters.length > 0) {
    stderr.write(
      helpText({
        userConfigPath,
        failingAdapters: readiness.failingAdapters,
        // PBCLI-40: the ephemeral re-run must carry the lineup's full mapped
        // SDK set and the user's own arguments, so it completes in one hop
        // and is executable exactly as printed.
        sdkFailureLines: adapterSdkFailureLines(unusableAdapters, {
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

  // tmux-play's diagnostics command is an explicit presentation escape hatch,
  // not a managed logical session. Preserve its established direct child
  // status/signal behavior and do not allocate a durable UUID or lease.
  if (interactiveArgs.themeDiagnostics) {
    const { dir: tempDir, path: composedPath } = writeComposedConfig(
      projectTmuxConfig(plan),
    );
    try {
      return await launchTmuxPlay(
        spawnFn,
        [
          tmuxPlayBin,
          '--config',
          composedPath,
          ...interactiveArgs.diagnosticArgv,
        ],
        stderr,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  try {
    store ??= createInteractiveStore(options, env, home);
  } catch (error) {
    stderr.write(`playbook: ${errorMessage(error)}\n`);
    return { code: COMPOSITION_FAILURE_EXIT_CODE };
  }

  let sessionId;
  let executionProjection;
  let cwd;
  try {
    if (selectedRecord) {
      sessionId = selectedRecord.sessionId;
      cwd = selectedRecord.cwd;
      executionProjection = assertCaptainSessionExecutionCompatible(
        selectedRecord.structuralProjection,
        executionConfigFromPlan(plan),
      );
    } else {
      sessionId = (options.createLogicalSessionId ?? randomUUID)();
      if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
        throw new Error(
          `logical session id generator returned a non-UUID value: ${JSON.stringify(sessionId)}`,
        );
      }
      cwd = launchCwd;
      executionProjection = executionConfigFromPlan(plan);
    }
  } catch (error) {
    stderr.write(`playbook: ${errorMessage(error)}\n`);
    return { code: COMPOSITION_FAILURE_EXIT_CODE };
  }

  const { dir: tempDir, path: composedPath } = writeComposedConfig(
    projectTmuxConfig(plan),
  );
  let prepared;
  try {
    throwIfSignalAborted(options.signal);
    prepared = await awaitManagedPreparation(
      () =>
        (options.launchManagedTmuxPlay ?? launchManagedTmuxPlay)({
          sessionId,
          configPath: composedPath,
          cwd,
          stdout,
          stderr,
          ...(options.attach !== undefined ? { attach: options.attach } : {}),
          ...(options.adapterImports
            ? { adapterImports: options.adapterImports }
            : {}),
          createSessionCommand: (context) =>
            createManagedInteractiveSessionCommand(
              context,
              {
                schemaVersion: MANAGED_INTERACTIVE_PAYLOAD_SCHEMA_VERSION,
                kind: MANAGED_INTERACTIVE_PAYLOAD_KIND,
                mode: selectedRecord ? 'selected' : 'fresh',
                sessionId,
                cwd,
                sessionsDir: store.sessionsDir,
                noProvision,
                executionProjection,
              },
              {
                selfBin:
                  options.managedSessionBin ??
                  fileURLToPath(
                    new URL('./interactive-session.js', import.meta.url),
                  ),
                ...(options.execPath ? { execPath: options.execPath } : {}),
              },
            ),
        }),
      options.signal,
    );
    if (prepared?.sessionId !== sessionId) {
      await cancelPreparedAfterFailure(
        prepared,
        new Error('managed tmux-play prepared a mismatched session id'),
      );
    }
    try {
      await writeStream(
        stderr,
        `playbook: session ${sessionId}\n`,
        options.signal,
      );
    } catch (error) {
      await cancelPreparedAfterFailure(prepared, error);
    }
    await cancelPreparedIfAborted(prepared, options.signal);
    await prepared.attach({
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onBeforeManagedAttach
        ? { beforeNativeAttach: options.onBeforeManagedAttach }
        : {}),
    });
    return { code: 0 };
  } catch (error) {
    stderr.write(`playbook: failed to launch managed session: ${errorMessage(error)}\n`);
    return { code: COMPOSITION_FAILURE_EXIT_CODE };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function parseInteractiveArgs(argv) {
  if (argv.includes('--theme-diagnostics')) {
    if (argv.filter((arg) => arg === '--theme-diagnostics').length > 1) {
      throw new Error('--theme-diagnostics was repeated');
    }
    if (argv.some((arg) => arg === '--session' || arg.startsWith('--session='))) {
      throw new Error('--session cannot combine with --theme-diagnostics');
    }
    if (argv.includes('--list')) {
      throw new Error('--list cannot combine with --theme-diagnostics');
    }
    const recoveryArg = argv.find(
      (arg) =>
        arg === '--continue' ||
        arg === '--retry-uncertain' ||
        arg === '--discard-uncertain',
    );
    if (recoveryArg !== undefined) {
      throw new Error(
        `${recoveryArg} is headless recovery syntax; use playbook run with an explicit session`,
      );
    }
    return Object.freeze({
      sessionId: undefined,
      cwd: undefined,
      list: false,
      themeDiagnostics: true,
      diagnosticArgv: Object.freeze([...argv]),
    });
  }

  let sessionId;
  let cwd;
  let list = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') {
      if (list) throw new Error('--list was repeated');
      list = true;
      continue;
    }
    if (arg === '--session' || arg.startsWith('--session=')) {
      if (sessionId !== undefined) {
        throw new Error('interactive --session selector was repeated or combined');
      }
      sessionId = optionValue(argv, index, '--session');
      if (arg === '--session') index += 1;
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        throw new Error('--session requires a canonical lowercase UUID');
      }
      continue;
    }
    if (arg === '--cwd' || arg.startsWith('--cwd=')) {
      if (cwd !== undefined) throw new Error('interactive --cwd was repeated');
      cwd = optionValue(argv, index, '--cwd');
      if (arg === '--cwd') index += 1;
      continue;
    }
    if (
      arg === '--continue' ||
      arg === '--retry-uncertain' ||
      arg === '--discard-uncertain'
    ) {
      throw new Error(
        `${arg} is headless recovery syntax; use playbook run with an explicit session`,
      );
    }
    throw new Error(
      `unsupported managed interactive option ${JSON.stringify(arg)}`,
    );
  }
  if (sessionId !== undefined && cwd !== undefined) {
    throw new Error(
      'interactive --cwd cannot combine with --session; the stored working directory is authoritative',
    );
  }
  if (sessionId !== undefined && list) {
    throw new Error('--session cannot combine with --list');
  }
  if (list && cwd !== undefined) {
    throw new Error('--cwd applies to a fresh launch and cannot combine with --list');
  }
  return Object.freeze({
    sessionId,
    cwd,
    list,
    themeDiagnostics: false,
    diagnosticArgv: Object.freeze([]),
  });
}

// PBCLI-23/24/49: the executable converts termination signals into an abort of
// an active headless turn or a not-yet-attached managed launch, waits for its
// uncertain marker and lease cleanup, then asks the caller to re-raise the
// original signal. Cligent invokes the supplied synchronous hand-off only
// after input activation and immediately before starting the native tmux
// client; that exact boundary transfers signal ownership to native terminal
// semantics without leaving an unowned activation interval.
export async function runPlaybookCliEntry(options = {}) {
  const processLike = options.processLike ?? process;
  const entryArgv = options.argv ?? processLike.argv?.slice(2) ?? [];
  if (entryArgv[0] !== 'run' && !isManagedInteractiveInvocation(entryArgv)) {
    return runPlaybookCli(options);
  }
  const controller = new AbortController();
  let receivedSignal;
  let signalOwnershipTransferred = false;
  const handlers = {};
  const removeHandlers = () => {
    for (const [signal, handler] of Object.entries(handlers)) {
      processLike.off(signal, handler);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    handlers[signal] = () => {
      if (receivedSignal !== undefined) {
        removeHandlers();
        processLike.kill(processLike.pid, signal);
        return;
      }
      receivedSignal = signal;
      controller.abort(new Error(`received ${signal}`));
    };
  }
  for (const [signal, handler] of Object.entries(handlers)) {
    processLike.on(signal, handler);
  }
  try {
    const result = await runPlaybookCli({
      ...options,
      signal: controller.signal,
      onBeforeManagedAttach: () => {
        signalOwnershipTransferred = true;
        removeHandlers();
        options.onBeforeManagedAttach?.();
      },
    });
    return receivedSignal === undefined || signalOwnershipTransferred
      ? result
      : { signal: receivedSignal };
  } finally {
    removeHandlers();
  }
}

function isManagedInteractiveInvocation(argv) {
  return (
    !argv.includes('--help') &&
    !argv.includes('-h') &&
    !argv.includes('--list') &&
    !argv.includes('--theme-diagnostics') &&
    !hasExplicitConfig(argv)
  );
}

function writeComposedConfig(composed) {
  const dir = mkdtempSync(join(tmpdir(), 'playbook-'));
  const path = join(dir, 'tmux-play.config.yaml');
  writeFileSync(path, stringifyYaml(composed));
  return { dir, path };
}

function hasExplicitConfig(argv) {
  return argv.some((arg) => arg === '--config' || arg.startsWith('--config='));
}

function assertRawConfigHasNoManagedSelector(argv) {
  const managed = argv.find(
    (arg) =>
      arg === '--session' ||
      arg.startsWith('--session=') ||
      arg === '--continue' ||
      arg === '--retry-uncertain' ||
      arg === '--discard-uncertain',
  );
  if (managed !== undefined) {
    throw new Error(
      `${managed} selects a managed Captain session and cannot combine with a raw --config launch`,
    );
  }
}

function optionValue(argv, index, name) {
  const arg = argv[index];
  const value =
    arg === name ? argv[index + 1] : arg.slice(`${name}=`.length);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function createInteractiveStore(options, env, home) {
  return (
    options.sessionStore ??
    createCaptainSessionStore({
      env,
      homeDir: home,
      ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.createSessionTempId
        ? { createTempId: options.createSessionTempId }
        : {}),
    })
  );
}

async function writeStream(stream, text, signal) {
  throwIfSignalAborted(signal);
  const ready = stream.write(text);
  if (ready !== false || typeof stream.once !== 'function') return;
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      stream.off?.('drain', onDrain);
      stream.off?.('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error) => {
      cleanup();
      rejectPromise(error);
    };
    const onAbort = () => {
      cleanup();
      rejectPromise(signal.reason ?? new Error('operation aborted'));
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function awaitManagedPreparation(start, signal) {
  throwIfSignalAborted(signal);
  const launch = Promise.resolve().then(start);
  if (signal === undefined) return launch;

  let onAbort;
  const aborted = new Promise((resolvePromise) => {
    onAbort = () => resolvePromise({ type: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const outcome = await Promise.race([
    launch.then(
      (value) => ({ type: 'prepared', value }),
      (error) => ({ type: 'failed', error }),
    ),
    aborted,
  ]);
  signal.removeEventListener('abort', onAbort);
  if (outcome.type === 'prepared') return outcome.value;
  if (outcome.type === 'failed') throw outcome.error;

  const abortError = signal.reason ?? new Error('operation aborted');
  let latePrepared;
  try {
    latePrepared = await launch;
  } catch (launchError) {
    throw aggregateOperationalFailures(
      abortError,
      launchError,
      'managed tmux-play preparation failed while retiring an aborted launch',
    );
  }
  await cancelPreparedAfterFailure(latePrepared, abortError);
}

async function cancelPreparedIfAborted(prepared, signal) {
  if (!signal?.aborted) return;
  await cancelPreparedAfterFailure(
    prepared,
    signal.reason ?? new Error('operation aborted'),
  );
}

async function cancelPreparedAfterFailure(prepared, primary) {
  try {
    if (typeof prepared?.cancel !== 'function') {
      throw new Error('managed tmux-play preparation has no cancellation boundary');
    }
    await prepared.cancel();
  } catch (cancelError) {
    throw aggregateOperationalFailures(
      primary,
      cancelError,
      `managed session operation failed (${errorMessage(primary)}) and cancellation could not prove ownership retirement`,
    );
  }
  throw primary;
}

function aggregateOperationalFailures(primary, secondary, summary) {
  return new AggregateError(
    [primary, secondary],
    `${summary}: ${errorMessage(secondary)}`,
  );
}

function throwIfSignalAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('operation aborted');
  }
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
    '  playbook [--with <path>]... [--no-provision] [--cwd <path>]',
    '  playbook --session <id> [--with <path>]... [--no-provision]',
    '  playbook --list [--with <path>]... [--no-provision]',
    '  playbook --theme-diagnostics [--with <path>]... [--cwd <path>]',
    '  playbook --config <path> [tmux-play arguments...]',
    '  playbook run [--with <path>]... [--no-provision] [--json]',
    '               [--verbose] [--] [input]',
    '  playbook run (--continue | --session <id>) [reply]',
    '  playbook run --session <id> --retry-uncertain',
    '  playbook run --session <id> --discard-uncertain',
    '  playbook --help',
    '',
    `Default config: ${userConfigPath}`,
    '',
    '  Only a fresh managed launch accepts --cwd. It creates a durable logical',
    '  Captain session and reports `playbook: session <id>` before attach.',
    '  Reopen that same session with `playbook --session <id>` or submit one',
    '  headless turn with `playbook run --session <id> [reply]`; selected',
    '  sessions always retain their stored working directory.',
    '  --with <path> overlays a top-level config fragment (same format as',
    '  the default config) for a fresh launch or compatible ordinary reopen —',
    '  maps merge recursively, other values replace, later files win, and the',
    '  default config file is never modified.',
    '  --no-provision keeps configured filesystem registries read-only;',
    '  any missing engine links remain a launch error.',
    '  `playbook run --verbose` prints Captain telemetry topics to stderr.',
    '  `playbook run --help` prints complete continuation and recovery usage.',
    '  Raw --config and --theme-diagnostics use cligent\'s stock tmux-play',
    '  process boundary and do not create or select a durable Captain session.',
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
    '  - set the top-level captain and each stable players.<id> to an',
    '    adapter shorthand (claude, codex) or an inline agent block',
    '  - bind every playbooks.<id>.roles.<role> explicitly to a player id;',
    '    reusing one id deliberately shares that provider conversation',
    '  - the launcher injects captain.from and retains referenced player ids',
    '    verbatim',
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
  const result = await runPlaybookCliEntry();
  if (result.signal) process.kill(process.pid, result.signal);
  // Let Node drain a long piped Captain reply or diagnostic naturally.
  else process.exitCode = result.code ?? 0;
}
