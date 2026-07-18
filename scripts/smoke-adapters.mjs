#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';

const checks = [
  ['claude adapter SDK', new ClaudeCodeAdapter()],
  ['codex adapter SDK', new CodexAdapter()],
];

let failed = 0;
for (const [label, adapter] of checks) {
  const ok = await adapter.isAvailable();
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
}

if (failed) {
  console.error(
    `\n${failed} adapter SDK(s) are not loadable from the published install closure. ` +
    `The bundled production config wires these adapters, so the SDKs must be ` +
    `direct dependencies of @sublang/playbook — not optional peers of cligent.`,
  );
  process.exit(1);
}
