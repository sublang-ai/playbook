// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveConfig, liveModels } from './live-config.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const liveTimeoutMs = positiveIntegerEnv(
  'PLAYBOOK_ACCEPTANCE_TIMEOUT_MS',
  20 * 60_000,
);
const startupTimeoutMs = 90_000;
const pollIntervalMs = 1_000;
const bossHistoryLines = 400;
const launcherTailCharacters = 16 * 1024;
const diagnosticTailCharacters = 8 * 1024;
const liveCommandMaxBufferBytes = 20 * 1024 * 1024;
const liveTerminationGraceMs = 5_000;
const failureSnapshotName = 'acceptance-failure.txt';
// One scenario spends at most five startup-length waits — new session,
// attached client, `boss>`, the started marker, and the pane shape — plus
// the live turn itself. Under-budgeting here is worse than a slow failure:
// vitest's own timeout fires outside the try/finally, so teardown never
// runs and `afterAll` would delete the artifacts while the agents are
// still live.
const scenarioTimeoutMs = liveTimeoutMs + 5 * startupTimeoutMs + 60_000;
const turnFailureMarkers = [
  '[turn aborted]',
  '[runtime error]',
  'workflow failed',
] as const;

const codeCommand =
  '/code Implement the existing ACCEPT-1 requirement exactly. ' +
  'This is one small complete change. Do not broaden the requirement.';
const discussCommand =
  '/discuss Add one minimal packages-layout spec item named ACCEPT-2. ' +
  'It shall require the repository-root file acceptance-discuss.txt to ' +
  'contain exactly DISCUSS_ACCEPTANCE_OK followed by a newline. ' +
  'This run is documentation-only: do not create the implementation file. ' +
  'The specs/map.md index already lists the file, so leave it untouched. ' +
  'Converge quickly and commit only the agreed spec item file.';
const headlessTask = 'Run the installed non-interactive acceptance probe.';
const headlessToken = 'HEADLESS_ACCEPTANCE_OK';
const hermeticTask = 'Echo the hermetic acceptance token.';
const hermeticToken = 'HERMETIC_ACCEPTANCE_OK';

let suiteRoot = '';
let candidateTarball = '';
// The gate runs its tmux-play sessions on a private tmux server so it can
// never bind to, drive, or kill a session the maintainer is using. Both the
// launcher and every tmux command below share this socket directory. It is
// deliberately short and rooted directly at the system temp dir: tmux socket
// paths are bounded by `sockaddr_un` (104 bytes on macOS), which a nested
// path under `suiteRoot` would blow past.
let tmuxSocketDir = '';
let candidateBin = '';
let preserveArtifacts = false;

