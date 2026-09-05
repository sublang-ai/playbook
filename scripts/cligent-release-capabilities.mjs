// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// RELEASE-28 step 9 / RELEASE-29: the standing guard that an installed
// `@sublang/cligent` carries the complete public contract Playbook uses.
//
// The obligation is a member on an interface, so the check is a type check,
// not a text search. Each member gets a one-line fixture that imports the
// interface through `@sublang/cligent/tmux-play` — the same public specifier
// the shell imports — and uses the member at its required type. The
// TypeScript compiler is the guard: a member that is absent, renamed, moved
// to another interface, or retyped fails its own fixture, and the failing
// fixture names which member is unproven.
//
// This replaced a substring scan over every `.d.ts` in the installed tree,
// which could not fail for the regression it existed to catch: in cligent
// 0.19.0, `resumeToken` names members of four unrelated declarations
// (`adapters/resume-token`, `cligent`, `protocol`, `types`) and `emitReply`
// survives in `app/tmux-play/records.d.ts` as a `{@link}` doc comment, so
// deleting both members from `CaptainContext` and `CaptainRunResult` left the
// scan reporting nothing absent.

import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import ts from 'typescript';

// The specifier the shell itself imports (`playbook-captain.ts`), so the check
// exercises the package's own `exports` map rather than a deep file path that
// a repackaging could move without breaking any consumer.
export const CLIGENT_RELEASE_SPECIFIER = '@sublang/cligent/tmux-play';

// One fixture per member. `source` must use the member in a way that cannot
// type-check without it; the assignment to an explicitly annotated binding is
// what also pins the member's type, so a member kept under a changed shape
// (a synchronous `emitReply`, a numeric `resumeToken`) fails too.
const typeCapability = (id, file, why, source) =>
  Object.freeze({ id, file, why, source });

