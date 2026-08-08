#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// RELEASE-28: the local, model-free release smoke — `pnpm smoke:release`.
//
// It packs the candidate, installs it into throwaway npm prefixes in both
// documented DR-026 shapes, exercises the installed CLI, drives the DR-024
// hermetic provisioning path deterministically, and checks that what the
// tarball carries is byte-for-byte what the repository committed.
//
// No model calls, no credentials, and no tmux: every agent-shaped step is
// either an availability probe or a DR-016 script actor. Registry access IS
// required — steps 2 and 3 install from npm.
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
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPTAIN_SURFACE_SPECIFIER,
  checkCligentCaptainSurface,
} from './cligent-captain-surface.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keepArtifacts = process.argv.includes('--keep');
const maxBuffer = 64 * 1024 * 1024;
const smokeToken = 'RELEASE_SMOKE_OK';
const smokeTask = 'Run the deterministic release smoke probe.';
const adapterSdks = ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'];

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

// A version manager's inherited prefix would send `npm install -g` to the
// maintainer's real global root instead of this run's throwaway one.
function smokeEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? smokeEnv(),
    encoding: 'utf8',
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
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

// A thin compiled-style artifact whose one working state is a DR-016 script
// actor: no player, no captain, no judge, so the whole run is deterministic
// and needs no credentials. The exit-status guards are the DR-016 pair.
function smokeArtifactSource() {
  return `// Release smoke fixture: a thin artifact with one script state.
import { assign, setup } from 'xstate';
import { createXStatePlaybookRuntime } from '@sublang/playbook/xstate-runtime';

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
          command: 'exit 0',
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
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
});

export default {
  id: 'releasesmoke',
  command: 'releasesmoke',
  intent: 'deterministic release smoke fixture',
  requiredRoleIds: [],
  validateOptions(value) {
    return value ?? {};
  },
  createRuntime() {
    return createRuntime({});
  },
};
`;
}

