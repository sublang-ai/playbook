<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-009: Generic playbook CLI and registry enablement

## Status

Accepted.
[DR-021](021-inline-agent-settings.md) replaces the former profile model with inline agent settings.
[DR-029](029-session-scoped-conversational-captain.md) places the compiled session Captain outside the engagement stack and owns ordinary-language routing and outcome-grounded replies.
[DR-030](030-shared-mapped-player-continuity.md) adds exact same-role inheritance and root-owned continuation to nested frames.
[DR-032](032-explicit-roles-session-players.md) supersedes the per-playbook fallback roster and same-role inheritance with top-level session players and explicit role bindings.
[DR-040](040-outcome-authority-effect-reconciliation.md) refines §5 for CODE, REVIEW, and DECIDE: saved-count metrics consume accepted outcomes and replies consume canonical structured settlements.

## Context

The original launcher and shell were tied to CODE, fixed role names, and one runtime.
A public playbook host needs explicit enablement, independently compiled workflows, deterministic commands, and static tmux players whose visible subset can follow a nested active leaf.
The configuration must remain inspectable and must not grant an imported registry authority over another playbook's settings.

## Decision

### 1. Registry manifests

Each enabled playbook shall be loaded from an explicit user-configured module whose default export declares its stable id, default command, routing intent, required local roles, optional summary policy, option validator, and runtime factory.
The shell shall validate each registry against only that playbook's namespaced option slice and shall derive lifecycle from runtime results and structured descriptors rather than registry state ids.
The bundled external registries are CODE with role `coder`, REVIEW with roles `coder` and `reviewer`, and DECIDE with roles `coder` and `reviewer`.
The internal session Captain is not a registry entry, and `captain` is reserved as a playbook id, command, and local role.

### 2. Generic configuration

The user config shall keep host fields at the top level and shall enable playbooks under `playbooks.<id>` with `from`, optional `command`, `players`, and that entry's remaining option fields.
Captain and player values shall be adapter shorthands or self-contained inline agent blocks under [DR-021](021-inline-agent-settings.md).
The launcher shall normalize each enablement into `captain.options.playbooks.<id>` and shall pass only its option slice to the registry.
Missing or invalid modules, id mismatches, duplicate ids or effective commands, reserved names, missing required roles, and a playbook with no visible effective player shall fail before launch.

### 3. Static roster and nested bindings

The launcher shall create the static tmux roster as the union of each configured playbook's namespaced `<id>-<role>` fallback players because tmux can change visibility but cannot create or reconfigure player identities after startup [[1]].
Distinct playbook declarations shall remain distinct configured players even when their agent settings are equal.
At runtime, a nested exact same-role child shall inherit the nearest ancestor's effective host player and root-owned continuation, while an unmatched child role shall use its own namespaced fallback under [DR-030](030-shared-mapped-player-continuity.md).
Registry identity metadata and visible panes shall follow these effective bindings rather than the unused fallback.

### 4. Active visibility

The launcher shall set `layout.initialVisible` from the first enabled playbook and shall preserve the user's other host layout, notification, and theme fields.
When the shell selects, resumes, pushes, or returns to an external leaf, it shall request that leaf's distinct effective players before dispatching Boss text.
The internal session Captain shall request no player visibility, and a display-only tmux reconciliation failure shall not block runtime dispatch.

### 5. Summary ownership

Each registry may declare only the state labels, adjudication guards, and saved-count wording its workflow owns.
During a root turn, descendant activity shall be included but each frame's events shall be interpreted by that frame's policy, so CODE does not duplicate REVIEW's nested review rounds.
The result reply shall remain grounded in the shell's outcome report under [DR-029](029-session-scoped-conversational-captain.md), and a zero-activity turn shall carry no saved-counts line.

### 6. CLI surface

The package shall expose one generic `playbook` executable that resolves or seeds its generic config, composes the tmux-play host, checks configured adapters, and launches the shell.
The starter config shall enable CODE, REVIEW, and DECIDE through explicit registry modules with the same `coder` and `reviewer` role names required for nested inheritance.
`playbook --list` shall print each configured id, effective command, and intent, while `--config` shall remain a raw tmux-play pass-through.

## Consequences

- Third-party playbooks can be enabled without changing the package or shell.
- Static configuration stays namespaced, while nested same-role execution reuses the conversation already holding the workflow context.
- CODE and DECIDE can call REVIEW without role aliases or reconstructed same-player context.
- Replacing a published registry or command remains a public-surface change governed by the release package.

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/docs/tmux-play.md#layout "cligent tmux-play dynamic visible player panes"
