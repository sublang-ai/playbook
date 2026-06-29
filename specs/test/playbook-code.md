<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBCODE: playbook-code CLI — integration tests

## Intent

This spec defines integration tests for the `playbook-code` shim.
The tests drive the shim entrypoint with mocked home/config
locations, environment variables, and process spawning so the
observable file, stdout/stderr, exit-code, and launch behavior is
covered without starting a live `tmux-play` session.

## User config

### PBCODE-9
Verifies: [PBCODE-5](../user/playbook-code.md#pbcode-5), [PBCODE-7](../dev/playbook-code.md#pbcode-7)

Where the test suite invokes `playbook-code` without `--config` and
without `--help`, with no file at the resolved user config path,
the test suite shall fail unless the shim creates the parent
directory, writes the bundled template to
`playbook-code.config.yaml`, preserves the template comments,
preserves the seeded Codex role's
`permissions: { mode: auto, writablePaths: ['.git'] }` block,
preserves the seeded
`notifications: { player_finished: bell, turn_finished: desktop }`
block,
preserves the seeded role defaults — Captain claude
`claude-codex-4-8` at `high`, Coder claude
`claude-codex-4-8-1m` at `xhigh`, Reviewer codex `gpt-5.5` at
`xhigh`, and the Committer alias to `coder`,
prints one stderr line naming the path, composes the launched
config from that file, and launches `tmux-play` against the
composed temp config — not the user config path — when readiness
passes.

### PBCODE-10
Verifies: [PBCODE-5](../user/playbook-code.md#pbcode-5)

Where the test suite invokes `playbook-code` without `--config` and
without `--help`, with an existing file at the resolved user config
path that already carries top-level `notifications`, the test suite
shall fail unless the shim leaves that file's contents and modified
time unchanged and launches `tmux-play` against the config composed
from that file — not the file itself — when readiness passes.
Where the test suite invokes `playbook-code` without `--config` and
without `--help`, with an existing file at the resolved user config
path that parses to a YAML mapping and lacks top-level
`notifications`, the test suite shall fail unless the shim preserves
the existing content, appends a `notifications` block with
`player_finished: bell` and `turn_finished: desktop`, prints one
stderr line naming the path, composes the launched config from the
migrated file, and launches `tmux-play` against the composed temp
config when readiness passes.
Where the test suite invokes `playbook-code` without `--config` and
without `--help`, with an existing file at the resolved user config
path that contains no YAML document, the test suite shall fail
unless the shim appends a `notifications` block, prints one
notification migration line, and then does not launch `tmux-play`
when composition rejects the incomplete CODE overlay.
Where the test suite invokes `playbook-code` without `--config` and
without `--help`, with an existing file at the resolved user config
path that fails YAML parsing or parses to a YAML scalar or sequence,
the test suite shall fail unless the shim leaves that file unchanged,
prints no notification migration line, and does not launch
`tmux-play`.

### PBCODE-11
Verifies: [PBCODE-1](../user/playbook-code.md#pbcode-1), [PBCODE-5](../user/playbook-code.md#pbcode-5), [PBCODE-6](../user/playbook-code.md#pbcode-6)

Where the test suite invokes `playbook-code --config <path>` with
additional arguments, the test suite shall fail unless the shim
does not seed the user config, does not run the readiness gate,
launches `tmux-play`, forwards the supplied `--config <path>` and
additional arguments verbatim, and inherits stdin, stdout, and
stderr.

## Readiness and help

### PBCODE-12
Verifies: [PBCODE-6](../user/playbook-code.md#pbcode-6), [PBCODE-8](../dev/playbook-code.md#pbcode-8)

Where the composed config declares `claude` or `codex`
adapters, the test suite shall fail unless readiness passes for
`claude` when `ANTHROPIC_API_KEY` is set or `$HOME/.claude/`
exists, passes for `codex` when `OPENAI_API_KEY` is set or
`$HOME/.codex/` exists, and launches `tmux-play` when every known
declared adapter is ready.

### PBCODE-13
Verifies: [PBCODE-6](../user/playbook-code.md#pbcode-6), [PBCODE-8](../dev/playbook-code.md#pbcode-8)

Where the composed config declares `claude` or `codex`
adapters and the corresponding readiness predicates are false, the
test suite shall fail unless the shim prints its help text to
stderr, includes the config path, every failing adapter id, and the
per-adapter auth or CLI setup pointer, includes the agent-swap
recipe from [PBCODE-6](../user/playbook-code.md#pbcode-6), exits
non-zero with a status other than `127`, and does not launch
`tmux-play`.

### PBCODE-14
Verifies: [PBCODE-6](../user/playbook-code.md#pbcode-6), [PBCODE-8](../dev/playbook-code.md#pbcode-8)

Where the composed config declares an adapter other than
`claude` or `codex`, the test suite shall fail unless the shim
prints one stderr warning naming that adapter and does not block
launch on that adapter.

### PBCODE-15
Verifies: [PBCODE-6](../user/playbook-code.md#pbcode-6)

Where the test suite invokes `playbook-code --help` or
`playbook-code -h`, the test suite shall fail unless the shim
prints its help text to stdout, exits with status `0`, does not
seed or modify the user config, does not run readiness checks, does
not launch `tmux-play`, and includes the config path, per-adapter
auth or CLI setup pointers, and the agent-swap recipe from
[PBCODE-6](../user/playbook-code.md#pbcode-6).

## Composition

### PBCODE-18
Verifies: [PBCODE-16](../user/playbook-code.md#pbcode-16), [PBCODE-17](../dev/playbook-code.md#pbcode-17)

Where the test suite invokes `playbook-code` without `--config`,
both with and without an existing base tmux-play config, the test
suite shall fail unless the composed config the shim launches has
`captain.from` set to `@sublang/playbook/playbook-captain`, the
Playbook Captain shell adapter module with CODE registered;
`players[].id` equal to `coder` and
`reviewer`, each carrying the `adapter`, `model`, `reasoningEffort`,
and `permissions` declared for that role in the overlay; `theme`,
the top-level `layout` and `notifications` blocks, and any
overlay-unset captain-judge fields inherited from the base when
present; the base `players[]` roster not mapped onto the CODE
roster; and `captain.options.code` injected from the overlay;
unless top-level `layout` and `notifications` blocks are carried
into the composed config from the overlay, and inherited from the
base when the overlay omits them (the same precedence as `theme`);
unless overlay `layout` and `notifications` blocks replace base
blocks whole rather than deep-merging nested layout fields or
notification event keys;
unless a base-inherited composed top-level `layout` reloads through
cligent's tmux-play loader against the composed `coder` + `reviewer`
roster — carrying no `layout.initialVisible` and not both the
`layout.columnWeights` alias and the canonical
`singlePlayerColumnWeights` / `multiPlayerColumnWeights` field for
its shape — while an overlay-set `layout` is carried through
verbatim;
unless a
`players.committer` aliasing `coder` or `reviewer` is resolved into
`captain.options.code.committer` with no extra `players[]` entry,
leaving the roster `coder` + `reviewer`; unless an overlay that
omits `coder` or `reviewer`, carries a `players` key other than
`coder` / `reviewer` / `committer`, sets `players.committer` to a
value other than `coder` or `reviewer`, or sets
`captain.options.code.committer` directly, is rejected with a
path-named error;
unless `captain.adapter` is inherited from the base when the
overlay omits it, and an overlay that omits `captain.adapter` with
no base config is rejected with a path-named error; unless the shim
located the base via `findTmuxPlayConfig` without writing a default
config; unless the shim removes the temporary config file before it
exits on a normal exit, on a non-zero child exit, and on the
signal-forwarding path of
[PBCODE-2](../user/playbook-code.md#pbcode-2); and unless
`--config <path>` still bypasses composition.
