<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-009: Generic playbook CLI and registry enablement

## Status

Accepted.
Amended by [DR-021](021-inline-agent-settings.md), [DR-029](029-session-scoped-conversational-captain.md), [DR-032](032-explicit-roles-session-players.md), [DR-040](040-outcome-authority-effect-reconciliation.md), [DR-050](050-pull-request-delivery.md), [DR-080](080-packaged-review-admission.md), [DR-083](083-module-locations-supplied-at-launch.md).

## Context

The original launcher and shell were tied to CODE, fixed role names, and one runtime.
A public playbook host needs explicit enablement, independently compiled workflows, deterministic commands, and static tmux players whose visible subset can follow a nested active leaf.
The configuration must remain inspectable and must not grant an imported registry authority over another playbook's settings.

## Decision

### 1. Registry manifests

Each enabled playbook shall be loaded from an explicit module, supplied by the launch or else by its configured `from` ([DR-083](083-module-locations-supplied-at-launch.md)), whose default export declares its stable id, default command, routing intent, required local roles, optional summary policy, option validator, and runtime factory.
The shell shall validate each registry against only that playbook's namespaced option slice, persisted as plain JSON apart from the current host's runtime-construction capabilities ([DR-040](040-outcome-authority-effect-reconciliation.md)), and shall derive lifecycle from runtime results and structured descriptors rather than registry state ids.
The bundled external registries include CODE with role `coder`, REVIEW with roles `coder` and `reviewer`, and DECIDE with roles `coder` and `reviewer`.
Fresh engagement of the packaged CODE or DECIDE registry requires REVIEW to be enabled, checked before the working frame is built and without rejecting the configuration ([DR-080](080-packaged-review-admission.md)).
The internal session Captain is not a registry entry, and `captain` is reserved as a playbook id, command, and local role.

### 2. Generic configuration

The user config shall keep host fields and top-level players at the top level and shall enable playbooks under `playbooks.<id>` with `from` (optional when the launch supplies the module or a reopened session records one), optional `command`, `roles` binding each required role to a player under [DR-032](032-explicit-roles-session-players.md), and that entry's remaining option fields.
Captain and player values shall be adapter shorthands or self-contained inline agent blocks under [DR-021](021-inline-agent-settings.md).
The launcher shall normalize each enablement into `captain.options.playbooks.<id>` and shall pass only its option slice to the registry.
Missing or invalid modules, id mismatches, duplicate ids or effective commands, reserved names, and missing, extra, or unknown role bindings shall fail before launch.

### 3. Static roster and nested bindings

The launcher shall create the static tmux roster from the top-level players that role bindings reference, because tmux can change visibility but cannot create or reconfigure player identities after startup [[1]].
Distinct player ids shall remain distinct configured players even when their agent settings are equal.
At runtime, each nested child role shall resolve its explicit role binding under [DR-032](032-explicit-roles-session-players.md), and registry identity metadata and visible panes shall follow these bindings.

### 4. Active visibility

The launcher shall set `layout.initialVisible` from the first enabled playbook and shall preserve the user's other host layout, notification, and theme fields.
When the shell selects, resumes, pushes, or returns to an external leaf, it shall request that leaf's distinct effective players before dispatching Boss text.
The internal session Captain shall request no player visibility, and a display-only tmux reconciliation failure shall not block runtime dispatch.

### 5. Summary ownership

Each registry may declare only the state labels, adjudication guards, and saved-count wording its workflow owns.
During a root turn, descendant activity shall be included but each frame's events shall be interpreted by that frame's policy, so CODE does not duplicate REVIEW's nested review rounds.
CODE, REVIEW, and DECIDE counts consume accepted outcomes, while replies consume canonical structured settlements ([DR-040](040-outcome-authority-effect-reconciliation.md)).
The result reply shall remain grounded in the shell's outcome report under [DR-029](029-session-scoped-conversational-captain.md), and a zero-activity turn shall carry no saved-counts line.

### 6. CLI surface

The package shall expose one generic `playbook` executable that resolves or seeds its generic config, composes the tmux-play host, checks configured adapters, and launches the shell.
The starter config shall enable the bundled playbooks through explicit registry modules, binding their roles to seeded top-level players; BRANCH and PR bind both `coder` roles to the seeded `dev.coder` player ([DR-050](050-pull-request-delivery.md)).
`playbook --list` shall print each configured id, effective command, and intent, while `--config` shall remain a raw tmux-play pass-through.

## Consequences

- Third-party playbooks can be enabled without changing the package or shell.
- Conversation sharing across nested playbooks is an explicit binding to the same player.
- CODE and DECIDE can call REVIEW without role aliases.
- Replacing a published registry or command remains a public-surface change governed by the release package.

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/docs/tmux-play.md#layout "cligent tmux-play dynamic visible player panes"
