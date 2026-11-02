// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirPrivate, tightenPrivateEntry } from './bin/private-paths.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'playbook-private-path-'));
  roots.push(root);
  const directory = join(root, 'owner');
  await mkdirPrivate(directory, fs);
  return { root, directory };
}

describe('private directory preparation on real storage', () => {
  it('pins an opened directory and closes it without POSIX directory mutations on Windows', async () => {
    const { directory } = await fixture();
    const before = await fs.lstat(directory);
    const opened: fs.FileHandle[] = [];
    const operations = { ...fs, async open(...args: Parameters<typeof fs.open>) {
      const handle = await fs.open(...args);
      opened.push(handle);
      return new Proxy(handle, { get(target, key) {
        if (key === 'chmod' && process.platform === 'win32') return async () => { throw new Error('unsupported directory fchmod was called'); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    const after = await tightenPrivateEntry(directory, before, true, operations, 'fixture owner');
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(opened).toHaveLength(1);
    await expect(opened[0].stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('rejects directory replacement after open and closes the original handle', async () => {
    const { root, directory } = await fixture();
    const replacement = join(root, 'replacement');
    await mkdirPrivate(replacement, fs);
    const before = await fs.lstat(directory);
    const opened: fs.FileHandle[] = [];
    const operations = { ...fs, async open(...args: Parameters<typeof fs.open>) {
      const handle = await fs.open(...args);
      opened.push(handle);
      await fs.rename(directory, join(root, 'retained-owner'));
      await fs.rename(replacement, directory);
      return handle;
    } };
    await expect(tightenPrivateEntry(directory, before, true, operations, 'fixture owner')).rejects.toThrow('permission tightening could not be verified');
    expect(opened).toHaveLength(1);
    await expect(opened[0].stat()).rejects.toMatchObject({ code: 'EBADF' });
    expect((await fs.lstat(directory)).ino).not.toBe(before.ino);
    expect((await fs.lstat(join(root, 'retained-owner'))).ino).toBe(before.ino);
  });
});
