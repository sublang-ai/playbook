// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-18/19/20: `playbook run <from> [task]` runs one playbook once,
// non-interactively and without tmux-play, over a headless PlaybookPorts
// host backed by cligent's Cligent. The playbook need not be enabled in
// config; its registry entry is loaded straight from the `<from>` module.
// PBCLI-22/23 (DR-014): a turn that parks awaiting a Boss reply persists
// the session under ${XDG_STATE_HOME:-$HOME/.local/state}/playbook/sessions,
// prints the pending question to stdout, and `playbook run resume
// <session-id> [reply]` (or `--last`) finishes it in a later invocation.

import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Cligent,
  isEffortSupported,
  supportedEffortValues,
} from '@sublang/cligent';
import { parse as parseYaml } from 'yaml';
import { hiddenControlEnvelope } from '../../../../src/xstate-runtime.js';
import {
  adapterSdkFailureLines,
  checkAdapterSdks,
  mappedSdksFor,
  probeAdapterSdk,
} from './adapter-sdk.js';
import { provisionEngine } from './provision.js';

// PBCLI-19: adapter shorthands the run host can construct.
const ADAPTER_LOADERS = {
  claude: async () =>
    (await import('@sublang/cligent/adapters/claude-code')).ClaudeCodeAdapter,
  codex: async () => (await import('@sublang/cligent/adapters/codex')).CodexAdapter,
  gemini: async () =>
    (await import('@sublang/cligent/adapters/gemini')).GeminiAdapter,
  opencode: async () =>
    (await import('@sublang/cligent/adapters/opencode')).OpenCodeAdapter,
};

const DEFAULT_ADAPTER = 'claude';
// PBCLI-18: exit-code map — terminal 0, arg/import 1, failed/aborted 2,
// suspended/quiescent 3.
const EXIT = { terminal: 0, arg: 1, failed: 2, suspended: 3 };
// PBCLI-23: session-file schema version for the park/resume store.
const SESSION_STORE_VERSION = 1;
// PBCLI-23: a session id names a file inside the store; anything with a
// path separator (or any character a fresh UUID cannot contain) would
// escape the 0700-protected directory and must be rejected before join.
const SESSION_REF_PATTERN = /^[A-Za-z0-9-]+$/;

export async function runPlaybookRun(options = {}) {
  const argv = options.argv ?? [];
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwdDefault = options.cwd ?? process.cwd();
  const loadModule =
    options.loadModule ??
    ((specifier) => import(registryImportSpecifier(specifier, cwdDefault)));
  const createAgent = options.createAgent ?? defaultCreateAgent;
  const readStdin = options.readStdin ?? readAllStdin;
  const sessionsDir = options.sessionsDir ?? defaultSessionsDir(process.env);
  // PBCLI-28/29: config defaults come from the same user config file the
  // interactive launcher resolves; tests inject a hermetic path.
  const userConfigPath =
    options.userConfigPath ?? (await defaultUserConfigPath());
  const ctx = {
    stdout,
    stderr,
    cwdDefault,
    loadModule,
    createAgent,
    readStdin,
    sessionsDir,
    userConfigPath,
    // PBCLI-39: the adapter SDK probe, injectable like createAgent so tests
    // can drive an unavailable SDK without uninstalling one.
    probeAdapterSdk: options.probeAdapterSdk ?? probeAdapterSdk,
    // PBCLI-40: the original invocation, preserved on the ephemeral re-run;
    // this module receives argv with the leading `run` already consumed.
    rawArgv: ['run', ...argv],
    ephemeralNpx: options.ephemeralNpx,
    // PBCLI-37: injected host package roots let tests provision against
    // synthetic trees, like the injected session store.
    hostRoots: options.hostRoots,
  };

  let args;
  try {
    args = parseRunArgs(argv);
  } catch (error) {
    stderr.write(`playbook run: ${message(error)}\n`);
    return { code: EXIT.arg };
  }
  if (args.help) {
    stdout.write(runHelpText());
    return { code: 0 };
  }
  if (args.resume) return runResume(args, ctx);
  return runFirst(args, ctx);
}

