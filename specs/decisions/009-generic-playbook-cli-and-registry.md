<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-009: Generic playbook CLI and registry enablement

## Status

Accepted.

## Context

[DR-008](008-playbook-captain-shell.md) introduced the Playbook Captain shell over registered `PlaybookRuntime` factories.
Its first implementation registered only CODE and explicitly deferred multiple parked engagements, multi-playbook discovery, and a generic `playbook` executable.

DR-004 links CODE into a host-agnostic `PlaybookRuntime` ([DR-004](004-link-code-fsm-to-playbook-runtime.md)), and PBRT-5 pins the runtime boundary: no host-specific types and interaction exclusively through `PlaybookPorts` ([PBRT-5](../dev/playbook-runtime.md#pbrt-5)).
The shell registry shape is therefore the right integration point for additional FSM workflows.

The current `playbook-code` launcher remains CODE-specific.
It seeds a CODE overlay, maps fixed CODE roles to tmux-play players, writes CODE options under `captain.options.code`, and launches the Playbook Captain shell with CODE registered.

The desired next surface is a generic `playbook` command that can enable multiple playbooks, expose deterministic commands such as `/code`, route ordinary intent through the Captain shell, and still keep each selected playbook responsible for classifying its own Boss turns.

## Decision

### 1. Registry entries become the playbook manifest

Each registered playbook shall be represented by a registry entry with these design fields:

| Field | Meaning |
| --- | --- |
| `id` | Stable playbook id and default options namespace key. |
| `command` | Default slash command without `/`; may be overridden by config. |
| `intent` | Routing description for hidden Captain selection. |
| `requiredRoleIds` | Local role ids the runtime may pass to `callPlayer`. |
| `idleStateId` | State id that represents idle return-to-Boss behavior. |
| `finalStateId` | State id that represents final completion. |
| `parkStateIds` | Additional state ids that park the engagement and wait for another Boss turn. |
| `summaryPolicy` | Optional declaration for visible turn summaries and wording. |
| `validateOptions` | Validator for that playbook's own option slice. |
| `createRuntime` | Factory for the linked `PlaybookRuntime`. |

CODE shall declare `id: "code"`, `command: "code"`, required roles `coder` and `reviewer`, `idleStateId: "ready"`, `finalStateId: "done"`, and `parkStateIds: ["failed", "awaitBossReply"]`.
CODE's Committer alias shall remain a CODE-owned option, not a global shell concept.

The shell shall read parked states from the active entry's `idleStateId` and `parkStateIds`.
It shall not hardcode CODE state ids such as `failed` or `awaitBossReply`.

### 2. Registry loading combines built-ins and `from` modules

The package shall retain a built-in CODE registry entry so existing `createPlaybookCaptainShell(options)` and `@sublang/playbook/code/tmux-play` compatibility paths keep CODE-only behavior by default.

The generic `playbook` command shall support third-party registry entries through module specifiers.
An enabled playbook config may omit `from` when its id resolves to a built-in entry, and shall provide `from` when it names an external entry.
The loader shall reject unknown ids without `from`, failed imports, modules without a valid registry entry, duplicate playbook ids, and duplicate effective commands.

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
        from: "@sublang/playbook/code/registry" # optional for built-ins
        command: code                           # optional; defaults from entry
        options:
          committer: reviewer
```

The shell shall pass each registry entry only its normalized option slice; entries shall validate that slice and shall not extract their own namespace from the full Captain options bag.

CODE compatibility requires a legacy bridge.
When `captain.options.playbooks` is absent, the shell shall keep the DR-008 behavior: it shall enable only built-in CODE and pass the legacy `captain.options.code` slice to CODE validation and runtime creation.
The `playbook-code` preset shall continue to support the legacy CODE overlay and the legacy `captain.options.code` composed namespace until a later DR removes that compatibility path.
The generic `playbook` command shall compile user-facing CODE options into `captain.options.playbooks.code.options`.

### 4. Player instances and layout are generated per playbook

The generic launcher shall treat each playbook's `players` map as the source of host players for that playbook.
It shall compile those playbook-local player declarations into the top-level tmux-play player roster.

The binding for local role `<role>` in playbook `<id>` shall be `<id>.<role>`.
The generic user-facing config shall not support binding a role to a player from another playbook or to a shared top-level host player.

Profiles reuse configuration, not player instances.
When two playbooks reference the same profile, the launcher shall still create separate playbook-scoped host players.

The shell shall apply the binding at two boundaries:

- At the shell port boundary between sub-runtime local roles and tmux-play host players.
- In the metadata passed to `createRuntime`, so playbooks such as CODE can derive prompt identity strings from the host player actually bound to each local role.

The generic launcher shall validate that every enabled playbook's required local roles resolve to generated host player ids present in the composed tmux-play roster.

The first generic design shall materialize every enabled playbook's generated host players at launch.
It shall not dynamically create, hide, or dispose tmux panes when the active engagement changes.

Because `layout.columnWeights` is positional to the Boss/Captain pane plus the generated player roster, the generic launcher shall derive a valid column-weight list when `layout.columnWeights` is omitted.
When the generic config explicitly sets `layout.columnWeights`, the launcher shall fail composition if the list length does not match the Boss/Captain pane plus the generated player roster.
The generic launcher shall not inherit or reuse a base or preset `layout.columnWeights` whose length was authored for a different generated roster.
Dynamic active-engagement-scoped pane visibility is deferred.

### 5. Summary policy is registry-owned and opt-in

The shell may keep generic count collection for player interruptions, inter-player copy-pastes, and summary-visible state counts.
The wording of visible summaries shall not be CODE-specific.

Each registry entry may declare a `summaryPolicy` that maps counted state ids and guard names to Boss-visible labels and provides the saved-counts line template or equivalent wording policy.
When an entry declares no summary policy, the shell shall skip the visible turn-summary block for that playbook.

CODE shall provide the existing review/rebuttal summary policy through its registry entry.
Generalizing summaries shall require CAPTAIN user/dev/test spec updates because [CAPTAIN-19](../user/playbook-captain.md#captain-19) currently pins CODE-specific saved-count wording.

### 6. Generic launcher and CODE preset

The package shall add a generic `playbook` executable.
Without `--config`, it shall read a top-level config at `${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml`, compose a tmux-play config, run launcher-owned adapter readiness checks, and launch tmux-play.
With `--config`, it shall preserve the current pass-through behavior by launching that config directly.

The generic config shall keep host fields top-level.
It shall not introduce a `config:` wrapper around `layout`, `notifications`, `captain`, `profiles`, or `playbooks`.
The generic user-facing config shall not expose a top-level `players` roster because such a roster invites cross-playbook player sharing.
Top-level `players` remains available only in raw tmux-play configs launched through `--config` pass-through.

The generic `playbook --list` command shall print available built-in playbooks and any enabled external playbooks with their ids, effective commands, and intents.
Pre-engagement forms such as `playbook code "task"` are deferred until tmux-play exposes or documents a clean initial Boss-turn injection surface.

The existing `playbook-code` executable shall remain as a compatibility preset.
It shall keep first-run CODE onboarding behavior and launch the same shell machinery with only CODE enabled.

### 7. Preserved DR-008 constraints

The shell shall still support only one active engagement for the first generic design.
When one playbook is engaged, a different registered command shall ask Boss to finish, dismiss, or resolve the current engagement before dispatching to another playbook.

The shell shall continue to call a selected runtime's `handleBossInput` with text.
It shall not pre-classify in-playbook events, choose interrupt targets, expose jumpable state lists, or add a `handleBossEvent` API.

`PlaybookRuntime.getSnapshot()` remains deferred.
Telemetry mirroring remains the first design's state-observation mechanism.

Adapter readiness remains launcher-owned or owned by a dedicated adapter-readiness registry.
Playbook registry entries shall not define credential or adapter readiness predicates.

### 8. Contract amendments for implementation

The implementing specs shall reconcile this DR with released CODE runtime and launcher items.

- [PBRT-15](../dev/playbook-runtime.md#pbrt-15) shall be amended so CODE identity derivation uses the active role binding rather than raw `session.players` ids `coder` and `reviewer`.
- [PBRT-30](../dev/playbook-runtime.md#pbrt-30) shall be amended so CODE validates a shell-selected option slice; the legacy CODE-only path supplies `captain.options.code`, and the generic path supplies `captain.options.playbooks.code.options`.
- [CAPTAIN-5](../dev/playbook-captain.md#captain-5), [CAPTAIN-10](../dev/playbook-captain.md#captain-10), and [CAPTAIN-11](../dev/playbook-captain.md#captain-11) shall be amended for registry-loaded entries, local-role-to-host-player binding, entry-owned `parkStateIds`, and CODE-only legacy defaults.
- [CAPTAIN-19](../user/playbook-captain.md#captain-19) and [CAPTAIN-20](../dev/playbook-captain.md#captain-20) shall be amended so summary policy and saved-count wording are registry-owned and optional rather than CODE-specific shell behavior.
- [CAPTAIN-16](../dev/playbook-captain.md#captain-16) shall be amended so shell initialization loads enabled registry entries from `captain.options.playbooks` while preserving the CODE-only default when that map is absent.
- [PBCODE-16](../user/playbook-code.md#pbcode-16) and [PBCODE-17](../dev/playbook-code.md#pbcode-17) shall be amended so `playbook-code` is specified as a compatibility preset over the generic shell machinery while retaining the legacy CODE overlay and `captain.options.code` composition.
- A follow-up IR shall add generic `playbook` user/dev/test items covering launcher behavior.

## Consequences

- DR-008's deferral of a generic `playbook` binary and multi-playbook discovery is superseded by this design.
- Existing `playbook-code` users and `@sublang/playbook/code/tmux-play` importers keep CODE-only behavior.
- Third-party playbooks can be added by configuration without forking `@sublang/playbook`.
- Role names no longer collide across playbooks because local runtime roles always bind to namespaced host player ids.
- Profiles let users reuse adapter, model, reasoning, and permission settings without sharing player instances or crossing playbook boundaries.
- CODE-specific shell assumptions move into CODE's registry entry.
- The generic launcher needs new user/dev/test specs before implementation, and CAPTAIN/PBCODE/PBRT specs need amendments for enablement, binding, options migration, summary policy, and compatibility behavior.

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/docs/tmux-play.md#custom-captains "cligent tmux-play custom Captains"
