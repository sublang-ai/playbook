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
`CallPlayerOptions.resume` selection accepted by
`CaptainContext.callPlayer`, plus `CallCaptainOptions.resume` and
`CallCaptainOptions.allowedTools` accepted by
`CaptainContext.callCaptain`.

### RELEASE-23

Verifies: [RELEASE-22](../dev/release.md#release-22)

The test suite shall fail unless `package.json` declares
`@sublang/spex` with a caret SemVer range whose floor is at least
0.3.0, the root importer in `pnpm-lock.yaml` records the same
specifier, and both `@sublang/spex/scaffold/specs/meta.md` and
`@sublang/spex/scaffold/i18n/zh/specs/meta.md` resolve from the repo
root to non-empty files.

## Public surfaces

### RELEASE-17

Verifies: [RELEASE-16](../dev/release.md#release-16)

The test suite shall fail unless each of
`@sublang/playbook/slc/link.md`, `@sublang/playbook/slc/gears2fsm.md`,
`@sublang/playbook/slc/text2gears.md`, and
`@sublang/playbook/slc/optimize.md` resolves via
`import.meta.resolve` to an existing file whose contents are readable.

### RELEASE-18

Verifies: [RELEASE-15](../dev/release.md#release-15), [RELEASE-16](../dev/release.md#release-16), [RELEASE-20](../dev/release.md#release-20), [CAPPLAY-6](../dev/captain-playbook.md#capplay-6)

The test suite shall fail unless `npm pack --dry-run` lists the
`@sublang/playbook/runtime` and `@sublang/playbook/xstate-runtime` `.js` and
`.d.ts` artifacts — including the `xstate-playbook-runtime` factory
siblings backing the engine subpath — and all four
`slc/*.md` files among the packed contents, plus
`reference/sdlc/captain.md`, the authored `reference/sdlc/code.md` and
`reference/sdlc/discuss.md` playbook sources, every `docs/*.md` guide the
README links to, `captain.gears.md`, and the
Captain FSM and linked-runtime `.ts`, `.js`, and `.d.ts` artifacts under
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

## Live pre-release acceptance

### RELEASE-25

Verifies: [RELEASE-24](../dev/release.md#release-24)

The opt-in local `pnpm test:acceptance` suite shall pack and install the
candidate package once, then exercise four independent fresh git repositories
through the installed npm `playbook` command shim.
The first case shall invoke `playbook run` with `--json` over a small fixture
playbook using one real Claude player and a real Codex captain for one hidden
judge call. It shall fail unless the installed headless host returns the exact
terminal JSON result, emits its start and finish statuses, creates no tmux
session, leaves `HEAD` unchanged, and leaves the repository clean with no
ignored or untracked artifacts.
The second case shall submit `/code` to real Claude and Codex agents and fail
unless the start and finish lifecycle markers appear, only the requested file
changes, its exact content is present in `HEAD`, and the worktree is clean.
The third, independent `/discuss` case shall fail unless the start and finish
lifecycle markers appear, only the requested spec item file changes, its
content is present in `HEAD`, its deliberately unimplemented file is absent
from both `HEAD` and the worktree, and the worktree is clean.
Each interactive case shall also fail unless the selected playbook leaves
exactly the Captain and its two namespaced role panes visible with their
expected adapters and the Boss/Captain pane focused.
The fourth, hermetic global-only case
([PBCLI-36](playbook-cli.md#pbcli-36)) shall install the packed
candidate into an isolated npm global prefix with inherited npm prefix
configuration neutralized, place a compiled thin fixture playbook —
importing `xstate` and `@sublang/playbook/xstate-runtime` and making
one real Claude player call and one real Codex judge call — in a fresh
git repository containing no `package.json`, lockfile, or
`node_modules` at any level, and invoke the prefix's `playbook` command
by absolute path.
It shall fail unless: neither engine import resolves from the fixture
before the run; the run prints one provisioning line and creates
exactly the `node_modules/xstate` and `node_modules/@sublang/playbook`
links resolving into the isolated prefix; the run returns its terminal
JSON envelope; a second run creates nothing further and prints no
provisioning line; and `@sublang/cligent` resolves from beneath the
prefix's `@sublang/playbook` rather than from any machine-global copy.

The acceptance suite shall require local adapter authentication, tmux, glow,
Expect, git, and npm. It shall not be selected by the normal `pnpm test`
configuration or by GitHub CI.
It shall stop after the first failed scenario rather than spend more model
calls, preserve the failed scenario artifacts, and report a bounded
terminal-control-stripped diagnostic snapshot outside the fixture repository.

## Conditional manual tmux UX smoke

### RELEASE-26

When a release changes the interactive CLI presentation or layout, or changes
the declared or locked `@sublang/cligent` version, a developer shall manually
launch the packed candidate's installed `playbook` command in a fresh
repository and verify:

- pane content, titles, colors, borders, and proportions are readable at the
  normal terminal size;
- narrowing, widening, and vertically resizing the terminal preserve usable
  wrapping and do not collapse or overlap the Boss pane;
- keyboard entry, pane switching, scrolling, selection, and copy behave
  naturally with both keyboard and mouse; and
- Ctrl-C exits cleanly, restores the parent terminal, and leaves no tmux-play
  session behind.

This human presentation check is conditional and does not replace
[RELEASE-25](#release-25); the real-model functional workflows shall not be
repeated manually — interactively or through `playbook run` — merely to
duplicate the automatic gate.
