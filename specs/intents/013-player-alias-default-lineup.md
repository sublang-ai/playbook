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

2. Refresh the seeded default overlay (the now-retired PBCODE-7):
   - a 174×49 window — cligent's tmux-play default, sized for 18pt text on a
     1080p 16:9 display — and 4:6:6 column weights, a playbook-specific override
     of cligent's `[1,1,1]` default, both under a top-level `layout` block;
   - Captain stays claude `claude-sonnet-4-6`;
   - Coder becomes codex `gpt-5.5` at `xhigh`;
   - Reviewer becomes claude `claude-opus-4-8` at `xhigh`;
   - Committer aliased to Reviewer.

## Why not one commit

- The alias is a new config concept that spans the overlay schema
  (the now-retired PBCODE-16, PBCODE-17), the composer, the CODE
  runtime's player-id resolver ([PBRT-8](../dev/playbook-runtime.md#pbrt-8))
  and identity-string derivation ([PBRT-4](../user/playbook-runtime.md#pbrt-4)),
  and the namespaced `captain.options.code` validator
  ([PBRT-29](../user/playbook-runtime.md#pbrt-29),
  [PBRT-30](../dev/playbook-runtime.md#pbrt-30)) — plus a matching amendment
  to DR-004 §2's baked-binding design.
- It embeds an unsettled design decision (see below) that warrants
  deliberate specification before code.
- Touched specs span three packages (PBCODE, PBRT, PLAYBOOK) and two DRs
  (DR-004 §2 baked-binding plus DR-006 §2.4 base-inheritance);
  touched code spans the composer, the adapter, the FSM, and the runtime,
  with `.js`/`.d.ts` siblings and four test files.
- The layout and model-default refresh are independently reviewable from the
  alias work.

Splitting keeps each commit atomic and `main` green; bundling would mix an
architectural feature with config edits and leave intermediate states where
spec and code disagree.

## Settled design decisions (Task 2)

Settled and recorded across PBRT-8/29/30, PBCODE-16/17, PLAYBOOK-3,
and DR-004 §2 (Addendum A2):

- **Representation.** A string alias `players.committer: <role>` in the
  overlay, value one of the existing roles `coder` / `reviewer` (formerly a
  rejected `players` key; PBCODE-16/17 now admit it). It is a reference, not a
  player block — no `adapter`, no pane.
- **Home.** The overlay carries it under `players.committer`; the composer
  resolves it into the composed config's `captain.options.code.committer`
  (PBRT-30) and emits no extra `players[]` entry. The alias is CODE-internal
  role resolution, not the host adapter/model routing PBRT-29 reserves for
  `players`, so `options.code` is its rightful home (carve-out added to
  PBRT-29). `players.committer` is the sole overlay surface: the composer is
  the sole writer of the composed `captain.options.code.committer`, so a
  directly-set overlay `captain.options.code.committer` is rejected, avoiding
  a two-source conflict.
- **No cligent change.** Resolved entirely in the playbook composer + CODE
  runtime; `@sublang/cligent` is untouched and the lockfile unchanged. Recorded
  as a DR-004 §2 amendment (Addendum A2), not a standalone DR-008.
- **Path to `resolvePlayerId` (PBRT-8).** The adapter validates
  `captain.options.code.committer` and threads it into `createPlaybookRuntime`,
  which wires it onto the `Committer` states' `CaptainInput.committerPlayer`. A
  configured alias wins; absent it, the DR-004 §2 coder-first fallback holds.
  The alias is a player id, independent of the `coderPlayer` / `reviewerPlayer`
  identity strings (PBRT-4), so the `<coder-llm>` / `<reviewer-llm>` trailers
  and `input.player` (`Committer`, PLAYBOOK-3) are unchanged.
- **Column-weight length stays 3** (Boss/Captain + coder + reviewer) because
  the alias reuses the Reviewer pane rather than adding a player.

## Deliverables

- [x] IR-013 doc and its `map.md` row.
- [x] Alias-representation decision recorded — DR-004 §2 amendment (Addendum A2); no DR-008, no new DR map row.
- [x] [`specs/decisions/006-code-config-composition.md`](../decisions/006-code-config-composition.md) §2.4 amendment adding `layout` to the base-inheritable list (today closed to `theme` + the captain-judge fields) + `map.md` row refresh.
- [x] `specs/user/playbook-code.md` — PBCODE-16: overlay may carry a top-level `layout` block and a Committer alias.
- [x] `specs/dev/playbook-code.md` — PBCODE-17: compose `layout` (overlay → composed, inherited from base like `theme`) and resolve the alias without emitting an extra `players[]` entry; PBCODE-7's template *shape* refreshed for the structural additions (the `layout` block and the alias slot), not concrete model picks — PBCODE-7 documents structure, and PBCODE-6 keeps model values user-tunable.
- [x] `specs/test/playbook-code.md` — PBCODE-18: `layout` and alias composition cases (alias cases landed in Task 2; `layout` cases in Task 3).
- [x] [`specs/user/playbook-runtime.md`](../user/playbook-runtime.md) + [`specs/dev/playbook-runtime.md`](../dev/playbook-runtime.md) — PBRT-8 (configurable Committer binding), PBRT-29/30 (alias placement), PBRT-4 interaction.
- [x] [`specs/test/playbook-runtime.md`](../test/playbook-runtime.md) — alias-resolution and options-validation cases (PBRT-26 configured-alias, PBRT-31 valid/invalid `committer`).
- [x] [`specs/dev/playbook.md`](../dev/playbook.md) — PLAYBOOK-3 Committer binding stays gears-consistent.
- [x] [`specs/decisions/004-link-code-fsm-to-playbook-runtime.md`](../decisions/004-link-code-fsm-to-playbook-runtime.md) §2 baked-binding amendment (Addendum A2).
- [x] `reference/sdlc/code.playbook/playbook-code.config.template.yaml` — `layout` (Task 3, done), model lineup (Task 4, done), Committer alias (Task 6, done).
- [x] `reference/sdlc/code.playbook/bin/playbook-code.js` — `layout` pass-through (Task 3, done) + alias resolution (Task 5) in the composer.
- [x] `reference/sdlc/code.playbook/code.tmux-play.ts` (+ `.js`) — alias option validation/threading.
- [x] [`reference/sdlc/code.playbook/code.fsm.ts`](../../reference/sdlc/code.playbook/code.fsm.ts) (+ `.js`/`.d.ts`) and [`code.playbook.ts`](../../reference/sdlc/code.playbook/code.playbook.ts) (+ `.js`) — `resolvePlayerId` honors the configured alias.
- [x] Tests: `playbook-code.test.ts`, `code.tmux-play.test.ts`, `code.playbook.test.ts`, and the gears/prompt conformance suites.

## Tasks

Each task is one commit; order keeps `main` building and `pnpm test` green.

1. **Land IR-013 + map.md row.** _[done]_
   This doc and its `map.md` row; no code.
2. **Settle the alias design.** _[done]_
   Decide representation, home, and the cligent-extension question;
   amend PBRT-8/29/30, PBCODE-16/17 (alias half), PLAYBOOK-3, and DR-004 §2
   (Addendum A2); refresh `map.md`.
   Prose only; no code.
   Review follow-up: de-cited IR-013 from DR-004 (META-18) and refreshed its
   `map.md` row; defined single-overlay-surface precedence (a direct overlay
   `captain.options.code.committer` is rejected); and pinned the alias
   test-spec cases now (PBCODE-18, PBRT-26/31) for spec coherence rather than
   deferring them to Task 5.
3. **Layout pass-through.** _[done]_
   Composer carries a top-level `layout` block (overlay → composed, inherited
   from a base config like `theme`); PBCODE-16/17 + PBCODE-18 amended; the
   structural `layout` block is added to PBCODE-7's template shape.
   DR-006 §2.4 is amended to add `layout` to the base-inheritable list (today
   closed to `theme` + the captain-judge fields), with a `map.md` refresh.
   Template gains
   `layout: { window: { columns: 174, rows: 49 }, columnWeights: [4, 6, 6] }`.
   `pnpm test` green.
   Implementation note: the composer is a pure pass-through and the specs
   keep `layout` host-observable (it rides with `theme`, not under
   `options.code`). The pinned host `@sublang/cligent@0.8.0` does not yet
   model a `layout` config — its loader reads only `captain` / `players` /
   `theme` and silently drops other top-level keys, and window/column sizing
   is hardcoded in the launcher — so the emitted block is presently a host
   no-op, honored once cligent ships `layout` (no cligent bump here, per the
   Task-2 no-cligent-change decision). Acceptance is verified at the
   composed-config level.
   Review follow-up: base-`layout` inheritance through a *discovered* base
   was dead on the real path — cligent's loader strips `layout` from the base
   before the composer sees it — so the shim now recovers a base `layout`
   from the raw base YAML (inert once a loader preserves `layout`); added an
   end-to-end discovered-base test that fails without the recovery.
4. **Refresh the model lineup.** _[done]_
   Template only: Captain claude `claude-sonnet-4-6`; Coder codex `gpt-5.5`
   `xhigh`; Reviewer claude `claude-opus-4-8` `xhigh`.
   No spec change — this swaps model *values*, and PBCODE-7 documents template
   structure while PBCODE-6 keeps concrete models user-tunable, so neither item
   pins these picks; the readiness gate still sees `claude` + `codex`.
5. **Alias end-to-end.** _[done]_
   Overlay schema accepts the Committer alias; the composer resolves it without
   adding a `players[]` entry and threads it to the runtime; `code.tmux-play.ts`
   validates/forwards it; `resolvePlayerId('Committer')` honors it; `.js`/`.d.ts`
   siblings regenerated; `playbook-code.test.ts`, `code.tmux-play.test.ts`,
   `code.playbook.test.ts`, and the conformance suites updated.
   Land together so spec and code agree.
   Implementation note: `committerPlayer` threads through the FSM's
   `CaptainInput` / `CodingInput` as a routing-only field — it selects the
   Committer host pane in `resolvePlayerId` but never participates in prompt
   composition, so it stays outside the prompt-contract suite's `ALL_FIELDS` /
   `FULL_CONTEXT` and those conformance suites stay green unchanged. The
   composer now whitelists `committer` as a `players` key, so the stale
   `playbook-code.test.ts` "non-CODE role id" rejection case was retargeted
   from `committer` to `maintainer`. The template's Committer alias slot is
   deferred to Task 6.
6. **Default alias + close-out.** _[done]_
   Set the template's Committer alias to Reviewer;
   update README's agent-swap recipe;
   re-verify `map.md`;
   record any divergence as a one-line addendum.
   Implementation note: the template's `players` mapping gains
   `committer: reviewer` (plus a safe-tuning comment), which the composer
   already resolves into `captain.options.code.committer`; the seeding
   integration test now asserts the composed config carries
   `committer: 'reviewer'` with the roster still `[coder, reviewer]` (no
   extra pane). `map.md` already carried the IR-013 row and the
   alias-aware PBCODE/PBRT/DR rows from Tasks 1–2, so it needed no edit.
   Divergence reconciled: the README "Configure agents" recipe still
   showed the pre-composer *full* tmux-play form (`captain.from`,
   `players: [- id: …]`) that predates the overlay; since the alias is an
   overlay-only surface (`players.committer`; a direct
   `captain.options.code.committer` is rejected), the recipe is rewritten
   to the seeded *overlay* form — role-keyed `players.coder` /
   `players.reviewer`, no `captain.from` (composer-owned), refreshed
   models (Reviewer `claude-opus-4-8`), and the `committer: reviewer`
   alias — matching the actual seeded template.

## Acceptance criteria

- A fresh-seeded overlay composes a tmux-play config whose `layout.columnWeights` is `[4, 6, 6]` and `layout.window` is `{ columns: 174, rows: 49 }`, with `layout` inheritable from a base config like `theme`.
- The seeded overlay pins Captain claude `claude-sonnet-4-6`, Coder codex `gpt-5.5` `xhigh`, and Reviewer claude `claude-opus-4-8` `xhigh`.
- With the Committer aliased to Reviewer, every CODE-18 / CODE-19 commit turn routes to the `reviewer` player and no extra tmux-play player/pane is created; the `<coder-llm>` / `<reviewer-llm>` trailers are unchanged (PBRT-4).
- The alias is expressed in the config per the Task-2 decision and validated; an unknown alias target is rejected with a path-named error.
- `resolvePlayerId('Committer')` returns the configured alias target; the seeded template pins Reviewer, and absent any alias it falls back to DR-004 §2's coder-first baked binding, staying consistent with the gears `Committer = Coder | Reviewer` (PLAYBOOK-3).
- `pnpm build` is clean and `pnpm test` is green; `specs/map.md` lists IR-013 and the refreshed PBCODE/PBRT rows.
- No `@sublang/cligent` dependency bump or lockfile change unless Task 2 explicitly chooses the cligent-extension path.
