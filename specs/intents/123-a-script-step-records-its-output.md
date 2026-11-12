<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-123: A Script Step Records Its Output

## Status

Implemented (2026-11-12).

## Intent

Record what a script step printed on its `playbook.script` telemetry event, for hosts and people only, per [DR-103](../decisions/103-a-script-step-records-its-output.md).

## Deliverables

- [x] The shared factory's script actor reads stdout and stderr through one pipe and emits the duration and the bounded, leniently decoded tail.
- [x] `slc/link.md` "Script execution", the embedding guide, spec items, map, and changelog in agreement; `spex lint` clean.
- [x] Runtime and Captain-shell suites pinning the record and its confinement.
- [x] The spawn and capture checked against Git's `sh.exe` on Windows 11.
- [x] A line in the Windows system code page decoded in it, verified on a Windows 11 host at code page 936.
- [x] A cut tail whose first line keeps its characters in the encoding that decodes it, verified on the same host.
- [x] A relay between the command and the runtime, so a process the command leaves running can still write after the step and after the host process exits, verified on macOS and on the same Windows host.
- [x] The tail's decoding and cut tracking in a module of their own, tested on every platform in each of the six code pages.
- [x] A command able to open its output again by path, as through `/dev/stderr`, verified in a Linux container.

## Tasks

1. Specify, implement, and verify the script output record in one commit.
2. Decode a non-UTF-8 line in the Windows system code page.
3. Drop a cut tail's partial character in the encoding that decodes its first line.
4. Follow the cut line's dropped bytes, so its character boundary is known and not inferred.
5. Keep following the cut line's UTF-8 boundary past bytes that are not UTF-8.
6. Relay the command's output, so a descendant's later write outlives the runtime's read and the host process.
7. Move the output tail to its own module and test it directly in every code page.
8. Keep a newline's NUL out of the next line.
9. Tie the Captain-shell and cut-row assertions to what their spec items state.
10. Give decoding its own spec item, and state outcomes where the items stated mechanism.
11. Give the command a pipe it can open again by path.
12. Take a relay that could not start as a failed step.
13. Put the script-output build under the drift check.
14. Leave a NUL that opens the output in its line.
15. Pass a code page's reader as one value.
16. Tie the descendant's marker to its write's own status, and pin the status of a signal-ended command.
17. State what the capture needs, and that its wait bounds a slow relay too.
18. State that native Windows keeps a pipe no command opens by path.

## Verification

- `pnpm test` and `npm run prepush` pass on the branch.
- The runtime suite pins write order, the bound, decoding, the descendant's later write with and without the host process, and confinement; the shell suite pins that no agent call receives the output; the script-output suite pins decoding and cut tracking in each code page.
