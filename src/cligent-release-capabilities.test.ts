// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// RELEASE-29: mutation-sensitive coverage for the complete cligent release
// capability guard. Each fixture removes or narrows one public capability;
// the guard must go red and name the boundary Playbook would lose.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { checkCligentReleaseCapabilities } from '../scripts/cligent-release-capabilities.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'cligent-surface-'));
  roots.push(root);
  return root;
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

interface FixtureShape {
  readonly emitReply?: string;
  readonly resumeToken?: string;
  readonly captainErrorCode?: string;
  readonly playerErrorCode?: string;
  readonly prepareDispose?: string;
  readonly callPlayer?: string;
  readonly callCaptain?: string;
  readonly tuningSelection?: string;
  readonly settingsModel?: string;
  readonly settingsEffort?: string;
  readonly settingsFastMode?: string;
  readonly rootEffort?: string;
  readonly rootPermissionPolicy?: string;
  readonly settingsInstruction?: string;
  readonly settingsPermissions?: string;
  readonly playerSettings?: string;
  readonly captainSettings?: string;
  readonly playerResume?: string;
  readonly captainResume?: string;
  readonly captainAllowedTools?: string;
  readonly settingsError?: string;
  readonly settingsPredicate?: string;
  readonly fastModeAssertion?: string;
  readonly fastModeAssertionRuntime?: boolean;
  readonly fastModeAssertionSemantics?: boolean;
  readonly launchManagedSignature?: string;
  readonly runManagedSignature?: string;
  readonly launchManagedRuntime?: boolean;
  readonly runManagedRuntime?: boolean;
  readonly launchWorkDirOwnership?: string;
  readonly sessionWorkDirOwnership?: string;
  readonly attachSignal?: string;
  readonly attachCallback?: string;
  readonly attachSignature?: string;
  readonly segmentedPlayerIds?: boolean;
  readonly emptyRosterConfig?: boolean;
  readonly emptyRosterRuntime?: boolean;
}

