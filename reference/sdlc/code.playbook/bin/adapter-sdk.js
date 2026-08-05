// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-39/40 (DR-027): the agent runtimes are cligent's to know. This
// module keeps only cligent module-path knowledge — which subpath exports
// which adapter class — and derives every runtime identity, supported
// floor, and repair from cligent's shipped descriptor, so a cligent
// upgrade alone moves the compatibility policy. A runtime's absence or
// staleness has to be a named gate failure rather than a mid-turn adapter
// error, which is what this probe provides for both the interactive
// launcher and `run`.

import { readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyRuntime } from '@sublang/cligent';
import { AGENT_RUNTIME_TARGETS } from '@sublang/cligent/runtime-targets';

// PBCLI-39: adapter shorthand -> the cligent module that constructs it.
// This is API-shape knowledge, not version knowledge; versions, floors,
// and repairs come from the descriptor. Adapters absent from cligent's
// descriptor are excluded from the gate and stay covered by PBCLI-12's
// unknown-adapter warning.
export const ADAPTER_MODULES = {
  claude: {
    module: '@sublang/cligent/adapters/claude-code',
    export: 'ClaudeCodeAdapter',
  },
  codex: {
    module: '@sublang/cligent/adapters/codex',
    export: 'CodexAdapter',
  },
  // DR-027 ends gemini's exemption: its missing-SDK rationale was true but
  // incomplete — the CLI can be absent or below cligent's floor, and the
  // descriptor names both.
  gemini: {
    module: '@sublang/cligent/adapters/gemini',
    export: 'GeminiAdapter',
  },
  kimi: {
    module: '@sublang/cligent/adapters/kimi',
    export: 'KimiAdapter',
  },
  opencode: {
    module: '@sublang/cligent/adapters/opencode',
    export: 'OpenCodeAdapter',
  },
};

// PBCLI-39: probe through cligent's own adapter rather than by resolution.
// `isAvailable()` performs the same load the adapter performs at run time,
// from cligent's installed module scope — and since cligent enforces its
// version floors inside that same loader, a passing probe cannot disagree
// with a failing run, for absence and for staleness alike.
export async function probeAdapterSdk(adapter) {
  const entry = ADAPTER_MODULES[adapter];
  if (entry === undefined) return true;
  try {
    const AdapterClass = (await import(entry.module))[entry.export];
    return await new AdapterClass().isAvailable();
  } catch {
    // An adapter module that cannot be imported at all is unavailable,
    // not an internal error — the remedy is the same install line.
    return false;
  }
}

// The descriptor rows for one adapter shorthand, in declaration order.
function runtimeTargetsFor(adapter) {
  return adapter in ADAPTER_MODULES
    ? (AGENT_RUNTIME_TARGETS[adapter] ?? [])
    : [];
}

// PBCLI-39: probe each distinct gated adapter at most once, and classify
// an unavailable adapter's runtimes through cligent's structured verdict.
// Only the runtimes at fault are reported: an `opencode` whose CLI is
// present and in range names the SDK alone, because the two halves have
// different repairs and naming a healthy one sends the user to install
// what is already there.
export async function checkAdapterSdks(
  adapters,
  probe = probeAdapterSdk,
  classify = classifyRuntime,
) {
  const known = [...new Set(adapters)].filter(
    (a) => runtimeTargetsFor(a).length > 0,
  );
  const results = await Promise.all(known.map((a) => probe(a)));
  const unusableAdapters = [];
  known.forEach((adapter, i) => {
    if (results[i]) return;
    const verdicts = runtimeTargetsFor(adapter).map((target) =>
      classify(target, false),
    );
    const unsupported = verdicts.filter((v) => v.state === 'unsupported');
    const missing = verdicts.filter(
      (v) => v.state === 'missing' && v.installed === undefined,
    );
    // When neither explains the failure (e.g. the cligent module itself
    // failed to import), fall back to every runtime so the gate still
    // blocks with a usable remedy.
    const culprits =
      unsupported.length > 0 || missing.length > 0
        ? [...unsupported, ...missing]
        : verdicts;
    unusableAdapters.push({ adapter, verdicts: culprits });
  });
  return { unusableAdapters };
}

// PBCLI-40: a run under `npx` / `npm exec` lives in npm's ephemeral cache
// tree. No `npm install` invocation reaches that tree — a global SDK install
// is not on its directory-ancestor walk — so the only honest remedy is to
// re-run with each SDK named as a sibling package of the same exec.
export function detectEphemeralNpxInstall(moduleUrl = import.meta.url) {
  return fileURLToPath(moduleUrl).split(sep).includes('_npx');
}