export const CLIGENT_RELEASE_TYPE_CAPABILITIES = Object.freeze([
  typeCapability(
    'CaptainContext.emitReply',
    'captain-context-emit-reply.ts',
    'Validated durable Captain prose reaches Boss only through this member.',
    `import type { CaptainContext } from '${CLIGENT_RELEASE_SPECIFIER}';
export const use: (value: CaptainContext, text: string) => Promise<void> =
  (value, text) => value.emitReply(text);
`,
  ),
  typeCapability(
    'CaptainRunResult.resumeToken',
    'captain-run-result-resume-token.ts',
    'The shell pins this string after every durable Captain call.',
    `import type { CaptainRunResult } from '${CLIGENT_RELEASE_SPECIFIER}';
type Assert<T extends true> = T;
type Optional = Assert<
  {} extends Pick<CaptainRunResult, 'resumeToken'> ? true : false
>;
export const optional: Optional = true;
export const use: (value: CaptainRunResult) => string | undefined =
  (value) => value.resumeToken;
`,
  ),
  ...['CaptainRunResult', 'PlayerRunResult'].map((owner) => typeCapability(
    `${owner}.errorCode`,
    `${owner === 'CaptainRunResult' ? 'captain' : 'player'}-run-result-error-code.ts`,
    'Only definite pre-execution rejection permits one fresh provider call.',
    `import type { ${owner} } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Optional = Assert<{} extends Pick<${owner}, 'errorCode'> ? true : false>;
type Exact = Assert<Equal<${owner}['errorCode'], 'SESSION_RESUME_REJECTED' | undefined>>;
export const optional: Optional = true;
export const exact: Exact = true;
`,
  )),
  typeCapability(
    'Captain.prepareDispose',
    'captain-prepare-dispose.ts',
    'The shell closes turn emissions before disposing Captain resources.',
    `import type { Captain } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Optional = Assert<{} extends Pick<Captain, 'prepareDispose'> ? true : false>;
type Exact = Assert<Equal<
  Captain['prepareDispose'],
  (() => Promise<void>) | undefined
>>;
export const optional: Optional = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'CaptainContext.callPlayer options',
    'captain-context-call-player-options.ts',
    'Player continuation and complete settings must reach the real call.',
    `import type { CallPlayerOptions, CaptainContext } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Exact = Assert<Equal<
  Parameters<CaptainContext['callPlayer']>,
  [playerId: string, prompt: string, options?: CallPlayerOptions]
>>;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'CaptainContext.callCaptain options',
    'captain-context-call-captain-options.ts',
    'Captain selection, tools, and complete settings must reach the real call.',
    `import type { CallCaptainOptions, CaptainContext } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Exact = Assert<Equal<
  Parameters<CaptainContext['callCaptain']>,
  [prompt: string, options?: CallCaptainOptions]
>>;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'CallPlayerOptions.resume',
    'call-player-resume.ts',
    'A player call explicitly selects fresh or an opaque prior token.',
    `import type { CallPlayerOptions } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Optional = Assert<{} extends Pick<CallPlayerOptions, 'resume'> ? true : false>;
type Exact = Assert<Equal<
  CallPlayerOptions['resume'],
  string | false | undefined
>>;
export const optional: Optional = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'CallPlayerOptions.settings',
    'call-player-settings.ts',
    'A player call carries one atomic complete-settings object.',
    `import type { AgentCallSettings, CallPlayerOptions } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Optional = Assert<{} extends Pick<CallPlayerOptions, 'settings'> ? true : false>;
type Exact = Assert<Equal<
  CallPlayerOptions['settings'],
  AgentCallSettings | undefined
>>;
export const optional: Optional = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'CallCaptainOptions.resume',
    'call-captain-resume.ts',
    'A Captain call explicitly selects fresh or an opaque prior token.',
    `import type { CallCaptainOptions } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Optional = Assert<{} extends Pick<CallCaptainOptions, 'resume'> ? true : false>;
type Exact = Assert<Equal<
  CallCaptainOptions['resume'],
  string | false | undefined
>>;
export const optional: Optional = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'CallCaptainOptions.allowedTools',
    'call-captain-allowed-tools.ts',
    'A hidden Captain control call can require an explicit tool allowlist.',
    `import type { CallCaptainOptions } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Optional = Assert<
  {} extends Pick<CallCaptainOptions, 'allowedTools'> ? true : false
>;
type Exact = Assert<Equal<
  CallCaptainOptions['allowedTools'],
  readonly string[] | undefined
>>;
export const optional: Optional = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'CallCaptainOptions.settings',
    'call-captain-settings.ts',
    'A Captain call carries one atomic complete-settings object.',
    `import type { AgentCallSettings, CallCaptainOptions } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Optional = Assert<{} extends Pick<CallCaptainOptions, 'settings'> ? true : false>;
type Exact = Assert<Equal<
  CallCaptainOptions['settings'],
  AgentCallSettings | undefined
>>;
export const optional: Optional = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'AgentCallSettings.model',
    'agent-call-settings-model.ts',
    'Model is required and distinguishes a concrete value from provider default.',
    `import type { AgentCallSettings, TuningSelection } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type Assert<T extends true> = T;
type Required = Assert<'model' extends RequiredKeys<AgentCallSettings> ? true : false>;
type Exact = Assert<Equal<AgentCallSettings['model'], TuningSelection<string>>>;
declare const model: string;
export const concrete: AgentCallSettings['model'] = { kind: 'value', value: model };
export const providerDefault: AgentCallSettings['model'] = { kind: 'provider-default' };
export const required: Required = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'AgentCallSettings.effort',
    'agent-call-settings-effort.ts',
    'Effort is required and distinguishes a concrete value from provider default.',
    `import type { Effort } from '@sublang/cligent';
import type { AgentCallSettings, TuningSelection } from '${CLIGENT_RELEASE_SPECIFIER}';
type ShellEffort =
  | 'off' | 'on'
  | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  | 'ultra' | 'ultracode';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type Assert<T extends true> = T;
type Required = Assert<'effort' extends RequiredKeys<AgentCallSettings> ? true : false>;
type RootExact = Assert<Equal<Effort, ShellEffort>>;
type Exact = Assert<Equal<
  AgentCallSettings['effort'],
  TuningSelection<ShellEffort>
>>;
declare const effort: ShellEffort;
export const concrete: AgentCallSettings['effort'] = { kind: 'value', value: effort };
export const providerDefault: AgentCallSettings['effort'] = { kind: 'provider-default' };
export const required: Required = true;
export const rootExact: RootExact = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'AgentCallSettings.fastMode',
    'agent-call-settings-fast-mode.ts',
    'Fast mode is an optional literal boolean in complete settings.',
    `import type { AgentCallSettings } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Optional = Assert<
  {} extends Pick<AgentCallSettings, 'fastMode'> ? true : false
>;
type Exact = Assert<Equal<AgentCallSettings['fastMode'], boolean | undefined>>;
export const disabled: AgentCallSettings['fastMode'] = false;
export const enabled: AgentCallSettings['fastMode'] = true;
export const optional: Optional = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'AgentCallSettings.instruction',
    'agent-call-settings-instruction.ts',
    'A complete replacement carries an explicit instruction selection.',
    `import type { AgentCallSettings } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Optional = Assert<
  {} extends Pick<AgentCallSettings, 'instruction'> ? true : false
>;
type Exact = Assert<Equal<
  AgentCallSettings['instruction'],
  string | undefined
>>;
export const optional: Optional = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'AgentCallSettings.permissions',
    'agent-call-settings-permissions.ts',
    'A complete replacement carries the normalized permission envelope.',
    `import type { PermissionPolicy } from '@sublang/cligent';
import type { AgentCallSettings } from '${CLIGENT_RELEASE_SPECIFIER}';
interface ShellPermissionPolicy {
  mode?: 'auto' | 'bypass';
  fileWrite?: 'allow' | 'ask' | 'deny';
  shellExecute?: 'allow' | 'ask' | 'deny';
  networkAccess?: 'allow' | 'ask' | 'deny';
  writablePaths?: string[];
}
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Optional = Assert<
  {} extends Pick<AgentCallSettings, 'permissions'> ? true : false
>;
type RootExact = Assert<Equal<PermissionPolicy, ShellPermissionPolicy>>;
type Exact = Assert<Equal<
  AgentCallSettings['permissions'],
  ShellPermissionPolicy | undefined
>>;
const permissions: PermissionPolicy = {
  mode: 'auto',
  fileWrite: 'allow',
  shellExecute: 'ask',
  networkAccess: 'deny',
  writablePaths: ['.git'],
};
export const optional: Optional = true;
export const rootExact: RootExact = true;
export const exact: Exact = true;
export const complete: AgentCallSettings = {
  model: { kind: 'provider-default' },
  effort: { kind: 'provider-default' },
  permissions,
};
`,
  ),
  typeCapability(
    'AgentCallSettingsError',
    'agent-call-settings-error.ts',
    'Ordinary continuation preserves its token on a typed settings rejection.',
    `import { AgentCallSettingsError } from '${CLIGENT_RELEASE_SPECIFIER}';
export const use: Error = new AgentCallSettingsError('unsupported');
export const cause: unknown = new AgentCallSettingsError('unsupported').cause;
`,
  ),
  typeCapability(
    'isAgentCallSettingsError',
    'is-agent-call-settings-error.ts',
    'The shell identifies the typed settings rejection without a fresh fallback.',
    `import { AgentCallSettingsError, isAgentCallSettingsError } from '${CLIGENT_RELEASE_SPECIFIER}';
export function use(value: unknown): AgentCallSettingsError | undefined {
  return isAgentCallSettingsError(value) ? value : undefined;
}
`,
  ),
  typeCapability(
    'assertFastModeSupported',
    'assert-fast-mode-supported.ts',
    'Playbook delegates adapter-scoped fast-mode capability to Cligent.',
    `import { assertFastModeSupported } from '@sublang/cligent';
import type { AgentType } from '@sublang/cligent';
declare const adapter: AgentType | 'claude';
export function use(): void {
  assertFastModeSupported(adapter, 'configured fastMode');
}
`,
  ),
  typeCapability(
    'launchManagedTmuxPlay signature',
    'launch-managed-tmux-play-signature.ts',
    'The outer interactive front end prepares a managed launch through this exact callable surface.',
    `import {
  launchManagedTmuxPlay,
  type LaunchManagedTmuxPlayOptions,
  type PreparedManagedTmuxPlayLaunch,
} from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true : false
    : false;
type Assert<T extends true> = T;
type Exact = Assert<Equal<
  typeof launchManagedTmuxPlay,
  (options: LaunchManagedTmuxPlayOptions) => Promise<PreparedManagedTmuxPlayLaunch>
>>;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'ManagedTmuxPlayLaunchContext.workDirOwnedByLauncher',
    'managed-launch-context-work-dir-ownership.ts',
    'The launcher explicitly grants or withholds recursive work-directory cleanup authority.',
    `import type { ManagedTmuxPlayLaunchContext } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true : false
    : false;
type Assert<T extends true> = T;
type Required = Assert<
  {} extends Pick<ManagedTmuxPlayLaunchContext, 'workDirOwnedByLauncher'>
    ? false
    : true
>;
type Exact = Assert<Equal<
  ManagedTmuxPlayLaunchContext['workDirOwnedByLauncher'], boolean
>>;
export const required: Required = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'runManagedTmuxPlaySession signature',
    'run-managed-tmux-play-session-signature.ts',
    'The pane child enters Cligent session mode through this exact callable surface.',
    `import {
  runManagedTmuxPlaySession,
  type ManagedTmuxPlaySessionOptions,
} from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true : false
    : false;
type Assert<T extends true> = T;
type Exact = Assert<Equal<
  typeof runManagedTmuxPlaySession,
  (options: ManagedTmuxPlaySessionOptions) => Promise<void>
>>;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'ManagedTmuxPlaySessionOptions.workDirOwnedByLauncher',
    'managed-session-options-work-dir-ownership.ts',
    'The pane child passes the launcher-issued cleanup authority to the managed runner unchanged.',
    `import type { ManagedTmuxPlaySessionOptions } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true : false
    : false;
type Assert<T extends true> = T;
type Required = Assert<
  {} extends Pick<ManagedTmuxPlaySessionOptions, 'workDirOwnedByLauncher'>
    ? false
    : true
>;
type Exact = Assert<Equal<
  ManagedTmuxPlaySessionOptions['workDirOwnedByLauncher'], boolean
>>;
export const required: Required = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'ManagedTmuxPlayAttachOptions.signal',
    'managed-attach-signal.ts',
    'Prepared interactive activation can be aborted before ownership transfer.',
    `import type { ManagedTmuxPlayAttachOptions } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true : false
    : false;
type Assert<T extends true> = T;
type Optional = Assert<
  {} extends Pick<ManagedTmuxPlayAttachOptions, 'signal'> ? true : false
>;
type Exact = Assert<Equal<
  ManagedTmuxPlayAttachOptions['signal'], AbortSignal | undefined
>>;
export const optional: Optional = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'ManagedTmuxPlayAttachOptions.beforeNativeAttach',
    'managed-attach-before-native.ts',
    'The launcher synchronously transfers signal ownership before native attach.',
    `import type { ManagedTmuxPlayAttachOptions } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true : false
    : false;
type Assert<T extends true> = T;
type Optional = Assert<
  {} extends Pick<ManagedTmuxPlayAttachOptions, 'beforeNativeAttach'>
    ? true
    : false
>;
type Exact = Assert<Equal<
  ManagedTmuxPlayAttachOptions['beforeNativeAttach'],
  (() => void) | undefined
>>;
export const optional: Optional = true;
export const exact: Exact = true;
`,
  ),
  typeCapability(
    'PreparedManagedTmuxPlayLaunch.attach options',
    'prepared-managed-attach-options.ts',
    'The prepared launch accepts the complete activation options object.',
    `import type { ManagedTmuxPlayAttachOptions, PreparedManagedTmuxPlayLaunch } from '${CLIGENT_RELEASE_SPECIFIER}';
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type Exact = Assert<Equal<
  Parameters<PreparedManagedTmuxPlayLaunch['attach']>,
  [options?: ManagedTmuxPlayAttachOptions]
>>;
export const exact: Exact = true;
`,
  ),
]);

export const CLIGENT_RELEASE_RUNTIME_CAPABILITIES = Object.freeze([
  'loadTmuxPlayConfig segmented player id',
  'loadTmuxPlayConfig empty player roster',
  'createTmuxPlayRuntime empty player roster',
  'assertFastModeSupported runtime semantics',
  'launchManagedTmuxPlay runtime export',
  'runManagedTmuxPlaySession runtime export',
]);

function formatDiagnostic(diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return `TS${diagnostic.code}: ${message}`;
  }
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start,
  );
  const name = diagnostic.file.fileName.split('/').pop();
  return `${name}:${line + 1}:${character + 1} TS${diagnostic.code}: ${message}`;
}

/**
 * Type-check the member fixtures against one installed `@sublang/cligent`.
 *
 * @param {object} input
 * @param {string} input.cligentRoot Installed package root to prove.
 * @param {string} input.workRoot Scratch directory; created, and replaced if
 *   it already exists. The fixtures are left behind for inspection.
 * @returns {{
 *   ok: boolean,
 *   workRoot: string,
 *   specifier: string,
 *   proven: string[],
 *   unproven: { id: string, why: string, diagnostics: string[] }[],
 *   otherDiagnostics: string[],
 * }}
 */
export function checkCligentReleaseCapabilities({ cligentRoot, workRoot }) {
  const packageRoot = resolve(cligentRoot);
  if (!existsSync(join(packageRoot, 'package.json'))) {
    throw new Error(`no package.json under ${packageRoot}`);
  }
  const root = resolve(workRoot);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'node_modules', '@sublang'), { recursive: true });
  // Resolve the specifier the way Node does — through a `node_modules`
  // lookup that walks up from the importer — so the package's own `exports`
  // map and its `types` condition are what answer, exactly as they answer
  // for the shell.
  symlinkSync(
    packageRoot,
    join(root, 'node_modules', '@sublang', 'cligent'),
    'junction',
  );
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'cligent-release-capability-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
      },
      undefined,
      2,
    )}\n`,
  );

  const fixtures = CLIGENT_RELEASE_TYPE_CAPABILITIES.map((member) => {
    const path = join(root, member.file);
    writeFileSync(path, member.source);
    return { member, path };
  });

  const program = ts.createProgram(
    fixtures.map((fixture) => fixture.path),
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      noEmit: true,
      // Declaration files are the subject, not the object: cligent's own
      // `.d.ts` graph reaches optional peer SDKs that a lean install does not
      // carry, and their absence is not this guard's business. The fixtures
      // are `.ts`, so their own checking is unaffected.
      skipLibCheck: true,
      types: [],
    },
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);

  const proven = [];
  const unproven = [];
  const attributed = new Set();
  for (const { member, path } of fixtures) {
    const own = diagnostics.filter(
      (diagnostic) => diagnostic.file?.fileName === path.split('\\').join('/'),
    );
    for (const diagnostic of own) attributed.add(diagnostic);
    if (own.length === 0) proven.push(member.id);
    else {
      unproven.push({
        id: member.id,
        why: member.why,
        diagnostics: own.map(formatDiagnostic),
      });
    }
  }
  const otherDiagnostics = diagnostics
    .filter((diagnostic) => !attributed.has(diagnostic))
    .map(formatDiagnostic);

  const runtime = checkRuntimeCapabilities(root);
  return {
    ok:
      unproven.length === 0 &&
      otherDiagnostics.length === 0 &&
      runtime.unproven.length === 0,
    workRoot: root,
    specifier: CLIGENT_RELEASE_SPECIFIER,
    proven: [...proven, ...runtime.proven],
    unproven: [...unproven, ...runtime.unproven],
    otherDiagnostics,
  };
}

