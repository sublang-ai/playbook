<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-004: Link CODE FSM to PlaybookRuntime

## Goal

Compile `reference/sdlc/code.playbook/code.fsm.ts` into a `PlaybookRuntime` module per [slc/link.md](../../slc/link.md), with CODE-specific bindings pinned by [DR-004](../decisions/004-link-code-fsm-to-playbook-runtime.md).
Ship the in-repo tmux-play host adapter `code.tmux-play.ts` that wires `PlaybookPorts` to cligent's Captain primitives.

## Deliverables

- [x] `reference/sdlc/code.playbook/code.playbook.ts` — emitted runtime
  module per [DR-004 §10](../decisions/004-link-code-fsm-to-playbook-runtime.md#10-emitted-module--codeplaybookts).
- [x] `reference/sdlc/code.playbook/code.playbook.test.ts` — unit tests
  with a hand-rolled fake `PlaybookPorts`.
  Covers the Boss-event classifier, player-id resolution, judge JSON
  parsing, the quiescence drive loop, and the natural-rejection abort
  path.
- [x] `reference/sdlc/code.playbook/code.tmux-play.ts` — tmux-play host
  adapter per [DR-004 §11](../decisions/004-link-code-fsm-to-playbook-runtime.md#11-host-adapter--tmux-play).
- [x] `reference/sdlc/code.playbook/code.tmux-play.test.ts` — unit tests
  with stubbed `CaptainContext` / `CaptainSession` asserting port wiring,
  `RoleRunResult` ↔ `PlayerResult` identity, `handleBossTurn →
  handleBossInput` forwarding, and lifecycle ordering.
- [ ] `reference/sdlc/code.playbook/tmux-play.config.yaml` — example
  config per [DR-004 §11](../decisions/004-link-code-fsm-to-playbook-runtime.md#11-host-adapter--tmux-play),
  with `captain.from: ./code.tmux-play.js`.
- [x] Build pipeline — `package.json` with `"type": "module"` and a
  `pnpm build` (or `npm run build`) script that emits `code.playbook.js`
  and `code.tmux-play.js` next to the `.ts` sources.
  TypeScript → ESM `.js`; no bundler.
  Source `.ts` and built `.js` both ship in the npm tarball; `.js` is
  what `captain.from` resolves to in dev or release.
- [ ] `reference/sdlc/code.playbook/README.md` — quickstart for the
  runtime module, a fake-ports example, a "running under tmux-play"
  subsection linking the example YAML, and a "release usage" note
  showing the `@sublang/playbook/code/tmux-play` package-specifier form.
- [x] `package.json` — declare `@sublang/cligent` as `peerDependency`
  (or `dependency` while the playbook is unpublished and consumed via
  local link); set up a script to link a local cligent checkout for
  development.
- [ ] `specs/map.md` — IR-004 row reflects the final summary; DR-004
  row present.
  *(Re-verify at close-out.)*

## Tasks

Each task is a commit.
Order keeps `main` building at every commit.

1. **Land DR-004 and the rewritten IR-004 and `slc/link.md`.**
   Update `specs/map.md` in the same commit.
2. **Bootstrap the build pipeline.**
   Add a minimal `package.json` (with `"type": "module"`),
   `tsconfig.json` (NodeNext module resolution), and `pnpm build`
   script under `reference/sdlc/code.playbook/`.
   The script shall emit `.js` next to every `.ts` source.
   Wire `@sublang/cligent` as a peer/devDependency.
   Verify `pnpm install && pnpm build` is clean on a fresh checkout
   before any source file is added.
3. **Scaffold the runtime module** — create `code.playbook.ts` with the
   top-of-file header from [DR-004 §10](../decisions/004-link-code-fsm-to-playbook-runtime.md#10-emitted-module--codeplaybookts),
   imports, factory export, `PlaybookPorts` / `PlaybookRuntime` types,
   and TODO stubs for the five internal capabilities.
   Typechecks against `./code.fsm.js` and `xstate` only; no host imports.
   Verify `pnpm build` emits `code.playbook.js`.
4. **Player-prompt composer.**
   Implement per [DR-004 §6](../decisions/004-link-code-fsm-to-playbook-runtime.md#6-player-prompt-composition).
   Unit test round-trips every placeholder token (`<#>`, `<coder-llm>`,
   `<reviewer-llm>`) and every labelled block (`intent`, `reviews`,
   `challenges`, `taskDescription`).
5. **Player-id resolver.**
   Implement per [DR-004 §2](../decisions/004-link-code-fsm-to-playbook-runtime.md#2-player-binding-for-code).
   Cover CODE-15 / 16 / 17 alias resolution in tests.
6. **LLM judge.**
   Implement per [DR-004 §4](../decisions/004-link-code-fsm-to-playbook-runtime.md#4-captain-adjudication).
   Test against a fake `ports.callJudge` returning fixed JSON; assert the
   prompt body contains every key in `input.result` with its description
   verbatim.
7. **Boss-event classifier.**
   Implement per [DR-004 §3](../decisions/004-link-code-fsm-to-playbook-runtime.md#3-boss-event-mapping-for-code).
   Slash forms first; LLM-classifier fallback via `ports.callJudge`
   second.
   Test the slash table and one LLM-fallback path.
8. **Captain-actor bridge.**
   Wire `captainBridge(ports)` + `.provide({ actors: { captain: … } })`
   inside `createPlaybookRuntime` per [DR-004 §7](../decisions/004-link-code-fsm-to-playbook-runtime.md#7-captain-actor-bridge).
   Test an actor driven through one fake turn end-to-end with stubbed
   `callPlayer` / `callJudge` ports.
9. **Drive-to-quiescence loop and abort.**
   Implement `handleBossInput` per [DR-004 §5](../decisions/004-link-code-fsm-to-playbook-runtime.md#5-session-lifecycle)
   and §8, including the final-state dispose/reconstruct path.
   On `signal` abort the runtime takes no FSM action — natural
   rejection → `onError` → `#failed`.
   Test three scenarios: clean run to `ready`; signal-abort
   mid-`callPlayer` lands at `failed` with the abort error in
   `lastError`; explicit `/interrupt <stateId>` redirects via
   `BOSS_INTERRUPT`.
10. **Status / telemetry hookup** per [DR-004 §9](../decisions/004-link-code-fsm-to-playbook-runtime.md#9-status-and-telemetry).
    Subscribe to actor snapshots, emit on every transition.
    Test with a fake `PlaybookPorts` recording emissions.
11. **tmux-play adapter** (`code.tmux-play.ts`) per [DR-004 §11](../decisions/004-link-code-fsm-to-playbook-runtime.md#11-host-adapter--tmux-play).
    Default-export the Captain factory; import types from
    `@sublang/cligent/tmux-play` and the runtime from
    `./code.playbook.js`.
    Unit-test with stubbed `CaptainContext` / `CaptainSession`: assert
    `callRole` / `callCaptain` forwarding, `RoleRunResult` ↔
    `PlayerResult` identity, `signal` propagation, and the
    `init → handleBossTurn → dispose` lifecycle order.
    Verify `pnpm build` emits `code.tmux-play.js`.
12. **Example config** (`tmux-play.config.yaml`) per [DR-004 §11](../decisions/004-link-code-fsm-to-playbook-runtime.md#11-host-adapter--tmux-play).
    Ship the dev form with `captain.from: ./code.tmux-play.js`;
    document the release-form swap inline as a YAML comment; declare
    `roles[].id` as `coder` and `reviewer` to match the baked
    `playerId` strings.
13. **README.**
    Document the fake-ports example, the public `PlaybookRuntime` /
    `PlaybookPorts` types, the tmux-play integration path (example
    YAML + how to run `pnpm build && tmux-play --config …`), and a
    "release usage" subsection showing the `@sublang/playbook`
    package-specifier form.
14. **End-to-end tmux-play acceptance** (manual; recorded as
    `code.tmux-play.acceptance.md` next to the YAML config).
    Steps: `pnpm install && pnpm build`; optionally
    `pnpm link @sublang/cligent` to point at a local checkout;
    `tmux-play --config reference/sdlc/code.playbook/tmux-play.config.yaml`;
    type `/start <intent>`; observe Captain pane walking through
    `planAndImplement → commitCoderInitial → reviewBossCommit*`;
    confirm coder pane streams a reply; type `/interrupt ready`;
    confirm the FSM jumps to `ready`; Ctrl-C, confirm the tmux session
    tears down cleanly.
    If a cligent or tmux-play bug surfaces, file and fix in cligent's
    repo per the maintainer agreement; do not patch around cligent
    from this repo.
15. **Spec deltas.**
    Update `specs/map.md` to mark IR-004 deliverables complete.
    If anything diverged from DR-004, record the delta in a
    one-paragraph addendum at the bottom of DR-004 (or open a follow-up
    DR if substantive).

## Acceptance criteria

- `code.playbook.ts` typechecks against `./code.fsm.js` and `xstate`
  with no host-specific imports.
  The exported `createPlaybookRuntime` satisfies the `PlaybookRuntime`
  interface from [slc/link.md](../../slc/link.md).
- Unit tests with a hand-rolled fake `PlaybookPorts` drive the FSM
  through at least:
  - `/start <intent>` → `planAndImplement` → `commitCoderInitial` →
    `reviewBossCommitSpecs` (or whichever scope-variant the test pins),
    with `callPlayer` invoked for Coder then Reviewer in the expected
    order.
  - LLM-classifier fallback: free-form Boss text routes through
    `callJudge` and lands on the same flow when the text obviously
    matches `START_CODING`.
  - Natural-rejection abort: `signal` fires mid-`callPlayer`, the fake
    port resolves with `PlayerResult { status: 'aborted' }`, the runtime
    lands at `failed`, the drive-loop returns, and `lastError` is
    surfaced via `emitStatus`.
  - `/interrupt <stateId>` redirects via `BOSS_INTERRUPT` (with
    `reenter: true`).
  - `done` cleanly disposes the actor; the next Boss turn starts fresh
    from `ready`.
- `code.playbook.ts` has no FSM-specific prose beyond what it derives
  from importing `code.fsm.ts` at runtime, and no host-specific imports
  (speaks only `PlaybookPorts`).
- `code.tmux-play.ts` is the *only* file in this IR that imports from
  `@sublang/cligent/tmux-play`.
  Removing that import shall not affect `code.playbook.ts` or its tests.
- All `reference/sdlc/code.playbook/**` source files carry SPDX headers
  per the project's licensing spec.
- End-to-end under tmux-play (per Task 14): launching `tmux-play` with
  the bundled YAML config shows the standard 4/6/6 layout
  (Captain | Coder | Reviewer); `/start <intent>` drives the FSM through
  at least `planAndImplement → commitCoderInitial → reviewBossCommit*`,
  with the coder pane streaming a real reply from the configured adapter
  and the Captain pane showing FSM-state status lines;
  `/interrupt ready` redirects to `ready`; Ctrl-C tears the session
  down cleanly.
