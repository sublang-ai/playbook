<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# RELEASE: Release Workflow

## Intent

This spec defines the release workflow for publishing the
`@sublang/playbook` package — the reference CODE playbook
runtime + tmux-play adapter at `reference/sdlc/code.playbook/` —
to npm and tagging the corresponding GitHub release.

## Versioning

### RELEASE-1

The project shall follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html):
`MAJOR.MINOR.PATCH` where MAJOR indicates breaking changes, MINOR
indicates new features, and PATCH indicates bug fixes.

### RELEASE-2

The `version` in `reference/sdlc/code.playbook/package.json` shall
match the git tag (without the `v` prefix). The release workflow
shall verify this match before publishing.

## Changelog

### RELEASE-3

All notable changes shall be documented in `CHANGELOG.md` at the
repository root, following the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

### RELEASE-4

Before creating a release tag, the developer/agent shall:

1. Review all commits since the last release (`git log <last-tag>..HEAD`).
2. Ensure all notable changes are documented in `[Unreleased]`.
3. Add a new version section to `CHANGELOG.md` with the release date.
4. Move items from `[Unreleased]` to the new version section.
5. Update the comparison links at the bottom of the file.

### RELEASE-5

Changelog entries shall be grouped under these headings (in
order): `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
`Security`.

## Release Process

### RELEASE-6

Releases shall be triggered by pushing a git tag matching the
pattern `vMAJOR.MINOR.PATCH` (e.g., `v0.1.0`).

### RELEASE-7

The release workflow on GitHub shall:

1. Verify the tag version matches the `version` field in
   `reference/sdlc/code.playbook/package.json`.
2. Drop the dev-only `pnpm-workspace.yaml` override before install
   so the build sees the registry-pinned `@sublang/cligent` rather
   than the contributor-machine local link (see
   `reference/sdlc/code.playbook/.gitignore`).
3. Install with `pnpm install --frozen-lockfile`, then `pnpm build`
   and `pnpm test`.
4. Extract release notes for the tag version from the root
   `CHANGELOG.md` into a file (not a shell variable), so backticks
   and `$()` in the notes can't be interpreted as commands when the
   release is created.
5. Publish to npm with provenance attestation.
6. Create a GitHub Release with the extracted notes attached.

### RELEASE-8

The npm package shall be published with the `--provenance` flag
for supply-chain attestation. Authentication shall use npm OIDC
trusted publishing — static npm tokens shall not be used.

### RELEASE-9

The scoped `@sublang/playbook` package shall be published with
`--access public` to ensure public availability.

## Pre-release Checklist

### RELEASE-10

Before tagging a release, the developer/agent shall verify:

- [ ] All tests pass (`pnpm test` in
      `reference/sdlc/code.playbook/`).
- [ ] The compiled `.js` / `.d.ts` siblings are in sync with their
      `.ts` sources (the CI drift check from
      [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)).
- [ ] `CHANGELOG.md` is updated with the new version and date.
- [ ] `reference/sdlc/code.playbook/package.json` `version` is
      bumped and `private` is unset (or `false`).
- [ ] All changes are committed and pushed to `main`.
