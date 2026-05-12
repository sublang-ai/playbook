<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# tmux-play end-to-end acceptance — CODE playbook (prep template)

> **Status: prep template — Task 14 is NOT yet complete.**
> This file documents the manual procedure and the static
> pre-conditions for [IR-004 Task 14](../../../specs/iterations/004-link-code-fsm-to-playbook-runtime.md),
> but it does **not** yet record an executed acceptance run.
> The live pass-criteria checklist is unchecked and the "Recorded
> run" block at the bottom is empty.
> Task 14 completes when an operator (a) performs the live
> tmux-play session per the procedure below, (b) fills in every
> live pass-criteria checkbox with the observed outcome, and (c)
> completes the Recorded-run block with date, operator, revisions,
> adapters, outcome, and notes.
> Once that happens, the banner can be removed.

This artifact will be recorded next to
[`tmux-play.config.yaml`](./tmux-play.config.yaml) per the IR's
"recorded as code.tmux-play.acceptance.md" instruction.
The covered scope is the IR's end-to-end acceptance criterion
(4/6/6 layout + `/start` walk + coder streaming + `/interrupt`
redirect + clean Ctrl-C teardown).

The file has two halves:

- **Static pre-conditions** that can be verified from any workstation
  without launching tmux-play.
  Filled in below from the IR-004 implementation work and are part
  of the prep that already landed.
- **Live procedure** — the actual tmux-play run.
  Left as a checklist plus an empty "Recorded run" block to be
  filled in by whoever performs the test; *these* are the parts
  Task 14's completion requires.

## Static pre-conditions (verified at landing)

These were verified during IR-004 implementation; re-run them on
a fresh checkout if any input changed since.

- [x] `pnpm install` resolves cleanly from
  [`reference/sdlc/code.playbook/`](./).
- [x] Local cligent checkout linked via
  `pnpm link <path-to-cligent>` per the [README install
  section](./README.md#install-development); verified with
  ``node --input-type=module -e "import('@sublang/cligent/tmux-play').then(() => console.log('ok'))"``.
- [x] `pnpm build` emits all four expected artifacts next to their
  `.ts` sources: `code.fsm.js`, `code.playbook.js`,
  `code.tmux-play.js`, plus the matching `.d.ts` siblings.
- [x] `pnpm test` is green: 72/72 vitest cases across
  [`code.playbook.test.ts`](./code.playbook.test.ts) (60) and
  [`code.tmux-play.test.ts`](./code.tmux-play.test.ts) (12).
- [x] [`tmux-play.config.yaml`](./tmux-play.config.yaml) loads via
  cligent's `loadTmuxPlayConfig` with every field at the expected
  value (`captain.from: ./code.tmux-play.js`,
  `captain.adapter: claude`, options for `coderPlayer` /
  `reviewerPlayer`, roles `coder@claude` and `reviewer@codex`).

## Live procedure

### Environment prerequisites

- [ ] `tmux` installed and on `$PATH`.
- [ ] The two role adapters declared in `tmux-play.config.yaml`
  installed locally (default config uses `claude` for the coder
  and `codex` for the reviewer; the captain pane also uses
  `claude`).
- [ ] API keys / credentials configured for each adapter per the
  upstream cligent docs.
- [ ] An interactive terminal (Ctrl-C teardown can't be exercised
  in a non-TTY environment).

### Steps

1. From the repo root, launch with the bundled config:
   ```bash
   tmux-play --config reference/sdlc/code.playbook/tmux-play.config.yaml
   ```
2. Observe the standard 4/6/6 layout — Captain pane on the left,
   Coder and Reviewer panes on the right (cligent's default
   `tmux-play` layout).
3. In the Boss prompt, type a concrete intent:
   ```
   /start add a sign-up form
   ```
4. Watch the Captain pane stream FSM-state status lines per
   DR-004 §9.  The expected walk is:
   ```
   State → planAndImplement
   State → commitCoderInitial
   State → reviewBossCommit{Specs|Code|Mixed}
   ```
   (The exact `reviewBossCommit*` variant depends on which guard
   the judge picks from `commitCoderInitial`'s `result` map.)
5. Confirm the Coder pane streams a real reply from the configured
   adapter while CODE-1 / CODE-15 are active.
6. In the Boss prompt, redirect with:
   ```
   /interrupt ready
   ```
   Confirm the Captain pane shows `State → ready` (the FSM's
   `bossInterrupts(jumpableStateIds)` handler with `reenter: true`
   accepts the jump per DR-004 §8).
7. Send Ctrl-C in the Boss pane.  Confirm the tmux session tears
   down cleanly — no orphaned `claude` / `codex` processes left
   behind, prompt returns to the parent shell.

### Pass criteria (IR-004 §Acceptance)

- [ ] 4/6/6 layout renders.
- [ ] `/start <intent>` drives the FSM through at least
  `planAndImplement → commitCoderInitial → reviewBossCommit*`.
- [ ] Coder pane streams a real reply from the configured adapter.
- [ ] Captain pane shows FSM-state status lines.
- [ ] `/interrupt ready` redirects to `ready`.
- [ ] Ctrl-C tears down cleanly.

## Recorded run (empty — fill in after performing the live procedure)

Replace the dashes with the observed values; the empty state of
this block is what flags the whole file as a prep template per
the banner at the top.

- Date: —
- Operator: —
- tmux-play / cligent revision: —
- Adapters used (coder / reviewer / captain): —
- Outcome: [ ] all pass / [ ] partial — see notes below
- Notes: —

## Filing cligent / tmux-play issues

If a cligent or tmux-play bug surfaces during this acceptance,
file and fix in cligent's repo per the maintainer agreement; do
not patch around cligent from this repo
([IR-004 Task 14](../../../specs/iterations/004-link-code-fsm-to-playbook-runtime.md)).
