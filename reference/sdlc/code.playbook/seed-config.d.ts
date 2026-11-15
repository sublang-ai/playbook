// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export interface SeedConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  /** Effective provider environment supplied by a host, independent of credential selection. */
  readonly modelEnv?: NodeJS.ProcessEnv;
  /** Local user home or host-approved Codex settings directory for model selection. */
  readonly modelHome?: string | { readonly codexHome: string };
}
export interface SeedConfigText {
  readonly text: string;
  readonly anyReady: boolean;
}
export declare function seedConfigText(options?: SeedConfigOptions): SeedConfigText;
