// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-36/37 (DR-024): probe-first engine provisioning for filesystem
// registry modules. A compiled thin artifact imports `xstate` and
// `@sublang/playbook/xstate-runtime`, which Node resolves by walking up
// from the artifact's own directory; a globally installed host therefore
// fails at artifact load in a bare directory. Before importing such a
// module, both `playbook` front ends probe both specifiers with the module's
// path as resolution parent and, only when a probe fails, symlink the running
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

export class EngineProvisioningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineProvisioningError';
    this.code = code;
  }
}

// PBCLI-36/37: host-neutral probe and provisioning core. It returns
// structured link notices and throws a coded error; CLI hosts own prefixes
// and streams, so the same preparation has no baked-in presentation.
export async function provisionEngine({
  modulePath,
  enabled = true,
  hostRoots,
}) {
  const missing = missingEngineLinks(modulePath);
  if (missing.length === 0) return { createdLinks: [] };

  const moduleDir = dirname(modulePath);
  if (!enabled) {
    // PBCLI-36: --no-provision still owes the dangling-link diagnostic —
    // a stale link we (or a prior host) created must not surface as a raw
    // module-not-found error.
    for (const name of missing) {
      const linkPath = join(moduleDir, 'node_modules', name);
      if (linkState(linkPath) === 'dangling') {
        throw new EngineProvisioningError(
          'stale-link',
          `${linkPath} is a stale engine link to missing ` +
            `${readlinkSync(linkPath)}; rerun without --no-provision to relink`,
        );
      }
    }
    return { createdLinks: [] };
  }

  const manifestPath = declaringManifest(moduleDir);
  if (manifestPath !== undefined) {
    throw new EngineProvisioningError(
      'declared-install-missing',
      `${manifestPath} declares @sublang/playbook; ` +
        'provisioning would shadow the project install — run the ' +
        "project's dependency install (e.g. npm install) instead",
    );
  }

  const roots = hostRoots ?? defaultHostRoots();

  // PBCLI-37: validate every destination before mutating any, so an
  // occupied-path refusal leaves the module directory unchanged rather
  // than half-provisioned.
  const plans = [];
  for (const name of missing) {
    const linkPath = join(moduleDir, 'node_modules', name);
    const state = linkState(linkPath);
    if (state === 'occupied' || state === 'live') {
      // A live-but-unresolvable link is as foreign as a real directory:
      // neither is a link this host may replace.
      throw new EngineProvisioningError(
        'occupied-link',
        `cannot provision ${linkPath}: the path is already ` +
          `occupied${state === 'live' ? ' by a foreign symbolic link' : ''}`,
      );
    }
    plans.push({
      linkPath,
      target: roots[name],
      dangling: state === 'dangling',
    });
  }

  try {
    for (const { linkPath, target, dangling } of plans) {
      if (dangling) await unlink(linkPath);
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(target, linkPath, 'dir');
    }
  } catch (error) {
    // PBCLI-37: a filesystem failure is a load fault, not a raw crash.
    throw new EngineProvisioningError(
      'filesystem',
      'cannot provision engine links: ' +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    createdLinks: plans.map(({ linkPath, target }) => ({
      path: linkPath,
      target,
    })),
  };
}

// PBCLI-36/46 (DR-024 as amended by DR-031): adapt the low-level
// probe/symlink operation to launch-config's prepare-or-throw contract. Both
// front ends install this hook, filesystem URLs are prepared before the
// catalog import transaction, and bare/custom specifiers stay untouched.
export function prepareConfiguredRegistries({
  enabled = true,
  stderr,
  hostRoots,
  commandName = 'playbook',
}) {
  return async ({ from }) => {
    if (!from.startsWith('file:')) return from;
    const result = await provisionEngine({
      modulePath: fileURLToPath(from),
      enabled,
      hostRoots,
    });
    if (result.createdLinks.length > 0) {
      await writeStream(
        stderr,
        `${commandName}: provisioned ${result.createdLinks
          .map(({ path, target }) => `${path} -> ${target}`)
          .join(', ')}\n`,
      );
    }
    return from;
  };
}

async function writeStream(stream, text) {
  const ready = stream.write(text);
  if (ready !== false || typeof stream.once !== 'function') return;
  await new Promise((resolvePromise, rejectPromise) => {
    const onDrain = () => {
      stream.off?.('error', onError);
      resolvePromise();
    };
    const onError = (error) => {
      stream.off?.('drain', onDrain);
      rejectPromise(error);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}
