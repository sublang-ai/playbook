<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-123: A Script Step Records Its Output

## Status

Implemented (2026-11-11).

## Intent

Record what a script step printed on its `playbook.script` telemetry event, for hosts and people only, per [DR-103](../decisions/103-a-script-step-records-its-output.md).

## Deliverables

- [x] The shared factory's script actor reads stdout and stderr through one pipe and emits the duration and the bounded, leniently decoded tail.
- [x] `slc/link.md` "Script execution", the embedding guide, spec items, map, and changelog in agreement; `spex lint` clean.
- [x] Runtime and Captain-shell suites pinning the record and its confinement.
- [x] The spawn and capture checked against Git's `sh.exe` on Windows 11.
- [x] A line in the Windows system code page decoded in it, verified on a Windows 11 host at code page 936.
- [x] A cut tail whose first line keeps its characters in the encoding that decodes it, verified on the same host.

## Tasks

1. Specify, implement, and verify the script output record in one commit.
2. Decode a non-UTF-8 line in the Windows system code page.
3. Drop a cut tail's partial character in the encoding that decodes its first line.
4. Follow the cut line's dropped bytes, so its character boundary is known and not inferred.

## Verification

- `pnpm test` and `npm run prepush` pass on the branch.
- The runtime suite pins write order, the bound, decoding, the descendant wait, and confinement; the shell suite pins that no agent call receives the output.