describe.sequential('installed playbook live acceptance', () => {
  beforeAll(async () => {
    assertLocalPrerequisites();
    suiteRoot = mkdtempSync(join(tmpdir(), 'playbook-live-acceptance-'));
    tmuxSocketDir = mkdtempSync(join(tmpdir(), 'pb-tmux-'));
    try {
      candidateBin = await packAndInstallCandidate(suiteRoot);
    } catch (error) {
      preserveArtifacts = true;
      writeFailureSnapshot(suiteRoot, undefined, undefined, error);
      throw withArtifactPath(error, suiteRoot);
    }
  });

  afterAll(() => {
    if (suiteRoot && !preserveArtifacts) {
      rmSync(suiteRoot, { recursive: true, force: true });
    }
    // Keep the socket directory when artifacts are preserved: a surviving
    // session is still reachable there for diagnosis.
    if (tmuxSocketDir && !preserveArtifacts) {
      rmSync(tmuxSocketDir, { recursive: true, force: true });
    }
  });

  it(
    'runs playbook run with a real Claude player and Codex judge',
    async () => {
      const scenario = createScenario('headless');
      let commandOutput = '';
      try {
        const sessionsBefore = [...listTmuxSessions()].sort();
        const models = liveModels();
        const result = await execLiveTextAsync(
          candidateBin,
          [
            'run',
            './headless.registry.mjs',
            headlessTask,
            '--player',
            `worker=claude:${models.claude}@low`,
            '--captain',
            `codex:${models.codex}@low`,
            '--cwd',
            scenario.repo,
            '--json',
          ],
          scenario.repo,
          privateTmuxEnv({
            XDG_CONFIG_HOME: scenario.configHome,
            XDG_STATE_HOME: join(scenario.root, 'xdg-state'),
          }),
        );
        commandOutput =
          `stdout:\n${diagnosticTail(result.stdout)}\n` +
          `stderr:\n${diagnosticTail(result.stderr)}`;

        const envelope = JSON.parse(result.stdout);
        expect(envelope).toEqual({
          outcome: 'terminal',
          sessionId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
          output: {
            playerToken: headlessToken,
            judge: { accepted: true, token: headlessToken },
          },
        });
        expect(result.stderr).toContain('◇ headless smoke started');
        expect(result.stderr).toContain('◇ headless smoke finished');
        expect([...listTmuxSessions()].sort()).toEqual(sessionsBefore);
        expect(headRevision(scenario.repo)).toBe(scenario.baselineCommit);
        expect(changedPaths(scenario)).toEqual([]);
        expect(gitStatus(scenario.repo)).toBe('');
        expect(ignoredUntracked(scenario.repo)).toBe('');
      } catch (error) {
        preserveArtifacts = true;
        const detailed =
          commandOutput === ''
            ? error
            : new Error(`${errorMessage(error)}\n${commandOutput}`);
        writeFailureSnapshot(
          scenario.root,
          undefined,
          undefined,
          detailed,
          scenario,
        );
        throw withArtifactPath(detailed, scenario.root);
      }
    },
    liveTimeoutMs + 60_000,
  );

  it(
    'provisions and runs a thin artifact from a hermetic global-only install',
    async () => {
      const scenario = createScenario('hermetic');
      let commandOutput = '';
      try {
        const globalBin = await installGlobalCandidate();
        // PBCLI-36 / RELEASE-25: neither engine import resolves from the
        // fixture before the run — the directory is genuinely bare.
        const probe = createRequire(join(scenario.repo, 'probe.js'));
        for (const specifier of [
          'xstate',
          '@sublang/playbook/xstate-runtime',
        ]) {
          expect(() => probe.resolve(specifier)).toThrow();
        }

        const models = liveModels();
        const runArgs = [
          'run',
          './hermetic.playbook.mjs',
          hermeticTask,
          '--player',
          `worker=claude:${models.claude}@low`,
          '--captain',
          `codex:${models.codex}@low`,
          '--cwd',
          scenario.repo,
          '--json',
        ];
        const runEnv = privateTmuxEnv({
          XDG_CONFIG_HOME: scenario.configHome,
          XDG_STATE_HOME: join(scenario.root, 'xdg-state'),
        });
        const first = await execLiveTextAsync(
          globalBin,
          runArgs,
          scenario.repo,
          runEnv,
        );
        commandOutput =
          `stdout:\n${diagnosticTail(first.stdout)}\n` +
          `stderr:\n${diagnosticTail(first.stderr)}`;

        const xstateLink = join(scenario.repo, 'node_modules', 'xstate');
        const playbookLink = join(
          scenario.repo,
          'node_modules',
          '@sublang',
          'playbook',
        );
        expect(first.stderr.match(/provisioned/g)).toHaveLength(1);
        expect(first.stderr).toContain(xstateLink);
        expect(first.stderr).toContain(playbookLink);
        // macOS aliases /var to /private/var. Compare canonical targets so
        // that alias does not make a link inside the isolated prefix appear
        // to escape it; readlinkSync still asserts each entry is a link.
        const prefix = `${realpathSync(join(suiteRoot, 'global'))}${sep}`;
        expect(realpathSync(readlinkSync(xstateLink)).startsWith(prefix)).toBe(
          true,
        );
        expect(realpathSync(readlinkSync(playbookLink)).startsWith(prefix)).toBe(
          true,
        );

        const envelope = JSON.parse(first.stdout);
        expect(envelope).toEqual({
          outcome: 'terminal',
          sessionId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
          output: { token: hermeticToken },
        });
        expect(headRevision(scenario.repo)).toBe(scenario.baselineCommit);
        // The fixture's .gitignore covers node_modules/, so a clean status
        // also proves the provisioned links stay out of player commits.
        expect(gitStatus(scenario.repo)).toBe('');

        const second = await execLiveTextAsync(
          globalBin,
          runArgs,
          scenario.repo,
          runEnv,
        );
        commandOutput +=
          `\nsecond stdout:\n${diagnosticTail(second.stdout)}\n` +
          `second stderr:\n${diagnosticTail(second.stderr)}`;
        expect(second.stderr).not.toContain('provisioned');
        expect(JSON.parse(second.stdout).outcome).toBe('terminal');
      } catch (error) {
        preserveArtifacts = true;
        const detailed =
          commandOutput === ''
            ? error
            : new Error(`${errorMessage(error)}\n${commandOutput}`);
        writeFailureSnapshot(
          scenario.root,
          undefined,
          undefined,
          detailed,
          scenario,
        );
        throw withArtifactPath(detailed, scenario.root);
      }
    },
    2 * liveTimeoutMs + 120_000,
  );

  it(
    'runs /code with real Claude and Codex agents in a fresh repository',
    async () => {
      const scenario = createScenario('code');
      try {
        await drivePlaybookTurn(scenario, codeCommand, {
          started: '◇ /code started',
          finished: '◇ /code finished',
          paneTitles: [
            'Captain · claude',
            'Code-coder · claude',
            'Code-reviewer · codex',
          ],
        });
        expect(
          readFileSync(join(scenario.repo, 'acceptance-code.txt'), 'utf8'),
        ).toBe('CODE_ACCEPTANCE_OK\n');
        expect(headFile(scenario.repo, 'acceptance-code.txt')).toBe(
          'CODE_ACCEPTANCE_OK\n',
        );
        expect(changedPaths(scenario)).toEqual(['acceptance-code.txt']);
        expect(headRevision(scenario.repo)).not.toBe(scenario.baselineCommit);
        expect(gitStatus(scenario.repo)).toBe('');
        expect(ignoredUntracked(scenario.repo)).toBe('');
      } catch (error) {
        preserveArtifacts = true;
        writeFailureSnapshot(
          scenario.root,
          undefined,
          undefined,
          error,
          scenario,
        );
        throw withArtifactPath(error, scenario.root);
      }
    },
    scenarioTimeoutMs,
  );

  it(
    'runs /discuss with real Claude and Codex agents in a fresh repository',
    async () => {
      const scenario = createScenario('discuss');
      try {
        await drivePlaybookTurn(
          scenario,
          discussCommand,
          {
            started: '◇ /discuss started',
            finished: '◇ /discuss finished',
            paneTitles: [
              'Captain · claude',
              'Discuss-host · claude',
              'Discuss-participant · codex',
            ],
          },
        );
        const acceptanceSpec = readFileSync(
          join(scenario.repo, 'specs/packages/acceptance.md'),
          'utf8',
        );
        expect(acceptanceSpec).toContain('### ACCEPT-2');
        expect(acceptanceSpec).toContain('DISCUSS_ACCEPTANCE_OK');
        const headAcceptanceSpec = headFile(
          scenario.repo,
          'specs/packages/acceptance.md',
        );
        expect(headAcceptanceSpec).toContain('### ACCEPT-2');
        expect(headAcceptanceSpec).toContain('DISCUSS_ACCEPTANCE_OK');
        expect(existsSync(join(scenario.repo, 'acceptance-discuss.txt'))).toBe(
          false,
        );
        expect(headHasPath(scenario.repo, 'acceptance-discuss.txt')).toBe(false);
        expect(changedPaths(scenario)).toEqual([
          'specs/packages/acceptance.md',
        ]);
        expect(headRevision(scenario.repo)).not.toBe(scenario.baselineCommit);
        expect(gitStatus(scenario.repo)).toBe('');
        expect(ignoredUntracked(scenario.repo)).toBe('');
      } catch (error) {
        preserveArtifacts = true;
        writeFailureSnapshot(
          scenario.root,
          undefined,
          undefined,
          error,
          scenario,
        );
        throw withArtifactPath(error, scenario.root);
      }
    },
    scenarioTimeoutMs,
  );
});

