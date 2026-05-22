<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# RELEASE: Release Workflow

## Intent

This spec defines the integration test for the published
`@sublang/playbook` install closure.

## Install closure

### RELEASE-13
Verifies: [RELEASE-12](../dev/release.md#release-12)

When the publishable tarball (`npm pack`) is installed globally,
the smoke test shall fail unless `@sublang/cligent` is nested
inside the installed `@sublang/playbook` module tree and each
adapter SDK reports available when probed from
`@sublang/cligent`'s installed location.
