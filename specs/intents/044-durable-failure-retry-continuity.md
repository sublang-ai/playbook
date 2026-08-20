<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-044: Durable failure-retry continuity

## Status

Done

## Intent

Implement DR-034 so a playbook parked in the recoverable failure state offers the same retry to a continued session as to the live process, sourcing that action's payload from the persisted machine snapshot instead of a process-local record.

## Deliverables

- [x] The shared factory's entry-event contract carries an optional declaration naming the FSM context member that holds the exact Boss entry text.
- [x] A declared runtime derives its failure-state retry from that member of the live snapshot, so the action derives identically before and after `restore`, including a failure reached after a Boss reply.
- [x] An undeclared runtime keeps the recorded-event source, and no candidate exclusion, label rule, or free-text invariant changes.
- [x] The durable runtime snapshot, its schema, its validator, and the shell's restore comparison are untouched.
- [x] CODE and REVIEW declare the source and prove recovery through a continued session in the shell and CLI suites.
- [x] The hermetic cross-process release gate proves the retry is advertised and applied in a second process.

## Tasks

1. Record DR-034 and this intent with their map entries in one commit.
2. Source the failure-state retry from the artifact-declared context member in the shared engine, amending the control-surface behavior and verification items and the matching linker definition text, with synthetic coverage of the entry-path and reply-path failure shapes live and restored, in one commit.
3. Declare the context source in the CODE and REVIEW artifacts with their generated siblings, and extend the artifact discovery expectation so a re-linked artifact cannot silently ship without it, in one commit.
4. Extend the Captain-shell and headless-CLI verification with a continued-session retry that is advertised from the restored leaf, decided from the composed digest, and applied once, in one commit.
5. Extend the hermetic cross-process release gate with a second-process retry leg asserted on the composed control view, in one commit.
6. Update the changelog, record this intent complete, and stop for review without tagging, pushing, or publishing in one commit.

## Verification

- The real CODE and REVIEW runtimes parked in the recoverable failure state advertise the same action id and label after `restore` as before it.
- A failure reached after a Boss reply resumed the work advertises that retry in both processes, where it previously advertised nothing in either.
- A runtime whose artifact declares no context member advertises exactly what it advertises today, including the case where the failure state refuses the recorded event.
- An exported snapshot's members and the restored runtime's re-export are unchanged by this intent.
- A continued headless session recovers a parked-failed leaf in place, with one execution and no dismissal of the engagement.
- Deterministic suites, the link and SPDX checks, Spex lint, the packed release smoke, and the cross-process gate pass.