interface Scenario {
  root: string;
  repo: string;
  configHome: string;
  baselineCommit: string;
}

interface TurnExpectation {
  started: string;
  finished: string;
  paneTitles: readonly string[];
}

interface Launcher {
  child: ChildProcessWithoutNullStreams;
  output(): string;
  exit(): { code: number | null; signal: NodeJS.Signals | null } | undefined;
}

function assertLocalPrerequisites(): void {
  for (const [command, args] of [
    ['git', ['--version']],
    ['glow', ['--version']],
    ['npm', ['--version']],
    ['tmux', ['-V']],
    ['expect', ['-v']],
  ] as const) {
    try {
      execText(command, args);
    } catch (error) {
      throw new Error(
        `live acceptance requires ${command} on PATH: ${errorMessage(error)}`,
      );
    }
  }

  const home = process.env.HOME ?? homedir();
  const missingAuth = [
    !process.env.ANTHROPIC_API_KEY && !existsSync(join(home, '.claude'))
      ? 'Claude (run Claude Code once or set ANTHROPIC_API_KEY)'
      : undefined,
    !process.env.OPENAI_API_KEY && !existsSync(join(home, '.codex'))
      ? 'Codex (run Codex once or set OPENAI_API_KEY)'
      : undefined,
  ].filter((value): value is string => value !== undefined);
  if (missingAuth.length > 0) {
    throw new Error(
      `live acceptance requires local authentication for: ${missingAuth.join(
        ', ',
      )}`,
    );
  }
}

async function packAndInstallCandidate(root: string): Promise<string> {
  const installRoot = join(root, 'candidate');
  mkdirSync(installRoot, { recursive: true });
  console.info('[acceptance] packing and installing the release candidate');

  const packOutput = await execTextAsync(
    'npm',
    ['pack', '--json', '--pack-destination', installRoot],
    repoRoot,
  );
  const packResult = JSON.parse(packOutput) as Array<{ filename?: string }>;
  const filename = packResult[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack did not report a tarball: ${packOutput}`);
  }
  const tarball = join(installRoot, filename);
  candidateTarball = tarball;

  writeFileSync(
    join(installRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'playbook-live-acceptance-consumer',
        version: '0.0.0',
        private: true,
      },
      null,
      2,
    )}\n`,
  );
  await execTextAsync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--prefer-offline',
      tarball,
    ],
    installRoot,
  );

  const installedBin = join(
    installRoot,
    'node_modules/.bin/playbook',
  );
  if (!existsSync(installedBin)) {
    throw new Error(`installed playbook command is missing: ${installedBin}`);
  }
  return installedBin;
}

