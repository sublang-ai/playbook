// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// One machine identity per user and machine (DR-087, playbook-cli-97): a
// tagged value read from a private file under the XDG state directory,
// published once and exclusively, never replaced, and carried in the
// `hostname` field of session leases and repository claims in place of
// `os.hostname()`, which the network renames.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { sameFileIdentity, syncDirectory, tightenPrivateEntry } from './private-paths.js';

export const MACHINE_IDENTITY_TAG_PREFIX = 'machine-id:v1:';
export const PLAYBOOK_MACHINE_IDENTITY_UNAVAILABLE =
  'PLAYBOOK_MACHINE_IDENTITY_UNAVAILABLE';

const IDENTITY_FILE = 'machine-id';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLISH_ATTEMPTS = 3;
// A publication links its complete temporary into place and unlinks the
// temporary right after, so a reader can meet the file with two links for
// an instant; it re-reads a few times before calling that a hard link.
const LINK_SETTLE_ATTEMPTS = 10;
const LINK_SETTLE_DELAY_MS = 20;
const DEFAULT_FS_OPERATIONS = Object.freeze({
  chmod,
  link,
  lstat,
  mkdir,
  open,
  unlink,
});
const resolved = new Map();

/** Exactly the tagged form: the prefix and one lowercase UUID. */
export function isMachineIdentity(value) {
  return (
    typeof value === 'string' &&
    value.startsWith(MACHINE_IDENTITY_TAG_PREFIX) &&
    UUID_PATTERN.test(value.slice(MACHINE_IDENTITY_TAG_PREFIX.length))
  );
}

/** How a lease or claim reader reads an owner's `hostname` field
 * (playbook-cli-23): the exact tag is an identity compared with this
 * machine's; a value that begins like the tag but fails its form is
 * unverifiable; anything else is a legacy host name compared with the
 * current one. */
export function classifyOwnerMachine(value, localIdentity, legacyHostname) {
  if (isMachineIdentity(value)) {
    return value === localIdentity ? 'local' : 'foreign';
  }
  if (typeof value === 'string' && value.startsWith('machine-id:')) {
    return 'unverifiable';
  }
  return value === legacyHostname ? 'local' : 'foreign';
}

/** A reader's word for an owner's `hostname` value in a diagnostic. */
export function describeOwnerMachine(value) {
  return isMachineIdentity(value)
    ? `another machine (identity ${JSON.stringify(value)})`
    : `foreign host ${JSON.stringify(value)}`;
}

export function machineIdentityPath(env = process.env, home = homedir()) {
  const stateHome =
    typeof env.XDG_STATE_HOME === 'string' && env.XDG_STATE_HOME.trim().length > 0
      ? env.XDG_STATE_HOME
      : join(
          typeof env.HOME === 'string' && env.HOME.trim().length > 0 ? env.HOME : home,
          '.local',
          'state',
        );
  return join(stateHome, 'playbook', IDENTITY_FILE);
}

