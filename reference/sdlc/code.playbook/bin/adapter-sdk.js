// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// PBCLI-39/40 (DR-026): the agent SDKs are optional peer dependencies, so
// an install carries only the stacks the user asked for. Their absence has
// to be a named gate failure rather than a mid-turn adapter error, which is
// what this probe provides for both the interactive launcher and `run`.

// PBCLI-39: adapter shorthand -> the SDK its cligent adapter demand-loads,
// and the cligent module that performs that load. Adapters absent from this
// map have no SDK the launcher knows how to name; they are excluded from
// the result and stay covered by PBCLI-12's unknown-adapter warning.
export const ADAPTER_SDKS = {
  claude: {
    sdk: '@anthropic-ai/claude-agent-sdk',
    module: '@sublang/cligent/adapters/claude-code',
    export: 'ClaudeCodeAdapter',
  },
  codex: {
    sdk: '@openai/codex-sdk',
    module: '@sublang/cligent/adapters/codex',
    export: 'CodexAdapter',
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
      .map((adapter) => ({ adapter, sdk: ADAPTER_SDKS[adapter].sdk })),
  };
}

// PBCLI-40: name every unavailable adapter and, for each, the exact command
// that supplies it, so the remedy never requires reading a spec.
export function adapterSdkFailureLines(missingAdapters) {
  if (missingAdapters.length === 0) return [];
  return [
    `Adapter SDKs not installed: ${missingAdapters
      .map(({ adapter }) => adapter)
      .join(', ')}`,
    ...missingAdapters.map(({ sdk }) => `  npm install -g ${sdk}`),
    '',
  ];
}
