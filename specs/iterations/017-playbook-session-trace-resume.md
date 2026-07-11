<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-017: Playbook session trace and resume

## Goal

Give every linked runtime session an immutable id, emit a boundary-complete ordered trace, and explicitly isolate or resume each player from its adapter-provided token.

## Deliverables

- [x] Session, trace, and resume contracts recorded in canonical specs.
- [x] cligent Captain player calls accept an explicit resume token or fresh-session selection.
- [x] The shared runtime contract and linker specification expose session and resume types.
- [x] CODE and DISCUSS trace every runtime-boundary operation and maintain per-player resume tokens.
- [x] The Playbook Captain generates session UUIDs and forwards resume selections and tokens.
- [x] Integration tests cover fresh-session isolation, token rotation/clearing, trace order, and lifecycle identity.
- [ ] Published artifacts, package constraints, README, and changelog are updated.

## Tasks

1. **Specify session tracing and resume.** _[done]_
   Add DR-010, amend conflicting released specs, and define integration acceptance criteria.
2. **Extend the host player-call contract.** _[done]_
   Add explicit `resume: string | false` forwarding to cligent tmux-play and fix every advertised adapter resume path.
3. **Extend the shared runtime contract.** _[done]_
   Add `PlaybookSession`, `PlayerCallOptions`, trace types, and returned resume tokens while keeping the four-port boundary.
4. **Instrument linked runtimes.** _[done]_
   Add sequenced trace emission and resolved-player token maps to CODE and DISCUSS.
5. **Wire the Captain shell.** _[done]_
   Generate collision-free UUIDs, keep them stable while parked, and bridge explicit host resume calls.
6. **Verify and publish artifacts.**
   Add contract/runtime/shell/real-host tests, rebuild committed JavaScript and declarations, and update user and release documentation.

The source and generated artifacts are complete. Release coordination remains:
publish the first cligent version containing explicit player resume and
`Captain.prepareDispose`, then raise this package's cligent dependency floor
and lockfile pin to that release and verify a clean frozen install.

## Acceptance criteria

- Every new engagement receives a distinct UUID; a parked engagement retains its UUID.
- Every trace event carries that UUID and a contiguous sequence, and trace call pairs bracket exact runtime-boundary data.
- A player's first call in a session passes `resume: false`; later calls pass only the last returned non-empty token.
- Missing returned tokens clear continuity, while error or aborted results carrying a token remain resumable.
- A replacement engagement cannot inherit the prior engagement's host-player conversation.
- CODE, DISCUSS, the shared contract, package build, and full test suite pass.
