<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-097: Readiness Reads Each Agent's Token Forms

## Status

Accepted (2026-10-26).
Amends [DR-053](053-seeding-picks-a-ready-adapter.md) and the readiness gate it relies on in one scope: an adapter's credential is any of its agent's documented environment forms, not one API key variable alone.
Readiness stays credentials alone, checked synchronously; the agent's sign-in folder still counts; the fixed order, the table and the second-adapter Reviewer of [DR-096](096-a-second-adapter-reviews.md) stand.

## Context

- The credential check counts `ANTHROPIC_API_KEY` or `$HOME/.claude/` for `claude`, and `OPENAI_API_KEY` or `$HOME/.codex/` for `codex`.
- Each agent reads further forms from its environment [[1]] [[2]] [[3]]:
  Claude Code a bearer in `ANTHROPIC_AUTH_TOKEN` and the long-lived sign-in token of `claude setup-token` in `CLAUDE_CODE_OAUTH_TOKEN`; Codex a key in `CODEX_API_KEY` and a workspace access token in `CODEX_ACCESS_TOKEN`.
- A machine that signs its agents in through these forms alone — a CI runner, or a team server whose administrator hands every member's account the same unrefreshed token — has neither sign-in folder.
  There the check counts the agent as not ready: the seed falls back to the first row with its none-ready notice, so a Codex-only server seeds every agent on Claude and fails on the first run, and the readiness gate blocks a launch the agent would serve.

## Decision

- An adapter is ready when any of its forms is set, or its sign-in folder exists:

| Adapter | Environment forms | Folder |
| --- | --- | --- |
| `claude` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` | `$HOME/.claude/` |
| `codex` | `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` | `$HOME/.codex/` |

- One check answers both the seed's selection and the launch gate, so the two never disagree on what is ready.
- A set form is a credential's presence, not its validity: no form is parsed, refreshed or probed.

## Consequences

- A Codex-only machine signed in by `CODEX_ACCESS_TOKEN` seeds every agent on Codex, and one holding both tokens seeds the Reviewer on Codex as [DR-096](096-a-second-adapter-reviews.md) has it.
- Hosts seeding through `@sublang/playbook/seed-config` see the same forms by passing the environment that holds them.
- An expired token still reads as ready; the failed call reports it, as an expired sign-in folder already does.

## References

[1]: https://code.claude.com/docs/en/authentication "Claude Code authentication: credential precedence, ANTHROPIC_AUTH_TOKEN and the setup-token CLAUDE_CODE_OAUTH_TOKEN"
[2]: https://learn.chatgpt.com/docs/auth/ci-cd-auth "Codex CI/CD authentication: CODEX_API_KEY for non-interactive runs"
[3]: https://learn.chatgpt.com/docs/enterprise/access-tokens "Codex access tokens: workspace plans and CODEX_ACCESS_TOKEN"
