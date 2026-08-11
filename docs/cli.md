<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Using the CLI

`playbook` has two presentations of one configured Captain session: an
interactive tmux-play UI and a headless `playbook run` turn for scripts and
CI. Both use the same compiled Captain, enabled catalog, players, nested
stack, and [config](configuration.md); only presentation differs.

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
([[playbook-cli-40](../specs/packages/playbook-cli.md#playbook-cli-40)]).

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
([[playbook-cli-1](../specs/packages/playbook-cli.md#playbook-cli-1)],
[[playbook-cli-2](../specs/packages/playbook-cli.md#playbook-cli-2)]).

### Running a Boss turn

The Boss pane starts at the Playbook Captain shell, where the session
Captain runs for the whole session and sees every turn. Use `/code`,
`/review`, or `/decide` followed by a task to select one of the bundled
playbooks explicitly. A registered command resolves deterministically,
with no model call parsing it: at idle it starts that playbook, at its
own leaf it delivers the rest of the line, an enabled command absent
from the active path switches to it, and a bare command answers with
status or a clarification instead of restarting anything. Type ordinary
text and the session Captain decides the turn instead: it chats back,
starts or switches a playbook, hands the text to the working playbook,
dismisses it, or applies one recovery action the running playbook
currently offers. It never does the specialized work itself, and a
conversational turn — including a progress or status question — leaves
the engagement, its parked state, and any pending player question
untouched
([[playbook-captain-1](../specs/packages/playbook-captain.md#playbook-captain-1)],
[[playbook-captain-2](../specs/packages/playbook-captain.md#playbook-captain-2)]).

The current CODE, REVIEW, and DECIDE workflows take their deterministic
initial event from the selecting Boss turn. CODE and DECIDE then call
REVIEW as a nested playbook: an exact same-name child role continues the
ancestor's player pane and backend conversation, while any additional
role uses REVIEW's configured fallback. When a player surfaces a
clarifying question the FSM parks, the pane shows the question, and a
judge classifies your next turn as its reply or a fresh directive that
abandons it
([[playbook-runtime-2](../specs/packages/playbook-runtime.md#playbook-runtime-2)]).

The Captain pane shows start/stop/finished status with `◇` lines and
streams progress with captain-speech classification and questions
([[playbook-runtime-3](../specs/packages/playbook-runtime.md#playbook-runtime-3)]), while player
prompts ride their own panes. A turn that actually did something ends
with one Captain reply summarizing what changed, composed only from that
turn's reported outcome; a turn that changed nothing ends with an
ordinary reply and no saved-counts line
([[playbook-captain-19](../specs/packages/playbook-captain.md#playbook-captain-19)]).

## Headless

`playbook run [input]` submits one exact Boss turn to the same Captain that
the interactive pane hosts, without constructing tmux. The shared config
selects the Captain, enabled playbooks, players, options, provisioning, and
readiness; a slash command selects a playbook through Captain, and ordinary
text remains a conversational Captain turn.

```sh
cd ./my-repo
playbook run "/review review the latest commit"
playbook run "/code implement the approved specification"
printf '%s\n' 'Summarize the current work and propose the next step.' | playbook run
```

When `[input]` is absent, stdin is read to EOF as verbatim UTF-8 text.
Use `--` before one flag-shaped input. Plain stdout is exactly the one
Boss-visible Captain reply plus a line feed; status and diagnostics use
stderr, and `--verbose` adds only telemetry topic names to stderr.
`--json` instead prints exactly `{"sessionId":"…","reply":"…"}`.

| Flag | Meaning |
| --- | --- |
| `--with <path>` | overlay the shared config for a new session; repeatable |
| `--no-provision` | do not create missing engine links for configured filesystem registries |
| `--json` | print exactly one `sessionId` / `reply` object |
| `--verbose` | add Captain telemetry topic names to stderr |
| `--continue` | continue the latest durable Captain session |
| `--session <id>` | continue one durable Captain session explicitly |
| `--retry-uncertain` | with `--session`, retry its exact recorded uncertain input |
| `--discard-uncertain` | with `--session`, abandon its uncertain attempt |
| `--` | end options before one literal input or reply |
| `-h`, `--help` | print the complete grammar without reading stdin or config |

Exit `0` means the Captain turn and its durable hand-off were presented,
even when the selected action reported rejection or failure through the
Captain reply. Argument, config, catalog, readiness, or pre-turn setup errors
exit `1`; a started-turn, persistence, lease-release, or presentation failure
exits `2` with stdout empty. SIGINT, SIGTERM, and SIGHUP preserve the
uncertain boundary, withhold stdout, and are re-raised after lease retirement
([[playbook-cli-18](../specs/packages/playbook-cli.md#playbook-cli-18)]).

The former positional `<from>`, `resume`, `--player`, `--captain`,
`--option`, `--cwd`, `--last`, run-only `--config`, and top-level `run:`
config are removed. Enable a registry under `playbooks`, tune its inline
agents and options there or in a fresh `--with` overlay, invoke its effective
`/command`, and run from the working directory you want agents to use.

### Piping a Spex update prompt

`spex scaffold --update` refreshes its scaffold before printing guidance and
a fenced reconciliation prompt. Force Spex's non-interactive agent-file
selection, capture its successful output, extract the first fenced prompt,
and pass only that prompt to Captain:

```sh
update_output="$(spex scaffold --update </dev/null)" &&
printf '%s\n' "$update_output" |
  awk '/^```$/{if (++n==2) exit; next} n==1' |
  playbook run
```

The capture prevents a failed Spex command from launching Playbook. Without
`--lang`, the first fenced block is the sole structure reconciliation or
legacy-migration prompt; a language switch adds a second translation prompt.

### External playbooks and engine provisioning

Enable an external registry in the shared config and invoke its effective
slash command; a path-shaped `playbooks.<id>.from` is resolved relative to
the primary config file. Before either front end imports a configured
filesystem registry, the shared launcher checks whether that module can
resolve `xstate` and `@sublang/playbook/xstate-runtime`. When needed, it
creates engine symlinks beside the module and prints one provisioning line
([[playbook-cli-36](../specs/packages/playbook-cli.md#playbook-cli-36)],
[DR-024](../specs/decisions/024-runtime-engine-provisioning.md)).

A directory where both imports already resolve is untouched, and
`--no-provision` disables new links for either fresh front end. If the
module's directory is a git repository, add `node_modules/` to its
`.gitignore` so provisioned links never enter player commits.

### Continuing a Captain session

Every successfully presented headless turn is stored under
`${XDG_STATE_HOME:-$HOME/.local/state}/playbook/sessions/` before stdout.
Continue the newest logical session, or select the id returned by `--json`:

```sh
playbook run --continue "keep the scope small; skip the docs"
playbook run --session 4f2c0000-0000-4000-8000-000000009ab1
```

A missing reply is read verbatim from stdin. Continuation restores the exact
compiled Captain conversation, engagement stack, nested child boundary,
mapped-player conversations, normalized execution config, and absolute
working directory. It does not reread current config, does not repeat a
settled or pending child start, and rejects `--with` because an existing
session's lineup is frozen
([[playbook-cli-22](../specs/packages/playbook-cli.md#playbook-cli-22)],
[DR-031](../specs/decisions/031-shared-captain-session-front-ends.md)).

### Recovering an uncertain turn

Before model work, the runner takes one exclusive session lease and writes an
uncertain marker. If the process is interrupted after effects may
have begun but before settlement is durable, ordinary continuation refuses
to guess. Choose explicitly:

```sh
playbook run --session 4f2c0000-0000-4000-8000-000000009ab1 --retry-uncertain
playbook run --session 4f2c0000-0000-4000-8000-000000009ab1 --discard-uncertain
```

Retry reads no input and reuses the byte-exact recorded turn; it may duplicate
external effects. Discard reads no input and runs no model: it restores the
exact prior settled boundary, or deletes a never-settled fresh session, while
abandoning the attempted work. Session files written by the removed direct
v6 runner are not shared-Captain sessions and cannot be continued.
