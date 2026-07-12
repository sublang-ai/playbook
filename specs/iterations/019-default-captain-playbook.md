<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-019: Default Captain playbook

## Goal

Compile the generic Captain's routing and multi-playbook planning policy from maintained natural language and host it over the causal nested runtime stack.
IR-020 supersedes this iteration's initial direct-answer routing and shared-agent-session assumptions.

## Deliverables

- [x] Architecture, user behavior, system behavior, acceptance tests, and natural-language source recorded before implementation.
- [x] Direct Captain calls and dynamic nested targets supported by the runtime and compiler contracts.
- [x] `slc playbook` produces reviewed Captain GEARS, FSM, runtime, and verification artifacts.
- [x] The shell lazily hosts the compiled Captain with a sanitized enabled-playbook catalog.
- [x] Nested clarification, multi-call planning, active-leaf routing, visibility, and trace behavior pass end to end.
- [ ] Immutable dependency and SLC pin refreshes preserve clean-install reproducibility.

## Tasks

1. **Specify and author the Captain.** _[done]_
   Add DR-012, the CAPPLAY package, this iteration, and `reference/sdlc/captain.md` before changing runtime contracts.
2. **Add Captain and dynamic-call primitives.** _[done]_
   Extend the shared runtime, linker definitions, traces, direct-actor FSM convention, and tests without modeling Captain as a player.
3. **Compile the source.** _[done]_
   Extend SLC's dynamic-call verification and child coverage, compile through `slc playbook`, review the artifacts, and resolve generated-test portability.
4. **Host the internal root.** _[done]_
   Inject the sanitized catalog, route idle ordinary text into the lazy Captain, preserve explicit idle commands, and retain deterministic leaf routing and LIFO return.
5. **Close immutable dependencies.** _[pending release gate]_
   Release the required cligent surface, release Playbook's breaking composed contract, then atomically refresh SLC's dependency, definitions, reviewed meta artifacts, provenance profile, and pins.
6. **Verify and finalize.** _[in progress]_
   Run focused stack/compiler tests, clean-install package closure, both full suites, generated-drift checks, licensing checks, and an adversarial audit.

The local runtime, compiler, shell, generated artifacts, and behavioral suites
are complete. Immutable closure remains release-coordinated: publish the
required cligent 0.14 surface and Playbook 1.0 composed contract, then refresh
SLC's dependency, definitions, reviewed artifacts, provenance profile, and
pins atomically. Until that authorized sequence, package versions, registry
locks, and SLC pins remain unchanged and clean registry installation is an
intentional open gate rather than evidence that the local implementation is
incomplete.

## Acceptance criteria

- Ordinary intent reaches the compiled Captain, while an explicit idle playbook command still selects that playbook directly.
- Captain handles, clarifies, or forms a finite useful plan from the sanitized enabled catalog and invokes no unknown or self target.
- Multiple calls run one at a time and may replan after every success, abort, or failure.
- A parked descendant receives the next Boss input and returns through every suspended parent without reconstruction or identity inference.
- Direct Captain work is visible once, hidden judge control remains hidden, and their shared session is serialized and fully traced.
- The checked-in Captain artifacts were produced by `slc playbook`, pass generated verification, and build against the same immutable contracts used by clean CI.
