// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The one verified tighten-only rule for private entries (session-storage-1):
// an entry qualifies only as current-user-owned and non-symlink — a file
// also as a single-link regular file — with its owner bits present; a
// qualifying entry with excess permissions is restricted through an opened
// handle whose identity is compared before and after, so a link swapped in
// between check and use cannot be tightened in its place. The session store
// applies it to the sessions directory and its files; the machine identity
// applies it to its state directory and file (playbook-cli-94).

import { constants } from 'node:fs';

export function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function verifyPrivateEntry(stat, directory, label, uid = process.getuid?.()) {
  const required = directory ? 0o700 : 0o600;
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & required) !== required
  ) {
    throw new Error(`${label} refuses unsafe ownership, links, type, or owner access`);
  }
}

export async function tightenPrivateEntry(path, before, directory, fs, label) {
  const uid = process.getuid?.();
  verifyPrivateEntry(before, directory, label, uid);
  const handle = await fs.open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0) |
      (directory ? constants.O_DIRECTORY ?? 0 : 0),
  );
  try {
    const opened = await handle.stat();
    verifyPrivateEntry(opened, directory, label, uid);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`${label}: the entry changed during permission preparation`);
    }
    const mode = directory ? 0o700 : 0o600;
    if ((opened.mode & 0o7777) !== mode) await handle.chmod(mode);
    const after = await handle.stat();
    verifyPrivateEntry(after, directory, label, uid);
    const current = await fs.lstat(path);
    verifyPrivateEntry(current, directory, label, uid);
    if (
      !sameFileIdentity(after, current) ||
      (after.mode & 0o7777) !== mode ||
      (current.mode & 0o7777) !== mode
    ) {
      throw new Error(`${label}: permission tightening could not be verified`);
    }
    return current;
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(path, fs) {
  let directory;
  try {
    directory = await fs.open(path, 'r');
    await directory.sync();
  } finally {
    await directory?.close();
  }
}
