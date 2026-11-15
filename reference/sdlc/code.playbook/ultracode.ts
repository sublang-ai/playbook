// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { isUltracodeSupported as runtimeSupportsUltracode, type AgentType } from '@sublang/cligent';

/** Whether the adapter supports independent Ultracode tuning. */
export function isUltracodeSupported(adapter: string): boolean {
  return runtimeSupportsUltracode(adapter as AgentType | 'claude');
}

/** Validate the authored boolean and project only supported fields to Cligent. */
export function ultracodeForCall(adapter: string, value: unknown, path: string): { ultracode?: boolean } {
  if (value === undefined) return {};
  if (typeof value !== 'boolean') throw new Error(`${path}.ultracode must be a boolean`);
  if (isUltracodeSupported(adapter)) return { ultracode: value };
  if (value) throw new Error(`${path}.ultracode is not supported for ${adapter}`);
  return {};
}
