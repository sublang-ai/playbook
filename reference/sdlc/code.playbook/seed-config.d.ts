// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export interface SeedConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}
export interface SeedConfigText {
  readonly text: string;
  readonly anyReady: boolean;
}
export declare function seedConfigText(options?: SeedConfigOptions): SeedConfigText;
