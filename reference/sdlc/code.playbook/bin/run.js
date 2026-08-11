// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-18/20 (DR-031): `playbook run [input]` is the non-interactive
// presentation of the same configured Captain session that `playbook` hosts
// in tmux. The core below uses cligent's ordinary tmux-play runtime without a
// presenter; it does not construct a registry runtime or PlaybookPorts itself.

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createTmuxPlayRuntime } from '@sublang/cligent/tmux-play';
import { createPlaybookCaptainShell } from '../playbook-captain.js';
import {
  adapterSdkFailureLines,
  checkAdapterSdks,
  mappedSdksFor,
  probeAdapterSdk,
} from './adapter-sdk.js';
import {
  adaptersFromLaunchPlan,
  checkReadiness,
  loadLaunchPlan,
  resolveUserConfigPath,
} from './launch-config.js';
import { prepareConfiguredRegistries } from './provision.js';

const EXIT = { ok: 0, argument: 1, turn: 2 };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

  // PBCLI-18/40: drain a piped producer before config, provisioning, or a
  // potentially slow SDK gate. The entire decoded stream is one Boss turn;
  // trim is used only to reject empty input and never changes submitted text.
  let input = args.input;
  if (input === undefined) {
    try {
      input = await (options.readStdin ?? readAllStdin)();
    } catch (error) {
      await writeStream(
        stderr,
        `playbook run: cannot read stdin: ${message(error)}\n`,
      );
      return { code: EXIT.argument };
    }
  }
  if (input.trim().length === 0) {
    await writeStream(
      stderr,
      'playbook run: empty input; pass one argument or pipe a Boss message on stdin\n',
    );
    return { code: EXIT.argument };
  }

  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? homedir();
  const cwd = resolve(options.cwd ?? process.cwd());
  const userConfigPath =
    options.userConfigPath ?? resolveUserConfigPath(env, home);
  const loadModule = options.loadModule ?? ((specifier) => import(specifier));
  const prepareRegistryModule =
    options.prepareRegistryModule ??
    prepareConfiguredRegistries({
      enabled: !args.noProvision,
      stderr,
      hostRoots: options.hostRoots,
      commandName: 'playbook run',
    });

  let plan;
  const configNotices = [];
  try {
    plan = await loadLaunchPlan({
      userConfigPath,
      overlayPaths: args.withPaths,
      loadModule,
      prepareRegistryModule,
      onNotice: (line) => configNotices.push(line),
    });
  } catch (error) {
    for (const line of configNotices) await writeStream(stderr, line);
    await writeStream(stderr, `playbook run: ${message(error)}\n`);
    return { code: EXIT.argument };
  }
  for (const line of configNotices) await writeStream(stderr, line);

  const adapters = adaptersFromLaunchPlan(plan);
  const readiness = checkReadiness(adapters, env, home);
  let sdkReadiness;
  try {
    sdkReadiness = await checkAdapterSdks(
      adapters,
      options.probeAdapterSdk ?? probeAdapterSdk,
      ...(options.classifyRuntime ? [options.classifyRuntime] : []),
    );
  } catch (error) {
    await writeStream(
      stderr,
      `playbook run: adapter readiness failed: ${message(error)}\n`,
    );
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
    return { code: EXIT.argument };
  }

  let sessionId;
  let config;
  try {
    sessionId = (options.createLogicalSessionId ?? randomUUID)();
    if (typeof sessionId !== 'string' || !UUID_PATTERN.test(sessionId)) {
      throw new Error(
        `logical session id generator returned a non-UUID value: ${JSON.stringify(sessionId)}`,
      );
    }
    config = executionConfigFromPlan(plan);
  } catch (error) {
    await writeStream(stderr, `playbook run: ${message(error)}\n`);
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
      ...(options.restoreSnapshot
        ? { restoreSnapshot: options.restoreSnapshot }
        : {}),
    });
  } catch (error) {
    await writeStream(stderr, `playbook run: ${message(error)}\n`);
    return {
      code:
        error instanceof HeadlessHostSetupError
          ? EXIT.argument
          : EXIT.turn,
    };
  }

  // Task 6 has no durable hand-off yet, so a fresh one-turn process disposes
  // after capturing the complete snapshot. Task 7 can persist `settled`
  // before choosing not to call this semantic teardown.
  try {
    await settled.dispose();
  } catch (error) {
    await writeStream(
      stderr,
      `playbook run: Captain session teardown failed: ${message(error)}\n`,
    );
    return { code: EXIT.turn };
  }

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
}) {
  const replies = [];
  let shell;
  let host;
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
    } catch (error) {
      throw new HeadlessHostSetupError(error);
    }
    await host.runBossTurn(input);
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
    else if (arg === '--with') {
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

function replayInvocation(argv, args, input) {
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
    '',
    'Options:',
    '  --with <path>    overlay a generic config fragment (repeatable)',
    '  --no-provision   do not provision thin filesystem registry engines',
    '  --json           print exactly {"sessionId", "reply"}',
    '  --verbose        print Captain telemetry topics to stderr',
    '  -h, --help       print this help without reading input or config',
    '',
  ].join('\n');
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
