<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-020: Routing-only Captain control

## Goal

Make the default Captain a deterministic router whose exact inputs, isolated calls, machine controls, and visible outputs cannot be confused with specialized execution.

## Deliverables

- [x] Routing-only architecture, behavior, implementation, and acceptance specs precede code changes.
- [x] Cligent enforces fresh tool-free Captain control calls or fails closed.
- [x] SLC keeps result contracts outside acting prompts and verifies them structurally.
- [x] The Captain source compiles to an initial clarify-or-delegate machine with exact visible prose ownership.
- [x] Shell and generated-runtime tests reproduce and prevent the observed direct-investigation failure.

## Tasks

1. **Record the correction.** _[done]_
   Add DR-013, this iteration, and coordinated CAPPLAY and CAPTAIN behavior before implementation.
2. **Enforce agent isolation.** _[done]_
   Forward fresh-session and tool-allowlist options through the Captain bridge and make each adapter honor or reject an empty allowlist.
   The runtime contract, shell bridge, generated generic Captain runtime, and cligent adapters now preserve fresh sessions and explicit empty tool allowlists.
3. **Separate source controls.** _[done]_
   Define and verify out-of-prompt result metadata in SLC without exposing guard schema to the acting Captain.
   The SLC definitions, compiled GEARS/FSM/runtime, and CAPPLAY-16 checks keep result metadata out of the exact acting prompts.
4. **Compile the router.** _[done]_
   Rewrite the maintained source, regenerate the canonical Captain bundle locally, and review every generated transition and prompt.
5. **Verify the live failure path.** _[done]_
   Test exact Boss-text delivery, zero initial terminal arms, zero tool calls, automatic child entry, meaningful final prose, and resume routing.
6. **Finalize without release.** _[partial]_
   Run focused and full suites in every changed repository, audit generated drift and package pins, and push signed commits without publishing artifacts.

## Progress

The canonical bundle under `reference/sdlc/captain.playbook/` is regenerated
from the routing-only source through the current interpreted SLC definitions.
The compiled routing state has only `question`, `delegation`, and the universal
Boss-reply suspension path; it has no direct terminal arm.
Visible Captain calls are fresh and tool-free, acting prompts preserve the
source prose without guard/result schema, and hidden adjudication owns the
structured result selection.

The generated artifact verifier reports no GEARS/FSM, prompt-composition, or
transition-coverage findings.
The hand-authored linked-runtime suite covers exact Boss text, automatic child
entry, child-result sanitization, resume, abort, lifecycle cleanup, ordered
traces, and control-error precedence.
Task 6 retains only the separately authorized signed push; no release, version,
lockfile, package pin, or published dependency range changes are part of this
iteration.

## Acceptance criteria

- An idle ordinary Boss intent reaches the Captain byte-for-byte and cannot terminate before clarification or a child call.
- Initial Captain calls cannot inspect the workspace or perform the requested specialized work.
- Visible prompts contain no guard or result-property schema, while adjudication still selects only declared transitions.
- Questions and final responses equal the visible Captain call's final text, and final text conveys an outcome rather than bare completion.
- A nested playbook pause receives the exact Boss reply at the active stack leaf and returns through the same runtime frames.
- All changed repositories pass their specified tests with no release, version, lock, or pin mutation.
