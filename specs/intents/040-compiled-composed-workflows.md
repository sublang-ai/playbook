<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-040: Compiled composed workflows

## Goal

Compile the maintained CODE, REVIEW, and DECIDE sources into releasable nested playbooks with shared mapped-player continuity and a current, coherent public package.

## Deliverables

- [ ] Canonical specs use the package-only item layout and describe the three current workflows.
- [ ] Nested same-role players retain one truthful backend conversation within a root engagement.
- [ ] SLC preserves authored instruction blocks, quoted relayed context, and verbatim player outputs.
- [ ] CODE, REVIEW, and DECIDE sources, GEARS, FSMs, linked runtimes, registries, and generated verification agree.
- [ ] Package exports, configuration, documentation, smoke, and acceptance cover the current workflows.
- [ ] Deterministic and real-agent release gates pass without publishing or tagging.

## Tasks

1. Migrate the canonical item corpus to `specs/packages/`, update the governing meta law and map, and record the shared-continuity decision.
2. Refine the SLC definitions so the maintained source fragments and verbatim relay fields survive compilation and are mechanically checked.
3. Add host-supplied player-continuation storage to the runtime contract and shared engine, with focused contract and snapshot tests.
4. Bind nested frames to inherited same-role players in the interactive shell, with effective visibility, identity metadata, and continuity tests.
5. Compile and register REVIEW from `reference/sdlc/review.md`.
6. Recompile CODE from `reference/sdlc/code.md` and replace DISCUSS with DECIDE compiled from `reference/sdlc/decide.md`.
7. Update package exports, config, docs, release checks, smoke, and acceptance for CODE, REVIEW, and DECIDE.
8. Run the complete deterministic release workflow and nonblocking real-agent CLI acceptance, then audit the packed candidate without publishing it.

## Acceptance criteria

- A Coder call made in nested REVIEW resumes the Coder conversation that CODE or DECIDE already used, and the next parent Coder call resumes the token REVIEW returned.
- DECIDE's nested Reviewer can compare against the independent proposal it produced before the child call without that proposal being copied into a replacement session.
- A new root engagement starts every effective player fresh.
- Generated tests prove the complete fenced instructions, quoted runtime values, and required verbatim outputs survive each compilation phase.
- Interactive CODE and DECIDE finish through nested REVIEW, and standalone REVIEW completes through `playbook run`.
- The packed candidate imports every declared public subpath and passes local smoke plus the selected live release gates.
