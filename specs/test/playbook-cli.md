<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBCLI: generic playbook CLI - integration tests

## Intent

This spec defines the integration tests for the generic `playbook`
command in `@sublang/playbook`: config seeding, composition,
enablement validation, readiness gating, and the CLI surface.
The tests drive the real command against a temporary config root and
stubbed cligent tmux-play resolution as needed.

## Seeding

### PBCLI-13
Verifies: [PBCLI-3](../user/playbook-cli.md#pbcli-3), [PBCLI-11](../dev/playbook-cli.md#pbcli-11)

Where the test suite invokes `playbook` without `--config` against a
config root with no `playbook/playbook.config.yaml`, the test suite
shall fail unless the command creates that file from the bundled
starter config, prints the resolved path to stderr, and the seeded
file enables CODE through `playbooks.code.from`
`@sublang/playbook/code/registry` with the
[PBCLI-11](../dev/playbook-cli.md#pbcli-11) lineup (Captain
`claude` / `claude-opus-4-8`, Coder `claude` / `claude-opus-4-8[1m]`,
Reviewer `codex` / `gpt-5.5`, the agent/model-named profile ids
`claude-opus` / `claude-opus-1m` / `codex-gpt` referenced by the
`captain` and `coder` / `reviewer` roles, `committer: coder`,
`permissions.mode: auto` on every seeded agent with the Codex
Reviewer's additional `.git` writable path, and the notification
defaults).
When the file is already present, the test suite shall fail unless the
command leaves it unchanged and does not reseed.

## Composition

### PBCLI-14
Verifies: [PBCLI-4](../user/playbook-cli.md#pbcli-4), [PBCLI-8](../dev/playbook-cli.md#pbcli-8), [PBCLI-9](../dev/playbook-cli.md#pbcli-9), [PBCLI-10](../dev/playbook-cli.md#pbcli-10)

When the test suite composes a top-level config enabling one or more
playbooks, the test suite shall fail unless the composed tmux-play
config sets `captain.from` to `@sublang/playbook/playbook-captain`;
carries one `captain.options.playbooks.<id>` entry per playbook with
that block's `from`, optional `command`, and an `options` slice built
from the block's non-launcher keys (CODE's `committer` among them and
no `from` / `command` / `players` in the slice); resolves scalar
`captain` and `players.<role>` values as profile ids or adapter
shorthands and a full block's `profile` key as a `profiles` entry
only, applying the profile beneath the block's own explicit fields and
emitting no `profile` key in the composed config; generates the
top-level roster as the union of each playbook's `<id>-<role>` host
players with separate instances when two playbooks share a profile;
sets `layout.initialVisible` to the first enabled playbook's
generated player ids while carrying through the window and
column-weight fields; and carries the user config's top-level
`notifications` and `theme` fields into the composed config unchanged.

## Validation

### PBCLI-15
Verifies: [PBCLI-8](../dev/playbook-cli.md#pbcli-8), [PBCLI-9](../dev/playbook-cli.md#pbcli-9)

When the test suite composes top-level configs that each carry one
fault — a missing `from`, a `from` whose import fails, a module
exposing no valid registry entry, a `playbooks.<id>` key not equal to
the imported manifest's `id`, two playbooks sharing an `id`, two
playbooks resolving to the same effective command, a `profiles` id
colliding with the `claude` or `codex` adapter shorthand, a full block
`profile` key naming no known profile, a manifest `requiredRoleIds`
naming the reserved `captain` role, a `playbooks.<id>.players` map
binding the reserved `captain` role, a configured playbook id equal to
`captain`, an effective command equal to `captain`, a manifest required role with no
generated roster id, and an enabled playbook with no visible local
role — the test suite shall fail unless the
command rejects each before launching tmux-play with a diagnostic
naming the fault.

## Readiness and CLI surface

### PBCLI-16
Verifies: [PBCLI-1](../user/playbook-cli.md#pbcli-1), [PBCLI-12](../dev/playbook-cli.md#pbcli-12)

When the test suite runs the readiness gate over a composed config,
the test suite shall fail unless: a config whose adapters all have
credentials present launches tmux-play; a config with a missing
`claude` or `codex` credential blocks the launch, prints the help
content plus every failing adapter id to stderr, and exits non-zero
with a status distinct from `127`; and a declared adapter with no
known predicate produces one stderr warning without blocking launch.

### PBCLI-17
Verifies: [PBCLI-1](../user/playbook-cli.md#pbcli-1), [PBCLI-2](../user/playbook-cli.md#pbcli-2), [PBCLI-5](../user/playbook-cli.md#pbcli-5), [PBCLI-6](../user/playbook-cli.md#pbcli-6)

When the test suite exercises the `playbook` CLI surface, the test
suite shall fail unless: `--list` prints each configured playbook's
id, effective command, and intent without launching; `--help` prints
help to stdout and exits `0` without seeding or launching;
`--config <path>` launches that raw config directly without seeding,
composition, or the readiness gate; and the command propagates the
tmux-play exit code, re-raises a terminating signal on itself, and
exits `127` when it cannot launch tmux-play.

### PBCLI-21
Verifies: [PBCLI-18](../user/playbook-cli.md#pbcli-18), [PBCLI-19](../user/playbook-cli.md#pbcli-19), [PBCLI-20](../dev/playbook-cli.md#pbcli-20)

When the test suite exercises `playbook run` with an injected
agent-run function over a fake registry entry, the test suite shall
fail unless: a terminal turn prints its output to stdout and exits `0`;
`--json` prints that output as JSON; `callPlayer` routes to the agent
bound for each required role and threads the returned resume token into
the next call; `callCaptain` requesting isolation runs a fresh
tool-free captain call; the `--option` slice reaches the entry's
`validateOptions`; a failed or aborted turn exits `2`; a suspended,
quiescent, or nested-call outcome exits `3`; and a missing `<from>`,
an invalid registry entry, or an unrequired `--player` role exits `1`.
