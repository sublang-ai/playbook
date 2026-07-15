<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-020: Routing-only Captain control

## Goal

Make the default Captain a deterministic router whose exact inputs, isolated calls, machine controls, and visible outputs cannot be confused with specialized execution.

## Deliverables

- [x] Routing-only architecture, behavior, implementation, and acceptance specs precede code changes.
- [ ] Cligent enforces fresh tool-free Captain control calls or fails closed.
      Cligent (IR-034/DR-010) and the shell bridge enforce it; the generated
      generic Captain runtime does not yet forward the empty allowlist (see
      Progress below).
- [ ] SLC keeps result contracts outside acting prompts and verifies them structurally.
      SLC definitions and CAPPLAY-16 landed; the guard/result schema is still
      present in the not-yet-regenerated compiled prompts.
- [ ] The Captain source compiles to an initial clarify-or-delegate machine with exact visible prose ownership.
- [ ] Shell and generated-runtime tests reproduce and prevent the observed direct-investigation failure.
      Shell/bridge tests landed; generated-runtime tests are still on the old
      `direct` machine.

## Tasks

1. **Record the correction.** _[done]_
   Add DR-013, this iteration, and coordinated CAPPLAY and CAPTAIN behavior before implementation.
2. **Enforce agent isolation.** _[partial]_
   Forward fresh-session and tool-allowlist options through the Captain bridge and make each adapter honor or reject an empty allowlist.
   Done: the runtime contract (`src/runtime.ts` `CaptainCallOptions.resume`/`allowedTools`), the shell bridge (`reference/sdlc/code.playbook/playbook-captain.ts` forwards `{ resume: false, allowedTools: [] }`), and cligent adapter honor/reject (IR-034/DR-010). Remaining: the generated generic Captain runtime (`captain.playbook.ts`) still calls `callCaptain(prompt, signal, { visibility })` and `callJudge(prompt, signal)` without the isolation options — fixed only by regenerating the bundle (Task 4).
3. **Separate source controls.** _[partial]_
   Define and verify out-of-prompt result metadata in SLC without exposing guard schema to the acting Captain.
   Done: SLC definitions (`slc/link.md`, `slc/gears2fsm.md`, `slc/text2gears.md`) and CAPPLAY-16. Remaining: the not-yet-regenerated compiled prompts still embed guard/result-property names, so the separation is defined but unrealized in the artifact.
4. **Compile the router.** _[pending]_
   Rewrite the maintained source, regenerate the canonical Captain bundle locally, and review every generated transition and prompt.
   The maintained source (`reference/sdlc/captain.md`) is rewritten routing-only; the compiled bundle under `reference/sdlc/captain.playbook/` was NOT regenerated (last generated before the source rewrite), so it still ships a `direct` routing→done arm, guard/result schema in the visible routing prompt, and no empty-allowlist forwarding. See Progress.
5. **Verify the live failure path.** _[pending]_
   Test exact Boss-text delivery, zero initial terminal arms, zero tool calls, automatic child entry, meaningful final prose, and resume routing.
6. **Finalize without release.** _[pending]_
   Run focused and full suites in every changed repository, audit generated drift and package pins, and push signed commits without publishing artifacts.

## Progress

Landed on this branch: the specs (DR-013, this record, CAPPLAY user/dev/test,
CAPTAIN), the routing-only Captain source `reference/sdlc/captain.md`, the SLC
compiler definitions, the `@sublang/playbook/runtime` isolation contract, the
Playbook Captain shell bridge (fresh + empty-allowlist on its direct-Captain
and judge calls), and cligent's per-adapter honor/reject (tracked there as
IR-034 / DR-010).

Remaining and blocking (Task 4): the canonical Captain bundle under
`reference/sdlc/captain.playbook/` must be regenerated from the rewritten
source. Until then the compiled machine still exposes the pre-DR-013 `direct`
terminal arm (`captain.fsm.ts` `direct` → `done`), leaks guard/result-property
names into the visible routing prompt (`captain.gears.md` CAPTAIN-1), and never
forwards `{ resume: false, allowedTools: [] }` from `captain.playbook.ts`.
The hand-authored `captain.playbook.integration.test.ts` (and the prompt/
coverage tests) still pin the old two-outcome machine and must move with it.

Regeneration requires a clean `slc playbook reference/sdlc/captain.md`
compile against the current runtime contract. That needs the SLC `playbook`
pipeline pins (`slc/pipelines/playbook/slc.pins.json`) regenerated for the new
6-port contract first: the pin-currency gate fails closed on the contract
change by design and SLC exposes no user-facing pin-regeneration command, so
this step is a prerequisite that must be run in a checkout with the packages
installed in-boundary (not symlinked). The output must then be reviewed
transition-by-transition and the authored integration test updated before the
generated-runtime suite (Task 5) can pass.

Observed live (spex desktop, real Captain over the current bundle): an idle
"review greet.ts for bugs" intent DID route to CODE (`delegation` →
`/code`), confirming the routing path works end to end — but the visible
routing call returned `{"guard":"delegation", ...}` JSON rather than human
prose (the CAPPLAY-16 / AC-3 violation), and a repeat run flaked into a
runtime error during adjudication. Both are consequences of the un-regenerated
bundle and are the concrete failures Task 4/5 must eliminate.

## Acceptance criteria

- An idle ordinary Boss intent reaches the Captain byte-for-byte and cannot terminate before clarification or a child call.
- Initial Captain calls cannot inspect the workspace or perform the requested specialized work.
- Visible prompts contain no guard or result-property schema, while adjudication still selects only declared transitions.
- Questions and final responses equal the visible Captain call's final text, and final text conveys an outcome rather than bare completion.
- A nested playbook pause receives the exact Boss reply at the active stack leaf and returns through the same runtime frames.
- All changed repositories pass their specified tests with no release, version, lock, or pin mutation.
