// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // NodeNext-style `import './foo.js'` specifiers exist in the
      // source so the compiled output resolves at runtime. During
      // tests, route them back to the `.ts` source via Vite's
      // transformer — that way `pnpm test` doesn't need a prior
      // `pnpm build` and can't be tripped by a stale `.js` sitting
      // next to a freshly-edited `.ts`.
      { find: /^(\.\/.*)\.js$/, replacement: '$1.ts' },
    ],
  },
  test: {
    // Confine the suite to the CODE playbook's tests under the slc
    // artifact directory. Subpackages (e.g., views/sketch) carry
    // their own vitest config and dependencies (jsdom, etc.);
    // running them from here would pull deps that aren't in this
    // package's lockfile.
    include: ['reference/sdlc/code.playbook/*.test.ts'],
  },
});
