// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-18/19/20: `playbook run <from> [task]` runs one playbook once,
// non-interactively and without tmux-play, over a headless PlaybookPorts
// host backed by cligent's Cligent. The playbook need not be enabled in
// config; its registry entry is loaded straight from the `<from>` module.

import { randomUUID } from 'node:crypto';
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

export async function runPlaybookRun(options = {}) {
  const argv = options.argv ?? [];
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const loadModule = options.loadModule ?? ((specifier) => import(specifier));
  const createAgent = options.createAgent ?? defaultCreateAgent;
  const readStdin = options.readStdin ?? readAllStdin;
  const cwdDefault = options.cwd ?? process.cwd();

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
  if (!args.from) {
    stderr.write('playbook run: missing <from> registry module\n');
    return { code: EXIT.arg };
  }

  let entry;
  try {
    entry = (await loadModule(args.from))?.default;
  } catch (cause) {
    stderr.write(
      `playbook run: ${args.from} failed to import: ${message(cause)}\n`,
    );
    return { code: EXIT.arg };
  }
  if (!isValidRegistryEntry(entry)) {
    stderr.write(`playbook run: ${args.from} exposes no valid registry entry\n`);
    return { code: EXIT.arg };
  }

  let task = args.task;
  if (task === undefined) task = (await readStdin()).trim();
  if (!task) {
    stderr.write('playbook run: empty task; pass it as an argument or on stdin\n');
    return { code: EXIT.arg };
  }

  // PBCLI-19: bind every required role, then the captain; defaults to claude.
  const cwd = args.cwd ?? cwdDefault;
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
  for (const spec of [...roleSpecs.values(), captainSpec]) {
    if (!ADAPTER_LOADERS[spec.adapter]) {
      stderr.write(`playbook run: unknown adapter "${spec.adapter}"\n`);
      return { code: EXIT.arg };
    }
  }

  const agentsByRole = new Map();
  for (const [role, spec] of roleSpecs) {
    agentsByRole.set(role, createAgent({ ...spec, role, cwd }));
  }
  const captainAgent = createAgent({ ...captainSpec, role: 'captain', cwd });

  const players = [...roleSpecs].map(([role, spec]) => ({
    id: role,
    adapter: spec.adapter,
    ...(spec.model ? { model: spec.model } : {}),
  }));

  let runtime;
  try {
    runtime = entry.createRuntime({ captainOptions: args.option, players });
  } catch (error) {
    stderr.write(`playbook run: ${message(error)}\n`);
    return { code: EXIT.arg };
  }

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
      return { status: result.status, finalText: result.finalText, ...(result.error ? { error: result.error } : {}) };
    },
    async callJudge(prompt, signal) {
      const result = await captainAgent.run(prompt, { signal });
      if (result.status !== 'ok' || result.finalText === undefined) {
        throw new Error(result.error ?? 'judge call failed');
      }
      return result.finalText;
    },
    async callPlaybook() {
      throw new Error('playbook run cannot host nested playbook calls');
    },
    async emitStatus(text) {
      stderr.write(`◇ ${text}\n`);
    },
    async emitTelemetry(event) {
      if (args.verbose) stderr.write(`· ${event.topic}\n`);
    },
  };

  const session = {
    sessionId: randomUUID(),
    playbookId: entry.id,
    rootSessionId: randomUUID(),
    depth: 0,
    ports,
  };
  try {
    await runtime.init(session);
    const result = await runtime.handleBossInput({
      text: task,
      signal: controller.signal,
    });
    return finishRun(result, { stdout, stderr, json: args.json });
  } catch (error) {
    stderr.write(`playbook run: ${message(error)}\n`);
    return { code: EXIT.failed };
  } finally {
    try {
      await runtime.dispose();
    } catch {
      // A dispose failure must not mask the run's own outcome.
    }
  }
}

// PBCLI-18: map the single turn's outcome to stdout output and an exit code.
function finishRun(result, { stdout, stderr, json }) {
  switch (result.outcome) {
    case 'terminal':
      stdout.write(
        (json
          ? JSON.stringify(result.output ?? null, null, 2)
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
      // quiescent / no-action: the playbook is waiting on a Boss reply.
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
    finalText: result.finalText,
    ...(result.resumeToken ? { resumeToken: result.resumeToken } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
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

async function runCligentCall(cligent, prompt, callOptions = {}) {
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
      if (event.type === 'text' && typeof event.payload?.text === 'string') {
        textParts.push(event.payload.text);
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
    '',
    '  <from>   registry module specifier (package subpath, path, or file: URL)',
    '  [task]   Boss intent; read from stdin when omitted',
    '',
    'Options:',
    '  --player <role>=<agent>   bind a required role (repeatable)',
    '  --captain <agent>         set the captain/judge agent',
    '  --option <key>=<value>    playbook option slice (repeatable)',
    '  --cwd <dir>               agents working directory',
    '  --json                    print the terminal output as JSON',
    '  --verbose                 forward telemetry topics to stderr',
    '  -h, --help                print this help',
    '',
    '  <agent> is an adapter shorthand (claude, codex, gemini, opencode)',
    '  or <adapter>:<model>. Every role and the captain default to claude.',
    '',
  ].join('\n');
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
