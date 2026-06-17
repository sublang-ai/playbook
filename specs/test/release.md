<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# RELEASE: Release Workflow

## Intent

This spec defines the integration tests for the published
`@sublang/playbook` install closure and public package surfaces.

## Install closure

### RELEASE-13
Verifies: [RELEASE-12](../dev/release.md#release-12)

When the publishable tarball (`npm pack`) is installed globally,
the smoke test shall fail unless `@sublang/cligent` is nested
inside the installed `@sublang/playbook` module tree and each
adapter SDK reports available when probed from
`@sublang/cligent`'s installed location.

### RELEASE-19
Verifies: [RELEASE-14](../dev/release.md#release-14)

The test suite shall fail unless `package.json` declares
`@sublang/cligent` as `^0.12.0` and the root importer in
`pnpm-lock.yaml` records the same specifier.

## Public surfaces

### RELEASE-17
Verifies: [RELEASE-16](../dev/release.md#release-16)

The test suite shall fail unless each of
`@sublang/playbook/slc/link.md`, `@sublang/playbook/slc/gears2fsm.md`,
and `@sublang/playbook/slc/text2gears.md` resolves via
`import.meta.resolve` to an existing file whose contents are readable.

### RELEASE-18
Verifies: [RELEASE-15](../dev/release.md#release-15), [RELEASE-16](../dev/release.md#release-16)

The test suite shall fail unless `npm pack --dry-run` lists the
`@sublang/playbook/runtime` `.js` and `.d.ts` artifacts and all three
`slc/*.md` files among the packed contents.
