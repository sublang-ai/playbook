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
import { pathToFileURL } from 'node:url';
import { Cligent } from '@sublang/cligent';

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
  const ctx = {
    stdout,
    stderr,
    cwdDefault,
    loadModule,
    createAgent,
    readStdin,
    sessionsDir,
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

  const loaded = await loadRegistryEntry(args.from, ctx);
  if (loaded.code !== undefined) return loaded;
  const { entry } = loaded;

  let task = args.task;
  if (task === undefined) task = (await readStdin()).trim();
  if (!task) {
    stderr.write('playbook run: empty task; pass it as an argument or on stdin\n');
    return { code: EXIT.arg };
  }

  // PBCLI-19: bind every required role, then the captain; defaults to claude.
  const roleSpecs = new Map(
    entry.requiredRoleIds.map((role) => [role, { adapter: DEFAULT_ADAPTER }]),
  );
  for (const [role, spec] of args.players) {
    if (!roleSpecs.has(role)) {
      stderr.write(`playbook run: --player ${role} is not a required role\n`);
      return { code: EXIT.arg };
    }
    roleSpecs.set(role, spec);
  }
  const captainSpec = args.captain ?? { adapter: DEFAULT_ADAPTER };
  const specError = firstUnknownAdapter([...roleSpecs.values(), captainSpec]);
  if (specError !== undefined) {
    stderr.write(`playbook run: unknown adapter "${specError}"\n`);
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
  const specError = firstUnknownAdapter([
    ...roleSpecs.values(),
    record.captain,
  ]);
  if (specError !== undefined) {
    stderr.write(`playbook run: unknown adapter "${specError}"\n`);
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
        allowedTools: callOptions?.allowedTools,
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
      const result = await captainAgent.run(prompt, {
        resume: false,
        allowedTools: [],
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

// Returns the first invalid or unknown adapter name, or undefined when
// every spec resolves. The caller must compare against undefined — an
// empty adapter string is a reportable error, not a pass.
function firstUnknownAdapter(specs) {
  for (const spec of specs) {
    if (
      !isAgentSpec(spec) ||
      !Object.prototype.hasOwnProperty.call(ADAPTER_LOADERS, spec.adapter)
    ) {
      return isAgentSpec(spec) ? spec.adapter : String(spec?.adapter);
    }
  }
  return undefined;
}

function isAgentSpec(spec) {
  return (
    typeof spec === 'object' &&
    spec !== null &&
    typeof spec.adapter === 'string' &&
    spec.adapter.length > 0 &&
    (spec.model === undefined || typeof spec.model === 'string')
  );
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
function defaultCreateAgent({ adapter, model, cwd, role }) {
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
    help: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--verbose') args.verbose = true;
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

// PBCLI-19: `<agent>` is an adapter shorthand or `<adapter>:<model>`.
function parseAgent(value) {
  const colon = value.indexOf(':');
  if (colon === -1) return { adapter: value };
  return { adapter: value.slice(0, colon), model: value.slice(colon + 1) };
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
    '  -h, --help                print this help',
    '',
    '  <agent> is an adapter shorthand (claude, codex, gemini, opencode)',
    '  or <adapter>:<model>. Every role and the captain default to claude.',
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
