<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-040: Compiled composed workflows

## Status

In progress

## Intent

Compile the maintained CODE, REVIEW, and DECIDE sources into releasable nested playbooks with shared mapped-player continuity and a current, coherent public package.

## Deliverables

- [ ] Canonical specs use the package-only item layout and describe the three current workflows.
- [ ] Nested same-role players retain one truthful backend conversation within a root engagement.
- [ ] SLC preserves authored instruction blocks, quoted relayed context, and verbatim player outputs.
- [ ] CODE, REVIEW, and DECIDE sources, GEARS, FSMs, linked runtimes, registries, and generated verification agree.
- [ ] Package exports, configuration, documentation, smoke, and acceptance cover the current workflows.
- [ ] Deterministic and real-agent release gates pass without publishing or tagging.

## Tasks

1. Record the shared mapped-player continuity decision and this implementation sequence.
2. Migrate the canonical item corpus to `specs/packages/` and update the governing meta law, citations, and map.
3. Refine the SLC definitions so the maintained source fragments and verbatim relay fields survive compilation and are mechanically checked.
4. Add host-supplied player-continuation storage to the runtime contract and shared engine, with focused contract and snapshot tests.
5. Bind nested frames to inherited same-role players in the interactive shell, with effective visibility, identity metadata, summary counting, and continuity tests.
6. Compile and register REVIEW from `reference/sdlc/review.md`.
7. Recompile and register CODE from `reference/sdlc/code.md`.
8. Replace DISCUSS with DECIDE compiled from `reference/sdlc/decide.md` and record the breaking public-surface change.
9. Update package exports, starter config, and user documentation for CODE, REVIEW, and DECIDE.
10. Update deterministic release checks, smoke, and acceptance for the compiled workflows.
11. Run the complete deterministic release workflow and nonblocking real-agent CLI acceptance, then audit the packed candidate without publishing it.

## Verification

- A Coder call made in nested REVIEW resumes the Coder conversation that CODE or DECIDE already used, and the next parent Coder call resumes the token REVIEW returned.
- DECIDE's nested Reviewer can compare against the independent proposal it produced before the child call without that proposal being copied into a replacement session.
- A new root engagement starts every effective player fresh.
- Generated tests prove the complete fenced instructions, quoted runtime values, and required verbatim outputs survive each compilation phase.
- Interactive CODE and DECIDE finish through nested REVIEW, and standalone REVIEW completes through `playbook run`.
- The packed candidate imports every declared public subpath and passes local smoke plus the selected live release gates.
