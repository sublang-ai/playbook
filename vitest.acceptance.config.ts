// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Live acceptance is intentionally outside the normal `pnpm test` suite.
    // It spends real model calls and is run locally only before a release.
    include: ['acceptance/**/*.acceptance.test.ts'],
    bail: 1,
    fileParallelism: false,
    hookTimeout: 10 * 60_000,
    testTimeout: 25 * 60_000,
  },
});
