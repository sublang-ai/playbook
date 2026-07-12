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
`@sublang/cligent` with a caret SemVer range, the root importer in
`pnpm-lock.yaml` records the same specifier, and, unless the
[RELEASE-11](../dev/release.md#release-11) local-development
override is active, the lockfile records a concrete resolved
cligent version whose public tmux-play contract declares both the
pre-close `Captain.prepareDispose()` lifecycle and
`CallPlayerOptions.resume` selection accepted by `CaptainContext.callPlayer`.

## Public surfaces

### RELEASE-17

Verifies: [RELEASE-16](../dev/release.md#release-16)

The test suite shall fail unless each of
`@sublang/playbook/slc/link.md`, `@sublang/playbook/slc/gears2fsm.md`,
and `@sublang/playbook/slc/text2gears.md` resolves via
`import.meta.resolve` to an existing file whose contents are readable.

### RELEASE-18

Verifies: [RELEASE-15](../dev/release.md#release-15), [RELEASE-16](../dev/release.md#release-16), [RELEASE-20](../dev/release.md#release-20), [CAPPLAY-6](../dev/captain-playbook.md#capplay-6)

The test suite shall fail unless `npm pack --dry-run` lists the
`@sublang/playbook/runtime` and `@sublang/playbook/xstate-runtime` `.js` and
`.d.ts` artifacts and all three
`slc/*.md` files among the packed contents, plus
`reference/sdlc/captain.md`, `captain.gears.md`, and the Captain FSM and
linked-runtime `.ts`, `.js`, and `.d.ts` artifacts under
`reference/sdlc/captain.playbook/`; the complete generated Captain verification
bundle, including its `.slc-verify` support modules, shall remain canonical
repository artifacts, but those verification files need not be packed.

### RELEASE-21

Verifies: [RELEASE-20](../dev/release.md#release-20)

The test suite shall fail unless `package.json` declares a `playbook`
bin and no `playbook-code` bin, declares
`exports['./runtime']` and `exports['./xstate-runtime']`, declares
`exports['./code/registry']` and `exports['./discuss/registry']`
subpaths, declares `exports['./captain/playbook']`, declares neither
`exports['./captain/registry']` nor `exports['./code/tmux-play']`, and
`npm pack --dry-run` lists the `playbook` launcher entry and the
`code.registry` and `discuss.registry` `.js` and `.d.ts` artifacts
among the packed contents.
