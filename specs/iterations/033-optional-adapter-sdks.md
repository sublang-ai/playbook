<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-033: Optional Adapter SDKs

## Goal

Implement [DR-026](../decisions/026-optional-adapter-sdks.md): move
`@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` from hard
`dependencies` to optional `peerDependencies`, so an install carries
only the agent stacks the user chose; add the adapter SDK preflight that
makes their absence a named, remediable gate failure on both the
interactive and the non-interactive path; and re-aim the release smoke
at the two install shapes users actually produce.

## Deliverables

- [x] DR-026, the rewritten [RELEASE-12](../dev/release.md#release-12)
      and [RELEASE-13](../test/release.md#release-13), new
      [RELEASE-27](../test/release.md#release-27), new
      [PBCLI-39](../dev/playbook-cli.md#pbcli-39)/[PBCLI-40](../user/playbook-cli.md#pbcli-40)/[PBCLI-41](../test/playbook-cli.md#pbcli-41),
      this record, and the map rows.
- [x] `package.json` declaring both SDKs as optional peers and as
      `devDependencies`, with `pnpm-lock.yaml` in agreement.
- [x] The SDK preflight in `bin/playbook.js` (readiness gate) and
      `bin/run.js` (bound agents), probing through cligent's own
      `adapter.isAvailable()` and naming the exact install line.
- [x] Integration tests per PBCLI-41, the declaration test per
      RELEASE-27, and the two-shape CI smoke per RELEASE-13.
- [x] README, `docs/cli.md`, and the seeded config template carrying the
      documented install line.

## Tasks

1. **Spec surface.** _[done]_ Author DR-026, rewrite RELEASE-12/13, add
   RELEASE-27 and PBCLI-39/40/41, author this record and the map rows.
2. **Declaration move.** _[done]_ Move both SDKs to optional peers plus
   `devDependencies` in `package.json`, refresh `pnpm-lock.yaml`, and add
   the RELEASE-27 declaration test.
3. **Preflight with integration tests.** _[done]_ Add the shared adapter
   SDK probe, wire it into the launcher readiness gate and the `run`
   agent binding, extend `playbook.test.ts` per PBCLI-41 with no existing
   expectation changed.
4. **Release gate and docs.** _[done]_ Rewrite `scripts/smoke-adapters.mjs`
   and the CI smoke job for the lean and opted-in shapes; update README,
   `docs/cli.md`, the config template comment, and `CHANGELOG.md`.

## Acceptance criteria

- A global install of the packed tarball alone contains no
  `@anthropic-ai` or `@openai` directory anywhere in its closure, keeps
  `@sublang/cligent` nested under `@sublang/playbook`, and reports both
  adapters unavailable when probed from cligent's installed location.
- The same install with both SDKs added as sibling roots reports both
  adapters available from that same location.
- With an adapter's SDK absent, `playbook` blocks the launch before
  spawning tmux-play, names the adapter and its `npm install -g` line,
  and exits non-zero with a status distinct from `127`; `playbook run`
  fails the same way before any agent call.
- With both SDKs present, every pre-existing readiness, launch, and run
  expectation holds unchanged.
- `pnpm test` passes with no pre-existing expectation modified.