// The installed package's own module scope: a self-referencing import is
// exactly what a consumer's \`import '@sublang/playbook/captain/playbook'\`
// resolves, exports map included.
function captainImportProbeSource() {
  return `// RELEASE-28 step 6: the installed captain/playbook subpath constructs.
import factory from '@sublang/playbook/captain/playbook';

const runtime = factory({
  enabledPlaybooks: [
    { id: 'code', command: 'code', intent: 'implement one spec item' },
  ],
});
const required = [
  'init',
  'handleBossInput',
  'resumePlaybookCall',
  'dispose',
  'describe',
  'apply',
];
const missing = required.filter((name) => typeof runtime[name] !== 'function');
if (missing.length > 0) {
  console.error(\`captain/playbook runtime is missing: \${missing.join(', ')}\`);
  process.exit(1);
}
// Construction is the claim; the control surface is asserted as a member
// pair, not exercised — \`describe()\` is only valid after \`init()\`, which
// needs a live host session this model-free gate deliberately has none of.
try {
  runtime.describe();
  console.error('captain/playbook describe() answered before init()');
  process.exit(1);
} catch {
  // The uninitialized refusal is the expected engine behavior.
}
console.log(\`OK    captain/playbook constructs with \${required.length} contract members\`);
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
// for every packed path, byte-for-byte the same artifacts step 7's suites
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
  const state = {};
  const steps = [
    ['pack the publishable tarball', () => stepPack(root, state)],
    ['install the lean global shape', () => stepLean(root, state)],
    ['install the opted-in global shape', () => stepOptedIn(root, state)],
    ['run the installed CLI surfaces', () => stepInstalledCli(root, state)],
    ['drive the hermetic provisioning run', () => stepHermetic(root, state)],
    ['check Captain artifact integrity', () => stepCaptainArtifact(state)],
    ['check compiled-artifact fidelity', () => stepCompiledFidelity(state)],
    ['guard the nested cligent floor', () => stepCligentFloor(root, state)],
  ];

  const startedAt = Date.now();
  let failed;
  for (const [index, [title, step]] of steps.entries()) {
    const label = `[${index + 1}/${steps.length}] ${title}`;
    const stepStartedAt = Date.now();
    process.stdout.write(`${label}\n`);
    try {
      const lines = (await step()) ?? [];
      for (const line of lines) process.stdout.write(`    ${line}\n`);
      process.stdout.write(
        `    ok (${seconds(Date.now() - stepStartedAt)}s)\n\n`,
      );
    } catch (error) {
      failed = { label, error };
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
  const configHome = join(home, '.config');
  mkdirSync(join(configHome, 'playbook'), { recursive: true });
  writeFileSync(
    join(configHome, 'playbook', 'playbook.config.yaml'),
    [
      'captain:',
      '  adapter: claude',
      'playbooks:',
      '  code:',
      '    from: "@sublang/playbook/code/registry"',
      '    players:',
      '      coder: claude',
      '      reviewer: codex',
      '    committer: coder',
      '  discuss:',
      '    from: "@sublang/playbook/discuss/registry"',
      '    players:',
      '      host: claude',
      '      participant: codex',
      '    committer: host',
      '',
    ].join('\n'),
  );
  const env = smokeEnv({
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: join(home, '.local', 'state'),
  });
  const help = run(state.optinBin, ['--help'], { cwd: root, env });
  expectContains(help.stdout, 'playbook run <from>', '--help output');
  expectContains(help.stdout, 'Default config:', '--help output');
  const list = run(state.optinBin, ['--list'], { cwd: root, env });
  for (const expected of [
    '/code  code  —',
    '/discuss  discuss  —',
  ]) {
    expectContains(list.stdout, expected, '--list output');
  }
  return [
    '--help printed usage and the resolved config path',
    ...list.stdout.trimEnd().split('\n'),
  ];
}

// Step 5 — DR-024 §7 / RELEASE-24 §hermetic, deterministic variant: a bare
// repository with no project-local packages at any level, a thin artifact
// whose only working state is a script actor, and the installed global host
// driving it. No agent call is ever made, so no credential is needed — the
// captain's SDK only has to be loadable, which step 3's shape guarantees.
function stepHermetic(root, state) {
  const scenario = join(root, 'hermetic');
  const repo = join(scenario, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'smoke.playbook.mjs'), smokeArtifactSource());
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
    XDG_CONFIG_HOME: join(scenario, 'xdg'),
    XDG_STATE_HOME: join(scenario, 'xdg-state'),
  });
  const args = [
    'run',
    './smoke.playbook.mjs',
    smokeTask,
    '--cwd',
    repo,
    '--json',
  ];
  const first = run(state.optinBin, args, { cwd: repo, env });
  const provisioningLines = first.stderr.match(/provisioned/g) ?? [];
  if (provisioningLines.length !== 1) {
    fail(
      `expected exactly one provisioning line, saw ${provisioningLines.length}`,
      `stderr:\n${tail(first.stderr)}`,
    );
  }
  const prefixReal = `${realpathSync(state.optinPrefix)}${sep}`;
  for (const name of ['xstate', join('@sublang', 'playbook')]) {
    const link = join(repo, 'node_modules', name);
    if (!lstatSync(link).isSymbolicLink()) {
      fail(`${link} is not a symbolic link`);
    }
    const target = realpathSync(readlinkSync(link));
    if (!target.startsWith(prefixReal)) {
      fail(`${link} resolves outside the isolated prefix`, target);
    }
  }
  const envelope = JSON.parse(first.stdout);
  const expected = {
    outcome: 'terminal',
    output: { token: smokeToken, exitStatus: 0 },
  };
  if (
    envelope.outcome !== expected.outcome ||
    envelope.output?.token !== smokeToken ||
    envelope.output?.exitStatus !== 0 ||
    typeof envelope.sessionId !== 'string'
  ) {
    fail(
      'the hermetic run did not return the expected terminal envelope',
      `expected ${JSON.stringify(expected)}\nactual   ${first.stdout.trim()}`,
    );
  }

  const second = run(state.optinBin, args, { cwd: repo, env });
  if (second.stderr.includes('provisioned')) {
    fail(
      'the second hermetic run provisioned again',
      `stderr:\n${tail(second.stderr)}`,
    );
  }
  if (JSON.parse(second.stdout).outcome !== 'terminal') {
    fail('the second hermetic run did not reach a terminal outcome', second.stdout);
  }
  const status = run('git', ['status', '--porcelain'], { cwd: repo });
  if (status.stdout.trim() !== '') {
    fail(
      'the hermetic fixture repository is not clean after the runs',
      status.stdout,
    );
  }
  return [
    'one provisioning line; both engine links resolve into the prefix',
    `terminal envelope with ${smokeToken} (exit status 0)`,
    'the second run provisioned nothing and stayed terminal',
  ];
}

// Step 6 — the installed default Captain: the published subpath imports and
// constructs, and every packed Captain artifact is byte-identical to the
// committed one.
function stepCaptainArtifact(state) {
  const probePath = join(
    installedPackageRoot(state.optinPrefix),
    'smoke-captain-import.mjs',
  );
  writeFileSync(probePath, captainImportProbeSource());
  const probe = run(process.execPath, [probePath], {
    cwd: dirname(probePath),
    allowFailure: true,
  });
  if (probe.status !== 0) {
    fail(
      'the installed @sublang/playbook/captain/playbook did not construct',
      `stdout:\n${tail(probe.stdout)}\nstderr:\n${tail(probe.stderr)}`,
    );
  }
  const captainDir = join(
    state.packedPackage,
    'reference',
    'sdlc',
    'captain.playbook',
  );
  if (!existsSync(captainDir)) {
    fail(`the tarball carries no ${relative(state.packedPackage, captainDir)}`);
  }
  const compared = compareAgainstCommitted(state.packedPackage, [captainDir]);
  return [probe.stdout.trim(), `${compared} packed Captain files byte-identical`];
}

// Step 7 — compiled-artifact fidelity WITHOUT a recompile. The SLC pipeline is
// agentic, so this gate cannot re-derive the artifacts deterministically and
// claims nothing about source → GEARS. What it does claim: every compiled
// artifact the tarball carries is byte-identical to the committed one, and the
// committed artifact-conformance suites — rooted at the compiled
// `captain.gears.md`, not at the maintained `reference/sdlc/captain.md` — are
// green. That is GEARS ↔ FSM ↔ runtime fidelity, and only that.
function stepCompiledFidelity(state) {
  const compared = compareAgainstCommitted(state.packedPackage, [
    state.packedPackage,
  ]);
  const suites = run('pnpm', [
    'vitest',
    'run',
    'reference/sdlc/captain.playbook',
  ]);
  const output = `${suites.stdout}\n${suites.stderr}`;
  const summary = /Tests\s+(\d+) passed/.exec(output);
  if (!summary) {
    fail(
      'the Captain artifact-conformance suites reported no passing count',
      tail(output),
    );
  }
  // A green run of whatever the path filter happened to match is not the
  // claim. The chain this step stands on is three suites by name, and a
  // suite renamed, moved, or deleted must fail the gate rather than shrink
  // it silently: vitest names every file it ran.
  const chain = [
    'captain.gears-fsm.test.ts',
    'captain.fsm.coverage.test.ts',
    'captain.fsm.introspect.test.ts',
  ];
  const absent = chain.filter((suite) => !output.includes(suite));
  if (absent.length > 0) {
    fail(
      `the conformance run did not include ${absent.join(', ')}`,
      'RELEASE-28 step 7 rests on the GEARS ↔ FSM conformance, ' +
        `declared-transition coverage, and pinned-topology suites.\n${tail(output)}`,
    );
  }
  return [
    `${compared} packed artifacts byte-identical to the committed tree`,
    `reference/sdlc/captain.playbook suites: ${summary[1]} tests passed`,
    `conformance chain ran: ${chain.join(', ')}`,
    'no recompile attempted — the pipeline is agentic (source → GEARS unproven here)',
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

// Step 8 — the nested cligent floor. This is the standing regression guard for
// the dependency bump: the shell's durable conversation needs
// `CaptainRunResult.resumeToken` and `CaptainContext.emitReply`, and a global
// install resolves cligent from this nested copy alone.
//
// The two members are proven by type-checking one fixture apiece against the
// nested copy (`scripts/cligent-captain-surface.mjs`), not by searching the
// installed declarations for their names: `resumeToken` names members of four
// unrelated cligent declarations and `emitReply` survives in a neighboring
// record type's doc comment, so a name search stays green with both members
// deleted from the interfaces the shell actually calls.
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
  const surface = checkCligentCaptainSurface({
    cligentRoot,
    workRoot: join(root, 'cligent-captain-surface'),
  });
  if (!surface.ok) {
    fail(
      `the installed @sublang/cligent ${installedVersion} does not carry ` +
        (surface.unproven.length > 0
          ? surface.unproven.map((member) => member.id).join(' or ')
          : `${CAPTAIN_SURFACE_SPECIFIER} as the shell imports it`),
      [
        ...surface.unproven.flatMap((member) => [
          `${member.id} — ${member.why}`,
          ...member.diagnostics.map((line) => `  ${line}`),
        ]),
        ...surface.otherDiagnostics,
        `Type-checked against ${surface.specifier} resolved from ${cligentRoot}.`,
        `Fixtures preserved at ${surface.workRoot}.`,
        'The published release the manifest range admits must carry both ' +
          'surfaces before this candidate can ship.',
      ].join('\n'),
    );
  }
  return [
    `nested @sublang/cligent ${installedVersion} satisfies ${declared}`,
    `${surface.specifier} type-checks ${surface.proven.join(' and ')}`,
  ];
}

await main();