// PBCLI-18/20: the one-shot first run.
async function runFirst(args, ctx) {
  const { stderr, cwdDefault, readStdin } = ctx;
  if (!args.from) {
    stderr.write('playbook run: missing <from> registry module\n');
    return { code: EXIT.arg };
  }

  // PBCLI-36/37 (DR-024): provision engine links for a filesystem module
  // before importing it; a resolvable engine is never touched.
  const provisioned = await maybeProvision(args.from, args, ctx);
  if (provisioned.code !== undefined) return provisioned;

  const loaded = await loadRegistryEntry(args.from, ctx);
  if (loaded.code !== undefined) return loaded;
  const { entry } = loaded;

  let task = args.task;
  if (task === undefined) task = (await readStdin()).trim();
  if (!task) {
    stderr.write('playbook run: empty task; pass it as an argument or on stdin\n');
    return { code: EXIT.arg };
  }

  // PBCLI-28 (DR-017): config-supplied defaults bind only a first run;
  // runResume rebuilds the lineup stored with the session.
  let runDefaults;
  try {
    runDefaults = await loadRunDefaults(ctx.userConfigPath);
  } catch (error) {
    stderr.write(`playbook run: ${message(error)}\n`);
    return { code: EXIT.arg };
  }

  // PBCLI-19/28: bind every required role, then the captain — flag over
  // config default over built-in claude. An unrequired run.players role is
  // ignored (the config is global across playbooks); an unrequired
  // --player flag stays an error below.
  const roleSpecs = new Map(
    entry.requiredRoleIds.map((role) => [
      role,
      {
        ...(runDefaults.players.get(role) ??
          runDefaults.player ?? { adapter: DEFAULT_ADAPTER }),
      },
    ]),
  );
  for (const [role, spec] of args.players) {
    if (!roleSpecs.has(role)) {
      stderr.write(`playbook run: --player ${role} is not a required role\n`);
      return { code: EXIT.arg };
    }
    roleSpecs.set(role, spec);
  }
  const captainSpec =
    args.captain ?? runDefaults.captain ?? { adapter: DEFAULT_ADAPTER };
  const specError = specsDiagnostic([...roleSpecs.values(), captainSpec]);
  if (specError !== undefined) {
    stderr.write(`playbook run: ${specError}\n`);
    return { code: EXIT.arg };
  }

  // PBCLI-39/40: an optional-peer SDK that is not installed fails here,
  // before the runtime exists and before any agent call — never mid-turn.
  const sdkError = await adapterSdksDiagnostic(
    [...roleSpecs.values(), captainSpec],
    ctx,
    args.task === undefined ? [task] : [],
  );
  if (sdkError !== undefined) {
    stderr.write(sdkError);
    return { code: EXIT.arg };
  }

  let runtime;
  try {
    runtime = entry.createRuntime({
      captainOptions: args.option,
      players: playersFromSpecs(roleSpecs),
    });
  } catch (error) {
    stderr.write(`playbook run: ${message(error)}\n`);
    return { code: EXIT.arg };
  }

  // PBCLI-23: the record stores everything a resume needs to rebuild the
  // identical host. `cwd` is resolved to an absolute path so a resume from
  // another directory rebinds the agents to the same place.
  const store = {
    schemaVersion: SESSION_STORE_VERSION,
    sessionId: randomUUID(),
    playbookId: entry.id,
    from: registryImportSpecifier(args.from, cwdDefault),
    cwd: resolve(cwdDefault, args.cwd ?? '.'),
    captain: captainSpec,
    players: Object.fromEntries(roleSpecs),
    option: args.option,
  };
  return driveTurn({
    ctx,
    runtime,
    store,
    text: task,
    json: args.json,
    verbose: args.verbose,
    restoreFrom: undefined,
  });
}

