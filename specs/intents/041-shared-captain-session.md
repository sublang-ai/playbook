<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-041: Shared Captain session

## Status

Complete

## Intent

Make interactive `playbook` and headless `playbook run` two presentations of the same compiled, configurable, durable Captain session, including nested playbook execution and process-crossing continuation.

## Deliverables

- [x] A new headless turn uses the same normalized config, compiled Captain, controller, catalog, engagement stack, and mapped player sessions as interactive mode.
- [x] Argument and stdin input enter the same Boss-turn boundary, with the one Boss-visible Captain reply on stdout and operational output on stderr.
- [x] CODE and DECIDE can complete their nested REVIEW calls under headless execution.
- [x] Every successful headless turn persists the complete logical Captain session, including chat-only and nested parked states.
- [x] `--continue` resumes the latest session and `--session` selects one explicitly without replaying prior effects.
- [x] The separate `run:` config, positional registry execution, and run-only binding flags are retired with a clear major-version migration.
- [x] Deterministic, packed, and real-agent release gates pass for the final candidate without publishing or tagging it; the conditional manual tmux gate does not trigger because presenter behavior and layout are unchanged.

## Tasks

1. Record the shared-front-end decision, this intent, the superseded decisions, and their map entries in one commit.
2. Update the playbook-runtime contract and extend the public runtime snapshot and nested bridge to restore one already-started suspended child call without reopening it, with schema-version-1 compatibility and focused contract tests in one commit.
3. Carry the suspended-call snapshot through the shared linked runtime, the bespoke DECIDE runtime, the playbook-runtime contract, `slc/link.md`, generated siblings, and artifact conformance tests in one commit.
4. Add complete safe snapshot and restore to the Captain shell, updating the playbook-captain and captain-playbook contracts and proving idle, engaged, and nested parked restoration in one commit.
5. Extract one reusable config, overlay, provisioning, readiness, and normalized-lineup path for interactive and headless hosts, updating the playbook-cli internal contract and preserving interactive behavior in one commit.
6. Replace direct one-shot execution with `playbook run [input]` over the shared Captain host, updating playbook-cli behavior and tests for argv, stdin, output channels, JSON, nested calls, and the retired run-only surface in one commit.
7. Persist every completed headless turn and add atomic session replacement, `--continue`, `--session`, frozen-config restoration, and their playbook-cli contract and tests in one commit.
8. Add exclusive session locking, write-ahead uncertain-turn state, crash recovery diagnostics, and their playbook-cli contract and concurrency tests in one commit.
9. Update the starter config, README, CLI and configuration guides, changelog, and migration diagnostics for unified Captain sessions in one commit.
10. Update deterministic packed smoke, release specifications, and real-agent acceptance to prove installed headless Captain parity, nested REVIEW, stdin, and process-crossing continuation in one commit.
11. Prepare the dated 7.0.0 changelog and manifest candidate without tagging, pushing, publishing, or creating a GitHub Release in one commit.
12. Correct the live-gate-exposed terminal-root settlement so Captain retains the runtime-published final meaning without exposing opaque output, and align deterministic and real-agent acceptance with that contract in one commit.
13. Run the complete pre-release and acceptance verification against the corrected candidate, record the verified intent as complete, and stop for Boss review and approval without tagging, pushing, publishing, or creating a GitHub Release in one commit.

## Verification

- The same configured Captain and player identities receive equivalent calls for one fresh Boss turn through `playbook` and `playbook run`.
- Plain headless stdout is exactly the Captain reply accepted for presentation, with no hidden prompt, player result, status, telemetry, or internal identifier.
- `playbook run "/code <task>"` drives CODE through its nested REVIEW and returns Captain's grounded reply.
- A parent parked behind REVIEW is persisted, restored in another process without a second child start, and resumed exactly once from the original child result.
- A chat-only turn and a turn after a root playbook completes both remain continuable through the same Captain conversation.
- A changed config cannot rewire an existing session, concurrent continuation is rejected, and a crash cannot silently replay an uncertain turn.
- The packed candidate passes the deterministic release workflow, real-agent CLI acceptance, and any required manual tmux smoke without publishing or tagging.
