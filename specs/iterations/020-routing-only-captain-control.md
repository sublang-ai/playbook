<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-020: Routing-only Captain control

## Goal

Make the default Captain a deterministic router whose exact inputs, isolated calls, machine controls, and visible outputs cannot be confused with specialized execution.

## Deliverables

- [ ] Routing-only architecture, behavior, implementation, and acceptance specs precede code changes.
- [ ] Cligent enforces fresh tool-free Captain control calls or fails closed.
- [ ] SLC keeps result contracts outside acting prompts and verifies them structurally.
- [ ] The Captain source compiles to an initial clarify-or-delegate machine with exact visible prose ownership.
- [ ] Shell and generated-runtime tests reproduce and prevent the observed direct-investigation failure.

## Tasks

1. **Record the correction.** _[in progress]_
   Add DR-013, this iteration, and coordinated CAPPLAY and CAPTAIN behavior before implementation.
2. **Enforce agent isolation.** _[pending]_
   Forward fresh-session and tool-allowlist options through the Captain bridge and make each adapter honor or reject an empty allowlist.
3. **Separate source controls.** _[pending]_
   Define and verify out-of-prompt result metadata in SLC without exposing guard schema to the acting Captain.
4. **Compile the router.** _[pending]_
   Rewrite the maintained source, regenerate the canonical Captain bundle locally, and review every generated transition and prompt.
5. **Verify the live failure path.** _[pending]_
   Test exact Boss-text delivery, zero initial terminal arms, zero tool calls, automatic child entry, meaningful final prose, and resume routing.
6. **Finalize without release.** _[pending]_
   Run focused and full suites in every changed repository, audit generated drift and package pins, and push signed commits without publishing artifacts.

## Acceptance criteria

- An idle ordinary Boss intent reaches the Captain byte-for-byte and cannot terminate before clarification or a child call.
- Initial Captain calls cannot inspect the workspace or perform the requested specialized work.
- Visible prompts contain no guard or result-property schema, while adjudication still selects only declared transitions.
- Questions and final responses equal the visible Captain call's final text, and final text conveys an outcome rather than bare completion.
- A nested playbook pause receives the exact Boss reply at the active stack leaf and returns through the same runtime frames.
- All changed repositories pass their specified tests with no release, version, lock, or pin mutation.
