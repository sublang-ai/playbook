<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# CAPPLAY: Default Captain playbook

## Intent

This spec defines the source, compiled runtime, host integration, and compiler contracts for the default generic Captain playbook.
Essential project-specific references are the `reference/sdlc/captain.md` source, `slc` compiler definitions, and Playbook Captain shell.

### CAPPLAY-6

Where the package ships the default Captain playbook, the maintained source shall be `reference/sdlc/captain.md` and `slc playbook` shall compile it into `reference/sdlc/captain.playbook/` GEARS, XState FSM, linked runtime, and verification artifacts; the FSM shall implement a finite `ready` to decision to dynamic child call to reassessment loop and shall return a JSON-safe `{ response }` terminal output.

### CAPPLAY-7

Where the default Captain runtime is constructed, the shell shall supply an immutable catalog containing only each enabled callable playbook's stable id, effective command, and intent, excluding the internal Captain and all module, option, player, token, session, call, and stack data; when the FSM selects a dynamic target, it shall validate the id against that catalog and the shell shall independently validate it against the enabled registry before opening a child.

### CAPPLAY-8

Where a compiled GEARS behavior has Captain act directly, the FSM shall invoke a first-class `captain` actor and the linked runtime shall call `PlaybookPorts.callCaptain` visibly; where Captain delegates behavior to a named player, the FSM shall invoke a distinct `player` actor and the runtime shall call `callPlayer`; the host shall serialize visible Captain work and hidden `callJudge` work through one abort-aware concurrency-one queue and shall trace Captain calls with paired `captain.call.started` and `captain.call.finished` events.

### CAPPLAY-9

Where the shell is idle, when it receives ordinary Boss text, it shall lazily construct the internal `captain` root and submit the text; while a runtime stack exists, it shall route Boss input according to the active leaf and shall not let a new root selection replace that stack; the internal root shall require no generated player, command, empty visibility request, or `/captain` lifecycle status.

### CAPPLAY-10

Where the compiler emits a dynamic nested call, its invocation shall carry runtime `playbookId` and text from typed context plus explicit static metadata naming those context fields; SLC verification shall compare the metadata with the GEARS dynamic-call declaration, verify the context wiring, and exercise scripted child success and failure without evaluating implementation source text.
