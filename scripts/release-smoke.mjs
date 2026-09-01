#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// RELEASE-28: the local, model-free release smoke — `pnpm smoke:release`.
//
// It packs the candidate, installs it into throwaway npm prefixes in both
// documented DR-026 shapes, exercises the installed CLI, drives the shared
// compiled Captain over a provisioned filesystem registry deterministically,
// and checks that what the tarball carries is byte-for-byte what the
// repository committed.
//
// No model calls, no credentials, and no tmux: agent availability is probed,
// the shared-Captain turn uses a deterministic injected adapter, and working
// playbook behavior is a DR-016 script actor. Registry access IS required —
// steps 2 and 3 install from npm.
//
// This is the gate that runs between `pnpm test` and `pnpm test:acceptance`
// (RELEASE-10). It fails fast, prints the failing step's own evidence, and
// preserves its temp root when a step fails (or with `--keep`).
//
// Usage: node scripts/release-smoke.mjs [--keep]

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CLIGENT_RELEASE_SPECIFIER,
  checkCligentReleaseCapabilities,
} from './cligent-release-capabilities.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keepArtifacts = process.argv.includes('--keep');
const maxBuffer = 64 * 1024 * 1024;
const smokeToken = 'RELEASE_SMOKE_OK';
const smokeContinuedReply = 'RELEASE_SMOKE_CONTINUED';
const smokeTask = 'Run the deterministic release smoke probe.';
const unsupportedFastModeAdapterMarker =
  '__PLAYBOOK_FAST_MODE_UNSUPPORTED_ADAPTER__';
const sessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const adapterSdks = ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'];
let isolatedNpmCache;
let tmuxSentinel;

class SmokeFailure extends Error {}

function fail(message, evidence) {
  throw new SmokeFailure(
    evidence === undefined || evidence === ''
      ? message
      : `${message}\n${indent(evidence)}`,
  );
}

function indent(text) {
  return String(text)
    .trimEnd()
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function tail(text, characters = 4000) {
  const value = String(text ?? '');
  return value.length <= characters
    ? value
    : value.slice(value.length - characters);
}

function installTmuxSentinel(root) {
  const bin = join(root, 'no-tmux-bin');
  const marker = join(root, 'tmux-was-invoked');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'tmux'),
    [
      '#!/bin/sh',
      ': > "$PLAYBOOK_SMOKE_TMUX_MARKER"',
      'exit 97',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  tmuxSentinel = Object.freeze({ bin, marker });
}

function assertTmuxWasNotInvoked() {
  if (tmuxSentinel !== undefined && existsSync(tmuxSentinel.marker)) {
    fail(
      'the release smoke invoked tmux',
      'The gate-wide private PATH sentinel was executed.',
    );
  }
}

// A version manager's inherited prefix would send `npm install -g` to the
// maintainer's real global root instead of this run's throwaway one.
function smokeEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  if (isolatedNpmCache !== undefined) {
    env.npm_config_cache = isolatedNpmCache;
  }
  if (tmuxSentinel !== undefined) {
    const pathEntries = String(env.PATH ?? '').split(delimiter);
    if (pathEntries[0] !== tmuxSentinel.bin) {
      env.PATH = [tmuxSentinel.bin, env.PATH].filter(Boolean).join(delimiter);
    }
    env.PLAYBOOK_SMOKE_TMUX_MARKER = tmuxSentinel.marker;
  }
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: smokeEnv(options.env),
    encoding: 'utf8',
    maxBuffer,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.error) {
    fail(`${command} ${args.join(' ')} could not run`, result.error.message);
  }
  if (options.allowFailure !== true && result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} exited ${String(result.status)}`,
      `stdout:\n${tail(stdout)}\nstderr:\n${tail(stderr)}`,
    );
  }
  return { status: result.status, stdout, stderr };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walkFiles(root, onFile) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(path, onFile);
    else if (entry.isFile()) onFile(path);
  }
}

function walkDirectories(root, onDirectory) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    onDirectory(path, entry.name);
    walkDirectories(path, onDirectory);
  }
}

// SemVer caret membership, enough for the single `^x.y.z` range the manifest
// declares. Nothing here needs a dependency: a prerelease is outside a stable
// caret, and that is the only subtlety the guard depends on.
function satisfiesCaret(version, range) {
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!caret) return undefined;
  const parsed = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!parsed) return false;
  if (parsed[4] !== undefined) return false;
  const [major, minor, patch] = [1, 2, 3].map((i) => Number(caret[i]));
  const [vMajor, vMinor, vPatch] = [1, 2, 3].map((i) => Number(parsed[i]));
  if (vMajor !== major) return false;
  // `^0.y.z` admits only that same minor; `^x.y.z` (x > 0) admits any later
  // minor within the major.
  if (major === 0 && vMinor !== minor) return false;
  if (vMinor < minor) return false;
  if (vMinor === minor && vPatch < patch) return false;
  return true;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function installedPackageRoot(prefix) {
  return join(prefix, 'lib', 'node_modules', '@sublang', 'playbook');
}

function nestedCligentRoot(prefix) {
  return join(installedPackageRoot(prefix), 'node_modules', '@sublang', 'cligent');
}

function installGlobally(prefix, packages) {
  mkdirSync(prefix, { recursive: true });
  run(
    'npm',
    [
      'install',
      '-g',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      ...packages,
    ],
    { cwd: prefix },
  );
  const installed = installedPackageRoot(prefix);
  if (!existsSync(installed)) {
    fail(`the candidate did not install under ${installed}`);
  }
  const cligent = nestedCligentRoot(prefix);
  if (!existsSync(cligent)) {
    fail(
      `@sublang/cligent did not install nested under ${installed}`,
      'RELEASE-12: cligent is a regular dependency so a global install ' +
        "nests it inside the package's own module tree.",
    );
  }
  const bin = join(prefix, 'bin', 'playbook');
  if (!existsSync(bin)) fail(`the installed playbook command is missing: ${bin}`);
  return { installed, cligent, bin };
}

// RELEASE-13: probe from @sublang/cligent's INSTALLED location — the module
// scope the adapter itself imports from at run time. Probing anywhere else
// passes even when the SDK is unreachable to cligent.
function probeAdapters(prefix, expectation) {
  const cligent = nestedCligentRoot(prefix);
  const probe = join(cligent, 'smoke-adapters.mjs');
  writeFileSync(
    probe,
    readFileSync(join(repoRoot, 'scripts', 'smoke-adapters.mjs')),
  );
  const result = run('node', ['./smoke-adapters.mjs', expectation], {
    cwd: cligent,
    allowFailure: true,
  });
  if (result.status !== 0) {
    fail(
      `adapter probe expected every adapter ${expectation} from ${cligent}`,
      `stdout:\n${tail(result.stdout)}\nstderr:\n${tail(result.stderr)}`,
    );
  }
  return result.stdout.trimEnd();
}

function expectContains(haystack, needle, what) {
  if (!haystack.includes(needle)) {
    fail(`${what} did not contain ${JSON.stringify(needle)}`, tail(haystack));
  }
}

function parseExactHeadlessReply(stdout, expectedReply, expectedSessionId) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    fail(
      'the installed headless Captain did not emit one JSON object',
      `${error instanceof Error ? error.message : String(error)}\n${tail(stdout)}`,
    );
  }
  if (
    envelope === null ||
    Array.isArray(envelope) ||
    typeof envelope !== 'object' ||
    typeof envelope.sessionId !== 'string' ||
    !sessionIdPattern.test(envelope.sessionId) ||
    envelope.reply !== expectedReply ||
    (expectedSessionId !== undefined && envelope.sessionId !== expectedSessionId)
  ) {
    fail(
      'the installed headless Captain returned the wrong reply envelope',
      `expected reply ${JSON.stringify(expectedReply)}` +
        (expectedSessionId === undefined
          ? ''
          : ` and session ${JSON.stringify(expectedSessionId)}`) +
        `\nactual ${stdout.trimEnd()}`,
    );
  }
  const exact = `${JSON.stringify({
    sessionId: envelope.sessionId,
    reply: expectedReply,
  })}\n`;
  if (stdout !== exact) {
    fail(
      'headless JSON exposed fields or bytes beyond sessionId and reply',
      `expected ${JSON.stringify(exact)}\nactual   ${JSON.stringify(stdout)}`,
    );
  }
  return envelope;
}

function assertProvisionedEngineTree(repo, prefix) {
  const nodeModules = join(repo, 'node_modules');
  const scope = join(nodeModules, '@sublang');
  const nodeModulesEntries = readdirSync(nodeModules).sort();
  const scopeEntries = readdirSync(scope).sort();
  if (
    !lstatSync(nodeModules).isDirectory() ||
    !lstatSync(scope).isDirectory() ||
    JSON.stringify(nodeModulesEntries) !==
      JSON.stringify(['@sublang', 'xstate']) ||
    JSON.stringify(scopeEntries) !== JSON.stringify(['playbook'])
  ) {
    fail(
      'provisioning created an unexpected node_modules shape',
      JSON.stringify({
        nodeModules: nodeModulesEntries,
        '@sublang': scopeEntries,
      }),
    );
  }
  const prefixReal = `${realpathSync(prefix)}${sep}`;
  for (const name of ['xstate', join('@sublang', 'playbook')]) {
    const link = join(nodeModules, name);
    if (!lstatSync(link).isSymbolicLink()) {
      fail(`${link} is not a symbolic link`);
    }
    const target = realpathSync(readlinkSync(link));
    if (!target.startsWith(prefixReal)) {
      fail(`${link} resolves outside the isolated prefix`, target);
    }
  }
}

// A thin compiled-style artifact whose one working state is a DR-016 script
// actor. It declares the shared config's mapped worker but never calls it;
// the command leaves one durable effect so continuation can prove that the
// completed root action was not replayed. The exit-status guards are the
// DR-016 pair.
function smokeArtifactSource() {
  return `// Release smoke fixture: a thin artifact with one script state.
import { assign, setup } from 'xstate';
import {
  createXStatePlaybookRuntime,
} from '@sublang/playbook/xstate-runtime';

const machine = setup({}).createMachine({
  id: 'releasesmoke',
  initial: 'ready',
  context: {},
  states: {
    ready: {
      id: 'ready',
      description: 'Waits for the Boss task.',
      meta: {
        playbook: { stateId: 'ready', description: 'Waits for the Boss task.' },
      },
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'work',
          actions: assign({ task: ({ event }) => event.task }),
        },
      },
    },
    work: {
      id: 'work',
      description: 'SMOKE-1: Captain runs the deterministic probe command.',
      meta: {
        playbook: {
          stateId: 'work',
          description: 'SMOKE-1: Captain runs the deterministic probe command.',
        },
      },
      tags: ['playbook.busy'],
      invoke: {
        src: 'script',
        input: () => ({
          stateId: 'work',
          sourceItem: 'SMOKE-1',
          command: "echo effect >> .release-smoke-effects",
          result: {
            probed: 'The command exited zero.',
            probeFailed: 'The command exited nonzero.',
          },
        }),
        onDone: [
          {
            guard: ({ event }) => event.output.guard === 'probed',
            target: 'done',
            actions: assign({ exitStatus: ({ event }) => event.output.exitStatus }),
          },
          {
            target: 'failed',
            actions: assign({ exitStatus: ({ event }) => event.output.exitStatus }),
          },
        ],
        onError: {
          target: 'failed',
          actions: assign({ lastError: ({ event }) => String(event.error) }),
        },
      },
    },
    failed: {
      id: 'failed',
      description: 'Recoverable failure awaiting a fresh Boss task.',
      meta: {
        playbook: {
          stateId: 'failed',
          description: 'Recoverable failure awaiting a fresh Boss task.',
        },
      },
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'work',
          actions: assign({ task: ({ event }) => event.task }),
        },
      },
    },
    done: {
      id: 'done',
      description: 'The probe command succeeded.',
      meta: {
        playbook: {
          stateId: 'done',
          description: 'The probe command succeeded.',
        },
      },
      type: 'final',
    },
  },
  output: ({ context }) => ({
    token: ${JSON.stringify(smokeToken)},
    exitStatus: context.exitStatus ?? null,
  }),
});

const createRuntime = createXStatePlaybookRuntime(machine, {
  label: 'SMOKE',
  // Link-time literal per slc/link.md, so the fixture models linker output.
  compat: { artifactSchema: 3, runtimeAbi: 1 },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
  roleStates: {},
  outcomeAuthority: { governedPlayerStates: {} },
});

export default {
  id: 'smoke',
  command: 'smoke',
  intent: 'deterministic release smoke fixture',
  artifactSchema: 3,
  runtimeProfile: { kind: 'shared-factory', compat: createRuntime.compat },
  requiredRoleIds: [],
  concurrentRoleSets: [],
  validateOptions(value) {
    return value ?? {};
  },
  createRuntime(configuredOptions, hostCapabilities) {
    return createRuntime({ configuredOptions, hostCapabilities });
  },
};
`;
}

// A third packed-smoke registry whose one working state fails on demand: its
// script actor tests for a flag file, so the machine parks in its recoverable
// failure state while the flag is absent and reaches its terminal state on the
// replayed entry event once the flag exists. It declares the DR-034 retry
// source, which is what lets the second process advertise that replay at all —
// nothing of the first process survives but the record.
function recoverArtifactSource(flagPath) {
  return `// Release smoke fixture: a deliberately recoverable failure.
