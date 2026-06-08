<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-013: Player-alias config and refreshed CODE default lineup

## Goal

Two coupled changes to the `playbook-code` CODE overlay and its composer.

1. Add config-level support for a **player alias** — a CODE-role-to-player
   binding carried in the playbook config rather than baked at link time —
   with the Committer as the first consumer.
   Today the runtime binds `Committer → coder` in code, baked at link time
   ([PBRT-8](../dev/playbook-runtime.md#pbrt-8),
   [DR-004](../decisions/004-link-code-fsm-to-playbook-runtime.md) §2),
   while the gears define `Committer = Coder | Reviewer` (code.gears.md).
   Cligent's tmux-play config has no alias concept (players are a flat array
   of unique ids); per the Boss it is "open to extend."

2. Refresh the seeded default overlay
   ([PBCODE-7](../dev/playbook-code.md#pbcode-7)):
   - 4:6:6 column weights and a 174×49 window — cligent's tmux-play default,
     sized for 18pt text on a 1080p 16:9 display — under a top-level `layout`
     block;
   - Captain stays claude `claude-sonnet-4-6`;
   - Coder becomes codex `gpt-5.5` at `xhigh`;
   - Reviewer becomes claude `claude-opus-4-8` at `xhigh`;
   - Committer aliased to Reviewer.

## Why not one commit

- The alias is a new config concept that spans the overlay schema
  ([PBCODE-16](../user/playbook-code.md#pbcode-16),
  [PBCODE-17](../dev/playbook-code.md#pbcode-17)), the composer, the CODE
  runtime's player-id resolver ([PBRT-8](../dev/playbook-runtime.md#pbrt-8))
  and identity-string derivation ([PBRT-4](../user/playbook-runtime.md#pbrt-4)),
  and the namespaced `captain.options.code` validator
  ([PBRT-29](../user/playbook-runtime.md#pbrt-29),
  [PBRT-30](../dev/playbook-runtime.md#pbrt-30)) — plus a matching amendment
  to DR-004 §2's baked-binding design.
- It embeds an unsettled design decision (see below) that warrants
  deliberate specification before code.
- Touched specs span three packages (PBCODE, PBRT, PLAYBOOK) and a DR;
  touched code spans the composer, the adapter, the FSM, and the runtime,
  with `.js`/`.d.ts` siblings and four test files.
- The layout and model-default refresh are independently reviewable from the
  alias work.

Splitting keeps each commit atomic and `main` green; bundling would mix an
architectural feature with config edits and leave intermediate states where
spec and code disagree.

## Open design decisions (settle in Task 2)

- Alias representation in the overlay: a string alias
  (`players.committer: reviewer`) vs an object, and whether `players.committer`
  (today a rejected non-CODE key per PBCODE-16/17) becomes the alias slot.
- Alias home: tmux-play-native `players` — consistent with PBRT-29's "model or
  adapter routing through `captain` / `players`, not `captain.options.code`" —
  vs the CODE-namespaced `captain.options.code` validator (PBRT-30).
- Whether to extend cligent's tmux-play `players[]` with a generic alias (an
  entry that reuses another player's session) or resolve the alias entirely in
  the playbook composer + CODE runtime with no cligent change and no lockfile
  bump. Record the choice in DR-004 §2 (or a standalone DR-008).
- How the resolved alias reaches `resolvePlayerId` (PBRT-8): via `CodingInput`
  / a composed option, and its interaction with the `coderPlayer` /
  `reviewerPlayer` identity strings (PBRT-4) so the alias changes only *which
  pane runs the commit*, not the `<coder-llm>` / `<reviewer-llm>` trailers.
- Column-weight length stays 3 (Boss/Captain + coder + reviewer) because the
  alias reuses the Reviewer pane rather than adding a player.

## Deliverables

- [ ] IR-013 doc and its `map.md` row.
- [ ] Alias-representation decision recorded (DR-004 §2 amendment, or DR-008 + map row).
- [ ] [`specs/user/playbook-code.md`](../user/playbook-code.md) — PBCODE-16: overlay may carry a top-level `layout` block and a Committer alias.
- [ ] [`specs/dev/playbook-code.md`](../dev/playbook-code.md) — PBCODE-17: compose `layout` (overlay → composed, inherited from base like `theme`) and resolve the alias without emitting an extra `players[]` entry; PBCODE-7 refreshed template.
- [ ] [`specs/test/playbook-code.md`](../test/playbook-code.md) — PBCODE-18: `layout` and alias composition cases.
- [ ] [`specs/user/playbook-runtime.md`](../user/playbook-runtime.md) + [`specs/dev/playbook-runtime.md`](../dev/playbook-runtime.md) — PBRT-8 (configurable Committer binding), PBRT-29/30 (alias placement), PBRT-4 interaction.
- [ ] [`specs/test/playbook-runtime.md`](../test/playbook-runtime.md) — alias-resolution and options-validation cases.
- [ ] [`specs/dev/playbook.md`](../dev/playbook.md) — PLAYBOOK-3 Committer binding stays gears-consistent.
- [ ] [`specs/decisions/004-link-code-fsm-to-playbook-runtime.md`](../decisions/004-link-code-fsm-to-playbook-runtime.md) §2 baked-binding amendment (or DR-008).
- [ ] [`reference/sdlc/code.playbook/playbook-code.config.template.yaml`](../../reference/sdlc/code.playbook/playbook-code.config.template.yaml) — `layout`, model lineup, Committer alias.
- [ ] [`reference/sdlc/code.playbook/bin/playbook-code.js`](../../reference/sdlc/code.playbook/bin/playbook-code.js) — `layout` pass-through + alias resolution in the composer.
- [ ] [`reference/sdlc/code.playbook/code.tmux-play.ts`](../../reference/sdlc/code.playbook/code.tmux-play.ts) (+ `.js`) — alias option validation/threading.
- [ ] [`reference/sdlc/code.playbook/code.fsm.ts`](../../reference/sdlc/code.playbook/code.fsm.ts) (+ `.js`/`.d.ts`) and [`code.playbook.ts`](../../reference/sdlc/code.playbook/code.playbook.ts) (+ `.js`) — `resolvePlayerId` honors the configured alias.
- [ ] Tests: `playbook-code.test.ts`, `code.tmux-play.test.ts`, `code.playbook.test.ts`, and the gears/prompt conformance suites.

## Tasks

Each task is one commit; order keeps `main` building and `pnpm test` green.

1. **Land IR-013 + map.md row.**
   This doc and its `map.md` row; no code.
2. **Settle the alias design.**
   Decide representation, home, and the cligent-extension question;
   amend PBRT-8/29/30, PBCODE-16/17, PLAYBOOK-3, and DR-004 §2 (or add DR-008);
   refresh `map.md`.
   Prose only; no code.
3. **Layout pass-through.**
   Composer carries a top-level `layout` block (overlay → composed, inherited
   from a base config like `theme`); PBCODE-16/17 + PBCODE-18 amended; template
   gains `layout: { window: { columns: 174, rows: 49 }, columnWeights: [4, 6, 6] }`.
   `pnpm test` green.
4. **Refresh the model lineup.**
   Template only: Captain claude `claude-sonnet-4-6`; Coder codex `gpt-5.5`
   `xhigh`; Reviewer claude `claude-opus-4-8` `xhigh`.
   No spec change; the readiness gate still sees `claude` + `codex`.
5. **Alias end-to-end.**
   Overlay schema accepts the Committer alias; the composer resolves it without
   adding a `players[]` entry and threads it to the runtime; `code.tmux-play.ts`
   validates/forwards it; `resolvePlayerId('Committer')` honors it; `.js`/`.d.ts`
   siblings regenerated; `playbook-code.test.ts`, `code.tmux-play.test.ts`,
   `code.playbook.test.ts`, and the conformance suites updated.
   Land together so spec and code agree.
6. **Default alias + close-out.**
   Set the template's Committer alias to Reviewer;
   update README's agent-swap recipe;
   re-verify `map.md`;
   record any divergence as a one-line addendum.

## Acceptance criteria

- A fresh-seeded overlay composes a tmux-play config whose `layout.columnWeights` is `[4, 6, 6]` and `layout.window` is `{ columns: 174, rows: 49 }`, with `layout` inheritable from a base config like `theme`.
- The seeded overlay pins Captain claude `claude-sonnet-4-6`, Coder codex `gpt-5.5` `xhigh`, and Reviewer claude `claude-opus-4-8` `xhigh`.
- With the Committer aliased to Reviewer, every CODE-18 / CODE-19 commit turn routes to the `reviewer` player and no extra tmux-play player/pane is created; the `<coder-llm>` / `<reviewer-llm>` trailers are unchanged (PBRT-4).
- The alias is expressed in the config per the Task-2 decision and validated; an unknown alias target is rejected with a path-named error.
- `resolvePlayerId('Committer')` returns the configured alias target, defaulting to Reviewer, and stays consistent with the gears `Committer = Coder | Reviewer` (PLAYBOOK-3).
- `pnpm build` is clean and `pnpm test` is green; `specs/map.md` lists IR-013 and the refreshed PBCODE/PBRT rows.
- No `@sublang/cligent` dependency bump or lockfile change unless Task 2 explicitly chooses the cligent-extension path.
