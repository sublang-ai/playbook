<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-032: Explicit roles and session-scoped players

## Status

Accepted.
Supersedes [DR-030](030-shared-mapped-player-continuity.md).
Amends the configuration and binding model of [DR-009](009-generic-playbook-cli-and-registry.md), the continuation ownership of [DR-010](010-playbook-session-tracing-and-resume.md), the same-player constraint of [DR-011](011-composable-playbook-execution.md), the continuation tuning rules of [DR-015](015-per-run-agent-tuning.md), the fixed source labels of [DR-018](018-gears-grammar-provenance-from-spex.md), the linker metadata of [DR-019](019-shared-linked-runtime-factory.md), the inline-agent placement of [DR-021](021-inline-agent-settings.md), the compatibility transition of [DR-022](022-runtime-compatibility-contract.md), and the configuration and persistence boundary of [DR-031](031-shared-captain-session-front-ends.md).

## Context

The current design uses “player” for both a playbook-local work function and a host agent conversation.
It gives each playbook a namespaced fallback player, then silently replaces a nested role's configured agent when an ancestor happens to use the same role name.
That inference makes session sharing depend on spelling, can ignore a child's configured settings, and ends shared continuation when the root engagement finishes.

Durable continuation also freezes the complete launch configuration.
A user who updates a player from one model to another therefore resumes the old model even when the provider can continue the same conversation under the new model.
Identity, workflow structure, security, and current invocation tuning need distinct ownership.

## Decision

### 1. Roles are playbook-local

`Roles:` shall replace `Players:` as the fixed-English declaration in authored playbook source and emitted GEARS.
A role is a playbook-local semantic slot such as `Coder` or `Reviewer`; Boss and Captain are fixed actors and are not roles.
Every delegated behavior and compiled actor input shall retain its local role id until the host binds that role to a player.
Canonical role ids shall be lowercase, and declarations that differ only by canonicalization shall reject rather than collapse.
The runtime operation may remain named `callPlayer`, but its incoming identifier is a role id and the host-visible target is a player id.
Source-level player aliases are removed because they would create a second implicit role-to-player binding mechanism.

### 2. Players are explicit session identities

The shared config shall define concrete players in one flat top-level `players` map.
A player id shall match `[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*`, shall be compared exactly, and shall treat dots as an optional naming convention rather than hierarchy.
The host player contract shall accept that same segmented grammar so launch projection preserves the logical id verbatim instead of mangling dots.
The exact id `captain` is reserved for the session Captain.
A player value shall be an adapter shorthand or a normalized agent block whose `adapter` is part of that player's identity and whose remaining fields are defaults; a logical Captain session freezes the adapter of every referenced player, while a new session may choose another adapter.

Every enabled playbook shall explicitly bind each manifest `requiredRoleIds` member through `playbooks.<id>.roles`.
A binding shall be either a scalar player id or a block containing `player` and optional `model`, `effort`, and `fastMode` overrides; each model or effort override shall be a concrete string or the boolean `false` sentinel selecting the provider default, while a `fastMode` override shall be a literal boolean and omission of any override shall inherit that player's top-level default.
Adapter, instruction, permissions, workspace, and tool posture belong to the player session envelope and shall not be overridden by a role binding.
Bindings shall cover the required role set exactly; unknown players, missing or extra roles, implicit name matching, ancestor inheritance, and generated fallback players are errors.
When a manifest requires no roles, its exact binding map shall be empty and it shall contribute no player to the session roster; the launcher shall not invent a role merely to satisfy presentation.
Each manifest shall declare `concurrentRoleSets` derived from its fixed parallel groups, and the launcher shall require the roles in each declared set to bind to pairwise-distinct player ids before host work.
Unused top-level players are permitted and do not enter the host roster or readiness gate until a binding references them.
The launch plan shall retain each referenced player's normalized top-level defaults separately from each role's resolved tuning selections; a role override shall not mutate or replace the shared player's defaults for another role.

### 3. Player continuity belongs to the Captain session

A concrete player conversation is identified by the logical Captain session id and player id.
The logical Captain session shall own one continuation ledger keyed by player id, initialized for every referenced player with its fixed adapter, instruction, and permissions and retaining its latest opaque resume token across root completion, nested playbooks, process hand-off, and both front ends.
Equal player ids intentionally share that sequential conversation; distinct ids never share even when their settings are equal.
A player id reused under a different adapter is incompatible with its established ledger entry.
Simultaneous calls resolving to one player shall reject rather than fork or silently serialize one continuation chain.
The resolved player id shall remain transaction-owned from host-call admission through the owning runtime's synchronous validated-result update.
Only that exact update may atomically publish or clear the token and release the lane.
A resolved transition that cannot be validated or committed shall quarantine the lane for the logical session rather than unlock an uncertain prior token, while a rejected provider promise with no result shall preserve the prior token and release after it settles.
After a validated resolved call, the ledger shall replace the prior token when the result carries a non-empty token, clear it only when an `ok` result omits one, and preserve it when an `aborted` or `error` result omits one; a rejected call with no result shall likewise preserve the prior token.
There is no time, turn-count, root-engagement-count, or model-change limit while the durable Captain session and provider continuation remain usable.

The session Captain remains a distinguished top-level agent rather than an entry in `players`.
Its durable conversation follows the same immutable-adapter and current-tuning rules.

### 4. Reopening separates structure from tuning

