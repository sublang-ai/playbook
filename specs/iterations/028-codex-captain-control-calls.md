<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-028: Codex captain control calls

## Goal

Implement [DR-013 Addendum A1](../decisions/013-routing-only-captain-control.md#addendum-a1-prompt-level-isolation-for-adapters-without-tool-enforcement): stop requesting an explicit empty tool allowlist from a captain adapter that cannot enforce one, so a Codex captain runs instead of failing every Boss turn, while Claude keeps its provider-enforced tool-free isolation.

## Deliverables

- [x] DR-013 Addendum A1 records the decision, the degrade path, and the unknown-adapter default.
- [x] The launcher passes the resolved captain adapter to the shell as `captain.options.captainAdapter`.
- [x] The shell omits `allowedTools` on its own control calls, and on a runtime-requested empty allowlist it forwards, for adapters without provider-enforced tool restriction; a non-empty request stays fail-closed.
- [x] `playbook run`'s `callJudge` applies the same rule from its bound captain spec.
- [x] Both hosts wrap runtime judge prompts in one shared hidden-control envelope, so the prompt-level isolation A1 substitutes is present wherever the allowlist is omitted.
- [x] Acceptance tests pin both hosts across enforcing, non-enforcing, unknown, and absent adapters.
- [x] README, the seeded config template, CHANGELOG, and `specs/map.md` state the isolation trade for a Codex captain.

## Tasks

1. **Author the addendum and the spec surface.** _[done]_
   DR-013 A1, this iteration, amended CAPTAIN-31 and PBCLI-8/PBCLI-20, and new CAPTAIN-33/PBCLI-31 precede code changes.
2. **Pass the captain adapter through composition.** _[done]_
   `bin/playbook.js` emits `captain.options.captainAdapter`; the shell reads it at construction, since the tmux-play `CaptainContext` does not expose it.
3. **Apply the substitution in both hosts.** _[done]_
   `controlCallToolOptions` / `forwardedToolOptions` in `playbook-captain.ts`, and the same rule in `bin/run.js`'s `callJudge`.
4. **Pin acceptance tests.** _[done]_
   CAPTAIN-33 in `playbook-captain.test.ts`, PBCLI-31 and the PBCLI-14 composition assertion in `playbook.test.ts`.
5. **Document the trade.** _[done]_
   README Captain note, config-template comment, CHANGELOG entry, and `specs/map.md` rows.

## Acceptance criteria

- A shell built with `captainAdapter: 'codex'` issues every visible routing and hidden adjudication call with no `allowedTools` property while still requesting `resume: false` and the hidden-control envelope.
- A shell built with `claude`, an unrecognized adapter, or no `captainAdapter` requests `allowedTools: []` on those calls.
- A runtime-requested non-empty allowlist is forwarded unchanged, so a real restriction still fails closed on an adapter that cannot enforce it.
- Every headless judge prompt, on any adapter, reaches the captain agent inside the hidden-control envelope with the runtime prompt verbatim between its delimiters.
- `playbook run --captain codex` issues `callJudge` with no `allowedTools`; `claude`, `gemini`, and `opencode` captains issue it with `[]`.
- The composed tmux-play config carries `captain.options.captainAdapter`.
- `pnpm test` and `pnpm build` pass.
