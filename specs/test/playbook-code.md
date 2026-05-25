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
prints one stderr line naming the path, and launches `tmux-play`
against that path when readiness passes.

### PBCODE-10
Verifies: [PBCODE-5](../user/playbook-code.md#pbcode-5)

Where the test suite invokes `playbook-code` without `--config` and
without `--help`, with an existing file at the resolved user config
path, the test suite shall fail unless the shim leaves that file's
contents and modified time unchanged and launches `tmux-play`
against the existing file when readiness passes.

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

Where the resolved user config declares `claude` or `codex`
adapters, the test suite shall fail unless readiness passes for
`claude` when `ANTHROPIC_API_KEY` is set or `$HOME/.claude/`
exists, passes for `codex` when `OPENAI_API_KEY` is set or
`$HOME/.codex/` exists, and launches `tmux-play` when every known
declared adapter is ready.

### PBCODE-13
Verifies: [PBCODE-6](../user/playbook-code.md#pbcode-6), [PBCODE-8](../dev/playbook-code.md#pbcode-8)

Where the resolved user config declares `claude` or `codex`
adapters and the corresponding readiness predicates are false, the
test suite shall fail unless the shim prints its help text to
stderr, includes the config path, every failing adapter id, and the
per-adapter auth or CLI setup pointer, exits non-zero with a status
other than `127`, and does not launch `tmux-play`.

### PBCODE-14
Verifies: [PBCODE-6](../user/playbook-code.md#pbcode-6), [PBCODE-8](../dev/playbook-code.md#pbcode-8)

Where the resolved user config declares an adapter other than
`claude` or `codex`, the test suite shall fail unless the shim
prints one stderr warning naming that adapter and does not block
launch on that adapter.

### PBCODE-15
Verifies: [PBCODE-6](../user/playbook-code.md#pbcode-6)

Where the test suite invokes `playbook-code --help`, the test suite
shall fail unless the shim prints its help text to stdout, exits
with status `0`, does not seed or modify the user config, does not
run readiness checks, and does not launch `tmux-play`.