// RELEASE-25 fourth case: install the same packed candidate globally into
// an isolated npm prefix. Inherited prefix configuration is neutralized so
// a version manager's npm_config_prefix cannot leak the maintainer's real
// global root into the gate, and the nested-cligent guard below fails
// loudly if a machine-global standalone @sublang/cligent shadows the copy
// nested under the prefix's @sublang/playbook.
async function installGlobalCandidate(): Promise<string> {
  const prefix = join(suiteRoot, 'global');
  mkdirSync(prefix, { recursive: true });
  console.info('[acceptance] installing the candidate into a global prefix');
  const env = { ...process.env };
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  await execTextAsync(
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
      candidateTarball,
    ],
    suiteRoot,
    env,
  );
  const installedPlaybook = join(
    prefix,
    'lib/node_modules/@sublang/playbook',
  );
  const nestedCligent = join(
    installedPlaybook,
    'node_modules/@sublang/cligent',
  );
  if (!existsSync(nestedCligent)) {
    throw new Error(
      `@sublang/cligent did not install nested under ${installedPlaybook}`,
    );
  }
  const globalBin = join(prefix, 'bin/playbook');
  if (!existsSync(globalBin)) {
    throw new Error(`global playbook command is missing: ${globalBin}`);
  }
  return globalBin;
}