import { assign, setup } from 'xstate';
import {
  createXStatePlaybookRuntime,
} from '@sublang/playbook/xstate-runtime';

const machine = setup({}).createMachine({
  id: 'releaserecover',
  initial: 'ready',
  context: {},
  states: {
    ready: {
      id: 'ready',
      description: 'Waits for the Boss task.',
      meta: {
        playbook: { stateId: 'ready', description: 'Waits for the Boss task.' },
      },
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'work',
          actions: assign({ task: ({ event }) => event.task }),
        },
      },
    },
    work: {
      id: 'work',
      description: 'RECOVER-1: Captain runs the gated probe command.',
      meta: {
        playbook: {
          stateId: 'work',
          description: 'RECOVER-1: Captain runs the gated probe command.',
        },
      },
      tags: ['playbook.busy'],
      invoke: {
        src: 'script',
        input: () => ({
          stateId: 'work',
          sourceItem: 'RECOVER-1',
          command: ${JSON.stringify(`test -f ${flagPath}`)},
          result: {
            probed: 'The command exited zero.',
            probeFailed: 'The command exited nonzero.',
          },
        }),
        onDone: [
          {
            guard: ({ event }) => event.output.guard === 'probed',
            target: 'done',
          },
          { target: 'failed' },
        ],
        onError: {
          target: 'failed',
          actions: assign({ lastError: ({ event }) => String(event.error) }),
        },
      },
    },
    failed: {
      id: 'failed',
      description: 'Recoverable failure awaiting a fresh Boss task.',
      meta: {
        playbook: {
          stateId: 'failed',
          description: 'Recoverable failure awaiting a fresh Boss task.',
        },
      },
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'work',
          actions: assign({ task: ({ event }) => event.task }),
        },
      },
    },
    done: {
      id: 'done',
      description: 'The gated probe command succeeded.',
      meta: {
        playbook: {
          stateId: 'done',
          description: 'The gated probe command succeeded.',
        },
      },
      type: 'final',
    },
  },
  output: () => ({ token: ${JSON.stringify(smokeToken)} }),
});

const createRuntime = createXStatePlaybookRuntime(machine, {
  label: 'RECOVER',
  // Link-time literal per slc/link.md, so the fixture models linker output.
  compat: { artifactSchema: 3, runtimeAbi: 1 },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task', contextField: 'task' },
  roleStates: {},
  outcomeAuthority: { governedPlayerStates: {} },
});

export default {
  id: 'recover',
  command: 'recover',
  intent: 'deterministic recoverable-failure fixture',
  artifactSchema: 3,
  runtimeProfile: { kind: 'shared-factory', compat: createRuntime.compat },
  requiredRoleIds: [],
  concurrentRoleSets: [],
  validateOptions(value) {
    return value ?? {};
  },
  createRuntime(configuredOptions, hostCapabilities) {
    return createRuntime({ configuredOptions, hostCapabilities });
  },
};
`;
}

// A schema-3 governed player fixture whose only semantic arm requires one
// descendant commit. The packed matrix below deliberately supplies no
// terminal adapter result, so the authoritative commit identity can come
// only from the repository receipt that the installed host persists.
function effectArtifactSource() {
  return `// Release smoke fixture: governed repository-effect authority.
import { writeFileSync } from 'node:fs';
import { assign, fromPromise, setup } from 'xstate';
import {
  createXStatePlaybookRuntime,
} from '@sublang/playbook/xstate-runtime';

const acceptedOidPath = process.env.PLAYBOOK_SMOKE_ACCEPTED_OID_PATH;
if (typeof acceptedOidPath !== 'string' || acceptedOidPath.length === 0) {
  throw new Error('PLAYBOOK_SMOKE_ACCEPTED_OID_PATH is required');
}

