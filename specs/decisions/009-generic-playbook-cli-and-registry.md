<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-009: Generic playbook CLI and registry enablement

## Status

Accepted.
[DR-012](012-default-captain-playbook.md) amends this record by routing ordinary idle intent through a compiled non-registry Captain, reserving `captain` as a playbook id and effective command, and exempting that internal root from player visibility.
The registry, CLI, role-binding, enabled-external-playbook visibility, and summary-policy constraints remain in force where later decisions have not amended them.

## Context

[DR-008](008-playbook-captain-shell.md) introduced the Playbook Captain shell over registered `PlaybookRuntime` factories.
Its first implementation registered only CODE and explicitly deferred multiple parked engagements, multi-playbook discovery, and a generic `playbook` executable.

DR-004 links CODE into a host-agnostic `PlaybookRuntime` ([DR-004](004-link-code-fsm-to-playbook-runtime.md)), and PBRT-5 pins the runtime boundary: no host-specific types and interaction exclusively through `PlaybookPorts` ([PBRT-5](../dev/playbook-runtime.md#pbrt-5)).
The shell registry shape is therefore the right integration point for additional FSM workflows.

The current `playbook-code` launcher remains CODE-specific.
It seeds a CODE overlay, maps fixed CODE roles to tmux-play players, writes CODE options under `captain.options.code`, and launches the Playbook Captain shell with CODE registered.
The generic `playbook` command replaces that path rather than preserving a CODE-specific preset.
This is an intentional pre-1.0 breaking simplification: one executable and one config model avoid maintaining a parallel CODE-only composer, default registry path, and option namespace.

cligent 0.13.0 adds tmux-play dynamic player visibility: the configured player roster remains fixed for a session, while `layout.initialVisible` and Captain-side `setVisiblePlayers` calls control which configured players have visible panes [[2]].
This lets the generic `playbook` command target tmux-play without showing every enabled playbook's players at once.

The desired next surface is a generic `playbook` command that can enable multiple playbooks, expose deterministic commands such as `/code`, route ordinary intent through the Captain shell, and still keep each selected playbook responsible for classifying its own Boss turns.

## Decision

### 1. Registry entries become the playbook manifest

Each registered playbook shall be represented by a registry entry with these design fields:

| Field | Meaning |
| --- | --- |
| `id` | Stable playbook id and default options namespace key. |
| `command` | Default slash command without `/`; may be overridden by config. |
| `intent` | Routing description for the compiled default Captain's sanitized catalog. |
| `requiredRoleIds` | Local role ids the runtime may pass to `callPlayer`. |
| `summaryPolicy` | Optional declaration for visible turn summaries and wording. |
| `validateOptions` | Validator for that playbook's own option slice. |
| `createRuntime` | Factory for the linked `PlaybookRuntime`. |

The CODE registry module shall declare `id: "code"`, command `code`, and
required roles `coder` and `reviewer`.
CODE's Committer alias shall remain a CODE-owned option, not a global shell concept.

[DR-011](011-composable-playbook-execution.md) supersedes registry-owned
lifecycle state ids with `PlaybookRunResult` outcomes and normalized XState
descriptor tags.
Registry entries shall no longer declare `idleStateId`, `finalStateId`, or
`parkStateIds`; the shell shall not hardcode CODE state ids such as `failed`,
`awaitBossReply`, or `done`.

### 2. Registry loading uses explicit `from` modules

The generic `playbook` command shall load every enabled playbook from an explicit module specifier.
CODE shall be configured with `from: "@sublang/playbook/code/registry"` like any other playbook.
The loader shall reject missing `from`, failed imports, modules without a valid registry entry, duplicate playbook ids, duplicate effective commands, and any configured playbook id or effective command equal to the reserved internal name `captain`.

tmux-play custom Captain configuration already uses user-supplied module specifiers for `captain.from` [[1]].
Registry `from` modules reuse that executable local-configuration trust boundary.

### 3. Enablement normalizes into `captain.options.playbooks`

The generic launcher shall compile its top-level config into a tmux-play config whose Captain is `@sublang/playbook/playbook-captain`.

Users shall configure reusable agent settings with a top-level `profiles` map and enabled playbooks with a top-level `playbooks` map.
The launcher shall normalize those user-facing maps into the shell's internal `captain.options.playbooks` map.

An example generic config is:

```yaml
profiles:
  claude-code:
    adapter: claude
    reasoningEffort: high

captain: claude-code

playbooks:
  code:
    from: "@sublang/playbook/code/registry"
    players:
      coder: codex
      reviewer: claude-code
    committer: reviewer
```

Scalar `captain` and player values shall resolve as profile ids or adapter shorthands.
Profile ids shall not collide with known adapter shorthand ids such as `claude` or `codex`; the launcher shall reject a colliding profile id rather than let a profile silently shadow an adapter shorthand.
Full captain and player blocks shall follow the host tmux-play agent-block schema ([DR-006 §2](006-code-config-composition.md#2-playbook-code-is-a-composer-not-a-config-the-user-authors)) and may reference a profile.

Within a playbook block, `from`, `command`, and `players` are launcher-owned keys.
Every other key belongs to that playbook's option slice.
This keeps common options such as CODE's `committer` at the level users expect, while the launcher still passes a clean option slice to the registry entry.

The normalized internal shell configuration shall have this shape, excluding the generated top-level tmux-play player roster:

```yaml
captain:
  options:
    playbooks:
      code:
        from: "@sublang/playbook/code/registry"
        command: code                           # optional; defaults from entry
        options:
          committer: reviewer
```

The shell shall pass each registry entry only its normalized option slice; entries shall validate that slice and shall not extract their own namespace from the full Captain options bag.

The generic `playbook` command shall compile user-facing CODE options into `captain.options.playbooks.code.options`.
The shell shall require `captain.options.playbooks` and shall not infer a CODE-only default from `captain.options.code`.

### 4. Player instances are static; visible panes follow the active playbook

The generic launcher shall treat each playbook's `players` map as the source of host players for that playbook.
It shall compile those playbook-local player declarations into the top-level tmux-play player roster.
That roster is a launch-time union of every enabled playbook's generated players, because tmux-play visibility can change panes but cannot create, delete, or reconfigure runtime player identities after startup [[2]].

The binding for local role `<role>` in playbook `<id>` shall be `<id>-<role>`.
A hyphen joins the two because cligent tmux-play player ids must match `^[a-z][a-z0-9_-]*$`, which excludes a `.` separator.
The generic user-facing config shall not support binding a role to a player from another playbook or to a shared top-level host player.

Profiles reuse configuration, not player instances.
When two playbooks reference the same profile, the launcher shall still create separate playbook-scoped host players.

The shell shall apply the binding at two boundaries:

- At the shell port boundary between sub-runtime local roles and tmux-play host players.
- In the metadata passed to `createRuntime`, so playbooks such as CODE can derive prompt identity strings from the host player actually bound to each local role.

The generic launcher shall validate that every enabled playbook's required local roles resolve to generated host player ids present in the composed tmux-play roster.

For the tmux-play host, the first generic design requires each enabled registry playbook to resolve at least one visible local role.
Pure Captain-only registry playbooks are deferred until a host supports a zero-player visible state or a later design defines a fallback visible set.
The compiled default Captain of [DR-012](012-default-captain-playbook.md) is an internal non-registry root, so it is exempt and makes no visibility request.

The generic launcher shall set the composed tmux-play `layout.initialVisible` to the generated players for the first enabled playbook in config order.
The generic config may use tmux-play layout window and column-weight fields, including the cligent 0.13.0 shape-specific `singlePlayerColumnWeights` and `multiPlayerColumnWeights` fields, but the generic launcher owns `layout.initialVisible`.
Column-weight fields are session-level per visible-column shape, not per playbook.
Raw tmux-play configs launched through `--config` pass-through retain direct access to `layout.initialVisible`.

When the shell selects, resumes, or routes to an enabled registry playbook, it shall request tmux-play visibility for that playbook's generated host player ids before dispatching Boss text to the playbook runtime.
The shell shall not request an empty visible set and shall make no visibility request for the internal default Captain root.
Because the launcher has already validated generated player ids, a `setVisiblePlayers` validation rejection is an internal shell or composition error.
tmux pane reconciliation failures are display-only in tmux-play, so they shall not block dispatch to the playbook runtime.
After a playbook reaches final completion or is dismissed, the visible panes may remain on the last selected playbook until the next selection.

### 5. Summary policy is registry-owned and opt-in

The shell may keep generic count collection for player interruptions, inter-player copy-pastes, and summary-visible state counts.
The wording of visible summaries shall not be CODE-specific.

Each registry entry may declare a `summaryPolicy` that maps counted state ids and guard names to Boss-visible labels and provides the saved-counts line template or equivalent wording policy.
When an entry declares no summary policy, the shell shall skip the visible turn-summary block for that playbook.

CODE shall provide the existing review/rebuttal summary policy through its registry entry.
Generalizing summaries shall require CAPTAIN user/dev/test spec updates because [CAPTAIN-19](../user/playbook-captain.md#captain-19) currently pins CODE-specific saved-count wording.

### 6. Generic launcher

The package shall add a generic `playbook` executable.
Without `--config`, it shall read a top-level config at `${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml`, compose a tmux-play config, run launcher-owned adapter readiness checks, and launch tmux-play.
When that config is absent, the launcher shall seed a starter generic config that enables CODE through explicit `from`, then continue.
With `--config`, it shall preserve the current pass-through behavior by launching that config directly.

The generic config shall keep host fields top-level.
It shall not introduce a `config:` wrapper around `layout`, `notifications`, `captain`, `profiles`, or `playbooks`.
The generic user-facing config shall not expose a top-level `players` roster because such a roster invites cross-playbook player sharing.
Top-level `players` remains available only in raw tmux-play configs launched through `--config` pass-through.

The generic `playbook --list` command shall print configured playbooks with their ids, effective commands, and intents.
Pre-engagement forms such as `playbook code "task"` are deferred until tmux-play exposes or documents a clean initial Boss-turn injection surface.

### 7. Preserved DR-008 constraints

The shell shall still support only one Boss-selected root engagement.
[DR-011](011-composable-playbook-execution.md) supersedes the one-runtime
limit by allowing that root to own a LIFO stack of nested child
sessions.
When one root engagement is active, a different registered command shall ask Boss to finish, dismiss, or resolve the current call stack before dispatching another root.

The shell shall continue to call a selected runtime's `handleBossInput` with text.
It shall not pre-classify in-playbook events, choose interrupt targets, expose jumpable state lists, or add a `handleBossEvent` API.

`PlaybookRuntime.getSnapshot()` remains deferred.
Telemetry mirroring remains the first design's state-observation mechanism.

Adapter readiness remains launcher-owned or owned by a dedicated adapter-readiness registry.
Playbook registry entries shall not define credential or adapter readiness predicates.

### 8. Contract amendments for implementation

The implementing specs shall reconcile this DR with released CODE runtime and launcher items.

- [PBRT-15](../dev/playbook-runtime.md#pbrt-15) shall be amended so CODE identity derivation uses the active role binding rather than raw `session.players` ids `coder` and `reviewer`.
- [PBRT-30](../dev/playbook-runtime.md#pbrt-30) shall be amended so CODE validates the shell-selected `captain.options.playbooks.code.options` slice.
- [PBRT-16](../dev/playbook-runtime.md#pbrt-16) and [PBRT-29](../user/playbook-runtime.md#pbrt-29) shall be amended to remove the `@sublang/playbook/code/tmux-play` compatibility-shim and legacy `captain.options.code` host-config contracts.
- [CAPTAIN-5](../dev/playbook-captain.md#captain-5), [CAPTAIN-10](../dev/playbook-captain.md#captain-10), and [CAPTAIN-11](../dev/playbook-captain.md#captain-11) were amended for registry-loaded entries, local-role-to-host-player binding, active-playbook visibility, and entry-owned lifecycle ids; DR-011 later retires those lifecycle ids in favor of run outcomes and descriptor tags.
- [CAPTAIN-19](../user/playbook-captain.md#captain-19) and [CAPTAIN-20](../dev/playbook-captain.md#captain-20) shall be amended so summary policy and saved-count wording are registry-owned and optional rather than CODE-specific shell behavior.
- [CAPTAIN-16](../dev/playbook-captain.md#captain-16) shall be amended so shell initialization loads enabled registry entries from `captain.options.playbooks` and rejects missing enablement.
- PBCODE user/dev/test specs shall be retired.
- Package metadata and release specs shall add `@sublang/playbook/code/registry` as a public export for the CODE registry module.
- RELEASE specs and package metadata shall treat removal of the `playbook-code` bin, `./code/tmux-play` export, and legacy CODE tmux-play configs as breaking public-surface changes under [RELEASE-1](../dev/release.md#release-1) and [RELEASE-4](../dev/release.md#release-4).
- [RELEASE-14](../dev/release.md#release-14) shall be satisfied with a cligent dependency range that includes the tmux-play dynamic visibility surface, first expected in `@sublang/cligent` 0.13.0.
- A follow-up IR shall add generic `playbook` user/dev/test items covering launcher behavior, starter-config seeding, generated roster composition, `layout.initialVisible`, active-playbook visibility switching, validation-rejection handling, and display-only pane reconciliation failures.

## Consequences

- DR-008's deferral of a generic `playbook` binary and multi-playbook discovery is superseded by this design.
- `playbook-code` and `@sublang/playbook/code/tmux-play` compatibility surfaces are retired.
- Third-party playbooks can be added by configuration without forking `@sublang/playbook`.
- Role names no longer collide across playbooks because local runtime roles always bind to namespaced host player ids.
- Profiles let users reuse adapter, model, reasoning, and permission settings without sharing player instances or crossing playbook boundaries.
- CODE-specific shell assumptions move into CODE's registry entry.
- tmux-play sessions still allocate every enabled playbook player at startup, but only the active playbook's players need to occupy visible panes.
- The generic launcher needs new user/dev/test specs before implementation, and CAPTAIN/PBCODE/PBRT specs need amendments for enablement, binding, options migration, summary policy, and compatibility behavior.

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/docs/tmux-play.md#custom-captains "cligent tmux-play custom Captains"
[2]: https://github.com/sublang-ai/cligent/blob/main/docs/tmux-play.md#layout "cligent tmux-play dynamic visible player panes"