Both `playbook --session <id>` and `playbook run --session <id>` shall open the same durable logical Captain session through the same exclusive-writer boundary.
A fresh launch through either front end shall create that same durable session kind; a fresh interactive launch shall expose its public id through operational output and persist its initialized settled boundary before accepting Boss input.
Every submitted non-empty Boss turn in either front end shall persist an uncertain write-ahead boundary before agent work and an atomic settled replacement before presenting the reply.
An attached interactive process shall retain ownership until it hands off or exits, while a headless invocation shall retain ownership through one durably settled turn.

Opening a settled session shall restore its Captain and working-runtime state, retain its normalized absolute working directory, and resolve the current shared config plus any opening overlays.
The stored enabled catalog and structural projection shall remain authoritative for the reopened session.
The current structural projection restricted to the stored playbook ids, Captain, and players referenced by those stored playbooks shall reproduce their prepared module identities, manifest contracts, effective commands, runtime options, required roles, explicit role-to-player ids, adapters, instructions, and permissions.
A missing or changed stored member shall reject before agent work, while additional current playbooks and players unreferenced by the stored catalog shall neither invalidate nor enter the reopened session; a new logical session is required to change that topology or provider identity.

The next Captain or player call shall use the current normalized model, effort, and optional fast-mode settings for its stable id while resuming the stored provider token under the established adapter.
Normalization shall represent each model and effort selection explicitly as either one concrete value or `provider-default`, so removing a prior selection is not confused with inheriting mutable provider-session state or inventing a provider default.
Fast mode shall remain an optional plain boolean: top-level omission selects the provider default, role omission inherits its player's top-level value, and explicit `false` is a retained literal request rather than a provider-default sentinel.
The host shall pass both complete model and effort selections plus the optional effective fast mode on every call rather than rely on provider state left by another role; an adapter that cannot explicitly restore a provider default or accept a present fast-mode request on a resumed conversation shall reject that selection before provider work.
The Captain-to-tmux-play host call surface shall therefore carry each delegated-player and durable session-Captain invocation's atomic complete-settings block containing model, effort, optional fast mode, instruction, and permissions alongside resume selection; omission of that block retains the host's legacy configured defaults, while a present block inherits no omitted model, effort, instruction, or permission member, and only model, effort, and fast mode may differ from the stored structural projection on ordinary reopen.
Where an adapter cannot enforce the requested settings on that resumed conversation, the call shall fail explicitly and retain the prior token; it shall never retry fresh or silently fork the session.
For the durable session Captain, that typed preflight rejection shall retain the selected token or never-opened `false` value plus the journal watermark already represented to it; the next supported call shall resume that selection with only the authoritative missed journal suffix.
An exact player-call preflight rejection that reaches shell fallback shall likewise retain the prior Captain resume target and require only missed-journal catch-up, never a fresh Captain conversation.
Other continuity failures and uncertain presentation shall continue to require a fresh full-history reseed.
An uncertain-turn retry shall instead use the exact config and bindings recorded for that attempt so recovery cannot change work after its write-ahead boundary.

### 5. Persistence and transition

The durable shell snapshot shall carry the Captain's fixed agent envelope and the player continuation ledger as common Captain-session state in chat as well as engaged modes, and every live frame shall carry its exact role-to-player binding projection.
Session records shall distinguish persisted structure and attempted settings from the current tuning applied at an ordinary reopen.
Linked-runtime traces and corresponding shell telemetry shall retain both the local role id and resolved player id where both are known.

The old `playbooks.<id>.players` format shall receive a major-version migration diagnostic rather than an automatic rewrite because choosing new player ids would also choose which prior conversations merge or remain isolated.
Released Captain-session records whose root-scoped generated players cannot be mapped unambiguously shall be rejected rather than merged, split, or resumed under guessed identities.
The source change from `Players:` to `Roles:` is mechanical only where no alias is present; an alias requires an explicit role and binding redesign.
Newly linked artifacts shall use artifact schema `2` for local-role metadata under [DR-022](022-runtime-compatibility-contract.md).
Every registry shall advertise artifact schema `2`, including bespoke profiles, and the next-major shared factory and Captain host shall reject artifact schema `1`, declaration-free artifacts, or a registry/factory disagreement because their `player` values may contain linker-time bindings or aliases that cannot be reinterpreted safely as local roles.
Linked-runtime traces shall use schema `3` so player-call boundaries carry required local `roleId` and optional resolved `playerId` without reinterpreting trace schema `2`'s overloaded player identity.
Runtime and complete shell snapshots shall use schema `3` for session player ledgers, local-role token projections, and discriminated Captain-or-role Boss-question ownership, and shall reject their released schemas rather than guess former player semantics.

## Consequences

- Session sharing becomes an explicit configuration choice instead of a role-name side effect.
- CODE, REVIEW, and DECIDE can share a Coder or Reviewer by naming the same player while applying role-specific invocation settings.
- A session can move from Opus 4.8 to Opus 5 without losing its Claude conversation, subject to provider support.
- Top-level players are identity-bearing session lanes rather than the reusable setting profiles rejected by [DR-021](021-inline-agent-settings.md).
- Active workflow state and security-sensitive provider identity remain stable while ordinary model, effort, and fast-mode tuning can evolve.
- A reopened session retains its saved catalog; newly enabled playbooks and their additional players become available only in a new logical session.
- The tmux-play host contract must accept segmented player ids and complete per-call effective settings before this design can be implemented.
- Source grammar, configuration, runtime metadata, snapshot shape, CLI continuation, and release acceptance change incompatibly and require a new major version.
