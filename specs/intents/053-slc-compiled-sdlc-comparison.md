<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-053: Compile the SDLC Workflows Through `slc playbook`

## Status

Blocked — the Codex usage limit is exhausted until 2026-09-06 19:29 PT; the reviewed compiles cannot run with the requested GPT-5.6 Sol coder before then.

## Intent

The maintained artifacts were recompiled by agents following the definitions directly; compile each SDLC source through `slc playbook` — reviewed two-agent compilation with a Codex coder in fast mode and a Claude reviewer — and judge whether the compiler's output is equivalent, better, or flawed, replacing an artifact only on solid real-run evidence and improving the compiler or definitions only where a flaw is essential and general.

## Deliverables

- [ ] Each of `code.md`, `review.md`, `decide.md`, and `dev.md` compiled through reviewed `slc playbook` into a scratch location.
- [ ] A comparison per workflow: conformance suites, prompt contracts, and real runs, with a verdict of equivalent, better, or flawed.
- [ ] Flaws traced to their cause with a minimal general improvement or an explicit decision to leave them.

## Tasks

1. [ ] Compile the four sources through reviewed `slc playbook` and collect the artifacts: launched 2026-09-02 with slc main (db83c66, Playbook 12.1.0 adopted), coder `codex` / `gpt-5.6-sol` / `ultra` / fast mode, reviewer `claude-code` / `claude-opus-5` / `ultracode`. The first `dev` attempt failed closed at text2gears after 22 min: the reviewer call showed no activity for the default 600 s stall budget; relaunched with `SLC_STALL_TIMEOUT=2400`; `decide` (38 min) and `review` (42 min) failed the same way, so all four were relaunched with the 2400 s budget; the relaunches then failed on the Codex usage limit (`review`, `code`, `decide`), and `dev` was stopped. No compile reached gears2fsm; no artifact to compare yet. Finding for task 3: an `ultracode` reviewer can stay silent beyond the default 600 s stall budget, so reviewed compilation needs either a documented larger default for deep reviewers or activity signals from the adapter.
2. [ ] Compare each against the maintained artifact and record verdicts here.
3. [ ] Land any essential improvement with its decision record, or record why none is warranted.

## Verification

- Every compiled artifact passes its emitted verification and the independent review before comparison.
- Any replacement passes the maintained conformance suites and a real run before it lands.