function createScenario(
  name: 'headless' | 'code' | 'discuss' | 'hermetic',
): Scenario {
  // Every fixture path derives from `suiteRoot`. A relative value here would
  // silently build the fixture tree inside the real repository instead.
  if (!isAbsolute(suiteRoot)) {
    throw new Error(
      `live acceptance suite root must be an absolute path, got "${suiteRoot}"`,
    );
  }
  // PBCLI-36: the headless fixture nests under the candidate consumer tree
  // so its registry module resolves the engine from an ancestor
  // node_modules — the project-local-install-wins path — and the run
  // provisions nothing, keeping the repository byte-clean. The hermetic
  // fixture stays outside every node_modules ancestry on purpose.
  const root =
    name === 'headless'
      ? join(suiteRoot, 'candidate', 'fixtures', name)
      : join(suiteRoot, name);
  const repo = join(root, 'repo');
  const configHome = join(root, 'xdg');
  mkdirSync(join(repo, 'specs/packages'), { recursive: true });
  mkdirSync(join(configHome, 'playbook'), { recursive: true });

  writeFileSync(
    join(repo, 'AGENTS.md'),
    [
      '# Repository instructions',
      '',
      'Before changing specifications, read specs/map.md and specs/meta.md.',
      'Keep changes scoped to the Boss request.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repo, 'README.md'),
    '# Live acceptance fixture\n\nA fresh repository for playbook release verification.\n',
  );
  writeFileSync(
    join(repo, 'specs/meta.md'),
    [
      '# Specification format',
      '',
      'Specification item files live under `specs/packages/`.',
      'Each requirement is headed by `### <PACKAGE>-<number>` and uses',
      'normative “shall” language. Keep items minimal and',
      'implementation-neutral.',
      '`specs/map.md` indexes every specification item file.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repo, 'specs/map.md'),
    [
      '# Spec map',
      '',
      '| Package | File | Summary |',
      '| --- | --- | --- |',
      '| ACCEPT | [acceptance.md](packages/acceptance.md) | Live acceptance fixture requirements |',
      '| GIT | [git.md](packages/git.md) | Commit conventions |',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repo, 'specs/packages/acceptance.md'),
    [
      '# ACCEPT: Live acceptance fixture',
      '',
      '### ACCEPT-1',
      '',
      'The repository root shall contain `acceptance-code.txt` whose entire',
      'content is `CODE_ACCEPTANCE_OK` followed by one newline.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repo, 'specs/packages/git.md'),
    [
      '# GIT: Commit conventions',
      '',
      '### GIT-1',
      '',
      'Each commit shall have a concise imperative subject.',
      '',
      '### GIT-2',
      '',
      'An agent-authored commit shall append a `Co-authored-by` trailer using',
      'the agent model as the name and `cligent@sublang.xyz` as the email.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(configHome, 'playbook/playbook.config.yaml'),
    liveConfig(),
  );
  if (name === 'headless') {
    writeFileSync(
      join(repo, 'acceptance-headless-token.txt'),
      `${headlessToken}\n`,
    );
    writeFileSync(
      join(repo, 'headless.registry.mjs'),
      headlessRegistrySource(),
    );
  }
  if (name === 'hermetic') {
    // The documented practice for artifact repositories: ignore the
    // provisioned engine links so player commits never carry them.
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(
      join(repo, 'acceptance-hermetic-token.txt'),
      `${hermeticToken}\n`,
    );
    writeFileSync(
      join(repo, 'hermetic.playbook.mjs'),
      hermeticArtifactSource(),
    );
  }

  execText('git', ['init', '-b', 'main'], repo);
  execText('git', ['config', 'user.name', 'Playbook Acceptance'], repo);
  execText(
    'git',
    ['config', 'user.email', 'acceptance@sublang.invalid'],
    repo,
  );
  execText('git', ['config', 'commit.gpgsign', 'false'], repo);
  execText('git', ['add', '.'], repo);
  execText('git', ['commit', '-m', 'Initialize acceptance fixture'], repo);
  const baselineCommit = headRevision(repo);
  return { root, repo, configHome, baselineCommit };
}

async function drivePlaybookTurn(
  scenario: Scenario,
  command: string,
  expectation: TurnExpectation,
): Promise<void> {
  const sessionsBefore = new Set(listTmuxSessions());
  const launcher = spawnLauncher(scenario);
  let sessionName: string | undefined;
  try {
    sessionName = await waitForNewSession(sessionsBefore, launcher);
    const target = `${sessionName}:0.0`;
    await waitForAttachedClient(sessionName, startupTimeoutMs, launcher);
    await waitForPaneText(target, 'boss>', startupTimeoutMs, launcher);
    console.info(`[acceptance] ${scenario.root.split('/').at(-1)}: ${command}`);
    tmuxText(['send-keys', '-t', target, '-l', command]);
    tmuxText(['send-keys', '-t', target, 'Enter']);
    await waitForPaneText(
      target,
      expectation.started,
      startupTimeoutMs,
      launcher,
      turnFailureMarkers,
    );
    await waitForPaneShape(
      sessionName,
      expectation.paneTitles,
      startupTimeoutMs,
      launcher,
    );
    await waitForPaneText(
      target,
      expectation.finished,
      liveTimeoutMs,
      launcher,
      turnFailureMarkers,
    );
    console.info(
      `[acceptance] ${scenario.root.split('/').at(-1)}: ${expectation.finished}`,
    );
  } catch (error) {
    writeFailureSnapshot(
      scenario.root,
      sessionName,
      launcher,
      error,
      scenario,
    );
    throw error;
  } finally {
    if (sessionName && listTmuxSessions().includes(sessionName)) {
      try {
        tmuxText(['kill-session', '-t', sessionName]);
      } catch {
        // Preserve the original test failure; launcher termination below is
        // the remaining best-effort cleanup.
      }
    }
    await stopLauncher(launcher);
  }
}

function spawnLauncher(scenario: Scenario): Launcher {
  // Keep the launched session on the gate's private tmux server, so it is
  // the only session this run can see, drive, or kill.
  const env = privateTmuxEnv({
    XDG_CONFIG_HOME: scenario.configHome,
    PLAYBOOK_ACCEPTANCE_BIN: candidateBin,
    PLAYBOOK_ACCEPTANCE_REPO: scenario.repo,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  });

  const expectScript = [
    'set stty_init "rows 49 columns 174"',
    'set timeout -1',
    'log_user 1',
    'spawn -noecho $env(PLAYBOOK_ACCEPTANCE_BIN) --cwd $env(PLAYBOOK_ACCEPTANCE_REPO)',
    'expect eof',
  ].join('\n');
  const child = spawn('expect', ['-c', expectScript], {
    cwd: scenario.repo,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exit:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = appendTail(stdout, chunk.toString());
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = appendTail(stderr, chunk.toString());
  });
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });
  return {
    child,
    output: () =>
      `stdout:\n${diagnosticTail(stdout)}\n` +
      `stderr:\n${diagnosticTail(stderr)}`,
    exit: () => exit,
  };
}

async function waitForNewSession(
  previous: Set<string>,
  launcher: Launcher,
): Promise<string> {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const added = listTmuxSessions().filter(
      (name) => name.startsWith('tmux-play-') && !previous.has(name),
    );
    if (added.length === 1) return added[0];
    if (added.length > 1) {
      throw new Error(
        `launcher created multiple tmux sessions: ${added.join(', ')}`,
      );
    }
    const exit = launcher.exit();
    if (exit) {
      throw new Error(
        `playbook launcher exited before creating a tmux session ` +
          `(code=${String(exit.code)}, signal=${String(exit.signal)})\n` +
          launcher.output(),
      );
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `timed out waiting for a new tmux-play session\n${launcher.output()}`,
  );
}

async function waitForAttachedClient(
  sessionName: string,
  timeoutMs: number,
  launcher: Launcher,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const clients = tmuxText([
        'list-clients',
        '-t',
        sessionName,
        '-F',
        '#{client_name}',
      ]);
      if (clients !== '') return;
    } catch {
      // tmux exits nonzero while the newly created session has no client.
    }
    const exit = launcher.exit();
    if (exit) {
      throw new Error(
        `playbook launcher exited before attaching a tmux client ` +
          `(code=${String(exit.code)}, signal=${String(exit.signal)})\n` +
          launcher.output(),
      );
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `timed out waiting for an attached tmux client\n${launcher.output()}`,
  );
}

async function waitForPaneText(
  target: string,
  expected: string,
  timeoutMs: number,
  launcher: Launcher,
  failureMarkers: readonly string[] = [],
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastPane = '';
  let nextProgressAt = startedAt + 60_000;
  while (Date.now() < deadline) {
    try {
      lastPane = capturePane(target);
    } catch (error) {
      throw new Error(
        `tmux session ended while waiting for ${JSON.stringify(expected)}: ` +
          `${errorMessage(error)}\n${launcher.output()}\nLast Boss pane:\n` +
          diagnosticTail(lastPane),
      );
    }
    if (paneContains(lastPane, expected)) return;
    for (const marker of failureMarkers) {
      if (paneContains(lastPane, marker)) {
        throw new Error(
          `playbook turn failed while waiting for ${JSON.stringify(expected)}; ` +
            `Boss pane contains ${JSON.stringify(marker)}\n` +
            `${launcher.output()}\nLast Boss pane:\n${diagnosticTail(lastPane)}`,
        );
      }
    }
    const exit = launcher.exit();
    if (exit) {
      throw new Error(
        `playbook launcher exited while waiting for ${JSON.stringify(expected)} ` +
          `(code=${String(exit.code)}, signal=${String(exit.signal)})\n` +
          `${launcher.output()}\nLast Boss pane:\n${diagnosticTail(lastPane)}`,
      );
    }
    if (Date.now() >= nextProgressAt) {
      console.info(
        `[acceptance] waiting for ${expected} ` +
          `(${Math.floor((Date.now() - startedAt) / 1_000)}s)`,
      );
      nextProgressAt += 60_000;
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `timed out waiting for ${JSON.stringify(expected)}\n` +
      `${launcher.output()}\nLast Boss pane:\n${diagnosticTail(lastPane)}`,
  );
}

async function waitForPaneShape(
  sessionName: string,
  expectedTitles: readonly string[],
  timeoutMs: number,
  launcher: Launcher,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastShape = '';
  while (Date.now() < deadline) {
    try {
      lastShape = tmuxText([
        'list-panes',
        '-t',
        `${sessionName}:0`,
        '-F',
        '#{pane_index}|#{pane_title}|#{pane_active}',
      ]);
      const panes = lastShape.split('\n').filter(Boolean);
      const titles = panes.map((pane) => pane.split('|')[1]).sort();
      const boss = panes.find((pane) => pane.startsWith('0|'));
      if (
        panes.length === expectedTitles.length &&
        titles.join('\n') === [...expectedTitles].sort().join('\n') &&
        boss?.endsWith('|1') === true
      ) {
        return;
      }
    } catch {
      // Visibility changes rebuild the player panes; retry until stable.
    }
    const exit = launcher.exit();
    if (exit) {
      throw new Error(
        `playbook launcher exited while waiting for the selected pane layout ` +
          `(code=${String(exit.code)}, signal=${String(exit.signal)})\n` +
          `${launcher.output()}\nLast pane shape:\n${lastShape}`,
      );
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `timed out waiting for pane titles ${expectedTitles.join(', ')} ` +
      `with the Boss pane focused\n${launcher.output()}\n` +
      `Last pane shape:\n${lastShape}`,
  );
}

async function stopLauncher(launcher: Launcher): Promise<void> {
  if (launcher.child.exitCode !== null || launcher.child.signalCode !== null) {
    return;
  }
  launcher.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) => {
      launcher.child.once('exit', () => resolveExit(true));
    }),
    delay(5_000).then(() => false),
  ]);
  if (!exited) launcher.child.kill('SIGKILL');
}

