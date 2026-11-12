<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-103: A Script Step Records Its Output

## Status

Accepted (2026-11-11), after one check step's nonzero exit ended three runs for two different reasons that no record could tell apart [[1]].
Amends [DR-016](016-script-actors-and-optimize-pass.md) §2 in one scope: the `playbook.script` telemetry event additionally carries the step's duration and a bounded tail of what the command printed.
Script output stays out of machine context, guards, prompts, status lines, and `playbook.trace` payloads, and every other DR-016 decision stands.

## Context

- A script step ran its command with stdout and stderr discarded: its whole record was the status line and `{ stateId, sourceItem, exitStatus }`.
- Script steps serve as gates, and a nonzero exit has many causes besides the check's own "no": a missing tool, a wrong runtime version, a wrong branch or directory, no network.
- A script runs in the host process's environment, not in an agent's shell, so one command can pass for the agent and fail as a script with nothing recorded to show the difference.
- A failure terminal's description is authored before the run and names one assumed cause ([DR-035](035-truthful-terminal-meaning.md), [DR-037](037-terminal-result-meaning.md)); a reader could not check it against what the command printed.
- An agent step leaves its commands and their output on record; the optimize pass's rewrite into a script dropped that record, although DR-016 §3 treats the rewrite as behavior-preserving.
- DR-016 §2 kept script output from becoming workflow data; it names the `playbook.script` topic as a record beside the trace, and it never required that the output go unrecorded.
- Considered and declined:
  - separate stdout and stderr tails: each line keeps its stream and loses its place among the other stream's lines, which is what a reader follows;
  - two pipes merged as read: the order of near-simultaneous writes on two pipes is arbitrary;
  - the pipe Node gives a child process, alone: it is a socket pair, which Linux refuses to open again by path, so a command that writes to `/dev/stderr` would fail where it passed with its output discarded;
  - the runtime as the pipe's only reader: a process the command left running would be killed by its next write once the host process exited, where discarded output never failed it;
  - a file the runtime reads back: a long-lived process the command left running would fill it without bound;
  - recording only a nonzero exit: a pass that should have failed needs the same evidence as a failure;
  - UTF-8 alone: on a Chinese Windows, `cmd`, PowerShell, Python, and the system tools print their messages in code page 936, which then read as U+FFFD and unrelated characters beyond recovery;
  - choosing between a system's differing ANSI and OEM code pages: both are single-byte, so a line is valid in either and a wrong choice prints plausible wrong letters;
  - reading UTF-16 lines: `wsl.exe` alone prints them, and their ASCII already reads once NUL is removed;
  - redaction: the runtime cannot tell a secret from other text, and an agent's tool output is already stored unredacted;
  - showing the output in `playbook run`: a terminal display of untrusted text is a separate host decision.

## Decision

### 1. One text, in the order written

The command's stdout and stderr share one pipe, so the record is one text in the order the command wrote it.
Off native Windows, where the host allows, it is a pipe the command can open again by path, as through `/dev/stderr`.
The stream a line came from is not kept.
The runtime starts a relay process beside the command's shell and hands it the reading of that pipe: the relay copies to the runtime and, once the runtime stops reading or its process exits, reads on and discards.

### 2. A bounded, leniently decoded tail

- The record keeps the last 16 KiB of the captured bytes and states whether earlier bytes were dropped.
- The kept bytes decode as UTF-8, each invalid sequence becoming U+FFFD.
- On native Windows, a line that is not UTF-8 decodes in the system code page instead, where one code page — 874, 932, 936, 949, 950, or 1258 — serves as both the system's ANSI and OEM code page; a line holding a NUL is UTF-16 and stays UTF-8, and the NUL that ends a UTF-16 newline belongs to that newline, not to the line after it.
- A tail cut inside a line reads the rest of that line as part of the whole line: in the encoding the whole line takes, from its first character boundary at or after the cut, less the character the cut split.
- The kept bytes alone settle neither: a two-byte code page marks no boundary in them, and the NUL or the invalid byte that decides the encoding may lie before the cut, so the capture accounts for that line's dropped bytes.
- NUL characters are removed, so a UTF-16 line of ASCII text reads as its text and no record holds U+0000.
- Capture ends when the pipe closes with everything passed on, or after a short bounded wait from the shell's exit, whichever comes first; a descendant that holds the pipe open past that exit keeps a working stdout and stderr, also after the host process has exited.

### 3. The record is the `playbook.script` telemetry event

Every completed script step, at a zero or nonzero exit alike, emits `{ stateId, sourceItem, exitStatus, durationMs, output, outputTruncated }`.
The status line is unchanged, and an aborted or unspawnable step still emits neither.
The exit status alone still selects the guard.

### 4. Untrusted text, for hosts and people only

- The output enters no actor result, machine context, saved step result, player, Captain, or judge prompt, status line, `playbook.trace` payload, or run result.
- The Captain shell passes the event to its host and gives its output to no agent call, the one reporting a failed run included.
- A host shows the output as inert text and hands it to no agent on the run's behalf.

### 5. Stored like every telemetry record

The event lands in the session's records, which a host may sync or share, exactly as an agent's tool output does today.
The runtime redacts nothing; a host that must not retain the output drops the two fields at its own telemetry port.

## Consequences

- A host can show why a gate failed: the command's own words beside the exit status and the terminal's authored description.
- Session records grow by at most the bound, plus JSON escaping, for each script step.
- The payload change is additive: `RUNTIME_ABI` and artifact schemas are unchanged, and no artifact recompiles, because the shared factory provides the actor ([DR-019](019-shared-linked-runtime-factory.md)).
- A consumer comparing the `playbook.script` payload exactly must accept the three new fields.
- On a Chinese, Japanese, Korean, Thai, or Vietnamese Windows, a tool's messages in the system code page read as their text beside UTF-8 lines.
- On a Windows whose ANSI and OEM code pages differ, a line that is not UTF-8 is lost beyond recovery: it reads as U+FFFD and unrelated characters, with only its ASCII intact; so does the non-ASCII text of a UTF-16 line.
- A short code-page line whose bytes happen to form valid UTF-8 reads as UTF-8.
- On native Windows, a host process's first script step waits for one registry read of the system's code pages.
- A step whose descendant holds the pipe open settles later by at most the bounded wait, and its relay runs for as long as that descendant holds the pipe.
- The bounded wait cannot tell a descendant that holds the pipe from a relay that is still copying: a relay that falls behind the shell's exit by more than the wait costs the record its last bytes, with nothing to mark the loss.
- On native Windows, and on Linux where the runtime cannot make its pipe, a command that opens `/dev/stderr` or `/dev/stdout` by path fails, where it passed with its output discarded.
- A script step needs `cat` beside `sh` and starts one more process, the relay; without `cat` a command's writes fail. The command's own shell, its process group, and its exit status are as before.
- `playbook run` is unchanged: it prints the status line, and telemetry topic names under `--verbose`.

## References

[1]: https://github.com/sublang-ai/playbook/issues/104 "Playbook issue 104 — a script step records only its exit status"