const machine = setup({
  actors: {
    player: fromPromise(async () => {
      throw new Error('player actor must be provided by the runner');
    }),
  },
  guards: {
    completed: ({ event }) => event.output?.guard === 'complete',
  },
  actions: {
    'playbook.acceptedOutcome': () => {},
    recordAcceptedCommit: ({ event }) => {
      writeFileSync(acceptedOidPath, event.output.latestCommit + '\\n');
    },
  },
}).createMachine({
  id: 'releaseeffect',
  initial: 'ready',
  context: {},
  states: {
    ready: {
      id: 'ready',
      description: 'Waits for the repository-effect probe.',
      meta: {
        playbook: {
          stateId: 'ready',
          description: 'Waits for the repository-effect probe.',
        },
      },
      tags: ['playbook.parked'],
      on: {
        START: {
          target: 'work',
          actions: assign({ task: ({ event }) => event.task }),
        },
      },
    },
    work: {
      id: 'work',
      description: 'EFFECT-1: Worker creates one descendant commit.',
      meta: {
        playbook: {
          stateId: 'work',
          description: 'EFFECT-1: Worker creates one descendant commit.',
          role: 'coder',
        },
      },
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: 'work',
          role: 'coder',
          sourceItem: 'EFFECT-1',
          prompt: [
            'EFFECT-SMOKE player: create exactly one descendant commit.',
            \`Task context: \${context.task}\`,
          ].join('\\n'),
          result: {
            complete:
              'The repository change is committed. Output shall include ' +
              '\`latestCommit: <commit identity>\`.',
          },
        }),
        onDone: [
          {
            guard: 'completed',
            target: 'done',
            actions: [
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'work',
                  target: 'done',
                  acceptedOutcome: 'complete',
                },
              },
              'recordAcceptedCommit',
              assign({
                latestCommit: ({ event }) => event.output.latestCommit,
              }),
            ],
          },
          { target: 'failed' },
        ],
        onError: {
          target: 'failed',
          actions: assign({ lastError: ({ event }) => String(event.error) }),
        },
      },
    },
    failed: {
      id: 'failed',
      description: 'The effect probe failed.',
      meta: {
        playbook: {
          stateId: 'failed',
          description: 'The effect probe failed.',
        },
      },
      tags: ['playbook.parked'],
    },
    done: {
      id: 'done',
      description: 'The repository effect was accepted from durable evidence.',
      meta: {
        playbook: {
          stateId: 'done',
          description:
            'The repository effect was accepted from durable evidence.',
        },
      },
      type: 'final',
    },
  },
  output: ({ context }) => ({ latestCommit: context.latestCommit }),
});

const createRuntime = createXStatePlaybookRuntime(machine, {
  label: 'EFFECT',
  compat: { artifactSchema: 3, runtimeAbi: 1 },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
  roleStates: {
    work: {
      role: 'coder',
      label: 'EFFECT-1: Worker creates one descendant commit.',
    },
  },
  outcomeAuthority: {
    governedPlayerStates: {
      work: {
        complete: {
          fields: { latestCommit: 'effect' },
          repositoryDisposition: 'one-descendant-commit',
        },
      },
    },
  },
});

export default {
  id: 'effect',
  command: 'effect',
  intent: 'exercise durable repository-effect reconciliation',
  artifactSchema: 3,
  runtimeProfile: { kind: 'shared-factory', compat: createRuntime.compat },
  requiredRoleIds: ['coder'],
  concurrentRoleSets: [],
  validateOptions(value) {
    return value ?? {};
  },
  createRuntime(configuredOptions, hostCapabilities) {
    return createRuntime({ configuredOptions, hostCapabilities });
  },
};
`;
}

// A second packed-smoke registry exercises the DR-032 identity boundary with
// no live model call: two sequential local roles share one segmented player,
// while a third role has an equal-shaped but distinct segmented player.
function laneArtifactSource() {
  return `// Release smoke fixture: explicit shared and isolated player lanes.
export default {
  id: 'lanes',
  command: 'lanes',
  intent: 'exercise segmented shared and isolated session players',
  artifactSchema: 3,
  runtimeProfile: { kind: 'bespoke', artifactSchema: 3 },
  requiredRoleIds: ['first', 'second', 'isolated'],
  concurrentRoleSets: [],
  validateOptions(value) {
    return value ?? {};
  },
  createRuntime(_configuredOptions, _hostCapabilities) {
    let session;
    return {
      async init(next) {
        session = next;
      },
      async handleBossInput({ text, signal }) {
        const results = [];
        // Exercise the shared ledger in both directions across the two
        // processes: A runs first -> second; B runs second -> first.
        const roles = text.includes('second pass')
          ? ['second', 'first', 'isolated']
          : ['first', 'second', 'isolated'];
        for (const role of roles) {
          const result = await session.ports.callPlayer(
            role,
            \`release-lane:\${role}:\${text}\`,
            signal,
            { resume: session.playerSessions.select(role) },
          );
          session.playerSessions.update(role, result.resumeToken);
          results.push(result.finalText);
        }
        return {
          outcome: 'terminal',
          state: {
            value: 'done',
            activeStateIds: ['done'],
            tags: [],
            status: 'done',
            quiescent: true,
            stateId: 'done',
          },
          output: { results },
        };
      },
      async resumePlaybookCall() {
        return {
          outcome: 'no-action',
          state: {
            value: 'ready',
            activeStateIds: ['ready'],
            tags: ['playbook.parked'],
            status: 'active',
            quiescent: true,
            stateId: 'ready',
          },
        };
      },
      async dispose() {},
    };
  },
};
`;
}

// Run from the packed installation's own module scope. The injected adapter
// and SDK probe make the boundary deterministic, while omitting both
// createCaptainRuntime and createHostRuntime deliberately selects the shipped
// compiled Captain and cligent's real no-presenter runtime core.
function installedHeadlessDriverSource() {
  return `import { appendFileSync } from 'node:fs';
import { createEvent } from '@sublang/cligent';
import { runPlaybookCli } from './reference/sdlc/code.playbook/bin/playbook.js';

const closingReply = ${JSON.stringify(smokeToken)};
const continuedReply = ${JSON.stringify(smokeContinuedReply)};
const callLog = requiredEnv('PLAYBOOK_SMOKE_AGENT_LOG');
const processName = requiredEnv('PLAYBOOK_SMOKE_PROCESS');
let sequence = 0;

class DeterministicAdapter {
  agent = 'claude-code';

  async *run(prompt, options = {}) {
    let kind;
    let result;
    let lane;
    let role;
    let resumeToken;
    let advertised = null;
    let selected = null;
    const laneMatch = /release-lane:(first|second|isolated):/.exec(prompt);
    if (
      prompt.includes('The closing reply is the turn summary') ||
      prompt.includes('Outcome report facts (verbatim):')
    ) {
      kind = 'closing';
      result = closingReply;
    } else if (prompt.includes('Select exactly one action from the closed set')) {
      kind = 'selection';
      // The only judgment in the hermetic scenario: when the digest offers a
      // recovery and the Boss asked for one, take it. Reading the id out of
      // the prompt is the point — a fabricated id is refused, so this selects
      // only what the restored leaf actually advertised.
      const advertisedRetry = /^- (retry:[A-Za-z0-9_]+): /m.exec(prompt);
      advertised = advertisedRetry === null ? null : advertisedRetry[1];
      if (advertised !== null && /retry/i.test(prompt)) {
        selected = advertised;
        result = JSON.stringify({ action: 'runtime', actionId: selected });
      } else {
        result = JSON.stringify({ action: 'respond', text: continuedReply });
      }
    } else if (laneMatch) {
      kind = 'player';
      role = laneMatch[1];
      lane = role === 'isolated' ? 'isolated' : 'shared';
      const prior = new RegExp(\`^release-lane:\${lane}:(\\\\d+)$\`).exec(
        options.resume ?? '',
      );
      const laneSequence = prior === null ? 1 : Number(prior[1]) + 1;
      result = \`lane result \${lane}:\${laneSequence}\`;
      resumeToken = \`release-lane:\${lane}:\${laneSequence}\`;
    } else {
      throw new Error('release smoke received an unexpected Captain prompt');
    }
    sequence += 1;
    resumeToken ??= \`release-smoke:\${kind}:\${processName}:\${sequence}\`;
    appendFileSync(
      callLog,
      JSON.stringify({
        process: processName,
        kind,
        role: role ?? null,
        lane: lane ?? null,
        resume: options.resume === undefined ? null : options.resume,
        model: options.model ?? null,
        effort: options.effort ?? null,
        fastMode: options.fastMode ?? null,
        resumeToken,
        advertised,
        selected,
      }) + '\\n',
    );
    yield createEvent(
      'done',
      this.agent,
      {
        status: 'success',
        result,
        resumeToken,
        usage: { toolUses: 0 },
        durationMs: 1,
      },
      \`release-smoke-transport-\${processName}-\${sequence}\`,
    );
  }

  async isAvailable() {
    return true;
  }
}

class DeterministicCodexAdapter extends DeterministicAdapter {
  agent = 'codex';
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(\`\${name} is required\`);
  }
  return value;
}

const result = await runPlaybookCli({
  argv: process.argv.slice(2),
  env: process.env,
  userConfigPath: requiredEnv('PLAYBOOK_SMOKE_CONFIG'),
  adapterImports: {
    claude: async () => DeterministicAdapter,
    codex: async () => DeterministicCodexAdapter,
  },
  probeAdapterSdk: async () => true,
});
process.exitCode = result.code ?? 0;
`;
}

// Exercise malformed fast-mode configuration through the packed public CLI
// boundary. Both boolean literals are semantically meaningful, so an adapter
// that does not support fast mode must reject either one before any external
// registry, SDK-readiness, or runtime work begins.
function installedFastModeBoundaryDriverSource() {
  return `import { readFileSync, writeFileSync } from 'node:fs';
import { FAST_MODE_SUPPORT } from '@sublang/cligent';
import { runPlaybookCli } from './reference/sdlc/code.playbook/bin/playbook.js';

const cases = process.argv.slice(2);
if (cases.length !== 2) {
  throw new Error('expected fastMode=false and fastMode=true config paths');
}
const unsupportedAdapter = Object.entries(FAST_MODE_SUPPORT).find(
  ([, capability]) => capability.requestSupported === false,
)?.[0];
if (unsupportedAdapter === undefined) {
  throw new Error('packed Cligent declares no unsupported fast-mode adapter');
}
const adapterMarker = ${JSON.stringify(unsupportedFastModeAdapterMarker)};

function capture() {
  let text = '';
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
        return true;
      },
    },
    value: () => text,
  };
}

for (const configPath of cases) {
  const authoredConfig = readFileSync(configPath, 'utf8');
  if (authoredConfig.split(adapterMarker).length !== 2) {
    throw new Error('unsupported fast-mode config has the wrong adapter marker');
  }
  writeFileSync(
    configPath,
    authoredConfig.replaceAll(adapterMarker, unsupportedAdapter),
  );
  const hooks = [];
  const forbidden = (name) => async () => {
    hooks.push(name);
    throw new Error(\`forbidden external hook: \${name}\`);
  };
  const stdout = capture();
  const stderr = capture();
  const result = await runPlaybookCli({
    argv: ['run', '/unsupported'],
    env: process.env,
    userConfigPath: configPath,
    stdout: stdout.stream,
    stderr: stderr.stream,
    prepareRegistryModule: forbidden('prepare'),
    loadModule: forbidden('import'),
    probeAdapterSdk: forbidden('readiness'),
    createCaptainRuntime: forbidden('captain-runtime'),
    createHostRuntime: forbidden('host-runtime'),
    sessionStore: new Proxy({}, {
      get() {
        hooks.push('session-store');
        throw new Error('forbidden external hook: session-store');
      },
    }),
  });
  if (result.code !== 1) {
    throw new Error(
      \`unsupported fastMode config exited \${String(result.code)} instead of 1\`,
    );
  }
  if (stdout.value() !== '') {
    throw new Error(\`unsupported fastMode config wrote stdout: \${stdout.value()}\`);
  }
  if (
    !stderr.value().includes('fastMode') ||
    !stderr.value().includes('not supported') ||
    !stderr.value().includes(unsupportedAdapter)
  ) {
    throw new Error(
      \`unsupported fastMode config reported the wrong error: \${stderr.value()}\`,
    );
  }
  if (hooks.length !== 0) {
    throw new Error(
      \`unsupported fastMode config crossed external hooks: \${hooks.join(', ')}\`,
    );
  }
}

process.stdout.write('fastMode false/true rejected before external hooks\\n');
`;
}

// A dedicated packed driver for the schema-3 effect matrix. Player calls
// create one real commit, emit two complete Cligent messages, and deliberately
// omit `done.result`; Captain calls deterministically resolve, park, reconcile,
// or abandon without a model.
function installedEffectReconciliationDriverSource() {
  return `import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEvent } from '@sublang/cligent';
import { runPlaybookCli } from './reference/sdlc/code.playbook/bin/playbook.js';

const closingReply = ${JSON.stringify(smokeToken)};
const callLog = requiredEnv('PLAYBOOK_SMOKE_AGENT_LOG');
const effectRepo = requiredEnv('PLAYBOOK_SMOKE_EFFECT_REPO');
const processName = requiredEnv('PLAYBOOK_SMOKE_PROCESS');
const commentary = 'Effect smoke commentary remained a complete message.';
const misleadingCommit = 'Commit: not-the-observed-oid';
let sequence = 0;

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: effectRepo,
    encoding: 'utf8',
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      'effect smoke git ' + args.join(' ') + ' failed: ' +
        String(result.error?.message ?? result.stderr ?? result.stdout),
    );
  }
}

function recordCall(kind, prompt, options, extra = {}) {
  sequence += 1;
  const resumeToken =
    \`release-smoke-effect:\${kind}:\${processName}:\${sequence}\`;
  appendFileSync(
    callLog,
    JSON.stringify({
      process: processName,
      kind,
      prompt,
      resume: options.resume === undefined ? null : options.resume,
      resumeToken,
      ...extra,
    }) + '\\n',
  );
  return resumeToken;
}

class EffectAdapter {
  agent = 'claude-code';

  async *run(prompt, options = {}) {
    if (this.agent === 'codex' && prompt.includes('EFFECT-SMOKE player:')) {
      const resumeToken = recordCall('player', prompt, options);
      if (!['effect-resolved', 'effect-parked'].includes(processName)) {
        throw new Error('an unresolved-effect control replayed the player');
      }
      const filename = \`effect-\${processName}.txt\`;
      const path = join(effectRepo, filename);
      if (existsSync(path)) {
        throw new Error('the governed player effect was replayed');
      }
      writeFileSync(path, \`\${processName}\\n\`);
      runGit(['add', '--', filename]);
      runGit(['commit', '-m', \`Record \${processName} effect\`]);
      const transportId =
        \`release-smoke-effect-transport-\${processName}-\${sequence}\`;
      yield createEvent(
        'text',
        this.agent,
        { content: commentary },
        transportId,
      );
      yield createEvent(
        'text',
        this.agent,
        { content: misleadingCommit },
        transportId,
      );
      yield createEvent(
        'done',
        this.agent,
        {
          status: 'success',
          resumeToken,
          usage: { toolUses: 0 },
          durationMs: 1,
        },
        transportId,
      );
      return;
    }

    let kind;
    let result;
    let selected = null;
    let recordedResumeToken;
    if (prompt.includes('Select exactly one action from the closed set')) {
      kind = 'selection';
      selected =
        processName === 'effect-reconcile'
          ? 'reconcile:unresolved-effect'
          : processName === 'effect-abandon'
            ? 'abandon:unresolved-effect'
            : null;
      if (selected === null || !prompt.includes(\`- \${selected}: \`)) {
        throw new Error(
          'the requested unresolved-effect control was not advertised',
        );
      }
      result = JSON.stringify({ action: 'runtime', actionId: selected });
    } else if (
      prompt.includes('The closing reply is the turn summary') ||
      prompt.includes('Outcome report facts (verbatim):')
    ) {
      kind = 'closing';
      result = closingReply;
    } else if (prompt.includes('This is hidden control work.')) {
      kind = 'judge';
      recordedResumeToken = recordCall(kind, prompt, options, { selected });
      if (processName === 'effect-resolved') {
        result = JSON.stringify({ guard: 'complete' });
      } else if (processName === 'effect-parked') {
        result = 'not JSON';
      } else {
        throw new Error('an unresolved-effect control started a judge');
      }
    } else {
      throw new Error('effect smoke received an unexpected Captain prompt');
    }

    const resumeToken =
      recordedResumeToken ?? recordCall(kind, prompt, options, { selected });
    yield createEvent(
      'done',
      this.agent,
      {
        status: 'success',
        result,
        resumeToken,
        usage: { toolUses: 0 },
        durationMs: 1,
      },
      \`release-smoke-effect-transport-\${processName}-\${sequence}\`,
    );
  }

  async isAvailable() {
    return true;
  }
}

class EffectCodexAdapter extends EffectAdapter {
  agent = 'codex';
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(\`\${name} is required\`);
  }
  return value;
}

const result = await runPlaybookCli({
  argv: process.argv.slice(2),
  env: process.env,
  userConfigPath: requiredEnv('PLAYBOOK_SMOKE_CONFIG'),
  adapterImports: {
    claude: async () => EffectAdapter,
    codex: async () => EffectCodexAdapter,
  },
  probeAdapterSdk: async () => true,
});
process.exitCode = result.code ?? 0;
`;
}

// Run from the registry-installed cligent package itself. This exercises the
// public no-presenter runtime that Playbook consumes, including the 0.23.0
// result-less fallback that must retain whole Codex message boundaries.
function cligentMessageBoundaryProbeSource() {
  return `import { createEvent } from '@sublang/cligent';
import { createTmuxPlayRuntime } from '@sublang/cligent/tmux-play';

const commentary = 'Reworked the small packages.';
const finalResponse = 'Commit: abc123';
const sessionId = 'playbook-release-message-boundary';
let playerResult;

class CodexMessageAdapter {
  agent = 'codex';

  async *run() {
    yield createEvent('text', this.agent, { content: commentary }, sessionId);
    yield createEvent('text', this.agent, { content: finalResponse }, sessionId);
    yield createEvent(
      'done',
      this.agent,
      {
        status: 'success',
        usage: { toolUses: 0 },
        durationMs: 1,
      },
      sessionId,
    );
  }

  async isAvailable() {
    return true;
  }
}

class UnusedCaptainAdapter extends CodexMessageAdapter {
  agent = 'claude-code';

  async *run() {
    throw new Error('the transport probe must not call the Captain adapter');
  }
}

const runtime = await createTmuxPlayRuntime({
  captain: {
    async handleBossTurn(turn, context) {
      playerResult = await context.callPlayer('coder', turn.prompt);
    },
  },
  captainConfig: { adapter: 'claude' },
  players: [{ id: 'coder', adapter: 'codex' }],
  adapterImports: {
    claude: async () => UnusedCaptainAdapter,
    codex: async () => CodexMessageAdapter,
  },
});

await runtime.runBossTurn('transport probe');

const expected = commentary + '\\n' + finalResponse;
const finalResponseLines = playerResult?.finalText
  ?.split('\\n')
  .filter((line) => line === finalResponse);
if (
  playerResult?.status !== 'ok' ||
  playerResult.finalText !== expected ||
  finalResponseLines?.length !== 1
) {
  throw new Error(
    'installed cligent did not preserve complete Codex messages: ' +
      JSON.stringify(playerResult),
  );
}
`;
}

// The installed package's own module scope: self-referencing imports resolve
// exactly as consumer imports of the four public playbook subpaths do,
// exports map included.
function compiledRuntimeImportProbeSource() {
  return `// RELEASE-28 step 7: every installed playbook subpath constructs.
import captainFactory from '@sublang/playbook/captain/playbook';
import codeFactory from '@sublang/playbook/code/playbook';
import reviewFactory from '@sublang/playbook/review/playbook';
import decideFactory from '@sublang/playbook/decide/playbook';
import { emptyPlaybookEffectLedger } from '@sublang/playbook/xstate-runtime';

const enabledPlaybooks = [
  { id: 'code', command: 'code', intent: 'implement a coding intent' },
  { id: 'review', command: 'review', intent: 'review the latest commit' },
  { id: 'decide', command: 'decide', intent: 'decide a spec design' },
];
const controller = {
  async submit() {
    throw new Error('the construction probe must not submit a selection');
  },
};
const coreMembers = [
  'init',
  'exportSnapshot',
  'restore',
  'handleBossInput',
  'resumePlaybookCall',
  'dispose',
];
const controlMembers = ['describe', 'apply'];
const adoptionMembers = ['adopt'];
const probeSessionId = '00000000-0000-4000-8000-000000000017';
const probeRepositoryIdentity = {
  worktree: process.cwd(),
  gitDir: process.cwd(),
};
const unavailableRepositoryOperation = async () => {
  throw new Error('the construction probe must not use the repository');
};
function construction(playbookId, requiredRoleIds, concurrentRoleSets) {
  const ledger = emptyPlaybookEffectLedger();
  return {
    configuredOptions: {},
    hostCapabilities: {
      authority: {
        playbookId,
        artifactSchema: 3,
        cwd: process.cwd(),
        sessionId: probeSessionId,
        leaseOwnerToken: 'release-smoke-construction-probe',
        canonicalWorktree: probeRepositoryIdentity,
        requiredRoleIds,
        concurrentRoleSets,
      },
      repository: {
        identity: probeRepositoryIdentity,
        observe: unavailableRepositoryOperation,
        acquire: unavailableRepositoryOperation,
        runExclusive: unavailableRepositoryOperation,
        runCohort: unavailableRepositoryOperation,
        runDeferred: unavailableRepositoryOperation,
      },
      effectLedger: {
        snapshot: () => ledger,
        writeAhead: async () => ledger,
      },
    },
  };
}
const cases = [
  {
    id: 'captain',
    runtime: captainFactory({ enabledPlaybooks, controller }),
    members: [...coreMembers, ...controlMembers, ...adoptionMembers],
  },
  {
    id: 'code',
    runtime: codeFactory(construction('code', ['coder'], [])),
    members: [...coreMembers, ...controlMembers, ...adoptionMembers],
  },
  {
    id: 'review',
    runtime: reviewFactory(construction('review', ['coder', 'reviewer'], [])),
    members: [...coreMembers, ...controlMembers, ...adoptionMembers],
  },
  {
    id: 'decide',
    runtime: decideFactory(
      construction('decide', ['coder', 'reviewer'], [['coder', 'reviewer']]),
    ),
    members: coreMembers,
    absentMembers: adoptionMembers,
  },
];

for (const { id, runtime, members, absentMembers = [] } of cases) {
  const missing = members.filter((name) => typeof runtime[name] !== 'function');
  if (missing.length > 0) {
    console.error(\`\${id}/playbook runtime is missing: \${missing.join(', ')}\`);
    process.exit(1);
  }
  const unexpected = absentMembers.filter((name) => name in runtime);
  if (unexpected.length > 0) {
    console.error(
      \`\${id}/playbook runtime unexpectedly exposes: \${unexpected.join(', ')}\`,
    );
    process.exit(1);
  }
  console.log(\`OK    \${id}/playbook constructs with \${members.length} contract members\`);
}
`;
}

// Every packed file except the manifest, which npm composes rather than
// copies. The compiled `.js` / `.d.ts` siblings and the compiled
// `*.gears.md` the conformance chain is rooted at are both in this set.
//
// What the comparison below is, and is not: `npm pack` copies the working
// tree, so equality is the normal outcome and this is not a drift guard —
// committed-vs-built drift is the CI sibling check (RELEASE-10). It is the
// transfer argument: the tarball a release uploads carries a counterpart
// for every packed path, byte-for-byte the same artifacts step 8's suites
// just ran against, with nothing generated or rewritten in transit.
function packedComparableEntries(packedRoot, packedPackage) {
  const entries = [];
  walkFiles(packedRoot, (path) => {
    if (relative(packedPackage, path) === 'package.json') return;
    entries.push(path);
  });
  return entries.sort();
}

async function main() {
  for (const [command, args] of [
    ['node', ['--version']],
    ['npm', ['--version']],
    ['git', ['--version']],
  ]) {
    const probe = spawnSync(command, args, { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      fail(`the release smoke requires ${command} on PATH`);
    }
  }

  const root = mkdtempSync(join(tmpdir(), 'playbook-release-smoke-'));
  isolatedNpmCache = join(root, 'npm-cache');
  mkdirSync(isolatedNpmCache, { recursive: true });
  installTmuxSentinel(root);
  const state = {};
  const steps = [
    ['pack the publishable tarball', () => stepPack(root, state)],
    ['install the lean global shape', () => stepLean(root, state)],
    ['install the opted-in global shape', () => stepOptedIn(root, state)],
    ['run the installed CLI surfaces', () => stepInstalledCli(root, state)],
    ['drive the installed headless Captain', () => stepHermetic(root, state)],
    ['reconcile packed repository effects', () =>
      stepEffectReconciliation(root, state)],
    ['check compiled runtime integrity', () => stepCompiledRuntimeIntegrity(state)],
    ['check compiled-artifact fidelity', () => stepCompiledFidelity(state)],
    ['guard the nested cligent floor', () => stepCligentFloor(root, state)],
    ['exercise the packed session-store facade', () =>
      stepPackedSessionStore(root, state)],
  ];

  const startedAt = Date.now();
  let failed;
  for (const [index, [title, step]] of steps.entries()) {
    const label = `[${index + 1}/${steps.length}] ${title}`;
    const stepStartedAt = Date.now();
    process.stdout.write(`${label}\n`);
    let lines = [];
    let failure;
    try {
      lines = (await step()) ?? [];
    } catch (error) {
      failure = { error };
    }
    try {
      assertTmuxWasNotInvoked();
    } catch (error) {
      failure = { error };
    }
    if (failure === undefined) {
      for (const line of lines) process.stdout.write(`    ${line}\n`);
      process.stdout.write(
        `    ok (${seconds(Date.now() - stepStartedAt)}s)\n\n`,
      );
    } else {
      failed = { label, error: failure.error };
      process.stdout.write(
        `    FAILED (${seconds(Date.now() - stepStartedAt)}s)\n\n`,
      );
      break;
    }
  }

  const elapsed = seconds(Date.now() - startedAt);
  if (failed) {
    process.stderr.write(
      `smoke:release failed at ${failed.label} after ${elapsed}s\n` +
        `${failed.error instanceof SmokeFailure ? failed.error.message : String(failed.error?.stack ?? failed.error)}\n` +
        `Artifacts preserved at ${root}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `smoke:release passed ${steps.length} steps in ${elapsed}s\n`,
  );
  if (keepArtifacts) {
    process.stdout.write(`Artifacts kept at ${root}\n`);
  } else {
    rmSync(root, { recursive: true, force: true });
  }
}

function seconds(milliseconds) {
  return (milliseconds / 1000).toFixed(1);
}

// Step 1 — the same artifact `npm publish` would upload, plus an extracted
// copy every later byte-equality check reads.
function stepPack(root, state) {
  const packDir = join(root, 'pack');
  mkdirSync(packDir, { recursive: true });
  const packed = run('npm', [
    'pack',
    '--json',
    '--pack-destination',
    packDir,
  ]);
  const filename = JSON.parse(packed.stdout)[0]?.filename;
  if (!filename) fail('npm pack did not report a tarball', packed.stdout);
  state.tarball = join(packDir, filename);
  if (!existsSync(state.tarball)) {
    fail(`npm pack reported a tarball that is missing: ${state.tarball}`);
  }
  state.packedRoot = join(root, 'packed');
  mkdirSync(state.packedRoot, { recursive: true });
  run('tar', ['-xzf', state.tarball, '-C', state.packedRoot]);
  state.packedPackage = join(state.packedRoot, 'package');
  state.packedManifest = readJson(join(state.packedPackage, 'package.json'));
  return [
    `packed ${filename}`,
    `${state.packedManifest.name}@${state.packedManifest.version}`,
  ];
}

// Step 2 — RELEASE-13 lean shape: the tarball ALONE. Global topology does not
// hoist between separately named top-level packages, so this is the only
// shape that reflects what a user gets; an in-repo install hoists the SDK
// flat and passes regardless.
function stepLean(root, state) {
  const prefix = join(root, 'lean');
  const { installed, cligent } = installGlobally(prefix, [state.tarball]);
  const found = [];
  walkDirectories(join(prefix, 'lib', 'node_modules'), (path, name) => {
    if (name === '@anthropic-ai' || name === '@openai') found.push(path);
  });
  if (found.length > 0) {
    fail(
      'a bare install shipped an agent SDK stack',
      `DR-026 / RELEASE-12: the SDKs are optional peers.\n${found.join('\n')}`,
    );
  }
  state.leanPrefix = prefix;
  const probe = probeAdapters(prefix, 'unavailable');
  return [
    `cligent nested under ${relative(root, installed)}`,
    'no @anthropic-ai or @openai directory in the installed closure',
    ...probe.split('\n'),
    `probed from ${relative(root, cligent)}`,
  ];
}

// Step 3 — RELEASE-13 opted-in shape: the documented install command, each
// SDK its OWN top-level install root so it lands on the directory-ancestor
// walk from the nested cligent (DR-026 §3).
function stepOptedIn(root, state) {
  const prefix = join(root, 'optin');
  const { bin, cligent } = installGlobally(prefix, [
    state.tarball,
    ...adapterSdks,
  ]);
  state.optinPrefix = prefix;
  state.optinBin = bin;
  const probe = probeAdapters(prefix, 'available');
  return [...probe.split('\n'), `probed from ${relative(root, cligent)}`];
}

// Step 4 — the installed executable's own non-launching surfaces.
function stepInstalledCli(root, state) {
  const home = join(root, 'cli-home');
  const spexHome = join(home, '.spex');
  mkdirSync(join(spexHome, 'playbook'), { recursive: true });
  writeFileSync(
    join(spexHome, 'playbook', 'playbook.config.yaml'),
    [
      'captain:',
      '  adapter: claude',
      'players:',
      '  release.coder: { adapter: claude }',
      '  release.reviewer: { adapter: codex }',
      'playbooks:',
      '  code:',
      '    from: "@sublang/playbook/code/registry"',
      '    roles: { coder: release.coder }',
      '  review:',
      '    from: "@sublang/playbook/review/registry"',
      '    roles: { coder: release.coder, reviewer: release.reviewer }',
      '  decide:',
      '    from: "@sublang/playbook/decide/registry"',
      '    roles: { coder: release.coder, reviewer: release.reviewer }',
      '',
    ].join('\n'),
  );
  const env = smokeEnv({
    HOME: home,
    SPEX_HOME: spexHome,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
  });
  const help = run(state.optinBin, ['--help'], { cwd: root, env });
  expectContains(help.stdout, 'playbook run [--with <path>]', '--help output');
  expectContains(help.stdout, '--session <id>', '--help output');
  expectContains(help.stdout, 'Default config:', '--help output');
  const runHelp = run(state.optinBin, ['run', '--help'], { cwd: root, env });
  expectContains(runHelp.stdout, 'playbook run [--with <path>]', 'run help');
  expectContains(runHelp.stdout, '--continue', 'run help');
  expectContains(runHelp.stdout, '--retry-uncertain', 'run help');
  expectContains(runHelp.stdout, '--discard-uncertain', 'run help');
  expectContains(runHelp.stdout, 'Default config:', 'run help');
  const list = run(state.optinBin, ['--list'], { cwd: root, env });
  for (const expected of [
    '/code  code  —',
    '/review  review  —',
    '/decide  decide  —',
  ]) {
    expectContains(list.stdout, expected, '--list output');
  }
  return [
    'top-level and run help printed current grammar and the resolved config path',
    ...list.stdout.trimEnd().split('\n'),
  ];
}

// Step 5 — DR-024 §7 plus DR-031's shared Captain boundary: a bare repository
// with no project-local packages at any level enables a thin filesystem
// registry in the shared config. Two separate processes drive the installed
// compiled Captain and real no-presenter host with a deterministic injected
// adapter: first from stdin, then by durable session id from another cwd.
// No model, credential, or tmux process participates.
function stepHermetic(root, state) {
  const scenario = join(root, 'hermetic');
  const repo = join(scenario, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(repo, '.gitignore'),
    ['node_modules/', '.release-smoke-effects', ''].join('\n'),
  );
  writeFileSync(join(repo, 'smoke.playbook.mjs'), smokeArtifactSource());
  writeFileSync(join(repo, 'lanes.playbook.mjs'), laneArtifactSource());
  const recoverFlagPath = join(scenario, 'recover-flag');
  writeFileSync(
    join(repo, 'recover.playbook.mjs'),
    recoverArtifactSource(recoverFlagPath),
  );
  const configPath = join(repo, 'playbook.config.yaml');
  writeFileSync(configPath, smokeConfig('a'));
  const retunePath = join(scenario, 'retune-b.yaml');
  writeFileSync(retunePath, smokeRetuneOverlay());
  const unsupportedFastModePaths = [false, true].map((fastMode) => {
    const path = join(
      scenario,
      `unsupported-fast-mode-${String(fastMode)}.yaml`,
    );
    writeFileSync(path, unsupportedFastModeConfig(fastMode));
    return path;
  });
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Playbook Release Smoke'],
    ['config', 'user.email', 'smoke@sublang.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '.'],
    ['commit', '-m', 'Initialize release smoke fixture'],
  ]) {
    run('git', args, { cwd: repo });
  }

  for (const specifier of ['xstate', '@sublang/playbook/xstate-runtime']) {
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        'const { createRequire } = require("node:module");' +
          `createRequire(process.argv[1]).resolve(process.argv[2]);`,
        join(repo, 'probe.js'),
        specifier,
      ],
      { encoding: 'utf8' },
    );
    if (probe.status === 0) {
      fail(
        `${specifier} already resolves from the fixture before the run`,
        'The hermetic case only proves provisioning when the directory is ' +
          'genuinely bare.',
      );
    }
  }

  const env = smokeEnv({
    HOME: join(scenario, 'home'),
    SPEX_HOME: join(scenario, 'spex'),
    XDG_CONFIG_HOME: join(scenario, 'xdg-config'),
    XDG_STATE_HOME: join(scenario, 'xdg-state'),
    ANTHROPIC_API_KEY: 'release-smoke-synthetic-readiness',
    OPENAI_API_KEY: 'release-smoke-synthetic-readiness',
    PLAYBOOK_SMOKE_CONFIG: configPath,
    PLAYBOOK_SMOKE_AGENT_LOG: join(scenario, 'agent-calls.ndjson'),
  });
  const processEnv = (name) => ({ ...env, PLAYBOOK_SMOKE_PROCESS: name });
  const driverPath = join(
    installedPackageRoot(state.optinPrefix),
    'release-smoke-headless.mjs',
  );
  writeFileSync(driverPath, installedHeadlessDriverSource());
  const fastModeBoundaryDriverPath = join(
    installedPackageRoot(state.optinPrefix),
    'release-smoke-fast-mode-boundary.mjs',
  );
  writeFileSync(
    fastModeBoundaryDriverPath,
    installedFastModeBoundaryDriverSource(),
  );
  const fastModeBoundary = run(
    process.execPath,
    [fastModeBoundaryDriverPath, ...unsupportedFastModePaths],
    { cwd: repo, env: processEnv('fast-mode-boundary') },
  );
  expectContains(
    fastModeBoundary.stdout,
    'fastMode false/true rejected before external hooks',
    'packed fast-mode boundary probe',
  );

  const first = run(process.execPath, [driverPath, 'run', '--json'], {
    cwd: repo,
    env: processEnv('first'),
    input: `/smoke ${smokeTask}\n`,
  });
  const provisioningLines = first.stderr.match(/provisioned/g) ?? [];
  if (provisioningLines.length !== 1) {
    fail(
      `expected exactly one provisioning line, saw ${provisioningLines.length}`,
      `stderr:\n${tail(first.stderr)}`,
    );
  }
  expectOneOrderedLifecycle(first.stderr, 'smoke');
  assertProvisionedEngineTree(repo, state.optinPrefix);
  const firstEnvelope = parseExactHeadlessReply(first.stdout, smokeToken);
  const sessionsDir = join(env.XDG_STATE_HOME, 'playbook', 'sessions');
  const sessionPath = join(sessionsDir, `${firstEnvelope.sessionId}.json`);
  const firstRecord = readJson(sessionPath);
  const frozenCwd = realpathSync(repo);
  const firstPlayerIds = firstRecord.structuralProjection?.players?.map(
    (player) => player.id,
  );
  if (
    firstRecord.schemaVersion !== 6 ||
    firstRecord.kind !== 'captain-session' ||
    firstRecord.state !== 'settled' ||
    firstRecord.cwd !== frozenCwd ||
    JSON.stringify(firstPlayerIds) !==
      JSON.stringify(['release.shared', 'release.isolated']) ||
    firstRecord.structuralProjection?.catalog?.lanes?.roles?.first?.playerId !==
      'release.shared' ||
    firstRecord.structuralProjection?.catalog?.lanes?.roles?.second?.playerId !==
      'release.shared' ||
    firstRecord.structuralProjection?.catalog?.lanes?.roles?.isolated?.playerId !==
      'release.isolated' ||
    JSON.stringify(firstRecord.retainedGenerations) !== '{}' ||
    firstRecord.snapshot?.captain?.conversation?.kind !== 'pinned' ||
    firstRecord.snapshot?.captain?.conversation?.token !==
      'release-smoke:closing:first:1'
  ) {
    fail(
      'the first headless turn did not persist its schema-3 identity boundary',
      JSON.stringify({
        schemaVersion: firstRecord.schemaVersion,
        kind: firstRecord.kind,
        state: firstRecord.state,
        cwd: firstRecord.cwd,
        playerIds: firstPlayerIds,
        laneRoles: firstRecord.structuralProjection?.catalog?.lanes?.roles,
        conversation: firstRecord.snapshot?.captain?.conversation,
      }),
    );
  }

  const continuationCwd = join(scenario, 'continuation-cwd');
  mkdirSync(continuationCwd, { recursive: true });
  const second = run(
    process.execPath,
    [driverPath, 'run', '--session', firstEnvelope.sessionId, '--json'],
    {
      cwd: continuationCwd,
      env: processEnv('continued'),
      input: 'Continue without replaying the completed action.\n',
    },
  );
  if (second.stderr.includes('provisioned') || second.stderr.includes('/smoke')) {
    fail(
      'the continued headless turn provisioned or replayed /smoke',
      `stderr:\n${tail(second.stderr)}`,
    );
  }
  assertProvisionedEngineTree(repo, state.optinPrefix);
  parseExactHeadlessReply(
    second.stdout,
    smokeContinuedReply,
    firstEnvelope.sessionId,
  );
  const secondRecord = readJson(sessionPath);
  if (
    secondRecord.state !== 'settled' ||
    secondRecord.cwd !== frozenCwd ||
    secondRecord.snapshot?.captain?.conversation?.kind !== 'pinned' ||
    secondRecord.snapshot?.captain?.conversation?.token !==
      'release-smoke:selection:continued:1'
  ) {
    fail(
      'continuation replaced the frozen cwd or lost Captain continuity',
      JSON.stringify({
        state: secondRecord.state,
        cwd: secondRecord.cwd,
        conversation: secondRecord.snapshot?.captain?.conversation,
      }),
    );
  }

  const laneA = run(
    process.execPath,
    [
      driverPath,
      'run',
      '--session',
      firstEnvelope.sessionId,
      '--json',
      '/lanes first pass',
    ],
    { cwd: continuationCwd, env: processEnv('lane-a') },
  );
  expectOneOrderedLifecycle(laneA.stderr, 'lanes');
  parseExactHeadlessReply(laneA.stdout, smokeToken, firstEnvelope.sessionId);

  const laneB = run(
    process.execPath,
    [
      driverPath,
      'run',
      '--session',
      firstEnvelope.sessionId,
      '--with',
      retunePath,
      '--json',
      '/lanes second pass',
    ],
    { cwd: continuationCwd, env: processEnv('lane-b') },
  );
  expectOneOrderedLifecycle(laneB.stderr, 'lanes');
  parseExactHeadlessReply(laneB.stdout, smokeToken, firstEnvelope.sessionId);
  const finalRecord = readJson(sessionPath);
  const finalExecution = finalRecord.lastAppliedExecutionProjection;
  const finalPlayers = Object.fromEntries(
    (finalExecution?.players ?? []).map((player) => [player.id, player]),
  );
  const finalRoles = finalExecution?.catalog?.lanes?.roles;
  const finalLedgerIds = Object.keys(
    finalRecord.snapshot?.playerSessions ?? {},
  ).sort();
  const finalPlayerIds = Object.keys(finalPlayers).sort();
  const finalRoleIds = Object.keys(finalRoles ?? {}).sort();
  if (
    finalRecord.schemaVersion !== 6 ||
    finalRecord.kind !== 'captain-session' ||
    finalRecord.sessionId !== firstEnvelope.sessionId ||
    finalRecord.state !== 'settled' ||
    finalRecord.cwd !== frozenCwd ||
    JSON.stringify(finalRecord.structuralProjection) !==
      JSON.stringify(firstRecord.structuralProjection) ||
    JSON.stringify(finalLedgerIds) !==
      JSON.stringify(['release.isolated', 'release.shared']) ||
    JSON.stringify(finalPlayerIds) !==
      JSON.stringify(['release.isolated', 'release.shared']) ||
    JSON.stringify(finalRoleIds) !==
      JSON.stringify(['first', 'isolated', 'second']) ||
    JSON.stringify(finalRecord.retainedGenerations) !== '{}' ||
    finalRecord.snapshot?.playerSessions?.['release.shared']?.resumeToken !==
      'release-lane:shared:4' ||
    finalRecord.snapshot?.playerSessions?.['release.isolated']?.resumeToken !==
      'release-lane:isolated:2' ||
    finalRecord.snapshot?.captain?.conversation?.kind !== 'pinned' ||
    finalRecord.snapshot?.captain?.conversation?.token !==
      'release-smoke:closing:lane-b:4' ||
    finalExecution?.captain?.model?.value !== 'release-smoke-captain-b' ||
    finalExecution?.captain?.effort?.value !== 'max' ||
    finalExecution?.captain?.fastMode !== true ||
    finalPlayers['release.shared']?.model?.value !== 'release-player-b' ||
    finalPlayers['release.shared']?.effort?.value !== 'max' ||
    finalPlayers['release.shared']?.fastMode !== false ||
    finalPlayers['release.isolated']?.model?.value !== 'release-player-b' ||
    finalPlayers['release.isolated']?.effort?.value !== 'max' ||
    finalPlayers['release.isolated']?.fastMode !== false ||
    finalRoles?.first?.model?.value !== 'release-player-b' ||
    finalRoles?.first?.effort?.value !== 'max' ||
    finalRoles?.first?.fastMode !== false ||
    finalRoles?.second?.model?.kind !== 'provider-default' ||
    finalRoles?.second?.effort?.kind !== 'provider-default' ||
    finalRoles?.second?.fastMode !== true ||
    finalRoles?.isolated?.model?.value !== 'release-player-b' ||
    finalRoles?.isolated?.effort?.value !== 'max' ||
    finalRoles?.isolated?.fastMode !== true
  ) {
    fail(
      'cross-process lane continuation lost identity or current tuning',
      JSON.stringify({
        cwd: finalRecord.cwd,
        schemaVersion: finalRecord.schemaVersion,
        kind: finalRecord.kind,
        sessionId: finalRecord.sessionId,
        captainConversation: finalRecord.snapshot?.captain?.conversation,
        playerSessions: finalRecord.snapshot?.playerSessions,
        finalLedgerIds,
        finalPlayerIds,
        finalRoleIds,
        structureUnchanged:
          JSON.stringify(finalRecord.structuralProjection) ===
          JSON.stringify(firstRecord.structuralProjection),
        captain: finalExecution?.captain,
        players: finalPlayers,
        roles: finalRoles,
      }),
    );
  }

  const effects = readFileSync(join(repo, '.release-smoke-effects'), 'utf8')
    .trimEnd()
    .split('\n');
  if (effects.length !== 1 || effects[0] !== 'effect') {
    fail(
      'continuation replayed or lost the completed filesystem effect',
      JSON.stringify(effects),
    );
  }
  const calls = readFileSync(env.PLAYBOOK_SMOKE_AGENT_LOG, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assertSmokeCalls(calls);
  const status = run('git', ['status', '--porcelain'], { cwd: repo });
  if (status.stdout.trim() !== '') {
    fail(
      'the hermetic fixture repository is not clean after the runs',
      status.stdout,
    );
  }
  // DR-034: one failure recovered across a process boundary. The first
  // process leaves the fixture parked in its recoverable failure state; the
  // second holds nothing but the record, and recovers from it in place.
  const recoverFirst = run(process.execPath, [driverPath, 'run', '--json'], {
    cwd: repo,
    env: processEnv('recover-first'),
    input: `/recover ${smokeTask}\n`,
  });
  // A parked failure emits the start line only: the engagement is retained
  // for the next Boss turn, so nothing has finished.
  if (
    !recoverFirst.stderr.includes('◇ /recover started') ||
    recoverFirst.stderr.includes('◇ /recover finished')
  ) {
    fail(
      'the parked failure did not retain its engagement',
      `stderr:\n${tail(recoverFirst.stderr)}`,
    );
  }
  const recoverEnvelope = parseExactHeadlessReply(
    recoverFirst.stdout,
    smokeToken,
  );
  const recoverPath = join(sessionsDir, `${recoverEnvelope.sessionId}.json`);
  const parkedRecover = readJson(recoverPath);
  const parkedFrame = parkedRecover.snapshot?.frames?.[0];
  if (
    parkedRecover.state !== 'settled' ||
    parkedFrame?.playbookId !== 'recover' ||
    parkedFrame?.runtime?.state?.stateId !== 'failed'
  ) {
    fail(
      'the recover fixture did not park in its recoverable failure state',
      JSON.stringify({
        state: parkedRecover.state,
        frame: parkedFrame?.runtime?.state,
      }),
    );
  }

  writeFileSync(recoverFlagPath, '');
  const recovered = run(
    process.execPath,
    [driverPath, 'run', '--session', recoverEnvelope.sessionId, '--json'],
    {
      cwd: continuationCwd,
      env: processEnv('recover-second'),
      input: 'Retry the failed step and continue.\n',
    },
  );
  // The retry drove the machine to its terminal state, so this turn is the
  // one that finishes the engagement.
  if (!recovered.stderr.includes('◇ /recover finished')) {
    fail(
      'the applied retry did not complete the recovered engagement',
      `stderr:\n${tail(recovered.stderr)}`,
    );
  }
  parseExactHeadlessReply(
    recovered.stdout,
    smokeToken,
    recoverEnvelope.sessionId,
  );
  const recoveredRecord = readJson(recoverPath);
  const recoverCalls = readFileSync(env.PLAYBOOK_SMOKE_AGENT_LOG, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((call) => call.process === 'recover-second');
  const selection = recoverCalls.find((call) => call.kind === 'selection');
  // The digest the restored leaf composed had to carry the action, or the
  // adapter above could not have named it and the shell would have refused it.
  if (
    selection === undefined ||
    selection.advertised !== 'retry:START' ||
    selection.selected !== 'retry:START' ||
    recoveredRecord.state !== 'settled' ||
    recoveredRecord.snapshot?.mode !== 'chat'
  ) {
    fail(
      'a continued session could not recover the parked failure in place',
      JSON.stringify({
        advertised: selection?.advertised ?? null,
        selected: selection?.selected ?? null,
        mode: recoveredRecord.snapshot?.mode,
        state: recoveredRecord.state,
      }),
    );
  }

  const credentials = [
    finalRecord.snapshot?.captain?.conversation?.token,
    ...Object.values(finalRecord.snapshot?.playerSessions ?? {}).map(
      (entry) => entry?.resumeToken,
    ),
  ].filter((value) => typeof value === 'string' && value.length > 0);
  if (credentials.length < 3) {
    fail(
      'the CLI-written session-store fixture is not credential-bearing',
      JSON.stringify(credentials),
    );
  }
  state.sessionStoreFixture = Object.freeze({
    sessionsDir,
    sessionId: firstEnvelope.sessionId,
    oldSessionId: recoverEnvelope.sessionId,
    oldSessionPath: recoverPath,
    expectedSummary: Object.freeze({
      schemaVersion: finalRecord.schemaVersion,
      sessionId: finalRecord.sessionId,
      state: finalRecord.state,
      cwd: finalRecord.cwd,
      updatedAt: finalRecord.updatedAt,
    }),
    credentials: Object.freeze(credentials),
  });

  rmSync(driverPath);
  rmSync(fastModeBoundaryDriverPath);
  return [
    'one provisioning line; both engine links resolve into the prefix',
    `stdin produced exact {sessionId,reply} with ${smokeToken}`,
    `four processes continued Captain session ${firstEnvelope.sessionId}`,
    'schema 3 retained two segmented player identities and frozen structure',
    'shared roles chained one token; the isolated player kept its own token',
    'ordinary reopen applied current model, effort, and literal fast mode',
    'omitted fast mode kept the provider default; unsupported booleans ran no external hook',
    'continuation replayed no settled effect and invoked no tmux',
    'a second process advertised and applied the parked failure retry',
  ];
}

// Step 6 — one real governed repository effect through the packed launcher,
// installed Cligent transport, shared Captain, CLI host, and schema-3 runtime.
// A resolved row proves receipt-owned commit identity; a second row parks on
// exhausted semantic correction, then two successor processes reconcile and
// abandon it without replaying either player or judge.
function stepEffectReconciliation(root, state) {
  const scenario = join(root, 'effect-reconciliation');
  const repo = join(scenario, 'repo');
  const continuationCwd = join(scenario, 'continuation-cwd');
  const home = join(scenario, 'home');
  const stateHome = join(scenario, 'state');
  const callLog = join(scenario, 'agent-calls.ndjson');
  const acceptedOidPath = join(scenario, 'accepted-commit-oid.txt');
  mkdirSync(repo, { recursive: true });
  mkdirSync(continuationCwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'effect.playbook.mjs'), effectArtifactSource());
  const configPath = join(repo, 'playbook.config.yaml');
  writeFileSync(
    configPath,
    [
      'captain: { adapter: claude, model: release-smoke-captain, effort: high }',
      'players:',
      '  effect.coder: { adapter: codex }',
      'playbooks:',
      '  effect:',
      '    from: ./effect.playbook.mjs',
      '    roles: { coder: effect.coder }',
      '',
    ].join('\n'),
  );
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Playbook Release Smoke'],
    ['config', 'user.email', 'smoke@sublang.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '.'],
    ['commit', '-m', 'Initialize effect reconciliation fixture'],
  ]) {
    run('git', args, { cwd: repo });
  }

  const env = smokeEnv({
    HOME: home,
    SPEX_HOME: join(home, '.spex'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: stateHome,
    ANTHROPIC_API_KEY: 'release-smoke-synthetic-readiness',
    OPENAI_API_KEY: 'release-smoke-synthetic-readiness',
    PLAYBOOK_SMOKE_CONFIG: configPath,
    PLAYBOOK_SMOKE_AGENT_LOG: callLog,
    PLAYBOOK_SMOKE_ACCEPTED_OID_PATH: acceptedOidPath,
    PLAYBOOK_SMOKE_EFFECT_REPO: repo,
  });
  const processEnv = (name) => ({ ...env, PLAYBOOK_SMOKE_PROCESS: name });
  const driverPath = join(
    installedPackageRoot(state.optinPrefix),
    'release-smoke-effect-reconciliation.mjs',
  );
  writeFileSync(driverPath, installedEffectReconciliationDriverSource());

  const head = () =>
    run('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
  const assertOneDescendant = (baseline, after, label) => {
    run('git', ['merge-base', '--is-ancestor', baseline, after], { cwd: repo });
    const count = run('git', ['rev-list', '--count', `${baseline}..${after}`], {
      cwd: repo,
    }).stdout.trim();
    if (count !== '1') {
      fail(`${label} did not create exactly one descendant commit`, count);
    }
    const status = run('git', ['status', '--porcelain'], { cwd: repo });
    if (status.stdout.trim() !== '') {
      fail(`${label} left repository residue`, status.stdout);
    }
  };
  const expectedFinalText =
    'Effect smoke commentary remained a complete message.\n' +
    'Commit: not-the-observed-oid';
  const assertBoundary = (
    record,
    { baselineHead, afterHead, resolved, label },
  ) => {
    const ledger = record.effectLedger;
    if (
      ledger?.boundaries?.length !== 1 ||
      ledger.logicalOperations?.length !== 0 ||
      JSON.stringify(record.snapshot?.effectLedger) !== JSON.stringify(ledger)
    ) {
      fail(
        `${label} did not persist one mirrored physical boundary`,
        JSON.stringify({ ledger, snapshotLedger: record.snapshot?.effectLedger }),
      );
    }
    const boundary = ledger.boundaries[0];
    const receipt = boundary.physicalReceipt;
    const candidateMatches = resolved
      ? JSON.stringify(boundary.semanticCandidate) ===
        JSON.stringify({ guard: 'complete' })
      : !Object.hasOwn(boundary, 'semanticCandidate');
    if (
      boundary.finalText !== expectedFinalText ||
      boundary.baseline?.head !== baselineHead ||
      boundary.after?.head !== afterHead ||
      receipt?.classification !== 'one-descendant-commit' ||
      receipt.baseline?.head !== baselineHead ||
      receipt.after?.head !== afterHead ||
      receipt.commitOid !== afterHead ||
      boundary.correctionBudget?.limit !== 1 ||
      boundary.correctionBudget?.spent !== !resolved ||
      !candidateMatches
    ) {
      fail(
        `${label} did not retain exact semantic and repository evidence`,
        JSON.stringify(boundary),
      );
    }
    return boundary;
  };
  const assertUnresolved = (record, baselineHead, afterHead, label) => {
    const expectedKeys = [
      'afterHead',
      'baselineHead',
      'classification',
      'commitOid',
    ];
    const effect = record.unresolvedEffects?.[0];
    if (
      record.unresolvedEffects?.length !== 1 ||
      JSON.stringify(Object.keys(effect ?? {}).sort()) !==
        JSON.stringify(expectedKeys) ||
      effect?.classification !== 'one-descendant-commit' ||
      effect.baselineHead !== baselineHead ||
      effect.afterHead !== afterHead ||
      effect.commitOid !== afterHead
    ) {
      fail(
        `${label} lost bounded unresolved-effect evidence`,
        JSON.stringify(record.unresolvedEffects),
      );
    }
  };
  const sessionsDir = join(stateHome, 'playbook', 'sessions');
  const sessionRecord = (id) => readJson(join(sessionsDir, `${id}.json`));

  const resolvedBaseline = head();
  const resolvedRun = run(process.execPath, [driverPath, 'run', '--json'], {
    cwd: repo,
    env: processEnv('effect-resolved'),
    input: '/effect resolve from durable repository evidence\n',
  });
  expectOneOrderedLifecycle(resolvedRun.stderr, 'effect');
  const resolvedEnvelope = parseExactHeadlessReply(
    resolvedRun.stdout,
    smokeToken,
  );
  const resolvedHead = head();
  assertOneDescendant(resolvedBaseline, resolvedHead, 'resolved effect row');
  if (
    !existsSync(acceptedOidPath) ||
    readFileSync(acceptedOidPath, 'utf8') !== `${resolvedHead}\n`
  ) {
    fail(
      'resolved effect row did not deliver the receipt-owned commit OID',
      existsSync(acceptedOidPath)
        ? readFileSync(acceptedOidPath, 'utf8')
        : 'accepted OID probe is absent',
    );
  }
  const resolvedRecord = sessionRecord(resolvedEnvelope.sessionId);
  assertBoundary(resolvedRecord, {
    baselineHead: resolvedBaseline,
    afterHead: resolvedHead,
    resolved: true,
    label: 'resolved effect row',
  });
  if (
    resolvedRecord.schemaVersion !== 6 ||
    resolvedRecord.state !== 'settled' ||
    resolvedRecord.snapshot?.mode !== 'chat' ||
    resolvedRecord.unresolvedEffects?.length !== 0
  ) {
    fail(
      'resolved effect row did not settle from receipt authority',
      JSON.stringify({
        schemaVersion: resolvedRecord.schemaVersion,
        state: resolvedRecord.state,
        mode: resolvedRecord.snapshot?.mode,
        unresolvedEffects: resolvedRecord.unresolvedEffects,
      }),
    );
  }

  rmSync(acceptedOidPath);
  const parkedBaseline = head();
  const parkedRun = run(process.execPath, [driverPath, 'run', '--json'], {
    cwd: repo,
    env: processEnv('effect-parked'),
    input: '/effect park after bounded semantic failure\n',
  });
  if (
    !parkedRun.stderr.includes('◇ /effect started') ||
    parkedRun.stderr.includes('◇ /effect finished')
  ) {
    fail(
      'unresolved effect row did not retain its engagement',
      `stderr:\n${tail(parkedRun.stderr)}`,
    );
  }
  const parkedHead = head();
  assertOneDescendant(parkedBaseline, parkedHead, 'parked effect row');
  if (existsSync(acceptedOidPath)) {
    fail(
      'semantically unresolved effect row published an accepted commit OID',
      readFileSync(acceptedOidPath, 'utf8'),
    );
  }
  const evidenceLine =
    `Observed repository change (one-descendant-commit); ` +
    `baseline HEAD ${parkedBaseline}; after HEAD ${parkedHead}; ` +
    `proven commit OID ${parkedHead}.`;
  const unresolvedReply = [
    smokeToken,
    '',
    'Repository-effect evidence:',
    `- 1. ${evidenceLine}`,
    'This evidence does not establish workflow completion or attribute any ' +
      'repository change or commit to this workflow.',
  ].join('\n');
  const parkedEnvelope = parseExactHeadlessReply(
    parkedRun.stdout,
    unresolvedReply,
  );
  const parkedRecord = sessionRecord(parkedEnvelope.sessionId);
  assertBoundary(parkedRecord, {
    baselineHead: parkedBaseline,
    afterHead: parkedHead,
    resolved: false,
    label: 'parked effect row',
  });
  assertUnresolved(
    parkedRecord,
    parkedBaseline,
    parkedHead,
    'parked effect row',
  );
  if (
    parkedRecord.schemaVersion !== 6 ||
    parkedRecord.state !== 'settled' ||
    parkedRecord.snapshot?.mode !== 'engaged.parked' ||
    parkedRecord.snapshot?.frames?.at(-1)?.playbookId !== 'effect'
  ) {
    fail(
      'unresolved effect row did not persist its parked root',
      JSON.stringify({
        schemaVersion: parkedRecord.schemaVersion,
        state: parkedRecord.state,
        mode: parkedRecord.snapshot?.mode,
        frames: parkedRecord.snapshot?.frames,
      }),
    );
  }
  const parkedLedgerBytes = JSON.stringify(parkedRecord.effectLedger);
  const parkedEvidenceBytes = JSON.stringify(parkedRecord.unresolvedEffects);

  const reconcileRun = run(
    process.execPath,
    [driverPath, 'run', '--session', parkedEnvelope.sessionId, '--json'],
    {
      cwd: continuationCwd,
      env: processEnv('effect-reconcile'),
      input: 'Reconcile the unresolved repository effect.\n',
    },
  );
  parseExactHeadlessReply(
    reconcileRun.stdout,
    unresolvedReply,
    parkedEnvelope.sessionId,
  );
  const reconciledRecord = sessionRecord(parkedEnvelope.sessionId);
  if (
    reconciledRecord.state !== 'settled' ||
    reconciledRecord.snapshot?.mode !== 'engaged.parked' ||
    JSON.stringify(reconciledRecord.effectLedger) !== parkedLedgerBytes ||
    JSON.stringify(reconciledRecord.unresolvedEffects) !== parkedEvidenceBytes ||
    head() !== parkedHead
  ) {
    fail(
      'reconciliation retry changed exhausted evidence or replayed work',
      JSON.stringify({
        state: reconciledRecord.state,
        mode: reconciledRecord.snapshot?.mode,
        effectLedger: reconciledRecord.effectLedger,
        unresolvedEffects: reconciledRecord.unresolvedEffects,
      }),
    );
  }
  const reconciledStatus = run('git', ['status', '--porcelain'], { cwd: repo });
  if (reconciledStatus.stdout.trim() !== '') {
    fail(
      'effect reconciliation changed the repository worktree or index',
      reconciledStatus.stdout,
    );
  }

  const abandonRun = run(
    process.execPath,
    [driverPath, 'run', '--session', parkedEnvelope.sessionId, '--json'],
    {
      cwd: continuationCwd,
      env: processEnv('effect-abandon'),
      input: 'Abandon the unresolved repository effect.\n',
    },
  );
  parseExactHeadlessReply(
    abandonRun.stdout,
    unresolvedReply,
    parkedEnvelope.sessionId,
  );
  const abandonedRecord = sessionRecord(parkedEnvelope.sessionId);
  if (
    abandonedRecord.schemaVersion !== 6 ||
    abandonedRecord.state !== 'settled' ||
    abandonedRecord.snapshot?.mode !== 'chat' ||
    (abandonedRecord.snapshot?.frames?.length ?? 0) !== 0 ||
    JSON.stringify(abandonedRecord.effectLedger) !== parkedLedgerBytes ||
    JSON.stringify(abandonedRecord.unresolvedEffects) !== parkedEvidenceBytes ||
    abandonedRecord.settledAbandonment?.phase !== 'final' ||
    abandonedRecord.settledAbandonment?.rootPlaybookId !== 'effect' ||
    JSON.stringify(abandonedRecord.settledAbandonment?.unresolvedEffects) !==
      parkedEvidenceBytes ||
    Object.hasOwn(abandonedRecord.retainedGenerations ?? {}, 'effect') ||
    head() !== parkedHead
  ) {
    fail(
      'abandonment did not preserve evidence while clearing the root',
      JSON.stringify({
        state: abandonedRecord.state,
        mode: abandonedRecord.snapshot?.mode,
        frames: abandonedRecord.snapshot?.frames,
        unresolvedEffects: abandonedRecord.unresolvedEffects,
        settledAbandonment: abandonedRecord.settledAbandonment,
        retainedGenerations: abandonedRecord.retainedGenerations,
      }),
    );
  }
  const finalStatus = run('git', ['status', '--porcelain'], { cwd: repo });
  if (finalStatus.stdout.trim() !== '') {
    fail(
      'unresolved-effect controls changed the repository worktree or index',
      finalStatus.stdout,
    );
  }

  const calls = readFileSync(callLog, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const expectedKinds = {
    'effect-resolved': ['player', 'judge', 'closing'],
    'effect-parked': ['player', 'judge', 'judge', 'closing'],
    'effect-reconcile': ['selection', 'closing'],
    'effect-abandon': ['selection', 'closing'],
  };
  for (const [processName, kinds] of Object.entries(expectedKinds)) {
    const processCalls = calls.filter((call) => call.process === processName);
    const actualKinds = processCalls.map((call) => call.kind);
    if (JSON.stringify(actualKinds) !== JSON.stringify(kinds)) {
      fail(
        `${processName} crossed unexpected player or judge boundaries`,
        JSON.stringify({ expected: kinds, actual: actualKinds, processCalls }),
      );
    }
    if (processName !== 'effect-resolved') {
      const closingPrompt = processCalls.find(
        (call) => call.kind === 'closing',
      )?.prompt;
      if (!closingPrompt?.includes(evidenceLine)) {
        fail(
          `${processName} closing prompt omitted canonical effect evidence`,
          closingPrompt,
        );
      }
    }
  }

  rmSync(driverPath);
  return [
    `resolved session ${resolvedEnvelope.sessionId} accepted ${resolvedHead}`,
    'result-less Codex commentary and misleading Commit prose stayed opaque',
    `parked session ${parkedEnvelope.sessionId} retained ${parkedHead}`,
    'a successor reconciliation replayed no player or judge',
    'a later successor abandoned the root with its exact evidence preserved',
  ];
}

function smokeConfig(tuning) {
  const suffix = tuning === 'a' ? 'a' : 'b';
  return [
    `captain: { adapter: claude, model: release-smoke-captain-${suffix}, effort: low, fastMode: false }`,
    'players:',
    `  release.shared: { adapter: codex, model: release-player-${suffix}, effort: high }`,
    `  release.isolated: { adapter: codex, model: release-player-${suffix}, effort: high }`,
    'playbooks:',
    '  smoke:',
    '    from: ./smoke.playbook.mjs',
    '    roles: {}',
    '  recover:',
    '    from: ./recover.playbook.mjs',
    '    roles: {}',
    '  lanes:',
    '    from: ./lanes.playbook.mjs',
    '    roles:',
    '      first: { player: release.shared, fastMode: true }',
    `      second: { player: release.shared, model: release-second-${suffix}, effort: low, fastMode: false }`,
    '      isolated: release.isolated',
    '',
  ].join('\n');
}

function smokeRetuneOverlay() {
  return [
    'captain: { model: release-smoke-captain-b, effort: max, fastMode: true }',
    'players:',
    '  release.shared: { model: release-player-b, effort: max, fastMode: false }',
    '  release.isolated: { model: release-player-b, effort: max, fastMode: false }',
    'playbooks:',
    '  lanes:',
    '    roles:',
    '      first: { player: release.shared, fastMode: false }',
    '      second: { player: release.shared, model: false, effort: false, fastMode: true }',
    '      isolated: { player: release.isolated, fastMode: true }',
    '',
  ].join('\n');
}

function unsupportedFastModeConfig(fastMode) {
  return [
    'captain: { adapter: claude }',
    'players:',
    `  release.unsupported: { adapter: ${unsupportedFastModeAdapterMarker} }`,
    'playbooks:',
    '  unsupported:',
    '    from: ./must-not-prepare.playbook.mjs',
    '    roles:',
    `      worker: { player: release.unsupported, fastMode: ${String(fastMode)} }`,
    '',
  ].join('\n');
}

function expectOneOrderedLifecycle(stderr, id) {
  const started = `/${id} started`;
  const finished = `/${id} finished`;
  const startedAt = stderr.indexOf(started);
  const finishedAt = stderr.indexOf(finished);
  if (
    startedAt < 0 ||
    startedAt !== stderr.lastIndexOf(started) ||
    finishedAt < 0 ||
    finishedAt !== stderr.lastIndexOf(finished) ||
    startedAt >= finishedAt
  ) {
    fail(
      `the headless turn did not emit one ordered /${id} lifecycle`,
      `stderr:\n${tail(stderr)}`,
    );
  }
}

function assertSmokeCalls(calls) {
  const expected = [
    ['first', 'closing', null, null, 'release-smoke-captain-a', 'low', false],
    [
      'continued',
      'selection',
      null,
      'release-smoke:closing:first:1',
      'release-smoke-captain-a',
      'low',
      false,
    ],
    ['lane-a', 'player', 'first', null, 'release-player-a', 'high', true],
    [
      'lane-a',
      'player',
      'second',
      'release-lane:shared:1',
      'release-second-a',
      'low',
      false,
    ],
    ['lane-a', 'player', 'isolated', null, 'release-player-a', 'high', null],
    [
      'lane-a',
      'closing',
      null,
      'release-smoke:selection:continued:1',
      'release-smoke-captain-a',
      'low',
      false,
    ],
    [
      'lane-b',
      'player',
      'second',
      'release-lane:shared:2',
      null,
      null,
      true,
    ],
    [
      'lane-b',
      'player',
      'first',
      'release-lane:shared:3',
      'release-player-b',
      'max',
      false,
    ],
    [
      'lane-b',
      'player',
      'isolated',
      'release-lane:isolated:1',
      'release-player-b',
      'max',
      true,
    ],
    [
      'lane-b',
      'closing',
      null,
      'release-smoke:closing:lane-a:4',
      'release-smoke-captain-b',
      'max',
      true,
    ],
  ];
  const actual = calls.map((call) => [
    call.process,
    call.kind,
    call.role,
    call.resume,
    call.model,
    call.effort,
    call.fastMode,
  ]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      'the deterministic calls did not preserve shared/isolated tokens and tuning',
      JSON.stringify({ expected, actual, calls }),
    );
  }
}

// Step 7 — every installed compiled runtime: each public playbook subpath
// imports and constructs with its declared required contract surface.
function stepCompiledRuntimeIntegrity(state) {
  const probePath = join(
    installedPackageRoot(state.optinPrefix),
    'smoke-runtime-imports.mjs',
  );
  writeFileSync(probePath, compiledRuntimeImportProbeSource());
  const probe = run(process.execPath, [probePath], {
    cwd: dirname(probePath),
    allowFailure: true,
  });
  if (probe.status !== 0) {
    fail(
      'an installed @sublang/playbook playbook subpath did not construct',
      `stdout:\n${tail(probe.stdout)}\nstderr:\n${tail(probe.stderr)}`,
    );
  }
  return probe.stdout.trimEnd().split('\n');
}

// Step 8 — compiled-artifact fidelity WITHOUT an agentic recompile. The
// deterministic Source → GEARS checker proves the mechanically decidable
// preservation contract for each external workflow. The checked-in suites
// then prove each artifact's GEARS ↔ FSM ↔ runtime contract, and byte equality
// transfers those results to the packed candidate.
function stepCompiledFidelity(state) {
  const compared = compareAgainstCommitted(state.packedPackage, [
    state.packedPackage,
  ]);

  const workflows = ['code', 'review', 'decide'];
  for (const id of workflows) {
    run(process.execPath, [
      join(repoRoot, 'scripts', 'check-slc-source-gears.mjs'),
      join(state.packedPackage, 'reference', 'sdlc', `${id}.md`),
      join(
        state.packedPackage,
        'reference',
        'sdlc',
        `${id}.playbook`,
        `${id}.gears.md`,
      ),
    ]);
  }

  const artifactDirectories = ['captain', ...workflows].map((id) =>
    `reference/sdlc/${id}.playbook`,
  );
  const suites = run('pnpm', [
    'vitest',
    'run',
    ...artifactDirectories,
  ]);
  const output = `${suites.stdout}\n${suites.stderr}`;
  const summary = /Tests\s+(\d+) passed/.exec(output);
  if (!summary) {
    fail(
      'the compiled artifact-conformance suites reported no passing count',
      tail(output),
    );
  }
  // A green run of whatever the path filters happen to match is not the
  // claim. Record every artifact suite the chain stands on, so a suite
  // renamed, moved, or deleted fails instead of silently shrinking coverage.
  const requiredSuites = [
    'captain.playbook/captain.gears-fsm.test.ts',
    'captain.playbook/captain.fsm.coverage.test.ts',
    'captain.playbook/captain.fsm.introspect.test.ts',
    'captain.playbook/captain.prompt-contract.test.ts',
    'captain.playbook/captain.playbook.integration.test.ts',
    'code.playbook/code.gears-fsm.test.ts',
    'code.playbook/code.fsm.coverage.test.ts',
    'code.playbook/code.fsm.introspect.test.ts',
    'code.playbook/code.prompt-contract.test.ts',
    'code.playbook/code.playbook.contract.test.ts',
    'code.playbook/code.playbook.test.ts',
    'code.playbook/headless-run.test.ts',
    'code.playbook/headless-captain-skew.test.ts',
    'code.playbook/session-store.test.ts',
    'code.playbook/headless-crash.test.ts',
    'review.playbook/review.gears-fsm.test.ts',
    'review.playbook/review.playbook.test.ts',
    'decide.playbook/decide.gears-fsm.test.ts',
    'decide.playbook/decide.playbook.test.ts',
  ];
  const absent = requiredSuites.filter((suite) => !output.includes(suite));
  if (absent.length > 0) {
    fail(
      `the conformance run did not include ${absent.join(', ')}`,
      'RELEASE-28 step 8 rests on the recorded source, transition, prompt, ' +
        `topology, and runtime suites.\n${tail(output)}`,
    );
  }
  return [
    `${compared} packed artifacts byte-identical to the committed tree`,
    `source → GEARS preservation: ${workflows.join(', ')}`,
    `compiled artifact suites: ${summary[1]} tests passed`,
    `required suite files ran: ${requiredSuites.length}`,
    'no agentic recompile attempted',
  ];
}

function compareAgainstCommitted(packedPackage, roots) {
  let compared = 0;
  const mismatched = [];
  const missing = [];
  for (const root of roots) {
    for (const path of packedComparableEntries(root, packedPackage)) {
      const relativePath = relative(packedPackage, path);
      const committed = join(repoRoot, relativePath);
      if (!existsSync(committed)) {
        missing.push(relativePath);
        continue;
      }
      compared += 1;
      if (sha256(path) !== sha256(committed)) mismatched.push(relativePath);
    }
  }
  if (missing.length > 0) {
    fail(
      `${missing.length} packed artifact(s) have no committed counterpart`,
      missing.join('\n'),
    );
  }
  if (mismatched.length > 0) {
    fail(
      `${mismatched.length} packed artifact(s) differ from the working tree`,
      'The tarball was built from a tree that has since changed; re-run ' +
        `the gate on a settled tree.\n${mismatched.join('\n')}`,
    );
  }
  if (compared === 0) fail('no packed artifact was compared');
  return compared;
}

// Step 9 — the nested cligent floor. The complete release contract is proven
// by one type-checking fixture per capability against the nested copy through
// `scripts/cligent-release-capabilities.mjs`. This avoids name searching,
// which stays green when a spelling survives on an unrelated declaration or
// comment after the owning public interface loses or narrows its member.
function stepCligentFloor(root, state) {
  const declared = state.packedManifest.dependencies?.['@sublang/cligent'];
  if (typeof declared !== 'string') {
    fail('the packed manifest declares no @sublang/cligent dependency');
  }
  const cligentRoot = nestedCligentRoot(state.optinPrefix);
  const installedVersion = readJson(join(cligentRoot, 'package.json')).version;
  const satisfied = satisfiesCaret(installedVersion, declared);
  if (satisfied === undefined) {
    fail(
      `@sublang/cligent is declared as ${declared}, not a caret range`,
      'RELEASE-14 requires a caret SemVer range, never a moving dist-tag.',
    );
  }
  if (!satisfied) {
    fail(
      `the installed @sublang/cligent ${installedVersion} does not satisfy ${declared}`,
    );
  }
  const surface = checkCligentReleaseCapabilities({
    cligentRoot,
    workRoot: join(root, 'cligent-release-capabilities'),
  });
  if (!surface.ok) {
    fail(
      `the installed @sublang/cligent ${installedVersion} does not carry ` +
        (surface.unproven.length > 0
          ? surface.unproven.map((member) => member.id).join(' or ')
          : `${CLIGENT_RELEASE_SPECIFIER} as the shell imports it`),
      [
        ...surface.unproven.flatMap((member) => [
          `${member.id} — ${member.why}`,
          ...member.diagnostics.map((line) => `  ${line}`),
        ]),
        ...surface.otherDiagnostics,
        `Type-checked against ${surface.specifier} resolved from ${cligentRoot}.`,
        `Fixtures preserved at ${surface.workRoot}.`,
        'The published release the manifest range admits must carry every ' +
          'required capability before this candidate can ship.',
      ].join('\n'),
    );
  }
  const messageBoundaryProbe = join(
    cligentRoot,
    'playbook-message-boundary-probe.mjs',
  );
  writeFileSync(messageBoundaryProbe, cligentMessageBoundaryProbeSource());
  run(process.execPath, [messageBoundaryProbe], { cwd: cligentRoot });
  rmSync(messageBoundaryProbe);
  return [
    `nested @sublang/cligent ${installedVersion} satisfies ${declared}`,
    `${surface.specifier} type-checks ${surface.proven.join(' and ')}`,
    'Codex commentary and final response remain separate complete messages',
  ];
}

// Step 10 — an external package whose only direct dependency is this exact
// tarball. Its emitted strict TypeScript consumer imports only the public
// session-store facade, so neither a repository source path nor the private
// store can make the declaration or runtime proof pass by accident.
function stepPackedSessionStore(root, state) {
  const fixture = state.sessionStoreFixture;
  if (fixture === undefined) {
    fail('the installed CLI produced no session-store smoke fixture');
  }
  const oldManifest = readJson(fixture.oldSessionPath);
  if (
    oldManifest.schemaVersion !== 6 ||
    oldManifest.sessionId !== fixture.oldSessionId
  ) {
    fail(
      'the CLI-written old-schema source manifest is not current and valid',
      JSON.stringify({
        schemaVersion: oldManifest.schemaVersion,
        sessionId: oldManifest.sessionId,
      }),
    );
  }
  const {
    unresolvedEffects: _unresolvedEffects,
    ...preUnresolvedEffectsManifest
  } = oldManifest;
  const oldSchemaBytes = `${JSON.stringify({
    ...preUnresolvedEffectsManifest,
    schemaVersion: 5,
  })}\n`;
  writeFileSync(fixture.oldSessionPath, oldSchemaBytes);

  const consumerRoot = join(root, 'session-store-consumer');
  mkdirSync(consumerRoot, { recursive: true });
  const manifest = {
    name: 'playbook-session-store-smoke',
    private: true,
    type: 'module',
    dependencies: {
      '@sublang/playbook': pathToFileURL(state.tarball).href,
    },
  };
  writeFileSync(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
    ],
    { cwd: consumerRoot },
  );
  const installedManifest = readJson(join(consumerRoot, 'package.json'));
  if (
    JSON.stringify(Object.keys(installedManifest.dependencies ?? {})) !==
    JSON.stringify(['@sublang/playbook'])
  ) {
    fail(
      'the external consumer declared more than @sublang/playbook',
      JSON.stringify(installedManifest.dependencies ?? {}),
    );
  }

  const installed = join(
    consumerRoot,
    'node_modules',
    '@sublang',
    'playbook',
  );
  if (
    !existsSync(installed) ||
    !lstatSync(installed).isDirectory() ||
    lstatSync(installed).isSymbolicLink()
  ) {
    fail('the external consumer did not install a real candidate directory');
  }
  const installedReal = realpathSync(installed);
  const consumerReal = `${realpathSync(consumerRoot)}${sep}`;
  const repositoryReal = `${realpathSync(repoRoot)}${sep}`;
  if (
    !`${installedReal}${sep}`.startsWith(consumerReal) ||
    `${installedReal}${sep}`.startsWith(repositoryReal)
  ) {
    fail(
      'the external consumer resolved outside its tarball installation',
      installedReal,
    );
  }
  const candidateManifest = readJson(join(installed, 'package.json'));
  if (
    candidateManifest.name !== state.packedManifest.name ||
    candidateManifest.version !== state.packedManifest.version
  ) {
    fail(
      'the external consumer installed a different candidate',
      JSON.stringify({
        expected: {
          name: state.packedManifest.name,
          version: state.packedManifest.version,
        },
        actual: {
          name: candidateManifest.name,
          version: candidateManifest.version,
        },
      }),
    );
  }
  for (const artifact of [
    'reference/sdlc/code.playbook/session-store.js',
    'reference/sdlc/code.playbook/session-store.d.ts',
  ]) {
    if (!existsSync(join(installed, artifact))) {
      fail(`the packed session-store consumer is missing ${artifact}`);
    }
  }

  writeFileSync(
    join(consumerRoot, 'consumer.ts'),
    sessionStoreConsumerSource(fixture),
  );
  writeFileSync(
    join(consumerRoot, 'tsconfig.json'),
    `${JSON.stringify(sessionStoreConsumerTsconfig(), null, 2)}\n`,
  );
  const compiler = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(compiler)) {
    fail('the release smoke development tree has no TypeScript compiler');
  }
  run(process.execPath, [compiler, '--project', 'tsconfig.json'], {
    cwd: consumerRoot,
  });
  run(process.execPath, [join('dist', 'consumer.js')], {
    cwd: consumerRoot,
  });
  if (readFileSync(fixture.oldSessionPath, 'utf8') !== oldSchemaBytes) {
    fail('the external consumer migrated or rewrote the old-schema manifest');
  }

  return [
    'one tarball-only dependency; no repository or private-store import',
    'strict declaration check passed with skipLibCheck false',
    'exact token-free summary listed and read from the CLI manifest',
    'independent follower saw readable advancement without durability claims',
    'release equalized replay durability; schema 5 stayed byte-identical',
  ];
}

function sessionStoreConsumerTsconfig() {
  return {
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      lib: ['ES2022'],
      strict: true,
      skipLibCheck: false,
      types: [],
      rootDir: '.',
      outDir: 'dist',
      noEmitOnError: true,
    },
    files: ['consumer.ts'],
  };
}

function sessionStoreConsumerSource(fixture) {
  return `import {
  RECORDS_STREAM_VERSION,
  openSessionStore,
  type PlaybookSessionSummary,
  type ReplayStreamEntry,
} from '@sublang/playbook/session-store';

const sessionsDir = ${JSON.stringify(fixture.sessionsDir)};
const sessionId = ${JSON.stringify(fixture.sessionId)};
const oldSessionId = ${JSON.stringify(fixture.oldSessionId)};
const expectedSummary: PlaybookSessionSummary = ${JSON.stringify(fixture.expectedSummary)};
const credentials: readonly string[] = ${JSON.stringify(fixture.credentials)};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function exactKeys(value: object, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  check(
    JSON.stringify(actual) === JSON.stringify(wanted),
    label + ' keys: expected ' + JSON.stringify(wanted) +
      ', got ' + JSON.stringify(actual),
  );
}

function sameJson(actual: unknown, expected: unknown, label: string) {
  check(
    JSON.stringify(canonicalJson(actual)) ===
      JSON.stringify(canonicalJson(expected)),
    label + ': expected ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(actual),
  );
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  return value;
}

function hasOwnKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasOwnKey(entry, key));
  }
  if (value === null || typeof value !== 'object') return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((entry) => hasOwnKey(entry, key));
}

function hasStringOwnValue(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasStringOwnValue(entry, key));
  }
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, key) && typeof record[key] === 'string') {
    return true;
  }
  return Object.values(record).some((entry) => hasStringOwnValue(entry, key));
}

check(RECORDS_STREAM_VERSION === 1, 'records stream version is not 1');
const store = openSessionStore(sessionsDir);
exactKeys(
  store,
  ['sessionsDir', 'list', 'read', 'readStream', 'acquire'],
  'store',
);
const listed = await store.list();
exactKeys(listed, ['sessions', 'skipped'], 'list result');
const listedSummary = listed.sessions.find(
  (summary) => summary.sessionId === sessionId,
);
check(listedSummary !== undefined, 'CLI-written session was not listed');
exactKeys(
  listedSummary,
  ['cwd', 'schemaVersion', 'sessionId', 'state', 'updatedAt'],
  'listed summary',
);
sameJson(listedSummary, expectedSummary, 'listed summary');
const skipped = listed.skipped.find((entry) => entry.sessionId === oldSessionId);
check(skipped !== undefined, 'schema-5 session was not reported as skipped');
exactKeys(skipped, ['sessionId', 'reason'], 'skipped session');
check(
  skipped.reason.includes('5') && /schema|cutover|current/i.test(skipped.reason),
  'schema-5 skip reason did not identify the cutover',
);

const direct = await store.read(sessionId);
exactKeys(
  direct,
  ['cwd', 'schemaVersion', 'sessionId', 'state', 'updatedAt'],
  'direct summary',
);
sameJson(direct, expectedSummary, 'direct summary');
const summaryJson = JSON.stringify(direct);
for (const credential of credentials) {
  check(!summaryJson.includes(credential), 'summary exposed a resume credential');
}

const follower = openSessionStore(sessionsDir);
const baselineRead = await follower.readStream(sessionId);
exactKeys(baselineRead, ['entries', 'lastReadableSeq'], 'baseline follower');
const baselineJson = JSON.stringify(baselineRead);
for (const credential of credentials) {
  check(
    !baselineJson.includes(credential),
    'CLI-written replay exposed a resume credential',
  );
}
check(
  !hasOwnKey(baselineRead, 'resumeToken'),
  'CLI-written replay retained a resumeToken member',
);
check(
  !hasStringOwnValue(baselineRead, 'resume'),
  'CLI-written replay retained a string resume selection',
);
const baseline = baselineRead.lastReadableSeq;
check(
  Number.isSafeInteger(baseline) && baseline >= 0,
  'baseline readable sequence was invalid',
);
check(
  baselineRead.entries.length === baseline,
  'baseline full-prefix entry count did not equal its final sequence',
);

const lease = await store.acquire(sessionId);
exactKeys(
  lease,
  ['sessionId', 'ownerToken', 'append', 'readStream', 'streamStatus', 'release'],
  'lease',
);
sameJson(
  lease.streamStatus(),
  {
    lastReadableSeq: baseline,
    lastDurableSeq: baseline,
    incomplete: false,
  },
  'initial lease status',
);

interface ExternalObservedRecord {
  readonly type: 'external_peer_record';
  readonly content: string;
  readonly resume: false;
  readonly resumeToken?: string;
  readonly nested: {
    readonly resume: string;
    readonly resumeToken: string;
    readonly retained: { readonly resume: false };
  };
}
const observed: ExternalObservedRecord = {
  type: 'external_peer_record',
  content: 'packed facade replay',
  resume: false,
  resumeToken: 'strip-top-level',
  nested: {
    resume: 'strip-selection',
    resumeToken: 'strip-nested',
    retained: { resume: false },
  },
};
const appendResult = await lease.append(observed, 'external');
check(appendResult === undefined, 'append did not resolve undefined');
const nextSequence = baseline + 1;
const expectedEntry: ReplayStreamEntry = {
  v: 1,
  seq: nextSequence,
  role: 'external',
  record: {
    type: 'external_peer_record',
    content: 'packed facade replay',
    resume: false,
    nested: { retained: { resume: false } },
  },
};
sameJson(
  lease.streamStatus(),
  {
    lastReadableSeq: nextSequence,
    lastDurableSeq: baseline,
    incomplete: false,
  },
  'readable-ahead-of-durable status',
);
const leaseRead = await lease.readStream({ afterSeq: baseline });
exactKeys(
  leaseRead,
  ['entries', 'lastReadableSeq', 'lastDurableSeq', 'incomplete'],
  'lease read',
);
sameJson(leaseRead.entries, [expectedEntry], 'lease replay');
check(
  !JSON.stringify(leaseRead).includes('strip-'),
  'replay exposed a resume credential',
);

const followed = await follower.readStream(sessionId, { afterSeq: baseline });
exactKeys(followed, ['entries', 'lastReadableSeq'], 'independent follower');
sameJson(followed.entries, [expectedEntry], 'independent follower replay');
check(
  followed.lastReadableSeq === nextSequence,
  'independent follower missed readable advancement',
);
// @ts-expect-error lease-free results cannot claim durability
followed.lastDurableSeq;
// @ts-expect-error lease-free results cannot claim incompleteness
followed.incomplete;

const finalStatus = await lease.release();
exactKeys(
  finalStatus,
  ['lastReadableSeq', 'lastDurableSeq', 'incomplete'],
  'release status',
);
sameJson(
  finalStatus,
  {
    lastReadableSeq: nextSequence,
    lastDurableSeq: nextSequence,
    incomplete: false,
  },
  'equalized release status',
);
const replayed = await follower.readStream(sessionId, { afterSeq: baseline });
sameJson(replayed.entries, [expectedEntry], 'post-release replay');

let oldSchemaRejected = false;
try {
  await store.read(oldSessionId);
} catch (error) {
  check(error instanceof Error, 'old-schema read rejected with a non-Error');
  check(
    !Object.hasOwn(error, 'code'),
    'old-schema rejection used a reserved facade code',
  );
  oldSchemaRejected = true;
}
check(oldSchemaRejected, 'schema-5 record was not rejected');
`;
}

export const _testing = Object.freeze({
  stepHermetic,
  stepEffectReconciliation,
  smokeConfig,
  smokeRetuneOverlay,
  unsupportedFastModeAdapterMarker,
  unsupportedFastModeConfig,
  assertSmokeCalls,
  effectArtifactSource,
  installedEffectReconciliationDriverSource,
  installedFastModeBoundaryDriverSource,
  compiledRuntimeImportProbeSource,
  cligentMessageBoundaryProbeSource,
  sessionStoreConsumerSource,
  sessionStoreConsumerTsconfig,
});

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
