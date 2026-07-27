<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Using the CLI

`playbook` has two surfaces: an interactive tmux-play session, and a
one-shot non-interactive `run`. Agent settings for both come from the
[config](configuration.md).

## Interactive

```sh
playbook            # launch the configured playbooks in tmux-play
playbook --list     # ids, slash commands, and intents; no launch
playbook --help     # config path, auth pointers, agent-swap recipe
```

Without a global install, `npx @sublang/playbook` runs the same bin.

The command resolves its config (seeding it on first run), composes a
`tmux-play` config, checks adapter readiness, and launches. It exits
with tmux-play's status, re-raises a terminating signal on itself, and
exits `127` when it cannot launch at all
([PBCLI-1](../specs/user/playbook-cli.md#pbcli-1),
[PBCLI-2](../specs/user/playbook-cli.md#pbcli-2)).

### Running a Boss turn

The Boss pane starts at the Playbook Captain shell. Use `/code <task>`
to select the CODE playbook explicitly, or type ordinary text and let
the compiled default Captain ask a material routing question or plan one
or more enabled playbook calls. It cannot answer the initial intent
directly; calls run sequentially so Captain can reassess after every
child result and then return a concrete result or actionable conclusion.

Once a turn reaches CODE, the CODE judge classifies it into an FSM event
— start a coding turn, continue or summarize an iteration, interrupt to
a named state, or nothing
([PBRT-1](../specs/user/playbook-runtime.md#pbrt-1)). When a player
surfaces a clarifying question the FSM parks, the pane shows the
question, and your next turn is normally classified as the reply — a
fresh directive abandons it
([PBRT-2](../specs/user/playbook-runtime.md#pbrt-2)).

The Captain pane shows start/stop/finished status with `◇` lines and
streams progress with captain-speech classification and questions
([PBRT-3](../specs/user/playbook-runtime.md#pbrt-3)), while player
prompts ride their own panes.

## Non-interactive

`playbook run <from> [task]` runs one playbook once, without tmux-play
and without a config entry — point it straight at a registry module:

```sh
playbook run @sublang/playbook/code/registry "add a test for parseArgs" \
  --player coder=claude --player reviewer=codex --cwd ./my-repo
```

`[task]` is read from stdin when omitted — pipe long or multi-line
intents the same way you would to `claude -p` or `codex exec`.

| Flag | Meaning |
| --- | --- |
| `--player <role>=<agent>` | bind a required role |
| `--captain <agent>` | set the captain/judge agent |
| `--option <key>=<value>` | a playbook option (CODE's `committer`) |
| `--cwd <dir>` | the agents' working directory |
| `--json` | one envelope: `outcome`, `sessionId`, output or questions |
| `--no-provision` | never create engine links beside a filesystem `<from>` |

`<agent>` is `<adapter>[:<model>][@<effort>]` — `codex:gpt-5.5@xhigh`,
or `claude@high` for the default model at high reasoning effort. The
model keeps every interior colon (`opencode:ollama/llama3:8b@max`), and
an unsupported effort is rejected up front naming the adapter's
supported values. Roles and the captain default to `claude` unless the
config supplies [run defaults](configuration.md#defaults-for-playbook-run).

Exit codes: `0` terminal, `1` bad argument or module, `2` failure, `3`
the playbook needs a Boss reply
([PBCLI-18](../specs/user/playbook-cli.md#pbcli-18)).

### Engine provisioning

A compiled playbook module imports `xstate` and
`@sublang/playbook/xstate-runtime` from its own directory. When a
filesystem `<from>` cannot resolve them — typically under a global
`npm install -g @sublang/playbook` with no project-local packages —
`playbook run` provisions them automatically before loading: it creates
`node_modules/xstate` and `node_modules/@sublang/playbook` beside the
module as symlinks to the running host's own packages and prints one
line naming what it linked
([PBCLI-36](../specs/user/playbook-cli.md#pbcli-36),
[DR-024](../specs/decisions/024-runtime-engine-provisioning.md)).
A directory where the imports already resolve is never touched — a
project-local install always wins — and `--no-provision` disables the
mechanism entirely.

If the module's directory is a git repository, add `node_modules/` to
its `.gitignore` so the provisioned links never land in commits made by
player agents working there.

### Resuming a parked run

When the playbook stops to ask something, the run is parked, not lost:
the question prints to stdout, the session is saved under
`${XDG_STATE_HOME:-$HOME/.local/state}/playbook/sessions/`, and stderr
names the command that continues it.

```sh
playbook run resume 4f2c…9ab1 "keep the scope small; skip the docs"
playbook run resume --last   # most recently parked session; reply on stdin
```

A resumed run picks up exactly where it parked — same session id, same
workflow state, and each agent continues its own conversation — then
prints the final output and exits `0`, or parks again and exits `3`. The
lineup, options, and working directory are stored with the session, so
`resume` takes no binding flags. In scripts, capture the session id from
the `--json` envelope, like Claude Code's `session_id` or
`codex exec resume`
([PBCLI-22](../specs/user/playbook-cli.md#pbcli-22),
[DR-014](../specs/decisions/014-durable-one-shot-run-sessions.md)).
