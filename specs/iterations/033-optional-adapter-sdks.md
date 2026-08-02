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
- [x] The peer ranges identical to cligent's, so npm never rejects an
      application-owned SDK version the loader accepts.
- [x] The probe map covering exactly cligent's optional-peer SDK
      adapters — `opencode` gated with both its SDK and CLI remedies,
      `gemini` excluded because its transport SDK is cligent's regular
      dependency.
- [x] The ephemeral `npx` / `npm exec` path: a documented and
      CI-verified multi-package form, and a preflight that detects an
      exec tree and prints that re-run instead of an install command no
      tree walk would ever see.
- [x] Upgrade guidance presenting the in-place upgrade as a migration:
      npm prunes the previously bundled SDK stacks, so upgraders re-run
      the full documented line.

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
5. **Review-round corrections.** _[done]_ Align the codex peer range to
   cligent's exact `>=0.138.0` with RELEASE-27 demanding identity; map
   `opencode` into the preflight with SDK-plus-CLI remedies and narrow
   `gemini` out explicitly; add the exec-tree smoke shapes and the
   npx-aware remedy per amended RELEASE-12/13 and PBCLI-39/40/41; and
   replace the false upgrade-compatibility claim with the measured
   prune-and-reinstall migration in DR-026, README, `docs/cli.md`, and
   the changelog.
6. **One-hop ephemeral re-run.** _[done]_ Build the printed re-run from
   the lineup's full mapped SDK set instead of the missing subset —
   each distinct package set is a distinct exec tree, so a missing-only
   re-run alternated between partial trees forever — pin the running
   package's own version, and replay the original arguments
   shell-quoted in place of the literal `playbook ...` placeholder;
   amend PBCLI-40/41, RELEASE-13's partial exec shape with its CI leg,
   DR-026 §3, and the changelog accordingly.
7. **Stdin preservation and CLI ordering.** _[done]_ Append a
   stdin-consumed task or reply to the re-run as a quoted positional
   and print prerequisite external CLI installs before the ephemeral
   re-run; amend PBCLI-40/41, DR-026 §3, and the changelog.
8. **Flag-shaped stdin values.** _[done]_ Add the `--` end-of-options
   terminator to the `run` argument grammar and emit it before
   stdin-derived values on the re-run — quoting cannot stop a `--json`
   task or `--last` reply from being reinterpreted as an option, the
   latter silently resuming the wrong session — with first-run and
   resume round-trip tests; amend PBCLI-18/40/41, DR-026 §3, the run
   help text, and the changelog.

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
- A bare exec tree (`npm exec` / `npx` with the tarball alone) reports
  every adapter unavailable and the gate prints the multi-package
  re-run, not an install command; the same exec invocation with the
  SDKs as sibling packages reports them available.
- A partially supplied exec tree prints a re-run naming every lineup
  SDK — the supplied one included — at the running package's own
  version, ending with the original arguments shell-quoted and no
  placeholder, so following it succeeds in one hop.
- An application depending on the package plus `@openai/codex-sdk`
  0.138.0 installs without a peer conflict.
- An `opencode` lineup with its SDK unavailable blocks naming both
  `@opencode-ai/sdk` and `opencode-ai`.
- `pnpm test` passes with no pre-existing expectation modified.
