<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Using the CLI

`playbook` has two surfaces: an interactive tmux-play session, and a
one-shot non-interactive `run`. Agent settings for both come from the
[config](configuration.md).

## Installing agent SDKs

Each adapter is backed by a vendor runtime that installing
`@sublang/playbook` never downloads for you, so no install carries an
agent stack you did not ask for. Which versions each adapter supports
is [cligent](https://github.com/sublang-ai/cligent)'s knowledge and
ships with it
([DR-027](../specs/decisions/027-runtime-compatibility-from-cligent.md));
the commands below install the latest, which cligent accepts from its
supported floor up. Install the SDKs your config names, each as its
own top-level install root:

```sh
npm install -g @sublang/playbook @anthropic-ai/claude-agent-sdk   # claude
npm install -g @sublang/playbook @openai/codex-sdk                # codex
npm install -g @sublang/playbook @opencode-ai/sdk opencode-ai     # opencode (SDK + CLI)
```

The `gemini` adapter needs no SDK install — its transport ships inside
cligent — only the `gemini` CLI on `PATH`, at a version cligent
supports; the preflight gates it like the SDKs.

**Upgrading from ≤ 3.1.0:** run the same full line. The old releases
bundled the SDKs inside `@sublang/playbook`'s own tree, and npm
removes that bundled copy when it upgrades to a version that no
longer declares them — an in-place `npm install -g @sublang/playbook`
alone leaves no SDK behind.

The "own top-level root" part matters. The adapter that imports the SDK
lives at `@sublang/playbook/node_modules/@sublang/cligent/`, and Node
finds a bare specifier by walking *up* from there — which reaches the
install prefix's own `node_modules`, but never into a sibling package's
subtree. An SDK that landed inside some other package is invisible to
the adapter even though it is on disk
([DR-026](../specs/decisions/026-optional-adapter-sdks.md)).

Both surfaces check this before doing any work: a declared adapter
whose runtime is not loadable — or is installed below the version
cligent supports — blocks the launch and names the adapter. An absent
runtime is reported as not installed; a stale one with its installed
and required versions, never as absent. Either way the remedy printed
is cligent's pinned install, `npm install -g <package>@<version>`, so
following it cannot install a version the gate refuses again
([PBCLI-40](../specs/user/playbook-cli.md#pbcli-40)).

## Interactive

```sh
playbook            # launch the configured playbooks in tmux-play
playbook --list     # ids, slash commands, and intents; no launch
playbook --help     # config path, auth pointers, agent-swap recipe
```

Without a global install, `npx` runs the same bin — but name each
agent SDK as a sibling package of the same invocation:

```sh
npx -y -p @sublang/playbook -p @anthropic-ai/claude-agent-sdk playbook
```

A bare `npx @sublang/playbook` cannot be repaired by any install
command: npx materializes the run in an ephemeral cache tree whose
ancestor walk touches no global prefix, so an SDK installed with
`npm install -g` is invisible to it. The preflight detects this case
and prints the multi-package re-run instead of an install line, naming
every SDK your config needs at cligent's pinned version — including any
already present, since each distinct package set is a distinct tree —
and replaying your original arguments, so the printed command works in
one hop.

The command resolves its config (seeding it on first run), composes a
`tmux-play` config, checks adapter readiness, and launches. It exits
with tmux-play's status, re-raises a terminating signal on itself, and
exits `127` when it cannot launch at all
([PBCLI-1](../specs/user/playbook-cli.md#pbcli-1),
[PBCLI-2](../specs/user/playbook-cli.md#pbcli-2)).

### Running a Boss turn

The Boss pane starts at the Playbook Captain shell, where the session
Captain runs for the whole session and sees every turn. Use
`/code <task>` to select the CODE playbook explicitly — a registered
command resolves deterministically, with no model call parsing it: at
idle it starts that playbook, at its own leaf it delivers the rest of
the line, an enabled command absent from the active path switches to it,
and a bare `/code` answers with status or a clarification instead of
restarting anything. Type ordinary text and the session Captain decides
the turn instead: it chats back, starts or switches a playbook, hands
the text to the working playbook, dismisses it, or applies one recovery
action the running playbook currently offers. It never does the
specialized work itself, and a conversational turn — including a
progress or status question — leaves the engagement, its parked state,
and any pending player question untouched
([CAPTAIN-1](../specs/user/playbook-captain.md#captain-1),
[CAPTAIN-2](../specs/user/playbook-captain.md#captain-2)).

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
prompts ride their own panes. A turn that actually did something ends
with one Captain reply summarizing what changed, composed only from that
turn's reported outcome; a turn that changed nothing ends with an
ordinary reply and no saved-counts line
([CAPTAIN-19](../specs/user/playbook-captain.md#captain-19)).

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
install with no project-local packages —
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
