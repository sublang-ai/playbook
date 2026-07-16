<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-021: Durable one-shot run sessions

## Goal

Implement DR-014 end to end: parked-session snapshot export/restore on the linked runtimes, a persisted one-shot session store, and a `playbook run resume` surface that prints the pending Boss question and finishes a parked run with one more invocation.

## Deliverables

- [x] `@sublang/playbook/runtime` exposes the optional `exportSnapshot` / `restore` capability and the `PlaybookRuntimeSnapshot` shape.
- [x] `slc/link.md` specifies the parked-session snapshot surface for generated linked runtimes.
- [x] The CODE and DISCUSS linked runtimes implement the capability; the shared XState engine hosts the reusable snapshot helpers.
- [x] `playbook run` persists parked sessions, prints the pending question(s) to stdout, and reports the session id; `playbook run resume <session-id> | --last [reply]` continues them; `--json` prints an outcome envelope with the session id.
- [x] Acceptance tests pin the runtime snapshot round-trip and the CLI park/resume lifecycle.
- [x] README, CHANGELOG, and `specs/map.md` document the feature for fresh users.

## Tasks

1. **Author DR-014 and the spec surface.** _[done]_
   DR-014, this iteration, the `slc/link.md` parked-session snapshot section, PBRT-45/PBRT-46, amended PBCLI-18/PBCLI-20, and new PBCLI-22/PBCLI-23/PBCLI-24 precede code changes.
2. **Add the snapshot contract to the shared runtime module.** _[done]_
   `src/runtime.ts` gains `PlaybookRuntimeSnapshot`, `PlaybookPendingBossQuestion`, and the optional `exportSnapshot` / `restore` members with compiled siblings.
3. **Implement export/restore in the linked runtimes.** _[done]_
   Shared helpers in `src/xstate-runtime.ts`; `code.playbook.ts` and `discuss.playbook.ts` export at parked quiescence and rehydrate under the same session identity without re-emitting `session.started`.
4. **Teach `playbook run` to park and resume.** _[done]_
   Session store under `${XDG_STATE_HOME:-$HOME/.local/state}/playbook/sessions/`, stdout question printing, stderr resume hint, `resume <session-id>` / `--last` with stdin reply, stored-binding enforcement, and the `--json` outcome envelope.
5. **Pin acceptance tests.** _[done]_
   Runtime round-trip (PBRT-46) in `code.playbook.test.ts` and `discuss.playbook.test.ts`; CLI park/resume lifecycle (PBCLI-24) in `playbook.test.ts`.
6. **Document for fresh users.** _[done]_
   README non-interactive section, CHANGELOG entry, and `specs/map.md` rows.

## Acceptance criteria

- A CODE run driven to `awaitBossReply` exports a snapshot that a fresh runtime instance restores in a new process image: the reply re-enters the recorded resume state, the player call carries the pre-park resume token, and the trace sequence continues contiguously with no second `session.started`.
- `exportSnapshot()` returns `undefined` during an active turn, when a nested playbook call is pending, and after disposal.
- `playbook run` on a parking playbook writes `<sessionId>.json` mode `0600`, prints the pending question text to stdout, prints a resume hint naming the session id to stderr, exits `3`, and does not dispose the parked runtime.
- `playbook run resume <session-id> "answer"` rebuilds the host from the stored bindings, restores the snapshot, and on a terminal outcome prints the output to stdout, deletes the session file, and exits `0`; parking again rewrites the file and exits `3`; failure keeps the file and exits `2`.
- `playbook run resume --last` picks the most recently updated stored session; a missing store, an unknown session id, a schema mismatch, a runtime without `restore`, or a binding flag on `resume` exits `1` with a diagnostic.
- `--json` prints one stdout envelope carrying `outcome`, `sessionId`, and `output` or `questions` for terminal and parked outcomes on both `run` and `run resume`.
- `pnpm test` passes with the new acceptance items; `pnpm build` regenerates compiled siblings without drift.
