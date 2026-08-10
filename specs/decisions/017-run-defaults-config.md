<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-017: Run-defaults config

## Status

Accepted.

## Context

`playbook run` binds every required role and the captain to bare adapter `claude` unless each invocation repeats `--player`/`--captain` flags ([[playbook-cli-19](../packages/playbook-cli.md#playbook-cli-19)]).
The durable lineup a user already tuned lives in the top-level config at `${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml` ([[playbook-cli-3](../packages/playbook-cli.md#playbook-cli-3)]), but the one-shot host never reads it: its `profiles`/`playbooks` model is keyed by enabled playbook, while `playbook run` deliberately runs modules that need no config block ([[playbook-cli-18](../packages/playbook-cli.md#playbook-cli-18)]).
So a user who always wants, say, Opus at high effort on one-shot runs must retype the same agent flags on every invocation, or wrap the CLI in a shell alias.
DR-015 solved the per-invocation tuning half; the durable half is still missing.

## Decision

### 1. A top-level `run` block in the user config

The existing user config gains an optional top-level `run` map that supplies default agent specs for `playbook run`:

```yaml
run:
  captain: claude:claude-opus-4-8@high
  player: claude:claude-opus-4-8@high   # catch-all for unlisted roles
  players:
    coder: claude:claude-opus-4-8[1m]@xhigh
```

Every value uses the exact `<adapter>[:<model>][@<effort>]` agent-string grammar of the run flags ([[playbook-cli-19](../packages/playbook-cli.md#playbook-cli-19)]) — one grammar whether an agent is bound by flag or by config.
The interactive launcher reads only its known top-level keys, so `run` coexists in the same file with no interactive-side change.

### 2. Precedence and scope

Per required role, `--player <role>=` beats `run.players.<role>`, which beats the `run.player` catch-all, which beats the built-in `claude` default; the captain resolves `--captain`, then `run.captain`, then `claude`.
The config is global across playbooks, so a `run.players` key naming a role the loaded entry does not require is silently ignored — unlike `--player`, whose per-invocation typo stays an error.
Resume is untouched: config defaults bind only a first run, and `playbook run resume` rebuilds the parked lineup exactly from the session record ([DR-014](014-durable-one-shot-run-sessions.md) §3), even when the config changed after parking.

### 3. Fail-closed handling

An absent config file or a config without a `run` block keeps the built-in `claude` defaults.
A config file that exists but cannot be parsed, a `run` or `run.players` value that is not a map, a non-string agent value, an invalid agent string, or an unsupported effort is a diagnostic and exit `1` — a run must never silently bind different agents than the user configured.
Effort support is validated through the same adapter-scoped path as flag-bound specs ([[playbook-cli-26](../packages/playbook-cli.md#playbook-cli-26)]).

## Consequences

- A user tunes `run:` once and every later `playbook run` binds that lineup; flags still override per role, per invocation.
- The `player` catch-all covers roles across playbooks without enumerating them, and unrequired per-role keys stay inert, so one global config serves CODE, REVIEW, DECIDE, and any external playbook.
- A malformed `run` block stops the run instead of quietly running the built-in lineup.
- Parked sessions resume the lineup they parked with; changing the config never rewires a suspended run.

## References

- [[playbook-cli-19](../packages/playbook-cli.md#playbook-cli-19)] defines the shared run-agent string and role-binding surface.