function listTmuxSessions(): string[] {
  try {
    return tmuxText(['list-sessions', '-F', '#{session_name}'])
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    const message = errorMessage(error);
    if (
      message.includes('no server running') ||
      message.includes('failed to connect to server') ||
      (message.includes('error connecting to') &&
        message.includes('No such file or directory'))
    ) {
      return [];
    }
    throw error;
  }
}

function headRevision(repo: string): string {
  return execText('git', ['rev-parse', 'HEAD'], repo);
}

function gitStatus(repo: string): string {
  return execText(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    repo,
  );
}

function ignoredUntracked(repo: string): string {
  return execText(
    'git',
    ['ls-files', '--others', '--ignored', '--exclude-standard'],
    repo,
  );
}

function changedPaths(scenario: Scenario): string[] {
  const output = execText(
    'git',
    ['diff', '--name-only', `${scenario.baselineCommit}..HEAD`],
    scenario.repo,
  );
  return output === '' ? [] : output.split('\n').sort();
}

function headFile(repo: string, path: string): string {
  return execRaw('git', ['show', `HEAD:${path}`], repo);
}

function headHasPath(repo: string, path: string): boolean {
  try {
    execText('git', ['cat-file', '-e', `HEAD:${path}`], repo);
    return true;
  } catch {
    return false;
  }
}

// Point a process at the gate's private tmux server under `tmuxSocketDir`.
// Clearing `TMUX` and `TMUX_PANE` is load-bearing, not hygiene: when the
// gate itself is run from inside tmux, an inherited `TMUX` names the
// caller's socket and takes precedence over `TMUX_TMPDIR`, so commands
// would reach the maintainer's server and could drive or kill their
// session. Every tmux invocation and the launcher share this one recipe so
// the two cannot drift apart.
function privateTmuxEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...overrides,
    TMUX_TMPDIR: tmuxSocketDir,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

function tmuxText(args: readonly string[]): string {
  return execFileSync('tmux', [...args], {
    env: privateTmuxEnv(),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function execText(
  command: string,
  args: readonly string[],
  cwd?: string,
): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function execRaw(
  command: string,
  args: readonly string[],
  cwd?: string,
): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function execTextAsync(
  command: string,
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        ...(env ? { env } : {}),
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stderr });
          rejectCommand(error);
          return;
        }
        resolveCommand(stdout.trimEnd());
      },
    );
  });
}