// PBCLI-39: the pinned repair specifiers of every descriptor-backed peer
// SDK in a lineup, deduplicated in descriptor order. The ephemeral re-run
// must be built from this full set: a fresh exec tree starts empty, so a
// re-run named after only the currently missing SDKs drops the ones this
// tree does have and alternates between vendors forever. Pinned specs also
// mean the re-run installs versions the gate accepts.
export function mappedSdksFor(adapters) {
  const distinct = new Set(adapters);
  const specs = [];
  for (const [adapter, targets] of Object.entries(AGENT_RUNTIME_TARGETS)) {
    if (!distinct.has(adapter) || !(adapter in ADAPTER_MODULES)) continue;
    for (const target of targets) {
      if (target.kind === 'peer' && !specs.includes(target.repairSpec)) {
        specs.push(target.repairSpec);
      }
    }
  }
  return specs;
}

// Minimal POSIX quoting so a preserved argument survives copy-paste; matches
// cligent's shared shellQuote. tmux-play is POSIX-only, so no cmd.exe form.
export function shellQuote(value) {
  if (/^[a-zA-Z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// The running package's own spec, so the re-run reinstalls exactly this
// version rather than whatever dist-tag `npx` would resolve today.
function selfPackageSpec() {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
    );
    if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
      return `${manifest.name}@${manifest.version}`;
    }
  } catch {
    // Fall through to the unpinned name.
  }
  return '@sublang/playbook';
}

// One clause describing a runtime verdict. `unsupported` carries versions,
// because "not installed" for a runtime that is installed sends the user
// hunting for something already present (PBCLI-40).
function describeVerdict(verdict) {
  const named = verdict.target.bundles ?? verdict.target.package;
  if (verdict.state === 'unsupported') {
    return `${named} ${verdict.installed} installed, >=${verdict.target.supportedFrom} required`;
  }
  return `${named} not installed`;
}

// PBCLI-40: name every unusable adapter with its per-runtime verdicts and,
// for each runtime at fault, the exact pinned command that supplies it.
// External CLIs are found through PATH, which an exec tree inherits, so
// their global install lines hold in both cases.
//
// options.requiredSdks: the full mapped-spec set of the lineup (see
// mappedSdksFor) — the ephemeral re-run is built from it, not from the
// missing subset. options.invocation: the original CLI arguments, preserved
// on the re-run so the printed command is executable as printed.
export function adapterSdkFailureLines(unusableAdapters, options = {}) {
  if (unusableAdapters.length === 0) return [];
  const ephemeralNpx = options.ephemeralNpx ?? detectEphemeralNpxInstall();
  const lines = [
    `Adapter runtimes not usable: ${unusableAdapters
      .map(
        ({ adapter, verdicts }) =>
          `${adapter} (${verdicts.map(describeVerdict).join('; ')})`,
      )
      .join(', ')}`,
  ];
  // External CLIs are found through PATH, which persists across exec trees
  // and installed prefixes alike, so their pinned global installs are keyed
  // to the runtimes actually at fault and hold in both branches. A CLI's
  // one-time steps (e.g. a login) follow its install.
  const cliInstalls = unusableAdapters.flatMap(({ verdicts }) =>
    verdicts
      .filter((v) => v.target.kind === 'cli')
      .flatMap((v) => [`npm install -g ${v.repair.spec}`, ...v.repair.steps]),
  );
  const peerInstalls = unusableAdapters.flatMap(({ verdicts }) =>
    verdicts
      .filter((v) => v.target.kind === 'peer')
      .map((v) => `npm install -g ${v.repair.spec}`),
  );
  if (ephemeralNpx) {
    const sdks =
      options.requiredSdks ??
      unusableAdapters.flatMap(({ verdicts }) =>
        verdicts
          .filter((v) => v.target.kind === 'peer')
          .map((v) => v.repair.spec),
      );
    const args = (options.invocation ?? [])
      .map((arg) => ` ${shellQuote(arg)}`)
      .join('');
    lines.push(
      '  This npx / npm exec run is ephemeral: no npm install reaches its tree.',
    );
    if (cliInstalls.length > 0) {
      // Prerequisites first: the re-run probes the CLI again, so following
      // the output top-to-bottom must install it before re-running.
      lines.push(
        '  First install the required CLI (it persists on PATH):',
        ...cliInstalls.map((command) => `    ${command}`),
      );
    }
    lines.push(
      `  ${cliInstalls.length > 0 ? 'Then re-run' : 'Re-run'} with every SDK your config needs named alongside the package:`,
      `    npx -y -p ${selfPackageSpec()}${sdks
        .map((sdk) => ` -p ${sdk}`)
        .join('')} playbook${args}`,
    );
  } else {
    lines.push(
      ...peerInstalls.map((command) => `  ${command}`),
      ...cliInstalls.map((command) => `  ${command}`),
    );
  }
  lines.push('');
  return lines;
}
