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
playbook                         # fresh durable session in this directory
playbook --cwd /path/to/repo     # fresh session in an explicit directory
playbook --session <id>          # reopen either front end's settled session
playbook --list                  # ids, slash commands, and intents; no launch
playbook --help                  # config path, auth pointers, binding recipe
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

For a managed launch, the outer command resolves current config (seeding it on
first use), prepares the complete stored catalog and presenter, waits for the
pane child to acquire the session lease and publish its settled turn-zero
record, prints the verified session ID, and then attaches. A normal outer
detach exits `0`; the pane child keeps owning the durable session and accepting
turns until it shuts down. Preparation, attachment, or required cleanup
failure prints its diagnostics and exits nonzero.

Before native-client hand-off, SIGHUP, SIGINT, or SIGTERM aborts activation,
joins the child, retires the lease, and only then re-raises the signal. At the
synchronous native-client hand-off, ownership transfers before tmux starts, so
later signals use native client detach or termination semantics and do not
retire the pane child's session. Only `--config` and composed
`--theme-diagnostics` use the stock subprocess boundary: those forms mirror
its exit status or signal and exit `127` when it cannot be spawned
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
initial event from the selecting Boss turn. CODE and DECIDE then call REVIEW
as a nested playbook. Local role names do not imply continuity: each frame
uses the exact stable player IDs configured under its `roles` map. Equal IDs
share one pane and provider conversation across nested and later root
engagements; distinct IDs remain isolated even when their agent settings are
identical. When a player surfaces a
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
| `--with <path>` | overlay current config for a fresh session or compatible ordinary reopen; repeatable |
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
config are removed from `playbook run`. Enable a registry under `playbooks`,
declare provider agents once under top-level `players`, bind every local role
under `playbooks.<id>.roles`, tune compatible model and effort in a `--with`
overlay, invoke the effective `/command`, and run from the working directory
you want agents to use. Legacy `playbooks.<id>.players` blocks are rejected and
are not auto-migrated because choosing equal or distinct new player IDs chooses
conversation sharing or isolation; see [Migrating per-playbook
players](configuration.md#migrating-per-playbook-players).

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

Interactive and headless commands write the same logical-session records under
`${XDG_STATE_HOME:-$HOME/.local/state}/playbook/sessions/`. A fresh interactive
child persists turn zero before printing `playbook: session <id>` and opening
Boss input; a fresh headless turn returns the same kind of ID in `--json`.
After the current writer exits or explicitly hands off, either presentation
can reopen either origin:

```sh
# Reopen the latest settled session headlessly:
playbook run --continue "keep the scope small; skip the docs"

# Reopen one exact session in either presentation:
playbook --session 4f2c0000-0000-4000-8000-000000009ab1
playbook run --session 4f2c0000-0000-4000-8000-000000009ab1
```

A missing headless reply is read verbatim from stdin. Reopening restores the
compiled Captain conversation, engagement stack, nested child boundary,
stable-player ledger, and absolute working directory without replaying a
settled or pending child start. One exclusive writer owns the session, so a
detached interactive pane child remains the owner until it shuts down; a
competing front end fails closed instead of forking the history.

An ordinary reopen reads current config and any opening `--with` fragments,
projects them to the stored catalog and player roster, and requires the stored
role bindings plus every structural setting to remain exact. Compatible
current `model` and `effort` selections apply to the next call, including an
explicit boolean `false` provider-default reset. The retained provider token
is never silently replaced by a fresh conversation if that selection is not
supported
([[playbook-cli-22](../specs/packages/playbook-cli.md#playbook-cli-22)],
[DR-032](../specs/decisions/032-explicit-roles-session-players.md)).

### Recovering an uncertain turn

Before model work, the runner takes one exclusive session lease and writes an
uncertain marker. If the process is interrupted after effects may
have begun but before settlement is durable, ordinary continuation refuses
to guess. Choose explicitly:

```sh
playbook run --session 4f2c0000-0000-4000-8000-000000009ab1 --retry-uncertain
playbook run --session 4f2c0000-0000-4000-8000-000000009ab1 --discard-uncertain
```

Retry reads no input and reuses the byte-exact recorded turn and its exact
attempted Captain, player, and per-role model/effort selections; current config
cannot retune that attempt, and retry may duplicate external effects. Discard
reads no input and runs no model: it restores the exact prior settled boundary,
or deletes a never-settled fresh session, while abandoning the attempted work.
An interrupted interactive turn uses the same uncertain record and is
recovered with these headless commands. Session files written by the removed
direct v6 runner and legacy record schemas are not shared schema-3 Captain
sessions and cannot be continued. Explicit selection rejects them. Implicit
`--continue` reports and skips released schema-2 Captain records, naming each
session and path; move them outside the sessions directory or remove them to
silence the warning. Malformed records and unknown schemas still fail closed.