function execLiveTextAsync(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveCommand, rejectCommand) => {
    // A detached child is a new POSIX process group. That lets timeout
    // cleanup reach adapter subprocesses as well as the installed CLI.
    const child = spawn(command, [...args], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let stopReason: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group may already be gone; fall back to the direct child for
        // spawn failures and platforms that reject negative process ids.
        child.kill(signal);
      }
    };
    const clearTimers = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    const failure = (reason: string): Error =>
      new Error(
        `installed playbook run failed: ${reason}\n` +
          `stdout:\n${diagnosticTail(stdout)}\n` +
          `stderr:\n${diagnosticTail(stderr)}`,
      );
    const rejectOnce = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      rejectCommand(failure(reason));
    };
    const stop = (reason: string): void => {
      if (settled || stopReason !== undefined) return;
      stopReason = reason;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        rejectOnce(reason);
      }, liveTerminationGraceMs);
    };
    const collect = (stream: 'stdout' | 'stderr', chunk: string): void => {
      outputBytes += Buffer.byteLength(chunk);
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (outputBytes > liveCommandMaxBufferBytes) {
        stop(`output exceeded ${liveCommandMaxBufferBytes} bytes`);
      }
    };
    const timeoutTimer = setTimeout(
      () => stop(`timed out after ${liveTimeoutMs}ms`),
      liveTimeoutMs,
    );

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: string) => collect('stderr', chunk));
    child.once('error', (error) => rejectOnce(error.message));
    child.once('close', (code, signal) => {
      // Once the CLI closes, nothing it started should outlive this smoke
      // case. This is a no-op when the process group drained normally.
      signalGroup('SIGKILL');
      if (stopReason !== undefined) {
        rejectOnce(stopReason);
        return;
      }
      if (code !== 0) {
        rejectOnce(
          `exited with code ${String(code)} and signal ${String(signal)}`,
        );
        return;
      }
      if (settled) return;
      settled = true;
      clearTimers();
      resolveCommand({ stdout, stderr });
    });
  });
}

// RELEASE-25 fourth case: a compiled-style thin artifact whose bare
// `xstate` and `@sublang/playbook/xstate-runtime` imports resolve only
// through provisioning. One player state, deterministic START entry (no
// classifier call), one hidden judge adjudication, machine output in the
// terminal envelope.
function hermeticArtifactSource(): string {
  return `// Hermetic acceptance fixture: a compiled-style thin artifact.
import { assign, fromPromise, setup } from 'xstate';
import { createXStatePlaybookRuntime } from '@sublang/playbook/xstate-runtime';

const machine = setup({
  actors: {
    player: fromPromise(async () => {
      throw new Error('player actor must be provided by the runner');
    }),
  },
}).createMachine({
  id: 'hermetic',
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
      description: 'HERMETIC-1: Worker echoes the fixture token.',
      meta: {
        playbook: {
          stateId: 'work',
          description: 'HERMETIC-1: Worker echoes the fixture token.',
        },
      },
      tags: ['playbook.busy'],
      invoke: {
        src: 'player',
        input: ({ context }) => ({
          stateId: 'work',
          player: 'Worker',
          sourceItem: 'HERMETIC-1',
          prompt: [
            'Read acceptance-hermetic-token.txt in the working directory and',
            'reply with exactly its trimmed content. Do not modify any file.',
            \`Task context: \${context.task}\`,
          ].join('\\n'),
          result: {
            done: 'Worker replied with the token. Output shall include \`token: <the exact token text>\`.',
          },
        }),
        onDone: {
          target: 'done',
          actions: assign({ token: ({ event }) => event.output.token }),
        },
        onError: {
          target: 'failed',
          actions: assign({
            lastError: ({ event }) => String(event.error),
          }),
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
      description: 'The token was echoed.',
      meta: {
        playbook: { stateId: 'done', description: 'The token was echoed.' },
      },
      type: 'final',
    },
  },
  output: ({ context }) => ({ token: context.token ?? '' }),
});

const createRuntime = createXStatePlaybookRuntime(machine, {
  label: 'HERMETIC',
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'task' },
});

export default {
  id: 'hermetic',
  command: 'hermetic',
  intent: 'hermetic global-only acceptance fixture',
  requiredRoleIds: ['worker'],
  validateOptions(value) {
    return value ?? {};
  },
  createRuntime() {
    return createRuntime({});
  },
};
`;
}