// PBCLI-22/23: continue a persisted parked session.
async function runResume(args, ctx) {
  const { stderr, readStdin, sessionsDir } = ctx;
  if (
    args.players.size > 0 ||
    args.captain !== undefined ||
    Object.keys(args.option).length > 0 ||
    args.cwd !== undefined
  ) {
    stderr.write(
      'playbook run: resume uses the bindings stored with the session; ' +
        'drop --player/--captain/--option/--cwd\n',
    );
    return { code: EXIT.arg };
  }

  let sessionFile;
  let record;
  if (args.last) {
    const latest = await latestSessionRecord(sessionsDir);
    if (!latest) {
      stderr.write(`playbook run: no persisted session under ${sessionsDir}\n`);
      return { code: EXIT.arg };
    }
    ({ file: sessionFile, record } = latest);
  } else if (args.sessionRef) {
    if (!SESSION_REF_PATTERN.test(args.sessionRef)) {
      stderr.write(
        `playbook run: "${args.sessionRef}" is not a session id\n`,
      );
      return { code: EXIT.arg };
    }
    sessionFile = join(sessionsDir, `${args.sessionRef}.json`);
    try {
      record = JSON.parse(await readFile(sessionFile, 'utf8'));
    } catch (error) {
      stderr.write(
        `playbook run: cannot read session ${args.sessionRef}: ${message(error)}\n`,
      );
      return { code: EXIT.arg };
    }
  } else {
    stderr.write('playbook run: resume needs a <session-id> or --last\n');
    return { code: EXIT.arg };
  }
  if (!isValidSessionRecord(record)) {
    stderr.write(
      `playbook run: ${sessionFile} is not a schema-version-${SESSION_STORE_VERSION} playbook run session\n`,
    );
    return { code: EXIT.arg };
  }

  let reply = args.task;
  if (reply === undefined) reply = (await readStdin()).trim();
  if (!reply) {
    stderr.write(
      'playbook run: empty reply; pass it as an argument or on stdin\n',
    );
    return { code: EXIT.arg };
  }

  // PBCLI-37: a stored filesystem `from` (a file: URL) is probed and
  // provisioned on resume exactly as on a first run.
  const provisioned = await maybeProvision(record.from, args, ctx);
  if (provisioned.code !== undefined) return provisioned;

  const loaded = await loadRegistryEntry(record.from, ctx);
  if (loaded.code !== undefined) return loaded;
  const { entry } = loaded;
  // PBCLI-23: the module may have changed since the session parked; a
  // different playbook id means a different machine, which the stored
  // snapshot cannot rehydrate.
  if (entry.id !== record.playbookId) {
    stderr.write(
      `playbook run: ${record.from} now exposes playbook "${entry.id}", ` +
        `but the stored session belongs to "${record.playbookId}"\n`,
    );
    return { code: EXIT.arg };
  }
  const roleSpecs = new Map(Object.entries(record.players));
  const missingRole = entry.requiredRoleIds.find(
    (role) => !roleSpecs.has(role),
  );
  if (missingRole !== undefined) {
    stderr.write(
      `playbook run: stored session lacks required role "${missingRole}"; ` +
        `the ${record.from} module changed since the session parked\n`,
    );
    return { code: EXIT.arg };
  }
  const specError = specsDiagnostic([...roleSpecs.values(), record.captain]);
  if (specError !== undefined) {
    stderr.write(`playbook run: ${specError}\n`);
    return { code: EXIT.arg };
  }

  // PBCLI-39: a resume rebuilds the stored lineup, so it needs the same
  // SDKs — an install that lost one must not resume into a mid-turn error.
  const sdkError = await adapterSdksDiagnostic(
    [...roleSpecs.values(), record.captain],
    ctx,
    args.task === undefined ? [reply] : [],
  );
  if (sdkError !== undefined) {
    stderr.write(sdkError);
    return { code: EXIT.arg };
  }

  let runtime;
  try {
    runtime = entry.createRuntime({
      captainOptions: record.option,
      players: playersFromSpecs(roleSpecs),
    });
  } catch (error) {
    stderr.write(`playbook run: ${message(error)}\n`);
    return { code: EXIT.arg };
  }
  if (typeof runtime.restore !== 'function') {
    stderr.write(
      `playbook run: the ${record.from} runtime does not support resume\n`,
    );
    return { code: EXIT.arg };
  }

  return driveTurn({
    ctx,
    runtime,
    store: record,
    text: reply,
    json: args.json,
    verbose: args.verbose,
    restoreFrom: { snapshot: record.snapshot, sessionFile },
  });
}

// PBCLI-18: shared module-load pipeline for `<from>` and a stored resume
// specifier. Returns { entry } or an { code } failure already reported.
async function loadRegistryEntry(specifier, { loadModule, stderr }) {
  let entry;
  try {
    entry = (await loadModule(specifier))?.default;
  } catch (cause) {
    stderr.write(
      `playbook run: ${specifier} failed to import: ${message(cause)}\n`,
    );
    return { code: EXIT.arg };
  }
  if (!isValidRegistryEntry(entry)) {
    stderr.write(
      `playbook run: ${specifier} exposes no valid registry entry\n`,
    );
    return { code: EXIT.arg };
  }
  return { entry };
}

