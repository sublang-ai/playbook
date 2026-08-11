#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  projectTmuxConfig,
  resolveUserConfigPath,
  checkReadiness,
} from './launch-config.js';
import { prepareConfiguredRegistries } from './provision.js';

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
    return await launchTmuxPlay(spawnFn, [tmuxPlayBin, ...argv], stderr);
  }

  let plan;
  try {
    plan = await loadLaunchPlan({
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
  if (argv.includes('--list')) {
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

  const { dir: tempDir, path: composedPath } = writeComposedConfig(
    projectTmuxConfig(plan),
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

// PBCLI-23/24: the executable converts termination signals into an abort of
// the active headless host, lets its uncertain marker and lease cleanup
// finish, then asks the caller to re-raise the original signal.
export async function runPlaybookCliEntry(options = {}) {
  const processLike = options.processLike ?? process;
  const entryArgv = options.argv ?? processLike.argv?.slice(2) ?? [];
  if (entryArgv[0] !== 'run') {
    return runPlaybookCli(options);
  }
  const controller = new AbortController();
  let receivedSignal;
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
    });
    return receivedSignal === undefined ? result : { signal: receivedSignal };
  } finally {
    removeHandlers();
  }
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
    '  playbook [--list] [--with <path>]... [--no-provision]',
    '           [--config <path>] [tmux-play options]',
    '  playbook run [--with <path>]... [--no-provision] [--json]',
    '               [--verbose] [--] [input]',
    '  playbook --help',
    '',
    `Default config: ${userConfigPath}`,
    '',
    '  --with <path> overlays a top-level config fragment (same format as',
    '  the default config) over the default config for this launch only —',
    '  maps merge recursively, other values replace, later files win. The',
    '  default config file is never modified.',
    '  --no-provision keeps configured filesystem registries read-only;',
    '  any missing engine links remain a launch error.',
    '  `playbook run --verbose` prints Captain telemetry topics to stderr.',
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