function checkRuntimeCapabilities(root) {
  const probes = [];
  const segmentedConfigPath = join(root, 'segmented-player.yaml');
  writeFileSync(
    segmentedConfigPath,
    [
      'captain:',
      "  from: '@sublang/cligent/captains/fanout'",
      '  adapter: claude',
      '  options: {}',
      'players:',
      '  - id: dev.coder',
      '    adapter: codex',
      '',
    ].join('\n'),
  );
  const segmentedRunner = join(root, 'segmented-player.mjs');
  writeFileSync(
    segmentedRunner,
    `import { loadTmuxPlayConfig } from '${CLIGENT_RELEASE_SPECIFIER}';

const loaded = await loadTmuxPlayConfig({ configPath: process.argv[2] });
const ids = loaded.config.players.map((player) => player.id);
if (ids.length !== 1 || ids[0] !== 'dev.coder') {
  throw new Error('segmented player id was not preserved: ' + JSON.stringify(ids));
}
`,
  );
  probes.push({
    id: CLIGENT_RELEASE_RUNTIME_CAPABILITIES[0],
    why: 'DR-032 segmented player identities must survive the public config loader without flattening or rejection.',
    runner: segmentedRunner,
    args: [segmentedConfigPath],
  });

  const emptyConfigPath = join(root, 'empty-player-roster.yaml');
  writeFileSync(
    emptyConfigPath,
    [
      'captain:',
      "  from: '@sublang/cligent/captains/fanout'",
      '  adapter: claude',
      '  options: {}',
      'players: []',
      '',
    ].join('\n'),
  );
  const emptyConfigRunner = join(root, 'empty-player-roster-config.mjs');
  writeFileSync(
    emptyConfigRunner,
    `import { loadTmuxPlayConfig } from '${CLIGENT_RELEASE_SPECIFIER}';

const loaded = await loadTmuxPlayConfig({ configPath: process.argv[2] });
if (loaded.config.players.length !== 0) {
  throw new Error('empty player roster was not preserved');
}
if (loaded.config.layout.initialVisible.length !== 0) {
  throw new Error('empty roster gained a visible player');
}
if (JSON.stringify(loaded.config.layout.columnWeights) !== '[1]') {
  throw new Error(
    'empty roster did not resolve to the Boss-only layout: ' +
      JSON.stringify(loaded.config.layout.columnWeights),
  );
}
`,
  );
  probes.push({
    id: CLIGENT_RELEASE_RUNTIME_CAPABILITIES[1],
    why: 'A DR-032 all-roleless catalog requires the public config loader to preserve an empty roster and resolve the Boss-only layout.',
    runner: emptyConfigRunner,
    args: [emptyConfigPath],
  });

  const emptyRuntimeRunner = join(root, 'empty-player-roster-runtime.mjs');
  writeFileSync(
    emptyRuntimeRunner,
    `import { createTmuxPlayRuntime } from '${CLIGENT_RELEASE_SPECIFIER}';

let initialized = false;
class ProbeAdapter {
  agent = 'release-probe';
  async isAvailable() {
    return true;
  }
  async *run() {
    throw new Error('empty-roster probe must not call a provider');
  }
}
const importAdapter = async () => ProbeAdapter;
const runtime = await createTmuxPlayRuntime({
  captain: {
    async init(session) {
      if (session.players.length !== 0) {
        throw new Error('Captain received a nonempty player manifest');
      }
      await session.setVisiblePlayers([]);
      initialized = true;
    },
    async handleBossTurn() {
      throw new Error('empty-roster probe must not run a Boss turn');
    },
  },
  captainConfig: { adapter: 'claude' },
  players: [],
  adapterImports: {
    claude: importAdapter,
    codex: importAdapter,
    gemini: importAdapter,
    kimi: importAdapter,
    opencode: importAdapter,
  },
});
if (!initialized) {
  throw new Error('Captain was not initialized');
}
await runtime.dispose();
`,
  );
  probes.push({
    id: CLIGENT_RELEASE_RUNTIME_CAPABILITIES[2],
    why: 'A DR-032 all-roleless catalog requires the public runtime core to initialize a Captain with an empty player manifest.',
    runner: emptyRuntimeRunner,
    args: [],
  });

  const fastModeRunner = join(root, 'fast-mode-support-runtime.mjs');
  writeFileSync(
    fastModeRunner,
    `import {
  FAST_MODE_SUPPORT,
  assertFastModeSupported,
} from '@sublang/cligent';

if (typeof assertFastModeSupported !== 'function') {
  throw new Error('assertFastModeSupported is not a runtime function');
}
if (
  typeof FAST_MODE_SUPPORT !== 'object' ||
  FAST_MODE_SUPPORT === null ||
  Array.isArray(FAST_MODE_SUPPORT)
) {
  throw new Error('FAST_MODE_SUPPORT is not a runtime descriptor');
}
const entries = Object.entries(FAST_MODE_SUPPORT);
if (
  entries.length === 0 ||
  !entries.some(([, support]) => support?.requestSupported === true) ||
  !entries.some(([, support]) => support?.requestSupported === false)
) {
  throw new Error('FAST_MODE_SUPPORT lacks supported and unsupported cases');
}
for (const [adapter, support] of entries) {
  if (typeof support?.requestSupported !== 'boolean') {
    throw new Error('FAST_MODE_SUPPORT carries an invalid requestSupported flag');
  }
  let rejected = false;
  try {
    assertFastModeSupported(adapter, 'configured fastMode');
  } catch {
    rejected = true;
  }
  if (rejected === support.requestSupported) {
    throw new Error(
      'assertFastModeSupported disagrees with FAST_MODE_SUPPORT for ' + adapter,
    );
  }
}
const claudeSupport = FAST_MODE_SUPPORT['claude-code'];
if (typeof claudeSupport?.requestSupported !== 'boolean') {
  throw new Error('FAST_MODE_SUPPORT lacks the claude-code alias target');
}
let claudeRejected = false;
try {
  assertFastModeSupported('claude', 'configured fastMode');
} catch {
  claudeRejected = true;
}
if (claudeRejected === claudeSupport.requestSupported) {
  throw new Error('the claude alias disagrees with claude-code fast-mode support');
}
`,
  );
  probes.push({
    id: CLIGENT_RELEASE_RUNTIME_CAPABILITIES[3],
    why: 'Playbook imports the root runtime assertion and delegates the exact supported-versus-unsupported adapter boundary to it.',
    runner: fastModeRunner,
    args: [],
  });

  const managedLaunchExportRunner = join(
    root,
    'managed-launch-runtime-export.mjs',
  );
  writeFileSync(
    managedLaunchExportRunner,
    `import { launchManagedTmuxPlay } from '${CLIGENT_RELEASE_SPECIFIER}';

if (typeof launchManagedTmuxPlay !== 'function') {
  throw new Error('launchManagedTmuxPlay is not a runtime function');
}
`,
  );
  probes.push({
    id: CLIGENT_RELEASE_RUNTIME_CAPABILITIES[4],
    why: 'The installed public tmux-play entry point must expose the managed launch runtime value used by the outer interactive front end.',
    runner: managedLaunchExportRunner,
    args: [],
  });

  const managedSessionExportRunner = join(
    root,
    'managed-session-runtime-export.mjs',
  );
  writeFileSync(
    managedSessionExportRunner,
    `import { runManagedTmuxPlaySession } from '${CLIGENT_RELEASE_SPECIFIER}';

if (typeof runManagedTmuxPlaySession !== 'function') {
  throw new Error('runManagedTmuxPlaySession is not a runtime function');
}
`,
  );
  probes.push({
    id: CLIGENT_RELEASE_RUNTIME_CAPABILITIES[5],
    why: 'The installed public tmux-play entry point must expose the managed session runtime value used by the pane child.',
    runner: managedSessionExportRunner,
    args: [],
  });

  const proven = [];
  const unproven = [];
  for (const probe of probes) {
    const result = spawnSync(process.execPath, [probe.runner, ...probe.args], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.error === undefined && result.status === 0) {
      proven.push(probe.id);
      continue;
    }
    unproven.push({
      id: probe.id,
      why: probe.why,
      diagnostics: [result.error?.message, result.stderr, result.stdout].filter(
        (value) => typeof value === 'string' && value.trim() !== '',
      ),
    });
  }
  return { proven, unproven };
}