// PBCLI-20/23: one Boss turn over the headless cligent-backed ports,
// parking to the session store when the playbook awaits a Boss reply.
async function driveTurn({ ctx, runtime, store, text, json, verbose, restoreFrom }) {
  const { stdout, stderr, createAgent } = ctx;
  const { sessionId, cwd } = store;

  const agentsByRole = new Map();
  for (const [role, spec] of Object.entries(store.players)) {
    agentsByRole.set(role, createAgent({ ...spec, role, cwd }));
  }
  const captainAgent = createAgent({ ...store.captain, role: 'captain', cwd });

  const controller = new AbortController();
  const ports = {
    async callPlayer(playerId, prompt, signal, callOptions) {
      const agent = agentsByRole.get(playerId);
      if (!agent) return { status: 'error', error: `unknown player ${playerId}` };
      const result = await agent.run(prompt, { resume: callOptions?.resume, signal });
      return toPlayerResult(result);
    },
    async callCaptain(prompt, signal, callOptions) {
      const result = await captainAgent.run(prompt, {
        resume: callOptions?.resume,
        ...(callOptions?.allowedTools === undefined
          ? {}
          : { allowedTools: callOptions.allowedTools }),
        signal,
      });
      return {
        status: result.status,
        ...(result.finalText === undefined
          ? {}
          : { finalText: result.finalText }),
        ...(result.error ? { error: result.error } : {}),
      };
    },
    async callJudge(prompt, signal) {
      // CAPTAIN-9 / DR-013 A1: wrap every judge prompt in the shared
      // hidden-control envelope. Runtime judge prompts embed raw Boss text
      // and quoted player output, so the envelope is what makes them
      // delimited evidence rather than instructions — and it is the
      // prompt-level isolation that stands in for provider enforcement
      // when the tool allowlist below has to be omitted.
      const result = await captainAgent.run(hiddenControlEnvelope(prompt), {
        resume: false,
        // An empty allowlist means "no tools" and is distinct from omission,
        // which grants the adapter's full tool surface. Send it only where
        // the adapter can enforce it; codex rejects any tool list outright,
        // so requesting one would fail every judge call.
        ...controlCallToolOptions(store.captain.adapter),
        signal,
      });
      if (result.status !== 'ok' || result.finalText === undefined) {
        throw new Error(result.error ?? 'judge call failed');
      }
      return result.finalText;
    },
    async callPlaybook() {
      // The one-shot host cannot drive the child, but returning a suspended
      // start lets the linked runtime expose that boundary as outcome
      // `suspended`, which finishRun maps to the documented exit code 3.
      return { state: 'suspended', childSessionId: randomUUID() };
    },
    async emitStatus(statusText) {
      stderr.write(`◇ ${statusText}\n`);
    },
    async emitTelemetry(event) {
      if (verbose) stderr.write(`· ${event.topic}\n`);
    },
  };

  const session = {
    sessionId,
    playbookId: store.playbookId,
    rootSessionId: sessionId,
    depth: 0,
    ports,
  };
  // DR-014 §2: only a successfully persisted parked hand-off skips
  // disposal; the session is then suspended, not ended.
  let parked = false;
  try {
    if (restoreFrom) {
      try {
        await runtime.restore(session, restoreFrom.snapshot);
      } catch (error) {
        stderr.write(
          `playbook run: session ${sessionId} cannot be resumed: ${message(error)}\n`,
        );
        return { code: EXIT.arg };
      }
    } else {
      await runtime.init(session);
    }
    const result = await runtime.handleBossInput({
      text,
      signal: controller.signal,
    });
    const parkedSnapshot =
      (result.outcome === 'quiescent' || result.outcome === 'no-action') &&
      typeof runtime.exportSnapshot === 'function'
        ? runtime.exportSnapshot()
        : undefined;
    if (parkedSnapshot && parkedSnapshot.pendingBossQuestions.length > 0) {
      const outcome = await finishParked({
        ctx,
        store,
        snapshot: parkedSnapshot,
        json,
      });
      parked = outcome.code === EXIT.suspended;
      return outcome;
    }
    const outcome = finishRun(result, { stdout, stderr, json, sessionId });
    if (restoreFrom && result.outcome === 'terminal') {
      // The turn succeeded; a session-file removal failure must not mask
      // the terminal output or flip the exit code.
      try {
        await rm(restoreFrom.sessionFile, { force: true });
      } catch (error) {
        stderr.write(
          `playbook run: warning: could not remove ${restoreFrom.sessionFile}: ${message(error)}\n`,
        );
      }
    }
    return outcome;
  } catch (error) {
    stderr.write(`playbook run: ${message(error)}\n`);
    return { code: EXIT.failed };
  } finally {
    if (!parked) {
      try {
        await runtime.dispose();
      } catch {
        // A dispose failure must not mask the run's own outcome.
      }
    }
  }
}

