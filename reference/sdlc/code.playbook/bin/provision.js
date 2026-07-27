// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-36/37 (DR-024): probe-first engine provisioning for filesystem
// registry modules. A compiled thin artifact imports `xstate` and
// `@sublang/playbook/xstate-runtime`, which Node resolves by walking up
// from the artifact's own directory; a globally installed host therefore
// fails at artifact load in a bare directory. Before importing such a
// module, `playbook run` probes both specifiers with the module's path as
// resolution parent and, only when a probe fails, symlinks the running
// host's own installed package roots beside the module. It never shells
// out to `npm link` and never installs from the registry.

import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { mkdir, symlink, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// PBCLI-37: probe specifier → the package name provisioning may link.
const ENGINE_LINKS = new Map([
  ['xstate', 'xstate'],
  ['@sublang/playbook/xstate-runtime', '@sublang/playbook'],
]);

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

// PBCLI-37: package names whose probes fail with the module as resolution
// parent. `createRequire` follows the same walk-up Node uses for the
// module's own imports, so an empty result means a project-local (or
// already provisioned) engine wins and provisioning must touch nothing.
function missingEngineLinks(modulePath) {
  const req = createRequire(modulePath);
  const missing = [];
  for (const [specifier, name] of ENGINE_LINKS) {
    try {
      req.resolve(specifier);
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

// PBCLI-36: a manifest at or above the module declaring @sublang/playbook
// means a project chose a dependency and its install is broken or absent;
// shadow-provisioning would mask the real fix.
function declaringManifest(startDir) {
  for (let dir = startDir; ; ) {
    const manifestPath = join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        for (const field of DEPENDENCY_FIELDS) {
          const block = manifest?.[field];
          if (
            block !== null &&
            typeof block === 'object' &&
            Object.prototype.hasOwnProperty.call(block, '@sublang/playbook')
          ) {
            return manifestPath;
          }
        }
      } catch {
        // An unreadable manifest cannot declare the dependency.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function packageRootUpward(startDir, name) {
  for (let dir = startDir; ; ) {
    const manifestPath = join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        if (JSON.parse(readFileSync(manifestPath, 'utf8')).name === name) {
          return dir;
        }
      } catch {
        // Keep walking past an unreadable manifest.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// PBCLI-37: the running host's own installed package roots, resolved from
// the host's module scope — this file lives inside @sublang/playbook, and
// xstate resolves from that root's own dependency tree.
function defaultHostRoots() {
  const here = dirname(fileURLToPath(import.meta.url));
  const playbookRoot = packageRootUpward(here, '@sublang/playbook');
  if (playbookRoot === undefined) {
    throw new Error(
      'cannot locate the running @sublang/playbook package root for provisioning',
    );
  }
  const req = createRequire(join(playbookRoot, 'package.json'));
  let xstateRoot;
  try {
    xstateRoot = packageRootUpward(dirname(req.resolve('xstate')), 'xstate');
  } catch {
    xstateRoot = undefined;
  }
  if (xstateRoot === undefined) {
    throw new Error(
      "cannot locate the running host's own xstate package for provisioning",
    );
  }
  return { xstate: xstateRoot, '@sublang/playbook': playbookRoot };
}

// 'absent' | 'dangling' | 'live' (a symlink with an existing target) |
// 'occupied' (a real file or directory, never removed).
function linkState(linkPath) {
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return 'absent';
  }
  if (!stat.isSymbolicLink()) return 'occupied';
  return existsSync(linkPath) ? 'live' : 'dangling';
}

// PBCLI-36/37: probe, then provision the missing engine links beside a
// filesystem registry module. Returns {} when the run may proceed (either
// nothing was needed or links were created and logged) or { code: 1 }
// after writing one `playbook run: <message>` diagnostic to stderr.
export async function provisionEngine({
  modulePath,
  stderr,
  enabled = true,
  hostRoots,
}) {
  const missing = missingEngineLinks(modulePath);
  if (missing.length === 0) return {};

  const moduleDir = dirname(modulePath);
  if (!enabled) {
    // PBCLI-36: --no-provision still owes the dangling-link diagnostic —
    // a stale link we (or a prior host) created must not surface as a raw
    // module-not-found error.
    for (const name of missing) {
      const linkPath = join(moduleDir, 'node_modules', name);
      if (linkState(linkPath) === 'dangling') {
        stderr.write(
          `playbook run: ${linkPath} is a stale engine link to missing ` +
            `${readlinkSync(linkPath)}; rerun without --no-provision to relink\n`,
        );
        return { code: 1 };
      }
    }
    return {};
  }

  const manifestPath = declaringManifest(moduleDir);
  if (manifestPath !== undefined) {
    stderr.write(
      `playbook run: ${manifestPath} declares @sublang/playbook; ` +
        'provisioning would shadow the project install — run the ' +
        "project's dependency install (e.g. npm install) instead\n",
    );
    return { code: 1 };
  }

  let roots;
  try {
    roots = hostRoots ?? defaultHostRoots();
  } catch (error) {
    stderr.write(
      `playbook run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { code: 1 };
  }

  const created = [];
  for (const name of missing) {
    const linkPath = join(moduleDir, 'node_modules', name);
    const state = linkState(linkPath);
    if (state === 'occupied' || state === 'live') {
      // A live-but-unresolvable link is as foreign as a real directory:
      // neither is a link this host may replace.
      stderr.write(
        `playbook run: cannot provision ${linkPath}: the path is already ` +
          `occupied${state === 'live' ? ' by a foreign symbolic link' : ''}\n`,
      );
      return { code: 1 };
    }
    if (state === 'dangling') await unlink(linkPath);
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(roots[name], linkPath, 'dir');
    created.push(`${linkPath} -> ${roots[name]}`);
  }
  stderr.write(`playbook run: provisioned ${created.join(', ')}\n`);
  return {};
}
