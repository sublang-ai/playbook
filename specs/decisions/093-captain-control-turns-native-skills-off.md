<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-093: Captain Control Turns Native Skills Off

## Status

Accepted (2026-10-20).

## Context

[DR-092](092-skills-follow-working-agents.md) gives routing, Judge and reporting calls an empty skill list, but each runtime still discovers skills by itself in its project and user skill folders and offers them to every run [[1]].
Environment managers now install persistent skills into exactly those folders [[2]].
Such a skill reaches a Captain's routing decision or a Judge's adjudication as instructions no Boss gave, and where tool isolation is prompt-only ([DR-013](013-routing-only-captain-control.md) A1) the Captain can even invoke it.

Cligent 0.35.0 adds a per-run `nativeSkills` option: `false` turns off, as far as each adapter's levers reach, the skills a runtime discovers by itself [[1]].
Cligent 0.36.0 carries it in tmux-play's complete call settings and rejects `false` before the call's prompt record for an adapter whose published native-skill support does not set `disableSupported` [[3]].
Claude Code, Codex, Gemini CLI and managed OpenCode set it; Kimi Code has no per-run lever and clears it.
A resumed conversation keeps the skill listings and bodies already in its history [[1]].

## Decision

- Every decision, Judge and reporting call carries `nativeSkills: false` where `getNativeSkillSupport` reports `disableSupported` for the session Captain's adapter.
- Where it does not — Kimi Code — or reports nothing, those calls omit `nativeSkills`, and the Captain keeps its runtime's own skill discovery.
  The owner chose this documented reduction over refusing a Kimi Captain, as DR-013 A1 accepts prompt-only tool isolation.
- Working-player and bounded recovery-preparation calls omit it: they are working actors, which DR-092 already gives their configured skills.
- The durable session-Captain conversation keeps resuming ([[playbook-captain-31](../packages/playbook-captain.md#playbook-captain-31)]); Judge and sub-runtime control calls already start fresh.
- The switch is fixed host behavior: no configuration field, durable execution field or structural-projection member, so ordinary reopening applies it at once.
- The Cligent floor rises to 0.36.0.

## Consequences

- On every adapter except Kimi Code, skills installed in project and user skill folders no longer reach Captain control; the skills each runtime keeps regardless stay.
- A durable Captain conversation established before adoption keeps the listings its history already holds until its next reseed; its new turns add none.
- On Claude Code the switch also drops, for control calls, any plugin placed in a project or user skill folder with its agents, hooks, MCP servers and commands; Codex lists every disabled skill path in its process arguments [[4]].
- A control call Cligent still rejects under the switch, such as Codex with an unreadable native skill root, fails like any other provider failure.
- A Kimi Captain still reads the skills in its project, user, configured and plugin skill folders.

## References

[1]: https://github.com/sublang-ai/cligent/blob/v0.35.0/specs/decisions/037-per-run-native-skill-switch.md "Cligent DR-037: Per-Run Native Skill Switch"
[2]: https://github.com/sublang-ai/spex/blob/main/specs/decisions/124-skills-reach-every-agent.md "Spex DR-124: Skills Reach Every Agent"
[3]: https://github.com/sublang-ai/cligent/pull/83 "Cligent DR-038: tmux-play nativeSkills call setting"
[4]: https://github.com/sublang-ai/cligent/blob/v0.35.0/specs/packages/skills.md#skills-11 "Cligent skills-11: native-skill support per adapter"
