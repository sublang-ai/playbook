// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { MAX_SESSION_CHUNK_BYTES } from './session-chunks.js';

export const SESSION_STORAGE_VERSION = 8;
const FIELDS = ['schemaVersion', 'kind', 'sessionId', 'cwd', 'state', 'createdAt', 'updatedAt', 'root'];
const SUMMARY = ['sessionId', 'cwd', 'state', 'createdAt', 'updatedAt'];

// Logical schema validation remains owned by portable-codec. This boundary
// validates the physical representation before giving that codec its input.
export async function decodeStoredManifest(bytes, chunks, sessionId) {
  const value = JSON.parse(bytes);
  if (value?.schemaVersion !== SESSION_STORAGE_VERSION) return value;
  if (Buffer.byteLength(bytes) > MAX_SESSION_CHUNK_BYTES ||
      !value || Array.isArray(value) || Object.keys(value).length !== FIELDS.length ||
      FIELDS.some((key) => !Object.hasOwn(value, key)) ||
      value.kind !== 'captain-session-storage' || value.sessionId !== sessionId) {
    throw new Error('invalid bounded session manifest');
  }
  const manifest = await chunks.readJson(value.root);
  if (manifest?.schemaVersion !== 7 || SUMMARY.some((key) => manifest[key] !== value[key])) {
    throw new Error('bounded session summary differs from recovery');
  }
  return manifest;
}

export async function encodeStoredManifest(manifest, chunks) {
  const root = await chunks.writeJson(manifest);
  const value = { schemaVersion: SESSION_STORAGE_VERSION, kind: 'captain-session-storage' };
  for (const key of SUMMARY) value[key] = manifest[key];
  value.root = root;
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_SESSION_CHUNK_BYTES) throw new Error('session manifest summary exceeds file bound');
  return bytes;
}