// A minimal stand-in for the published package: the same `exports` map entry
// the shell resolves, the same interface names, and — as in the real package —
// unrelated declarations that also spell `resumeToken` and `emitReply`, which
// is what made the substring scan unfalsifiable.
function fixtureCligent(root: string, shape: FixtureShape = {}): string {
  const {
    emitReply = 'emitReply(text: string): Promise<void>;',
    resumeToken = 'readonly resumeToken?: string;',
    captainErrorCode = "readonly errorCode?: 'SESSION_RESUME_REJECTED';",
    playerErrorCode = "readonly errorCode?: 'SESSION_RESUME_REJECTED';",
    prepareDispose = 'prepareDispose?(): Promise<void>;',
    callPlayer =
      'callPlayer(playerId: string, prompt: string, options?: CallPlayerOptions): Promise<unknown>;',
    callCaptain =
      'callCaptain(prompt: string, options?: CallCaptainOptions): Promise<CaptainRunResult>;',
    tuningSelection = `export type TuningSelection<T extends string = string> =
      | { readonly kind: 'value'; readonly value: T }
      | { readonly kind: 'provider-default' };`,
    settingsModel = 'readonly model: TuningSelection;',
    settingsEffort = 'readonly effort: TuningSelection<Effort>;',
    settingsFastMode = 'readonly fastMode?: boolean;',
    rootEffort = `export type Effort =
      | 'off' | 'on'
      | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      | 'ultra' | 'ultracode';`,
    rootPermissionPolicy = `export interface PermissionPolicy {
      mode?: 'auto' | 'bypass';
      fileWrite?: 'allow' | 'ask' | 'deny';
      shellExecute?: 'allow' | 'ask' | 'deny';
      networkAccess?: 'allow' | 'ask' | 'deny';
      writablePaths?: string[];
    }`,
    settingsInstruction = 'readonly instruction?: string;',
    settingsPermissions = 'readonly permissions?: PermissionPolicy;',
    playerSettings = 'readonly settings?: AgentCallSettings;',
    captainSettings = 'readonly settings?: AgentCallSettings;',
    playerResume = 'readonly resume?: string | false;',
    captainResume = 'readonly resume?: string | false;',
    captainAllowedTools = 'readonly allowedTools?: readonly string[];',
    settingsError = `export declare class AgentCallSettingsError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown);
}`,
    settingsPredicate =
      'export declare function isAgentCallSettingsError(error: unknown): error is AgentCallSettingsError;',
    fastModeAssertion =
      "export declare function assertFastModeSupported(agent: AgentType | 'claude', path?: string): void;",
    fastModeAssertionRuntime = true,
    fastModeAssertionSemantics = true,
    launchManagedSignature =
      'export declare function launchManagedTmuxPlay(options: LaunchManagedTmuxPlayOptions): Promise<PreparedManagedTmuxPlayLaunch>;',
    runManagedSignature =
      'export declare function runManagedTmuxPlaySession(options: ManagedTmuxPlaySessionOptions): Promise<void>;',
    launchManagedRuntime = true,
    runManagedRuntime = true,
    launchWorkDirOwnership =
      'readonly workDirOwnedByLauncher: boolean;',
    sessionWorkDirOwnership =
      'readonly workDirOwnedByLauncher: boolean;',
    attachSignal = 'readonly signal?: AbortSignal;',
    attachCallback = 'readonly beforeNativeAttach?: () => void;',
    attachSignature =
      'attach(options?: ManagedTmuxPlayAttachOptions): Promise<void>;',
    segmentedPlayerIds = true,
    emptyRosterConfig = true,
    emptyRosterRuntime = true,
  } = shape;
  const packageRoot = join(root, 'cligent');
  write(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: '@sublang/cligent',
        version: '0.19.0',
        type: 'module',
        exports: {
          '.': {
            import: './dist/index.js',
            types: './dist/index.d.ts',
          },
          './tmux-play': {
            import: './dist/app/tmux-play/index.js',
            types: './dist/app/tmux-play/index.d.ts',
          },
        },
      },
      undefined,
      2,
    )}\n`,
  );
  const tmuxPlay = join(packageRoot, 'dist', 'app', 'tmux-play');
  write(
    join(packageRoot, 'dist', 'index.js'),
    fastModeAssertionRuntime
      ? `export const FAST_MODE_SUPPORT = Object.freeze({
  'claude-code': Object.freeze({ requestSupported: true }),
  codex: Object.freeze({ requestSupported: true }),
  gemini: Object.freeze({ requestSupported: false }),
});
export function assertFastModeSupported(agent, path = 'fastMode') {
  ${
    fastModeAssertionSemantics
      ? `const canonical = agent === 'claude' ? 'claude-code' : agent;
  if (FAST_MODE_SUPPORT[canonical]?.requestSupported !== true) {
    throw new Error(path + ' is not supported for adapter ' + agent);
  }`
      : ''
  }
}
`
      : 'export {};\n',
  );
  write(
    join(packageRoot, 'dist', 'index.d.ts'),
    `export type { Effort, PermissionPolicy } from './app/tmux-play/contract.js';
export type AgentType = 'claude-code' | 'codex' | 'gemini' | 'kimi' | 'opencode';
${fastModeAssertion}
`,
  );
  write(
    join(tmuxPlay, 'index.js'),
    `import { readFileSync } from 'node:fs';
