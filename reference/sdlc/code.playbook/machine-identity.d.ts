// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export declare const MACHINE_IDENTITY_TAG_PREFIX: 'machine-id:v1:';
export declare function isMachineIdentity(value: unknown): value is string;
export declare function machineIdentityPath(env?: NodeJS.ProcessEnv, home?: string): string;
export interface ResolveMachineIdentityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}
export declare function resolveMachineIdentity(options?: ResolveMachineIdentityOptions): Promise<string>;
