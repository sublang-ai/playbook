// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
/**
 * Exact-byte SHA-256 hashing for pin currency (pinning-2, pinning-3; DR-007).
 *
 * Hashes are SHA-256 over the exact file bytes — with no line-ending or other
 * text normalization — written as `sha256:` followed by 64 lowercase hexadecimal
 * characters. This is the conservative identity the pin validator compares
 * recorded hashes against, so any byte difference (including a line-ending
 * change) yields a different hash. The DR-003 write-scope snapshot in
 * `execution.ts` keeps its own raw-hex helper; this module owns the pin format.
 * See specs/packages/pinning.md.
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
/**
 * Orders two strings by their exact UTF-8 bytes (DR-007).
 *
 * This is the ordering every hashed tree record is sorted and validated by,
 * so it belongs beside the hashes themselves: a second implementation that
 * disagreed on one code point would silently change identities.
 */
export function compareUtf8(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
function canonicalJsonString(value) {
    let serialized = '"';
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined)
            continue;
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
            throw new Error('tree entry contains an unpaired Unicode surrogate');
        }
        if (character === '"' || character === '\\') {
            serialized += `\\${character}`;
        }
        else if (codePoint <= 0x1f) {
            serialized += `\\u${codePoint.toString(16).padStart(4, '0')}`;
        }
        else {
            serialized += character;
        }
    }
    return `${serialized}"`;
}
/**
 * Serializes one tree entry as `[kind,path,identity]` (DR-007).
 *
 * Every tree identity — whatever walker produced its entries — is this exact
 * encoding, so it is written once beside the hash it feeds.
 */
export function serializeTreeRecord(kind, path, identity) {
    return `[${canonicalJsonString(kind)},${canonicalJsonString(path)},${canonicalJsonString(identity)}]`;
}
/** Hashes tree entries in UTF-8 path order, one LF between entries. */
export function hashTreeRecords(records) {
    return hashBytes(new TextEncoder().encode([...records]
        .sort((left, right) => compareUtf8(left.path, right.path))
        .map((record) => record.serialized)
        .join('\n')));
}
