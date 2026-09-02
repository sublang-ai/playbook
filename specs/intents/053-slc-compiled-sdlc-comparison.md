<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-053: Compile the SDLC Workflows Through `slc playbook`

## Status

Planned — starts after the milestone release.

## Intent

The maintained artifacts were recompiled by agents following the definitions directly; compile each SDLC source through `slc playbook` — reviewed two-agent compilation with a Codex coder in fast mode and a Claude reviewer — and judge whether the compiler's output is equivalent, better, or flawed, replacing an artifact only on solid real-run evidence and improving the compiler or definitions only where a flaw is essential and general.

## Deliverables

- [ ] Each of `code.md`, `review.md`, `decide.md`, and `dev.md` compiled through reviewed `slc playbook` into a scratch location.
- [ ] A comparison per workflow: conformance suites, prompt contracts, and real runs, with a verdict of equivalent, better, or flawed.
- [ ] Flaws traced to their cause with a minimal general improvement or an explicit decision to leave them.

## Tasks

1. [ ] Compile the four sources through reviewed `slc playbook` and collect the artifacts.
2. [ ] Compare each against the maintained artifact and record verdicts here.
3. [ ] Land any essential improvement with its decision record, or record why none is warranted.

## Verification

- Every compiled artifact passes its emitted verification and the independent review before comparison.
- Any replacement passes the maintained conformance suites and a real run before it lands.
