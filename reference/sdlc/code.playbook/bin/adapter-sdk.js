// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-39/40 (DR-026): the agent SDKs are optional peer dependencies, so
// an install carries only the stacks the user asked for. Their absence has
// to be a named gate failure rather than a mid-turn adapter error, which is
// what this probe provides for both the interactive launcher and `run`.

import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// PBCLI-39: adapter shorthand -> the optional peer SDK its cligent adapter
// demand-loads, the cligent module that performs that load, and any external
// CLI the adapter's own availability probe additionally requires. The map
// covers exactly the adapters backed by cligent's optional peer SDKs;
// gemini is excluded by design — its transport SDK is a regular dependency
// of cligent, so it has no missing-SDK failure mode to gate. Adapters absent
// from this map are excluded from the result and stay covered by PBCLI-12's
// unknown-adapter warning.
export const ADAPTER_SDKS = {
  claude: {
    sdk: '@anthropic-ai/claude-agent-sdk',
    module: '@sublang/cligent/adapters/claude-code',
    export: 'ClaudeCodeAdapter',
    clis: [],
  },
  codex: {
    sdk: '@openai/codex-sdk',
    module: '@sublang/cligent/adapters/codex',
    export: 'CodexAdapter',
    clis: [],
  },
  opencode: {
    sdk: '@opencode-ai/sdk',
    module: '@sublang/cligent/adapters/opencode',
    export: 'OpenCodeAdapter',
    // OpenCode's managed default also spawns the `opencode` binary, and its
    // isAvailable() probes both — so the remedy must name both installs.
    clis: ['opencode-ai'],
  },
};

// PBCLI-39: probe through cligent's own adapter rather than by resolution.
// `isAvailable()` performs the same dynamic import the adapter performs at
// run time, from cligent's installed module scope — so a passing probe
// cannot disagree with a failing run. Resolution-based probes are wrong
// here: neither SDK exports `./package.json`, and @openai/codex-sdk is
// ESM-only, so `createRequire(...).resolve()` reports both absent when
// they are present.
export async function probeAdapterSdk(adapter) {
  const entry = ADAPTER_SDKS[adapter];
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

// PBCLI-39: probe each distinct known adapter at most once and report the
// unavailable ones in declaration order.
export async function checkAdapterSdks(adapters, probe = probeAdapterSdk) {
  const known = [...new Set(adapters)].filter((a) => a in ADAPTER_SDKS);
  const results = await Promise.all(known.map((a) => probe(a)));
  return {
    missingAdapters: known
      .filter((_, i) => !results[i])
      .map((adapter) => ({
        adapter,
        sdk: ADAPTER_SDKS[adapter].sdk,
        clis: ADAPTER_SDKS[adapter].clis,
      })),
  };
}

// PBCLI-40: a run under `npx` / `npm exec` lives in npm's ephemeral cache
// tree. No `npm install` invocation reaches that tree — a global SDK install
// is not on its directory-ancestor walk — so the only honest remedy is to
// re-run with each SDK named as a sibling package of the same exec.
export function detectEphemeralNpxInstall(moduleUrl = import.meta.url) {
  return fileURLToPath(moduleUrl).split(sep).includes('_npx');
}

// PBCLI-40: name every unavailable adapter and, for each, the exact command
// that supplies it, so the remedy never requires reading a spec. External
// CLIs are found through PATH, which an exec tree inherits, so their global
// install lines hold in both cases.
export function adapterSdkFailureLines(missingAdapters, options = {}) {
  if (missingAdapters.length === 0) return [];
  const ephemeralNpx = options.ephemeralNpx ?? detectEphemeralNpxInstall();
  const lines = [
    `Adapter SDKs not installed: ${missingAdapters
      .map(({ adapter }) => adapter)
      .join(', ')}`,
  ];
  if (ephemeralNpx) {
    lines.push(
      '  This npx / npm exec run is ephemeral: no npm install reaches its tree.',
      '  Re-run with each SDK named alongside the package:',
      `    npx -y -p @sublang/playbook${missingAdapters
        .map(({ sdk }) => ` -p ${sdk}`)
        .join('')} playbook ...`,
    );
  } else {
    lines.push(...missingAdapters.map(({ sdk }) => `  npm install -g ${sdk}`));
  }
  for (const { clis } of missingAdapters) {
    lines.push(...(clis ?? []).map((cli) => `  npm install -g ${cli}`));
  }
  lines.push('');
  return lines;
}
