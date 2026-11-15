<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-124: A Script Step's Command Is on Record

## Status

Implemented (2026-11-15).

## Intent

Carry a script step's command on its `playbook.script` telemetry event, and tell the session Captain closing a failed run the last script step's exit status and command, never its output, per [DR-107](../decisions/107-a-script-steps-command-is-on-record.md).

## Deliverables

- [x] The shared factory's script actor emits `command` as executed in the `playbook.script` payload.
- [x] The Captain shell adds the script-step settlement fact after the completion fact of a failed root run.
- [x] `slc/link.md` "Script execution", the embedding guide, spec items, map, and changelog in agreement; `spex lint` clean.
- [x] Runtime and Captain-shell suites pinning the field, the fact, its reach to a later Boss question, and the output's confinement.

## Tasks

1. Specify, implement, and verify the command on the record and the Captain's script-step fact in one commit.

## Verification

- `pnpm test` and `npm run prepush` pass on the branch.
- The runtime suite pins the seven-field payload with the command the machine's context bound; the shell suite pins the fact in the closing call, the resumed conversation and the journal recap of a later Boss question, the absence of the fact where the script exited zero, and that no agent call receives the output.