export async function loadTmuxPlayConfig({ configPath }) {
  const text = readFileSync(configPath, 'utf8');
  if (/^\\s*players:\\s*\\[\\s*\\]\\s*$/m.test(text)) {
    ${emptyRosterConfig ? '' : "throw new Error('empty player roster is unsupported');"}
    return {
      path: configPath,
      config: {
        captain: {
          from: '@sublang/cligent/captains/fanout',
          adapter: 'claude',
          options: {},
        },
        players: [],
        layout: { initialVisible: [], columnWeights: [1] },
      },
    };
  }
  const id = /- id:\\s*([^\\s]+)/.exec(text)?.[1];
  if (!id) throw new Error('fixture config has no player id');
  ${segmentedPlayerIds ? '' : "if (id.includes('.')) throw new Error('invalid player id');"}
  return {
    path: configPath,
    config: {
      captain: {
        from: '@sublang/cligent/captains/fanout',
        adapter: 'claude',
        options: {},
      },
      players: [{ id }],
      layout: { initialVisible: [id], columnWeights: [1, 1] },
    },
  };
}
export async function createTmuxPlayRuntime({ captain, players }) {
  ${emptyRosterRuntime ? '' : "if (players.length === 0) throw new Error('empty runtime roster is unsupported');"}
  const session = {
    signal: new AbortController().signal,
    players,
    async emitStatus() {},
    async emitTelemetry() {},
    async setVisiblePlayers(ids) {
      if (players.length !== 0 || ids.length !== 0) {
        throw new Error('fixture only supports empty visibility');
      }
    },
  };
  await captain.init?.(session);
  return { async dispose() {} };
}
${
  launchManagedRuntime
    ? `export async function launchManagedTmuxPlay() {
  throw new Error('fixture managed launch must not run');
}`
    : ''
}
${
  runManagedRuntime
    ? `export async function runManagedTmuxPlaySession() {
  throw new Error('fixture managed session must not run');
}`
    : ''
}
`,
  );
  write(
    join(tmuxPlay, 'index.d.ts'),
    "export * from './contract.js';\nexport * from './launcher.js';\nexport * from './session.js';\nexport declare function loadTmuxPlayConfig(options: { configPath: string }): Promise<{ path: string; config: { players: { id: string }[] } }>;\nexport declare function createTmuxPlayRuntime(options: unknown): Promise<{ dispose(): Promise<void> }>;\n",
  );
  write(join(tmuxPlay, 'contract.js'), 'export {};\n');
  write(
    join(tmuxPlay, 'contract.d.ts'),
    `export type RunStatus = 'ok' | 'aborted' | 'error';
${rootPermissionPolicy}
${rootEffort}
${tuningSelection}
export interface AgentCallSettings {
  ${settingsModel}
  ${settingsEffort}
  ${settingsFastMode}
  ${settingsInstruction}
  ${settingsPermissions}
}
${settingsError}
${settingsPredicate}
export interface CallCaptainOptions {
  readonly visibility?: 'visible' | 'hidden';
  ${captainResume}
  ${captainAllowedTools}
  ${captainSettings}
}
export interface CallPlayerOptions {
  ${playerResume}
  ${playerSettings}
}
export interface Captain {
    ${prepareDispose}
}
export interface CaptainContext {
    readonly signal: AbortSignal;
    ${callPlayer}
    ${callCaptain}
    ${emitReply}
}
export interface CaptainRunResult {
    readonly status: RunStatus;
    readonly turnId: number;
    ${resumeToken}
    ${captainErrorCode}
    readonly finalText?: string;
}
export interface PlayerRunResult {
    ${playerErrorCode}
}
`,
  );
  write(join(tmuxPlay, 'launcher.js'), 'export {};\n');
  write(
    join(tmuxPlay, 'launcher.d.ts'),
    `export interface ManagedTmuxPlayLaunchContext {
  ${launchWorkDirOwnership}
}
export interface LaunchManagedTmuxPlayOptions {
  readonly sessionId: string;
  readonly createSessionCommand: (
    context: ManagedTmuxPlayLaunchContext,
  ) => string | Promise<string>;
}
export interface ManagedTmuxPlayAttachOptions {
  ${attachSignal}
  ${attachCallback}
}
export interface PreparedManagedTmuxPlayLaunch {
  ${attachSignature}
}
${launchManagedSignature}
`,
  );
  write(join(tmuxPlay, 'session.js'), 'export {};\n');
  write(
    join(tmuxPlay, 'session.d.ts'),
    `export interface ManagedTmuxPlaySessionOptions {
  ${sessionWorkDirOwnership}
}
${runManagedSignature}
`,
  );
  // The decoys. Both names live on other declarations in the real package
  // too — `resumeToken` on four of them, `emitReply` in record types and doc
  // comments — so their presence proves nothing about the two interfaces.
  write(join(packageRoot, 'dist', 'types.js'), 'export {};\n');
  write(
    join(packageRoot, 'dist', 'types.d.ts'),
    'export interface DonePayload {\n    readonly resumeToken?: string;\n}\n',
  );
  write(join(tmuxPlay, 'records.js'), 'export {};\n');
  write(
    join(tmuxPlay, 'records.d.ts'),
    '/** Emitted by `emitReply`. */\nexport interface CaptainReplyRecord {\n    readonly text: string;\n}\n',
  );
  // Complete unrelated spelling decoys. A declaration-wide name search must
  // remain green after any owning member below is removed or narrowed, which
  // proves that only resolving the actual exported type can satisfy the gate.
  write(
    join(packageRoot, 'dist', 'capability-decoys.d.ts'),
    `export interface UnrelatedCapabilityNames {
  emitReply: unknown;
  resumeToken: unknown;
  errorCode: unknown;
  prepareDispose: unknown;
  callPlayer: unknown;
  callCaptain: unknown;
  resume: unknown;
  allowedTools: unknown;
  settings: unknown;
  model: unknown;
  effort: unknown;
  fastMode: unknown;
  instruction: unknown;
  permissions: unknown;
  signal: unknown;
  beforeNativeAttach: unknown;
  attach: unknown;
  workDirOwnedByLauncher: unknown;
  launchManagedTmuxPlay: unknown;
  runManagedTmuxPlaySession: unknown;
  assertFastModeSupported: unknown;
}
export declare class AgentCallSettingsErrorDecoy {}
export declare function isAgentCallSettingsErrorDecoy(): void;
export type TuningSelectionDecoy =
  | { kind: 'value'; value: string }
  | { kind: 'provider-default' };
