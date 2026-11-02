// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The one verified tighten-only rule for private entries (session-storage-1):
// an entry qualifies only as current-user-owned and non-symlink — a file
// also as a single-link regular file — with its owner bits present; a
// qualifying entry with excess permissions is restricted through an opened
// handle whose identity is compared before and after, so a link swapped in
// between check and use cannot be tightened in its place. The session store
// applies it to the sessions directory and its files; the machine identity
// applies it to its state directory and file (playbook-cli-97).

import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
// POSIX hosts retain the existing Node floor and never load the optional
// Windows mechanism. Native Windows requires Node 22.19 or newer.
const windowsPermissions = process.platform === 'win32'
  ? createRequire(import.meta.url)('@openclaw/fs-safe/permissions') : undefined;

// The library owns Windows descriptor inspection and creation. This is the
// store's admission policy, deliberately conservative even for unusual ACEs.
export function privatePermissions(stat, mode, path) {
  if (process.platform !== 'win32') return (Number(stat.mode) & 0o7777) === mode;
  if (!path) throw new Error('private Windows permission checks require the entry path');
  const facts = windowsPermissions.readOwnerAndDacl(path);
  if (facts.status !== 'supported' || !facts.complete || !facts.isLocal || !facts.daclPresent || facts.unsupportedAceTypes.length) return false;
  const trusted = new Set([facts.currentUserSid, 's-1-5-18', 's-1-5-32-544']);
  return trusted.has(facts.ownerSid) && facts.aces.every(ace =>
    ace.aceType === 'deny' || ace.mask === 0 || trusted.has(ace.sid));
}

export async function mkdirPrivate(path, fs, options = {}) {
  if (process.platform !== 'win32') return fs.mkdir(path, { ...options, mode: 0o700 });
  if (options.recursive) {
    try { await fs.lstat(dirname(path)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdirPrivate(dirname(path), fs, { recursive: true });
    }
  }
  try { await windowsPermissions.createPrivateDirectory(path); }
  catch (error) {
    if (error.code !== 'EEXIST' || !options.recursive) throw error;
  }
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !privatePermissions(stat, 0o700, path)) {
    throw new Error('private Windows directory permission verification failed');
  }
}

export function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function verifyPrivateEntry(stat, directory, label, uid = process.getuid?.(), path) {
  const required = directory ? 0o700 : 0o600;
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    (uid !== undefined && stat.uid !== uid) ||
    (process.platform === 'win32' ? !privatePermissions(stat, required, path) : (stat.mode & required) !== required)
  ) {
    throw new Error(`${label} refuses unsafe ownership, links, type, or owner access`);
  }
}

export async function tightenPrivateEntry(path, before, directory, fs, label) {
  const uid = process.getuid?.();
  verifyPrivateEntry(before, directory, label, uid, path);
  // Keep descriptor identity checks on both platforms; Windows admits ACLs
  // without attempting POSIX fchmod on the opened directory.
  const handle = await fs.open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0) |
      (directory ? constants.O_DIRECTORY ?? 0 : 0),
  );
  try {
    const opened = await handle.stat();
    verifyPrivateEntry(opened, directory, label, uid, path);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`${label}: the entry changed during permission preparation`);
    }
    const mode = directory ? 0o700 : 0o600;
    if (process.platform !== 'win32' && (opened.mode & 0o7777) !== mode) await handle.chmod(mode);
    const after = await handle.stat();
    verifyPrivateEntry(after, directory, label, uid, path);
    const current = await fs.lstat(path);
    verifyPrivateEntry(current, directory, label, uid, path);
    if (
      !sameFileIdentity(after, current) ||
      !privatePermissions(after, mode, path) ||
      !privatePermissions(current, mode, path)
    ) {
      throw new Error(`${label}: permission tightening could not be verified`);
    }
    return current;
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(path, fs) {
  if (process.platform === 'win32') return;
  let directory;
  try {
    directory = await fs.open(path, 'r');
    await directory.sync();
  } finally {
    await directory?.close();
  }
}
