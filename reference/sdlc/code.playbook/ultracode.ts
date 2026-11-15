// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import * as cligent from '@sublang/cligent';

/** Whether the installed runtime can honor independent Ultracode tuning. */
export function isUltracodeSupported(adapter: string): boolean {
  const runtime = cligent as { isUltracodeSupported?: (adapter: string) => boolean };
  return runtime.isUltracodeSupported?.(adapter) === true;
}

/** Validate the authored boolean and project only supported fields to Cligent. */
export function ultracodeForCall(adapter: string, value: unknown, path: string): { ultracode?: boolean } {
  if (value === undefined) return {};
  if (typeof value !== 'boolean') throw new Error(`${path}.ultracode must be a boolean`);
  if (isUltracodeSupported(adapter)) return { ultracode: value };
  if (adapter === 'claude') {
    throw new Error(`${path}.ultracode is not supported by the installed runtime for claude; update Cligent to use independent Ultracode tuning`);
  }
  if (value) throw new Error(`${path}.ultracode is not supported for ${adapter}`);
  return {};
}