`,
  );
  return packageRoot;
}

const NAIVE_REQUIRED_SPELLINGS = [
  'emitReply',
  'resumeToken',
  'errorCode',
  'prepareDispose',
  'callPlayer',
  'callCaptain',
  'resume',
  'allowedTools',
  'settings',
  'model',
  'effort',
  'fastMode',
  'instruction',
  'permissions',
  'AgentCallSettingsError',
  'isAgentCallSettingsError',
  'assertFastModeSupported',
  'signal',
  'beforeNativeAttach',
  'attach',
  'workDirOwnedByLauncher',
  'launchManagedTmuxPlay',
  'runManagedTmuxPlaySession',
  "kind: 'value'",
  "kind: 'provider-default'",
] as const;

function naiveDeclarationScanIsGreen(packageRoot: string): boolean {
  const declarations: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && path.endsWith('.d.ts')) {
        declarations.push(readFileSync(path, 'utf8'));
      }
    }
  };
  walk(packageRoot);
  const joined = declarations.join('\n');
  return NAIVE_REQUIRED_SPELLINGS.every((name) => joined.includes(name));
}

function check(packageRoot: string, root: string): ReturnType<typeof checkCligentReleaseCapabilities> {
  return checkCligentReleaseCapabilities({
    cligentRoot: packageRoot,
    workRoot: join(root, 'typecheck'),
  });
}

describe('the cligent release-capability guard', () => {
  it('proves the complete contract against the installed dependency', () => {
    const root = scratch();
    const result = check(join(repoRoot, 'node_modules', '@sublang', 'cligent'), root);

    expect(result.otherDiagnostics).toEqual([]);
    expect(result.unproven).toEqual([]);
    expect(result.proven).toEqual([
      'CaptainContext.emitReply',
      'CaptainRunResult.resumeToken',
      'CaptainRunResult.errorCode',
      'PlayerRunResult.errorCode',
      'Captain.prepareDispose',
      'CaptainContext.callPlayer options',
      'CaptainContext.callCaptain options',
      'CallPlayerOptions.resume',
      'CallPlayerOptions.settings',
      'CallCaptainOptions.resume',
      'CallCaptainOptions.allowedTools',
      'CallCaptainOptions.settings',
      'AgentCallSettings.model',
      'AgentCallSettings.effort',
      'AgentCallSettings.fastMode',
      'AgentCallSettings.instruction',
      'AgentCallSettings.permissions',
      'AgentCallSettingsError',
      'isAgentCallSettingsError',
      'assertFastModeSupported',
      'launchManagedTmuxPlay signature',
      'ManagedTmuxPlayLaunchContext.workDirOwnedByLauncher',
      'runManagedTmuxPlaySession signature',
      'ManagedTmuxPlaySessionOptions.workDirOwnedByLauncher',
      'ManagedTmuxPlayAttachOptions.signal',
      'ManagedTmuxPlayAttachOptions.beforeNativeAttach',
      'PreparedManagedTmuxPlayLaunch.attach options',
      'loadTmuxPlayConfig segmented player id',
      'loadTmuxPlayConfig empty player roster',
      'createTmuxPlayRuntime empty player roster',
      'assertFastModeSupported runtime semantics',
      'launchManagedTmuxPlay runtime export',
      'runManagedTmuxPlaySession runtime export',
    ]);
    expect(result.ok).toBe(true);
    expect(result.specifier).toBe('@sublang/cligent/tmux-play');
  });

  it('passes a complete fixture', () => {
    const root = scratch();
    const result = check(fixtureCligent(root), root);

    expect(result.unproven).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    ...(['CaptainRunResult', 'PlayerRunResult'] as const).flatMap((owner) =>
      [
        ['absent', ''],
        ['required', "readonly errorCode: 'SESSION_RESUME_REJECTED';"],
        ['widened', 'readonly errorCode?: string;'],
        ['narrowed', 'readonly errorCode?: never;'],
      ].map(([kind, declaration]) => [
        `${kind} ${owner} resume rejection`,
        { [owner === 'CaptainRunResult' ? 'captainErrorCode' : 'playerErrorCode']: declaration },
        `${owner}.errorCode`,
      ]),
    ),
    [
      'required Captain reply emitter',
      { emitReply: 'emitReply?: (text: string) => Promise<void>;' },
      'CaptainContext.emitReply',
    ],
    [
      'optional Captain resume token',
      { resumeToken: 'readonly resumeToken: string;' },
      'CaptainRunResult.resumeToken',
    ],
    [
      'pre-close Captain lifecycle',
      { prepareDispose: '' },
      'Captain.prepareDispose',
    ],
    [
      'synchronous pre-close Captain lifecycle',
      { prepareDispose: 'prepareDispose?(): void;' },
      'Captain.prepareDispose',
    ],
    [
      'required pre-close Captain lifecycle',
      { prepareDispose: 'prepareDispose(): Promise<void>;' },
      'Captain.prepareDispose',
    ],
    [
      'player call-option plumbing',
      { callPlayer: 'callPlayer(playerId: string, prompt: string): Promise<unknown>;' },
      'CaptainContext.callPlayer options',
    ],
    [
      'narrowed player call-option plumbing',
      {
        callPlayer:
          'callPlayer(playerId: string, prompt: string, options?: { resume?: string | false }): Promise<unknown>;',
      },
      'CaptainContext.callPlayer options',
    ],
    [
      'required player call-option plumbing',
      {
        callPlayer:
          'callPlayer(playerId: string, prompt: string, options: CallPlayerOptions | undefined): Promise<unknown>;',
      },
      'CaptainContext.callPlayer options',
    ],
    [
      'Captain call-option plumbing',
      { callCaptain: 'callCaptain(prompt: string): Promise<CaptainRunResult>;' },
      'CaptainContext.callCaptain options',
    ],
    [
      'required Captain call-option plumbing',
      {
        callCaptain:
          'callCaptain(prompt: string, options: CallCaptainOptions | undefined): Promise<CaptainRunResult>;',
      },
      'CaptainContext.callCaptain options',
    ],
    [
      'narrowed Captain call-option plumbing',
      {
        callCaptain:
          'callCaptain(prompt: string, options?: { resume?: string | false }): Promise<CaptainRunResult>;',
      },
      'CaptainContext.callCaptain options',
    ],
    [
      'player resume selection',
      { playerResume: '' },
      'CallPlayerOptions.resume',
    ],
    [
      'player fresh selection',
      { playerResume: 'readonly resume?: string;' },
      'CallPlayerOptions.resume',
    ],
    [
      'player token selection',
      { playerResume: 'readonly resume?: false;' },
      'CallPlayerOptions.resume',
    ],
    [
      'optional player resume selection',
      { playerResume: 'readonly resume: string | false;' },
      'CallPlayerOptions.resume',
    ],
    [
      'player call settings',
      { playerSettings: '' },
      'CallPlayerOptions.settings',
    ],
    [
      'optional player call settings',
      { playerSettings: 'readonly settings: AgentCallSettings;' },
      'CallPlayerOptions.settings',
    ],
    [
      'Captain resume selection',
      { captainResume: '' },
      'CallCaptainOptions.resume',
    ],
    [
      'Captain fresh selection',
      { captainResume: 'readonly resume?: string;' },
      'CallCaptainOptions.resume',
    ],
    [
      'Captain token selection',
      { captainResume: 'readonly resume?: false;' },
      'CallCaptainOptions.resume',
    ],
    [
      'optional Captain resume selection',
      { captainResume: 'readonly resume: string | false;' },
      'CallCaptainOptions.resume',
    ],
    [
      'Captain tool allowlist',
      { captainAllowedTools: '' },
      'CallCaptainOptions.allowedTools',
    ],
    [
      'optional Captain tool allowlist',
      { captainAllowedTools: 'readonly allowedTools: readonly string[];' },
      'CallCaptainOptions.allowedTools',
    ],
    [
      'narrowed Captain tool allowlist',
      { captainAllowedTools: 'readonly allowedTools?: string;' },
      'CallCaptainOptions.allowedTools',
    ],
    [
      'Captain call settings',
      { captainSettings: '' },
      'CallCaptainOptions.settings',
    ],
    [
      'optional Captain call settings',
      { captainSettings: 'readonly settings: AgentCallSettings;' },
      'CallCaptainOptions.settings',
    ],
    [
      'required model',
      { settingsModel: '' },
      'AgentCallSettings.model',
    ],
    [
      'narrowed model value domain',
      {
        settingsModel:
          "readonly model: TuningSelection<'only-this-model'>;",
      },
      'AgentCallSettings.model',
    ],
    [
      'required effort',
      { settingsEffort: '' },
      'AgentCallSettings.effort',
    ],
    [
      'narrowed effort value domain',
      { settingsEffort: "readonly effort: TuningSelection<'low' | 'high'>;" },
      'AgentCallSettings.effort',
    ],
    [
      'narrowed root effort value domain',
      { rootEffort: "export type Effort = 'low' | 'high';" },
      'AgentCallSettings.effort',
    ],
    [
      'fast-mode setting',
      { settingsFastMode: '' },
      'AgentCallSettings.fastMode',
    ],
    [
      'optional fast-mode setting',
      { settingsFastMode: 'readonly fastMode: boolean;' },
      'AgentCallSettings.fastMode',
    ],
    [
      'complete fast-mode boolean domain',
      { settingsFastMode: 'readonly fastMode?: true;' },
      'AgentCallSettings.fastMode',
    ],
    [
      'narrowed root permission value domain',
      {
        rootPermissionPolicy:
          "export interface PermissionPolicy { mode?: 'auto'; }",
        settingsPermissions:
          "readonly permissions?: { mode?: 'auto' };",
      },
      'AgentCallSettings.permissions',
    ],
    [
      'instruction replacement',
      { settingsInstruction: '' },
      'AgentCallSettings.instruction',
    ],
    [
      'optional instruction replacement',
      { settingsInstruction: 'readonly instruction: string;' },
      'AgentCallSettings.instruction',
    ],
    [
      'permission replacement',
      { settingsPermissions: '' },
      'AgentCallSettings.permissions',
    ],
    [
      'optional permission replacement',
      { settingsPermissions: 'readonly permissions: PermissionPolicy;' },
      'AgentCallSettings.permissions',
    ],
    [
      'narrowed permission replacement',
      { settingsPermissions: "readonly permissions?: { mode?: 'auto' };" },
      'AgentCallSettings.permissions',
    ],
    [
      'model provider-default tuning',
      {
        settingsModel:
          "readonly model: { readonly kind: 'value'; readonly value: string };",
      },
      'AgentCallSettings.model',
    ],
    [
      'model concrete-value tuning',
      {
        settingsModel:
          "readonly model: { readonly kind: 'provider-default' };",
      },
      'AgentCallSettings.model',
    ],
    [
      'effort provider-default tuning',
      {
        settingsEffort:
          "readonly effort: { readonly kind: 'value'; readonly value: 'low' | 'high' };",
      },
      'AgentCallSettings.effort',
    ],
    [
      'effort concrete-value tuning',
      {
        settingsEffort:
          "readonly effort: { readonly kind: 'provider-default' };",
      },
      'AgentCallSettings.effort',
    ],
    [
      'typed settings error',
      { settingsError: '' },
      'AgentCallSettingsError',
    ],
    [
      'settings-error predicate',
      { settingsPredicate: '' },
      'isAgentCallSettingsError',
    ],
    [
      'fast-mode capability assertion',
      { fastModeAssertion: '' },
      'assertFastModeSupported',
    ],
    [
      'fast-mode runtime capability assertion',
      { fastModeAssertionRuntime: false },
      'assertFastModeSupported runtime semantics',
    ],
    [
      'fast-mode runtime capability semantics',
      { fastModeAssertionSemantics: false },
      'assertFastModeSupported runtime semantics',
    ],
    [
      'managed launch declaration',
      { launchManagedSignature: '' },
      'launchManagedTmuxPlay signature',
    ],
    [
      'managed launch signature',
      {
        launchManagedSignature:
          'export declare function launchManagedTmuxPlay(): Promise<PreparedManagedTmuxPlayLaunch>;',
      },
      'launchManagedTmuxPlay signature',
    ],
    [
      'managed launch work-directory ownership',
      { launchWorkDirOwnership: '' },
      'ManagedTmuxPlayLaunchContext.workDirOwnedByLauncher',
    ],
    [
      'required managed launch work-directory ownership',
      {
        launchWorkDirOwnership:
          'readonly workDirOwnedByLauncher?: boolean;',
      },
      'ManagedTmuxPlayLaunchContext.workDirOwnedByLauncher',
    ],
    [
      'complete managed launch work-directory ownership',
      {
        launchWorkDirOwnership:
          'readonly workDirOwnedByLauncher: true;',
      },
      'ManagedTmuxPlayLaunchContext.workDirOwnedByLauncher',
    ],
    [
      'managed session declaration',
      { runManagedSignature: '' },
      'runManagedTmuxPlaySession signature',
    ],
    [
      'managed session signature',
      {
        runManagedSignature:
          'export declare function runManagedTmuxPlaySession(): Promise<void>;',
      },
      'runManagedTmuxPlaySession signature',
    ],
    [
      'managed runner work-directory ownership',
      { sessionWorkDirOwnership: '' },
      'ManagedTmuxPlaySessionOptions.workDirOwnedByLauncher',
    ],
    [
      'required managed runner work-directory ownership',
      {
        sessionWorkDirOwnership:
          'readonly workDirOwnedByLauncher?: boolean;',
      },
      'ManagedTmuxPlaySessionOptions.workDirOwnedByLauncher',
    ],
    [
      'complete managed runner work-directory ownership',
      {
        sessionWorkDirOwnership:
          'readonly workDirOwnedByLauncher: true;',
      },
      'ManagedTmuxPlaySessionOptions.workDirOwnedByLauncher',
    ],
    [
      'managed launch runtime export',
      { launchManagedRuntime: false },
      'launchManagedTmuxPlay runtime export',
    ],
    [
      'managed session runtime export',
      { runManagedRuntime: false },
      'runManagedTmuxPlaySession runtime export',
    ],
    [
      'activation signal',
      { attachSignal: '' },
      'ManagedTmuxPlayAttachOptions.signal',
    ],
    [
      'optional activation signal',
      { attachSignal: 'readonly signal: AbortSignal;' },
      'ManagedTmuxPlayAttachOptions.signal',
    ],
    [
      'native-client hand-off',
      { attachCallback: '' },
      'ManagedTmuxPlayAttachOptions.beforeNativeAttach',
    ],
    [
      'optional native-client hand-off',
      { attachCallback: 'readonly beforeNativeAttach: () => void;' },
      'ManagedTmuxPlayAttachOptions.beforeNativeAttach',
    ],
    [
      'asynchronous native-client hand-off',
      { attachCallback: 'readonly beforeNativeAttach?: () => void | Promise<void>;' },
      'ManagedTmuxPlayAttachOptions.beforeNativeAttach',
    ],
    [
      'managed attach options parameter',
      { attachSignature: 'attach(): Promise<void>;' },
      'PreparedManagedTmuxPlayLaunch.attach options',
    ],
    [
      'required managed attach options parameter',
      {
        attachSignature:
          'attach(options: ManagedTmuxPlayAttachOptions | undefined): Promise<void>;',
      },
      'PreparedManagedTmuxPlayLaunch.attach options',
    ],
    [
      'narrowed managed attach options parameter',
      {
        attachSignature:
          'attach(options?: { readonly signal?: AbortSignal }): Promise<void>;',
      },
      'PreparedManagedTmuxPlayLaunch.attach options',
    ],
    [
      'segmented player grammar',
      { segmentedPlayerIds: false },
      'loadTmuxPlayConfig segmented player id',
    ],
    [
      'empty-roster config normalization',
      { emptyRosterConfig: false },
      'loadTmuxPlayConfig empty player roster',
    ],
    [
      'empty-roster runtime initialization',
      { emptyRosterRuntime: false },
      'createTmuxPlayRuntime empty player roster',
    ],
  ] as const)(
    'fails when the fixture loses %s',
    (_name, shape, expectedCapability) => {
      const root = scratch();
      const packageRoot = fixtureCligent(root, shape);
      const result = check(packageRoot, root);

      expect(result.ok).toBe(false);
      expect(result.unproven.map((item) => item.id)).toContain(
        expectedCapability,
      );
      expect(naiveDeclarationScanIsGreen(packageRoot)).toBe(true);
    },
  );

  it('fails when CaptainContext.emitReply is absent, where a name scan passes', () => {
    const root = scratch();
    const packageRoot = fixtureCligent(root, { emitReply: '' });
    const result = check(packageRoot, root);

    expect(result.ok).toBe(false);
    expect(result.unproven.map((member) => member.id)).toEqual([
      'CaptainContext.emitReply',
    ]);
    expect(result.unproven[0]?.diagnostics.join('\n')).toContain(
      "Property 'emitReply' does not exist on type 'CaptainContext'",
    );
    expect(result.proven).toContain('CaptainRunResult.resumeToken');
    expect(naiveDeclarationScanIsGreen(packageRoot)).toBe(true);
  });

  it('fails when CaptainRunResult.resumeToken is absent, where a name scan passes', () => {
    const root = scratch();
    const packageRoot = fixtureCligent(root, { resumeToken: '' });
    const result = check(packageRoot, root);

    expect(result.ok).toBe(false);
    expect(result.unproven.map((member) => member.id)).toEqual([
      'CaptainRunResult.resumeToken',
    ]);
    expect(result.unproven[0]?.diagnostics.join('\n')).toContain(
      "Property 'resumeToken' does not exist on type 'CaptainRunResult'",
    );
    expect(result.proven).toContain('CaptainContext.emitReply');
    expect(naiveDeclarationScanIsGreen(packageRoot)).toBe(true);
  });

  it('fails when a member survives under a shape the shell cannot call', () => {
    const root = scratch();
    // Kept, spelled the same, on the right interface — and unusable: the
    // shell awaits every `emitReply`, and a token that is not a string is not
    // a resume token. A member check that stopped at presence would pass this.
    const packageRoot = fixtureCligent(root, {
      emitReply: 'emitReply(text: string): void;',
      resumeToken: 'readonly resumeToken?: number;',
    });
    const result = check(packageRoot, root);

    expect(result.ok).toBe(false);
    expect(result.unproven.map((member) => member.id)).toEqual(
      expect.arrayContaining([
        'CaptainContext.emitReply',
        'CaptainRunResult.resumeToken',
      ]),
    );
    expect(naiveDeclarationScanIsGreen(packageRoot)).toBe(true);
  });

  it('fails when the public specifier no longer resolves', () => {
    const root = scratch();
    const packageRoot = fixtureCligent(root);
    // The members are all still there; only the `exports` entry the shell
    // imports through is gone. A deep-path check would not notice.
    const manifest = join(packageRoot, 'package.json');
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      exports: Record<string, unknown>;
    };
    delete parsed.exports['./tmux-play'];
    writeFileSync(manifest, `${JSON.stringify(parsed, undefined, 2)}\n`);
    const result = check(packageRoot, root);

    expect(result.ok).toBe(false);
    expect(result.unproven.map((member) => member.id)).toEqual(
      expect.arrayContaining([
        'CaptainContext.emitReply',
        'CaptainRunResult.resumeToken',
        'loadTmuxPlayConfig segmented player id',
        'loadTmuxPlayConfig empty player roster',
        'createTmuxPlayRuntime empty player roster',
      ]),
    );
    expect(naiveDeclarationScanIsGreen(packageRoot)).toBe(true);
  });
});
