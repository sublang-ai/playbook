// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
/**
 * Exact-byte SHA-256 hashing for pin currency (PIN-2, PIN-3; DR-007).
 *
 * Hashes are SHA-256 over the exact file bytes — with no line-ending or other
 * text normalization — written as `sha256:` followed by 64 lowercase hexadecimal
 * characters. This is the conservative identity the pin validator compares
 * recorded hashes against, so any byte difference (including a line-ending
 * change) yields a different hash. The DR-003 write-scope snapshot in
 * `execution.ts` keeps its own raw-hex helper; this module owns the pin format.
 * See specs/dev/pinning.md.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** Hashes exact bytes as `sha256:<64 lowercase hex>`, applying no normalization (DR-007). */
export function hashBytes(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
/**
 * Reads a file and hashes its exact bytes (DR-007).
 *
 * Reads with no encoding so the bytes are hashed verbatim, without line-ending
 * or text transformation.
 */
export async function hashFile(path) {
    return hashBytes(await readFile(path));
}
/** Reports whether a string is a well-formed `sha256:<64 lowercase hex>` hash (DR-007). */
export function isHash(value) {
    return HASH_PATTERN.test(value);
}
