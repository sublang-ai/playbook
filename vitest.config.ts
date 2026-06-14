// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // NodeNext-style `import './foo.js'` specifiers exist in the
    // source so the compiled output resolves at runtime. During
    // tests, route them back to the `.ts` source — that way `pnpm
    // test` doesn't need a prior `pnpm build` and can't be tripped by
    // a stale `.js` sitting next to a freshly-edited `.ts`.
    //
    // Scope the rewrite to this project's own sources: rewrite only
    // when a sibling `.ts` actually exists next to the importer. A
    // plain regex alias would also catch the same-shaped relative
    // imports inside compiled dependencies (e.g. the published — or
    // link-local — `@sublang/cligent` dist, whose `index.js` does
    // `import './config.js'`), rewriting them to a `.ts` that isn't
    // there and breaking resolution. Those deps ship no `.ts`, so the
    // existence check leaves them on their real `.js`.
    {
      name: 'playbook-source-js-to-ts',
      enforce: 'pre',
      resolveId(source: string, importer: string | undefined) {
        if (importer === undefined) return null;
        const match = /^(\.\/.*)\.js$/.exec(source);
        if (match === null) return null;
        const importerPath = importer.startsWith('file://')
          ? fileURLToPath(importer)
          : importer;
        const tsPath = resolve(dirname(importerPath), `${match[1]}.ts`);
        return existsSync(tsPath) ? tsPath : null;
      },
    },
  ],
  test: {
    // Confine the suite to the CODE playbook's tests under the slc
    // artifact directory. Subpackages (e.g., views/sketch) carry
    // their own vitest config and dependencies (jsdom, etc.);
    // running them from here would pull deps that aren't in this
    // package's lockfile.
    include: ['src/*.test.ts', 'reference/sdlc/code.playbook/*.test.ts'],
  },
});