class MachineIdentityUnavailableError extends Error {
  constructor(path, reason) {
    super(`machine identity file ${path} is unavailable: ${reason}`);
    this.name = 'MachineIdentityUnavailableError';
    this.code = PLAYBOOK_MACHINE_IDENTITY_UNAVAILABLE;
    this.path = path;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Read the identity, publishing one when none exists; the result is kept
 * for the process, and a refusal is not, so a repaired file is read next
 * time. */
export function resolveMachineIdentity(options = {}) {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? homedir();
  const path = machineIdentityPath(env, home);
  if (options.fsOps === undefined && resolved.has(path)) return resolved.get(path);
  const pending = readOrPublish(path, {
    ...DEFAULT_FS_OPERATIONS,
    ...(options.fsOps ?? {}),
  }, options.createIdentity ?? randomUUID);
  if (options.fsOps === undefined) {
    resolved.set(path, pending);
    pending.catch(() => resolved.delete(path));
  }
  return pending;
}

/** One store's or coordinator's lazy resolution (playbook-cli-97): the
 * first identity it resolves is kept for its lifetime, and a refusal is
 * not, so its next lease or claim resolves again once the file is
 * repaired. */
export function lazyMachineIdentity(resolve) {
  let pending;
  return () => {
    if (pending === undefined) {
      const attempt = Promise.resolve(resolve());
      pending = attempt;
      attempt.catch(() => {
        if (pending === attempt) pending = undefined;
      });
    }
    return pending;
  };
}

async function readOrPublish(path, fs, createIdentity) {
  const directory = dirname(path);
  await prepareDirectory(directory, path, fs);
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
    const existing = await readIdentity(path, fs);
    if (existing !== undefined) return existing;
    await publish(path, directory, fs, createIdentity);
  }
  throw new MachineIdentityUnavailableError(path, 'the identity could not be published');
}

async function prepareDirectory(directory, path, fs) {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (cause) {
    if (cause?.code !== 'ENOENT') {
      throw new MachineIdentityUnavailableError(path, `its directory cannot be read: ${errorMessage(cause)}`);
    }
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      stat = await fs.lstat(directory);
    } catch (creation) {
      throw new MachineIdentityUnavailableError(path, `its directory cannot be created: ${errorMessage(creation)}`);
    }
  }
  try {
    await tightenPrivateEntry(directory, stat, true, fs, 'machine identity directory');
  } catch (cause) {
    throw new MachineIdentityUnavailableError(path, errorMessage(cause));
  }
}

async function readIdentity(path, fs) {
  let before;
  for (let attempt = 0; ; attempt += 1) {
    try {
      before = await fs.lstat(path);
    } catch (cause) {
      if (cause?.code === 'ENOENT') return undefined;
      throw new MachineIdentityUnavailableError(path, `it cannot be read: ${errorMessage(cause)}`);
    }
    if (
      before.nlink <= 1 ||
      before.isSymbolicLink() ||
      !before.isFile() ||
      attempt >= LINK_SETTLE_ATTEMPTS
    ) {
      break;
    }
    await new Promise((settle) => setTimeout(settle, LINK_SETTLE_DELAY_MS));
  }
  let current;
  try {
    current = await tightenPrivateEntry(path, before, false, fs, 'machine identity file');
  } catch (cause) {
    throw new MachineIdentityUnavailableError(path, errorMessage(cause));
  }
  let text;
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(current, opened)) {
      throw new MachineIdentityUnavailableError(path, 'it changed while being read');
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile());
  } catch (cause) {
    if (cause instanceof MachineIdentityUnavailableError) throw cause;
    throw new MachineIdentityUnavailableError(path, `it cannot be read: ${errorMessage(cause)}`);
  } finally {
    await handle.close();
  }
  const value = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!isMachineIdentity(value) || value.includes('\n')) {
    throw new MachineIdentityUnavailableError(path, 'it does not hold one machine identity');
  }
  return value;
}

async function publish(path, directory, fs, createIdentity) {
  const uuid = createIdentity();
  const value = `${MACHINE_IDENTITY_TAG_PREFIX}${uuid}`;
  if (!isMachineIdentity(value)) {
    throw new MachineIdentityUnavailableError(path, 'the identity generator returned an invalid value');
  }
  const temporary = join(directory, `.${IDENTITY_FILE}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${value}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.link(temporary, path);
    } catch (cause) {
      // Another creator published first; its complete file is read next.
      if (cause?.code === 'EEXIST') return;
      throw cause;
    }
    await fs.unlink(temporary);
    await syncDirectory(directory, fs);
  } catch (cause) {
    throw new MachineIdentityUnavailableError(path, `it cannot be published: ${errorMessage(cause)}`);
  } finally {
    try {
      await handle?.close();
    } catch {
      // The publication failure stands.
    }
    try {
      await fs.unlink(temporary);
    } catch {
      // A temporary already gone leaves nothing to remove.
    }
  }
}
