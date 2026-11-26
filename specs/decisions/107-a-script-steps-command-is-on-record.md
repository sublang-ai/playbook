<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-107: A Script Step's Command Is on Record

## Status

Accepted (2026-11-15).
Amends [DR-106](106-a-script-step-records-its-output.md).

## Context

- A host could show what a failed check printed but not the command that printed it, and the session Captain could tell the Boss neither [[1]].
- This record extends DR-106 §3's event with the command and §4's Captain with the facts below; every other DR-106 decision stands.
- DR-106 records what a script step printed, and the event names the step only by `stateId` and `sourceItem`.
- A script's command may carry a placeholder the machine binds at run time ([DR-050](050-pull-request-delivery.md)), so a host reading the artifact's source finds the authored command, not the one that ran.
- The session Captain closes a failed run from the terminal's authored description alone; asked which command ran and how it exited, it can only answer that its report holds neither.
- The command is the playbook's own text with values the machine already retains bound in as data; the exit status is a number the runtime measured: neither is what a command printed.
- The shell keeps internal state identifiers out of what the Captain is told and says ([DR-029](029-session-scoped-conversational-captain.md)), so a step cannot be named to it by its state id.
- Considered and declined:
  - giving the Captain the output, fenced as evidence: what a command prints is text no one authored or reviewed, and the Captain selects actions;
  - the authored command with its placeholders: the host and the Captain would name a command that did not run;
  - naming the step to the Captain by its state id: the shell withholds internal state identifiers from the Captain's prompts and replies, and the command names the step by itself;
  - stating every script step, or the script steps of a run that succeeded: the Boss asks why a run failed, and a passed check answers nothing;
  - stating a nonzero exit that a later script step of the turn followed: the run went on past it, so it reads as the cause where it is not;
  - retaining the fact in shell state for later turns: the closing call's conversation and the outcome journal already carry every settlement fact to a later Boss question.

## Decision

### 1. The event carries the command as executed

The `playbook.script` event is `{ stateId, sourceItem, command, exitStatus, durationMs, output, outputTruncated }`.
`command` is the text the script actor ran through the shell, every placeholder bound, at a zero or nonzero exit alike.
It is the playbook's text for hosts and people, shown as inert text like the output.

### 2. The Captain is told what ran and how it exited, not what it printed

- Where a root playbook ends at a failure terminal, and the last script step to complete in that Boss turn — the root's or a nested playbook's — exited nonzero, the shell adds one settlement fact after the completion fact.
- The fact names the playbook the step belongs to by its command, the exit status, and the command as executed, quoted and bounded as the shell quotes every text it did not author.
- The fact says that the command's output is on the session's record for the host and was not given to the Captain.
- The fact names no state id, and it claims no cause: it states what ran and how it exited beside the terminal's authored meaning.
- A later Boss question reads the fact as every settlement fact is read: from the Captain's remembered conversation, or from the outcome journal where that conversation was replaced.
- The output still enters no Captain, judge, or player call.

## Consequences

- A host shows the command that ran beside its exit status and output without reading the artifact's source.
- Asked why a run failed, the Captain can name the command and its exit status and say where the output is, instead of saying its report holds neither.
- A consumer comparing the `playbook.script` payload exactly must accept the new field.
- The payload change is additive: `RUNTIME_ABI` and artifact schemas are unchanged, and no artifact recompiles.
- A command longer than the shell's bound for quoted text reaches the Captain truncated and so marked, and a command of several lines reaches it on one line; the event carries it whole.
- A value bound into the command reaches the Captain's prompt as quoted evidence, as a player's reported text does today.
- A run that parks for the Boss between its failed script step and its failure terminal ends with no such fact: the step completed in an earlier turn.
- A failed run whose last script step exited zero ends with no such fact.

## References

[1]: https://github.com/sublang-ai/spex/issues/380 "Spex issue 380 — a failed playbook run reads done, and the app cannot show why it failed"
