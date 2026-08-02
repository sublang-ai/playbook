#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// RELEASE-13: probe every adapter SDK wired by the bundled production
// config, and assert the expected availability for the install shape under
// test. Run this from @sublang/cligent's INSTALLED directory: Node's
// walk-up for the SDK must start at the same tree cligent uses at run time.
// Probing from the prefix root, or from a hoisted project-local install,
// passes even when the SDK is unreachable to cligent.
//
// Usage: node smoke-adapters.mjs <available|unavailable>
//   available    the opted-in shape — tarball + each SDK as its own
//                top-level install root; every adapter must load.
//   unavailable  the lean shape — tarball alone; no adapter may load, which
//                is what keeps the DR-026 footprint fix from regressing.

import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';

const expected = process.argv[2];
if (expected !== 'available' && expected !== 'unavailable') {
  console.error('usage: smoke-adapters.mjs <available|unavailable>');
  process.exit(2);
}
const want = expected === 'available';

const checks = [
  ['claude adapter SDK', new ClaudeCodeAdapter()],
  ['codex adapter SDK', new CodexAdapter()],
];

let failed = 0;
for (const [label, adapter] of checks) {
  const got = await adapter.isAvailable();
  console.log(`${got === want ? 'OK  ' : 'FAIL'}  ${label} (${got ? 'loadable' : 'not loadable'})`);
  if (got !== want) failed++;
}

if (failed) {
  console.error(
    want
      ? `\n${failed} adapter SDK(s) are not loadable from cligent's installed ` +
          `location even though each was installed as its own top-level ` +
          `global root. The documented install command is broken: an SDK on ` +
          `the directory-ancestor walk from cligent must resolve (DR-026 §3).`
      : `\n${failed} adapter SDK(s) loaded from an install of the tarball ` +
          `ALONE. The SDKs are optional peers (RELEASE-12): a bare install ` +
          `must carry no agent stack, or the 466 MB footprint returns.`,
  );
  process.exit(1);
}