// PBCLI-23: persist the parked session and surface the pending question —
// stdout carries the question text (the run's product), stderr one hint
// naming the session id and the exact resume command.
async function finishParked({ ctx, store, snapshot, json }) {
  const { stdout, stderr } = ctx;
  const now = new Date().toISOString();
  const record = {
    ...store,
    createdAt: store.createdAt ?? now,
    updatedAt: now,
    snapshot,
  };
  const file = join(ctx.sessionsDir, `${store.sessionId}.json`);
  try {
    await mkdir(ctx.sessionsDir, { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash mid-write can never truncate the only
    // durable copy of the session.
    const tmpFile = `${file}.${process.pid}.tmp`;
    await writeFile(tmpFile, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(tmpFile, file);
  } catch (error) {
    stderr.write(`playbook run: cannot persist session: ${message(error)}\n`);
    return { code: EXIT.failed };
  }
  const questions = snapshot.pendingBossQuestions;
  if (json) {
    stdout.write(
      `${JSON.stringify(
        {
          outcome: 'awaiting-reply',
          sessionId: store.sessionId,
          questions: questions.map(({ questionId, player, question }) => ({
            questionId,
            player,
            question,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    stdout.write(`${questions.map(({ question }) => question).join('\n')}\n`);
  }
  stderr.write(
    `playbook run: session ${store.sessionId} is awaiting a Boss reply; ` +
      `continue with: playbook run resume ${store.sessionId} "<answer>"\n`,
  );
  return { code: EXIT.suspended };
}

// PBCLI-18: map the single turn's outcome to stdout output and an exit code.
function finishRun(result, { stdout, stderr, json, sessionId }) {
  switch (result.outcome) {
    case 'terminal':
      stdout.write(
        (json
          ? JSON.stringify(
              {
                outcome: 'terminal',
                sessionId,
                output: result.output ?? null,
              },
              null,
              2,
            )
          : renderOutput(result.output)) + '\n',
      );
      return { code: EXIT.terminal };
    case 'failed':
    case 'aborted':
      stderr.write(
        `playbook run: ${result.outcome}${
          result.error ? `: ${result.error.message}` : ''
        }\n`,
      );
      return { code: EXIT.failed };
    case 'suspended':
      stderr.write(
        'playbook run: playbook made a nested call a one-shot run cannot answer\n',
      );
      return { code: EXIT.suspended };
    default:
      // quiescent / no-action without a persistable pending question:
      // the pre-DR-014 diagnostic path.
      stderr.write(
        'playbook run: playbook is awaiting Boss input; a one-shot run cannot continue\n',
      );
      return { code: EXIT.suspended };
  }
}

function renderOutput(output) {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  if (
    typeof output === 'object' &&
    typeof (output.response ?? output.finalText) === 'string'
  ) {
    return output.response ?? output.finalText;
  }
  return JSON.stringify(output);
}

function toPlayerResult(result) {
  return {
    status: result.status,
    ...(result.finalText === undefined ? {} : { finalText: result.finalText }),
    ...(result.resumeToken ? { resumeToken: result.resumeToken } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

function playersFromSpecs(roleSpecs) {
  return [...roleSpecs].map(([role, spec]) => ({
    id: role,
    adapter: spec.adapter,
    ...(spec.model ? { model: spec.model } : {}),
  }));
}

// DR-013 A1: adapters with no provider-enforced tool-restriction surface.
// Cligent's codex adapter rejects any allowedTools value — including the
// empty list that expresses tool-free — so a control call that requests one
// fails before the model is reached. Omission is the only way such an
// adapter can run a control call; isolation then rests on the prompt.
const ADAPTERS_WITHOUT_TOOL_ENFORCEMENT = new Set(['codex']);

// Keep requesting enforcement whenever the adapter is unknown, so the
// DR-013 guarantee holds by default.
function controlCallToolOptions(captainAdapter) {
  if (ADAPTERS_WITHOUT_TOOL_ENFORCEMENT.has(captainAdapter)) return {};
  return { allowedTools: [] };
}

// PBCLI-19/26: returns a diagnostic for the first invalid spec — an
// unknown adapter or an effort the adapter does not support — or
// undefined when every spec resolves. The caller must compare against
// undefined.
function specsDiagnostic(specs) {
  for (const spec of specs) {
    if (
      !isAgentSpec(spec) ||
      !Object.prototype.hasOwnProperty.call(ADAPTER_LOADERS, spec.adapter)
    ) {
      const adapter = isAgentSpec(spec)
        ? spec.adapter
        : String(spec?.adapter);
      return `unknown adapter "${adapter}"`;
    }
    if (spec.effort !== undefined && !isEffortSupported(spec.adapter, spec.effort)) {
      const supported = supportedEffortValues(spec.adapter).join(', ');
      return `adapter "${spec.adapter}" does not support effort "${spec.effort}" (supported: ${supported})`;
    }
  }
  return undefined;
}

// PBCLI-39/40: returns the ready-to-write stderr block naming every bound
// adapter whose optional-peer SDK is not installed, or undefined when every
// one of them loads. Runs only after specsDiagnostic has accepted the
// adapter names, so every spec here carries a known adapter.
async function adapterSdksDiagnostic(specs, ctx, stdinArgs = []) {
  const adapters = specs.map((spec) => spec.adapter);
  const { missingAdapters } = await checkAdapterSdks(
    adapters,
    ctx.probeAdapterSdk,
  );
  if (missingAdapters.length === 0) return undefined;
  const [header, ...commands] = adapterSdkFailureLines(missingAdapters, {
    // PBCLI-40: the ephemeral re-run carries the lineup's full mapped SDK
    // set and the original arguments, so it completes in one hop and runs
    // exactly as printed. A task or reply consumed from stdin before this
    // gate is appended behind an end-of-options `--`: quoting alone cannot
    // keep a flag-shaped value (`--json`, `- bullet …`) from being read as
    // an option, and the pipe that supplied it will not exist when the
    // printed command runs.
    requiredSdks: mappedSdksFor(adapters),
    invocation: [
      ...ctx.rawArgv,
      ...(stdinArgs.length > 0 ? ['--', ...stdinArgs] : []),
    ],
    ...(ctx.ephemeralNpx !== undefined
      ? { ephemeralNpx: ctx.ephemeralNpx }
      : {}),
  }).filter((line) => line !== '');
  // Only the header takes the command prefix; the install lines stay
  // copy-pasteable.
  return [`playbook run: ${header}`, ...commands]
    .map((line) => `${line}\n`)
    .join('');
}

function isAgentSpec(spec) {
  return (
    typeof spec === 'object' &&
    spec !== null &&
    typeof spec.adapter === 'string' &&
    spec.adapter.length > 0 &&
    (spec.model === undefined || typeof spec.model === 'string') &&
    (spec.effort === undefined ||
      (typeof spec.effort === 'string' && spec.effort.length > 0))
  );
}

// PBCLI-29: the run host reads the same user config file the interactive
// launcher resolves. The resolver is imported lazily: a static import of
// ./playbook.js would deadlock the CLI entry — playbook.js is still
// mid-evaluation of its own top-level await when it dynamically imports
// this module, and a circular static edge back to it can never settle.
// The launcher always injects userConfigPath, so this default runs only
// for direct runPlaybookRun callers, where playbook.js is not evaluating.
async function defaultUserConfigPath() {
  const { resolveUserConfigPath } = await import('./playbook.js');
  return resolveUserConfigPath(process.env, process.env.HOME ?? homedir());
}

// PBCLI-28/29 (DR-017): default agent specs for a first run, read from the
// user config's top-level `run` map. An absent file or absent map is an
// empty default set; a malformed file or block fails closed — the run must
// never silently bind different agents than the user configured. Adapter
// and effort support of the specs actually bound flow through the shared
// specsDiagnostic path.
async function loadRunDefaults(userConfigPath) {
  const defaults = { players: new Map() };
  let text;
  try {
    text = await readFile(userConfigPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return defaults;
    throw new Error(`cannot read config ${userConfigPath}: ${message(error)}`);
  }
  let config;
  try {
    config = parseYaml(text);
  } catch (error) {
    throw new Error(`cannot parse config ${userConfigPath}: ${message(error)}`);
  }
  const run = isPlainMap(config) ? config.run : undefined;
  if (run === undefined || run === null) return defaults;
  if (!isPlainMap(run)) {
    throw new Error(`${userConfigPath}: run must be a map of agent defaults`);
  }
  if (run.captain !== undefined) {
    defaults.captain = parseAgentDefault(run.captain, 'run.captain', userConfigPath);
  }
  if (run.player !== undefined) {
    defaults.player = parseAgentDefault(run.player, 'run.player', userConfigPath);
  }
  if (run.players !== undefined && run.players !== null) {
    if (!isPlainMap(run.players)) {
      throw new Error(
        `${userConfigPath}: run.players must be a map of <role>: <agent>`,
      );
    }
    for (const [role, value] of Object.entries(run.players)) {
      defaults.players.set(
        role,
        parseAgentDefault(value, `run.players.${role}`, userConfigPath),
      );
    }
  }
  return defaults;
}

function parseAgentDefault(value, key, userConfigPath) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `${userConfigPath}: ${key} must be an <adapter>[:<model>][@<effort>] string`,
    );
  }
  try {
    return parseAgent(value);
  } catch (error) {
    throw new Error(`${userConfigPath}: ${key}: ${message(error)}`);
  }
}

function isPlainMap(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// PBCLI-23: the session store honors XDG_STATE_HOME at invocation time.
export function defaultSessionsDir(env = process.env) {
  const stateHome =
    typeof env.XDG_STATE_HOME === 'string' && env.XDG_STATE_HOME.trim() !== ''
      ? env.XDG_STATE_HOME
      : join(homedir(), '.local', 'state');
  return join(stateHome, 'playbook', 'sessions');
}

// PBCLI-23: `--last` selects by the record's own update timestamp, not
// filesystem mtime. Unreadable or foreign .json files are skipped.
async function latestSessionRecord(sessionsDir) {
  let names;
  try {
    names = await readdir(sessionsDir);
  } catch {
    return undefined;
  }
  const candidates = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const file = join(sessionsDir, name);
        try {
          const record = JSON.parse(await readFile(file, 'utf8'));
          if (!isValidSessionRecord(record)) return undefined;
          if (typeof record.updatedAt !== 'string') return undefined;
          return { file, record };
        } catch {
          return undefined;
        }
      }),
  );
  let latest;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!latest || candidate.record.updatedAt > latest.record.updatedAt) {
      latest = candidate;
    }
  }
  return latest;
}

function isValidSessionRecord(record) {
  return (
    typeof record === 'object' &&
    record !== null &&
    record.schemaVersion === SESSION_STORE_VERSION &&
    typeof record.sessionId === 'string' &&
    SESSION_REF_PATTERN.test(record.sessionId) &&
    typeof record.playbookId === 'string' &&
    typeof record.from === 'string' &&
    typeof record.cwd === 'string' &&
    isAgentSpec(record.captain) &&
    typeof record.players === 'object' &&
    record.players !== null &&
    Object.values(record.players).every(isAgentSpec) &&
    typeof record.option === 'object' &&
    record.option !== null &&
    typeof record.snapshot === 'object' &&
    record.snapshot !== null
  );
}

// PBCLI-20: default agent — one lazily-built Cligent per role, run through
// the same event drain as tmux-play's host.
function defaultCreateAgent({ adapter, model, effort, cwd, role }) {
  let cligent;
  return {
    async run(prompt, callOptions) {
      if (!cligent) {
        const AdapterClass = await ADAPTER_LOADERS[adapter]();
        // Protected auto mode (as the seeded lineup uses, PBCLI-11) so a
        // one-shot run does not block on routine approval prompts.
        cligent = new Cligent(new AdapterClass(), {
          cwd,
          role,
          permissions: { mode: 'auto' },
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        });
      }
      return runCligentCall(cligent, prompt, callOptions);
    },
  };
}

export async function runCligentCall(cligent, prompt, callOptions = {}) {
  const { resume, allowedTools, signal } = callOptions;
  const gen = cligent.run(prompt, {
    ...(signal ? { abortSignal: signal } : {}),
    ...(resume !== undefined ? { resume } : {}),
    ...(allowedTools !== undefined ? { allowedTools: [...allowedTools] } : {}),
  });
  const textParts = [];
  let done;
  let lastError;
  let completed = false;
  try {
    for (;;) {
      let next;
      try {
        next = await gen.next();
      } catch (error) {
        return { status: signal?.aborted ? 'aborted' : 'error', error: message(error) };
      }
      if (next.done) {
        completed = true;
        break;
      }
      const event = next.value;
      if (event.type === 'text' && typeof event.payload?.content === 'string') {
        textParts.push(event.payload.content);
      } else if (
        event.type === 'text_delta' &&
        typeof event.payload?.delta === 'string'
      ) {
        textParts.push(event.payload.delta);
      }
      if (event.type === 'error') lastError = event.payload?.message;
      if (event.type === 'done') done = event.payload;
    }
  } finally {
    if (!completed) {
      try {
        await gen.return(undefined);
      } catch {
        // The original outcome is already captured.
      }
    }
  }
  const status = done ? mapStatus(done.status) : 'error';
  const finalText = done?.result ?? (textParts.length > 0 ? textParts.join('') : undefined);
  return {
    status,
    finalText,
    ...(done?.resumeToken ? { resumeToken: done.resumeToken } : {}),
    ...(status === 'error'
      ? { error: done?.result ?? lastError ?? 'agent run failed' }
      : {}),
  };
}

function mapStatus(doneStatus) {
  if (doneStatus === 'success') return 'ok';
  if (doneStatus === 'interrupted') return 'aborted';
  return 'error';
}

export function parseRunArgs(argv) {
  const args = {
    from: undefined,
    task: undefined,
    resume: false,
    sessionRef: undefined,
    last: false,
    players: new Map(),
    captain: undefined,
    option: {},
    cwd: undefined,
    json: false,
    verbose: false,
    noProvision: false,
    help: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // PBCLI-40: end-of-options — everything after `--` is positional, so a
    // flag-shaped task or reply (a stdin-derived `--json`, a `- bullet`
    // line) survives the ephemeral re-run round trip instead of being
    // reinterpreted as an option.
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--no-provision') args.noProvision = true;
    else if (arg === '--last') args.last = true;
    else if (arg === '--cwd') args.cwd = takeValue(argv, (i += 1), '--cwd');
    else if (arg === '--captain')
      args.captain = parseAgent(takeValue(argv, (i += 1), '--captain'));
    else if (arg === '--player') {
      const [role, agent] = takePair(takeValue(argv, (i += 1), '--player'), '--player');
      args.players.set(role, parseAgent(agent));
    } else if (arg === '--option') {
      const [key, value] = takePair(takeValue(argv, (i += 1), '--option'), '--option');
      args.option[key] = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else positionals.push(arg);
  }
  // PBCLI-22: `playbook run resume <session-id>|--last [reply]`.
  if (positionals[0] === 'resume') {
    args.resume = true;
    let rest = positionals.slice(1);
    if (!args.last) {
      args.sessionRef = rest[0];
      rest = rest.slice(1);
    }
    if (rest.length > 0) args.task = rest.join(' ');
    return args;
  }
  if (args.last) throw new Error('--last applies to `playbook run resume`');
  args.from = positionals[0];
  if (positionals.length > 1) args.task = positionals.slice(1).join(' ');
  return args;
}

// PBCLI-19: `<agent>` is `<adapter>[:<model>][@<effort>]`. The effort
// rides after the last `@` so a model name may itself contain colons
// (`opencode:ollama/llama3:8b@max`); `claude@high` keeps the default
// model while setting effort.
function parseAgent(value) {
  const at = value.lastIndexOf('@');
  const spec = at === -1 ? value : value.slice(0, at);
  const effort = at === -1 ? undefined : value.slice(at + 1);
  if (at !== -1 && !effort) {
    throw new Error(`agent "${value}" has an empty effort after '@'`);
  }
  const colon = spec.indexOf(':');
  const adapter = colon === -1 ? spec : spec.slice(0, colon);
  const model = colon === -1 ? undefined : spec.slice(colon + 1);
  return {
    adapter,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

function takeValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

function takePair(value, flag) {
  const eq = value.indexOf('=');
  if (eq <= 0) throw new Error(`${flag} needs <key>=<value>`);
  return [value.slice(0, eq), value.slice(eq + 1)];
}

function registryImportSpecifier(specifier, cwd) {
  if (
    isAbsolute(specifier) ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('.\\') ||
    specifier.startsWith('..\\')
  ) {
    return pathToFileURL(resolve(cwd, specifier)).href;
  }
  return specifier;
}

// PBCLI-37: the absolute file path of a filesystem `<from>` (path or
// file: URL), or undefined for a bare package specifier — those resolve
// from the host's own module tree and are neither probed nor provisioned.
function moduleFilePath(specifier, cwd) {
  if (specifier.startsWith('file:')) return fileURLToPath(specifier);
  if (
    isAbsolute(specifier) ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('.\\') ||
    specifier.startsWith('..\\')
  ) {
    return resolve(cwd, specifier);
  }
  return undefined;
}

// PBCLI-36/37: probe-and-provision for a filesystem registry module.
// Returns {} to proceed or { code } after a reported provisioning fault.
async function maybeProvision(specifier, args, ctx) {
  const modulePath = moduleFilePath(specifier, ctx.cwdDefault);
  if (modulePath === undefined) return {};
  return provisionEngine({
    modulePath,
    stderr: ctx.stderr,
    enabled: !args.noProvision,
    hostRoots: ctx.hostRoots,
  });
}

function isValidRegistryEntry(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.id === 'string' &&
    typeof value.command === 'string' &&
    typeof value.intent === 'string' &&
    Array.isArray(value.requiredRoleIds) &&
    typeof value.validateOptions === 'function' &&
    typeof value.createRuntime === 'function'
  );
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function runHelpText() {
  return [
    'Usage:',
    '  playbook run <from> [task] [options]',
    '  playbook run resume <session-id> [reply] [options]',
    '  playbook run resume --last [reply] [options]',
    '',
    '  <from>   registry module specifier (package subpath, path, or file: URL)',
    '  [task]   Boss intent; read from stdin when omitted',
    '  [reply]  Boss reply to a parked session; read from stdin when omitted',
    '  --       end of options; use before a task or reply that starts with -',
    '',
    'Options:',
    '  --player <role>=<agent>   bind a required role (repeatable)',
    '  --captain <agent>         set the captain/judge agent',
    '  --option <key>=<value>    playbook option slice (repeatable)',
    '  --cwd <dir>               agents working directory',
    '  --json                    print one JSON envelope (outcome, sessionId,',
    '                            output or questions) instead of plain text',
    '  --last                    resume the most recently parked session',
    '  --verbose                 forward telemetry topics to stderr',
    '  --no-provision            never create engine links beside a',
    '                            filesystem <from> module',
    '  -h, --help                print this help',
    '',
    '  <agent> is <adapter>[:<model>][@<effort>] over the shorthands',
    '  claude, codex, gemini, opencode — e.g. codex:gpt-5.5@xhigh, or',
    '  claude@high for the default model at high effort. Every role and',
    '  the captain default to claude, unless a top-level run: block in',
    '  ${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml',
    '  supplies defaults — run.captain, run.players.<role>, or the',
    '  run.player catch-all for other roles; flags override per role.',
    '',
    '  When a playbook needs a Boss reply, the run prints the question,',
    '  parks the session under',
    '  ${XDG_STATE_HOME:-$HOME/.local/state}/playbook/sessions, and exits 3;',
    '  answer with `playbook run resume`. Bindings are stored with the',
    '  session, so resume takes no --player/--captain/--option/--cwd.',
    '',
  ].join('\n');
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