function headlessRegistrySource(): string {
  return [
    `const expectedTask = ${JSON.stringify(headlessTask)};`,
    `const expectedToken = ${JSON.stringify(headlessToken)};`,
    '',
    'export default {',
    "  id: 'headless-smoke',",
    "  command: 'headless-smoke',",
    "  intent: 'verify the installed non-interactive host with real agents',",
    "  requiredRoleIds: ['worker'],",
    '  validateOptions(options) {',
    '    return options ?? {};',
    '  },',
    '  createRuntime() {',
    '    let ports;',
    '    return {',
    '      async init(session) {',
    '        ports = session.ports;',
    '      },',
    '      async handleBossInput({ text, signal }) {',
    '        if (text !== expectedTask) throw new Error("headless task changed");',
    "        await ports.emitStatus('headless smoke started');",
    '        const player = await ports.callPlayer(',
    "          'worker',",
    '          [',
    "            'Read acceptance-headless-token.txt from the working directory using your tools.',",
    "            'Do not modify any file.',",
    "            'Return exactly the file token with no prose or Markdown.',",
    "          ].join('\\n'),",
    '          signal,',
    '          { resume: false },',
    '        );',
    "        if (player.status !== 'ok' || typeof player.finalText !== 'string') {",
    "          throw new Error(player.error ?? 'headless player call failed');",
    '        }',
    '        const playerToken = player.finalText.trim();',
    '        if (playerToken !== expectedToken) {',
    '          throw new Error(`unexpected player token: ${JSON.stringify(playerToken)}`);',
    '        }',
    '        const judged = await ports.callJudge(',
    '          [',
    "            'Return exactly one JSON object with keys accepted and token.',",
    "            'Set accepted to true and token to the expected token only when the player output matches it exactly.',",
    '            `Expected token: ${JSON.stringify(expectedToken)}`,',
    '            `Player output: ${JSON.stringify(playerToken)}`,',
    "          ].join('\\n'),",
    '          signal,',
    '        );',
    '        const decision = JSON.parse(judged);',
    '        if (',
    '          decision.accepted !== true ||',
    '          decision.token !== expectedToken ||',
    "          Object.keys(decision).sort().join(',') !== 'accepted,token'",
    '        ) {',
    '          throw new Error(`unexpected judge decision: ${judged}`);',
    '        }',
    "        await ports.emitStatus('headless smoke finished');",
    '        return {',
    "          outcome: 'terminal',",
    '          state: {',
    "            value: 'done',",
    '            activeStateIds: [],',
    '            tags: [],',
    "            status: 'done',",
    '            quiescent: true,',
    '          },',
    '          output: { playerToken, judge: decision },',
    '        };',
    '      },',
    '      async resumePlaybookCall() {',
    '        throw new Error("headless smoke cannot resume a nested call");',
    '      },',
    '      async dispose() {},',
    '    };',
    '  },',
    '};',
    '',
  ].join('\n');
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

function withArtifactPath(error: unknown, path: string): Error {
  if (error instanceof Error) {
    error.message =
      `${error.message}\nAcceptance artifacts preserved at ${path}`;
    return error;
  }
  return new Error(
    `${String(error)}\nAcceptance artifacts preserved at ${path}`,
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as Error & { stderr?: Buffer | string }).stderr;
    const detail = stderr?.toString().trim();
    return detail ? `${error.message}\n${detail}` : error.message;
  }
  return String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function appendTail(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= launcherTailCharacters
    ? combined
    : combined.slice(combined.length - launcherTailCharacters);
}

function paneContains(pane: string, expected: string): boolean {
  return (
    pane.includes(expected) ||
    pane.replace(/\s+/g, ' ').includes(expected) ||
    pane.replace(/\s+/g, '').includes(expected.replace(/\s+/g, ''))
  );
}

function capturePane(target: string): string {
  return tmuxText([
    'capture-pane',
    '-p',
    '-S',
    `-${bossHistoryLines}`,
    '-t',
    target,
  ]);
}

function diagnosticTail(value: string): string {
  const stripped = stripVTControlCharacters(value).replace(/\r/g, '');
  return stripped.length <= diagnosticTailCharacters
    ? stripped
    : stripped.slice(stripped.length - diagnosticTailCharacters);
}

function writeFailureSnapshot(
  root: string,
  sessionName: string | undefined,
  launcher: Launcher | undefined,
  error: unknown,
  scenario?: Scenario,
): void {
  const snapshotPath = join(root, failureSnapshotName);
  if (existsSync(snapshotPath)) return;

  const sections = [
    `Error:\n${diagnosticTail(errorMessage(error))}`,
    launcher ? `Launcher:\n${launcher.output()}` : undefined,
  ];
  if (sessionName !== undefined) {
    try {
      sections.push(
        `Boss pane:\n${diagnosticTail(
          capturePane(`${sessionName}:0.0`),
        )}`,
      );
    } catch (captureError) {
      sections.push(
        `Boss pane capture failed:\n${diagnosticTail(
          errorMessage(captureError),
        )}`,
      );
    }
    try {
      sections.push(
        `Pane shape:\n${tmuxText([
          'list-panes',
          '-t',
          `${sessionName}:0`,
          '-F',
          '#{pane_index}|#{pane_title}|#{pane_active}',
        ])}`,
      );
    } catch (shapeError) {
      sections.push(
        `Pane shape capture failed:\n${diagnosticTail(
          errorMessage(shapeError),
        )}`,
      );
    }
  }
  if (scenario !== undefined) {
    try {
      sections.push(
        [
          'Repository:',
          execText('git', ['log', '--oneline', '-3'], scenario.repo),
          execText(
            'git',
            ['status', '--porcelain', '--untracked-files=all'],
            scenario.repo,
          ),
          execText(
            'git',
            [
              'diff',
              '--stat',
              `${scenario.baselineCommit}..HEAD`,
            ],
            scenario.repo,
          ),
        ].join('\n'),
      );
    } catch (repositoryError) {
      sections.push(
        `Repository capture failed:\n${diagnosticTail(
          errorMessage(repositoryError),
        )}`,
      );
    }
  }

  try {
    writeFileSync(
      snapshotPath,
      `${sections.filter((section) => section !== undefined).join('\n\n')}\n`,
    );
  } catch {
    // A diagnostic write must never replace the acceptance failure.
  }
}
