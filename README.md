<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Playbook: Reliability Is All You Need

*Skills made reliable through state machines and diverse LLMs.*

[![npm version](https://img.shields.io/npm/v/@sublang/playbook)](https://www.npmjs.com/package/@sublang/playbook)
[![Node.js](https://img.shields.io/node/v/@sublang/playbook)](https://nodejs.org/)
[![CI](https://github.com/sublang-ai/playbook/actions/workflows/ci.yml/badge.svg)](https://github.com/sublang-ai/playbook/actions/workflows/ci.yml)

Natural-language skills are flexible and easy to use, but less predictable than scripted workflows, especially on long-horizon jobs. And even the best LLMs make mistakes, partly because plain-language descriptions rarely eliminate vagueness or guarantee completeness.

SubLang Playbook addresses both:

- The companion [SLC compiler](https://github.com/sublang-ai/slc) turns plain-language procedures, such as a `SKILL.md`, into **playbooks** with deterministic state-machine control flow.
- A playbook can assign **different agents or LLMs** to its steps and have them **review and challenge one another**, helping catch mistakes before delivery.

---

## Table of Contents

- [The Big Picture: CUSTOMER · PLAYBOOK · EXECUTION](#the-big-picture-customer--playbook--execution)
- [Vocabulary](#vocabulary)
- [Why Playbook? The 4 Core Advantages](#why-playbook-the-4-core-advantages)
  - [Side-by-Side: Playbook vs. Ad-hoc Prompting](#side-by-side-playbook-vs-ad-hoc-prompting)
- [Quick Start](#quick-start)
  - [Install](#install)
  - [Prerequisites](#prerequisites)
  - [Run](#run)
- [Headless & Session Management](#headless--session-management)
- [Create Your Own Playbook](#create-your-own-playbook)
- [How It Compiles](#how-it-compiles)
- [Contributing](#contributing)
- [License](#license)

---

<a id="the-big-picture-customer--playbook--execution"></a>
## The Big Picture: CUSTOMER · PLAYBOOK · EXECUTION

```mermaid
flowchart TB
    subgraph Customer_Scope["👤 CUSTOMER (The Business Need)"]
        User[("Boss / End User")] --- Need["Requires reliable, deterministic AI output"]
    end

    subgraph Playbook_Scope["📋 PLAYBOOK (The Deterministic Process)"]
        direction TB
        FSM["🧠 State Machine (Compiled FSM)"]
        Roles["Roles: CODE, REVIEW, DECIDE"]
        FSM -->|Defines| Roles
        Nested["Nested verification (CODE→REVIEW, DECIDE→REVIEW)"]
        Roles -.-> Nested
    end

    subgraph Execution_Scope["⚡ EXECUTION (The Persistent Runtime Layer)"]
        direction TB
        Captain["⚓ Captain (Coordinator)"]
        Players["Players: dev.coder (Claude), dev.reviewer (Codex)"]
        Captain -->|Binds to| Players
    end

    User -->|"1. Triggers task"| Captain
    Captain -->|"2. Invokes & compiles"| FSM
    Roles -->|"3. Executed by"| Players
    Players -->|"4. Cross-checked, verified result"| Captain
    Captain -->|"5. Returns final answer"| User

    classDef cust fill:#e1f5fe,stroke:#01579b,color:#000;
    classDef play fill:#fff3e0,stroke:#e65100,color:#000;
    classDef exec fill:#f3e5f5,stroke:#4a148c,color:#000;
    class User,Need cust;
    class FSM,Roles,Nested play;
    class Captain,Players exec;
```

| Pillar | What it means |
| :--- | :--- |
| **CUSTOMER** | You — the **Boss**. You bring the business need and trigger the task. |
| **PLAYBOOK** | The compiled, deterministic state machine (FSM) that defines **roles** (`CODE`, `REVIEW`, `DECIDE`) and their nested verification logic. |
| **EXECUTION** | The persistent runtime layer: the **Captain** (coordinating agent) and the stable **Players** (e.g., Claude as `dev.coder`, Codex as `dev.reviewer`) that actually execute the roles and cross-check each other. |

---

## Vocabulary

- **Boss** — you, the user.
- **Captain** — the coordinating agent you talk to.
- **Role** — a playbook-local job, such as `coder`.
- **Player** — a stable Captain-session agent and provider conversation to which one or more roles bind.

Roles describe the *workflow*, while player IDs decide which work shares conversation continuity.

---

## Why Playbook? The 4 Core Advantages

Playbook isn't just another agent wrapper—it's a fundamental re-architecture of how LLMs execute tasks. Here is why it beats ad-hoc prompting:

1. **Deterministic Control Flow** – Compiled XState state machines prevent the Captain from wandering off-script.
2. **Adversarial Multi-LLM Review** – `CODE` (Claude) and `REVIEW` (Codex) cross-check each other, catching hallucinations autonomously.
3. **Stable Persistent Contexts** – Players retain full conversation history across nested playbooks and multiple turns.
4. **Compiled Explicit Specs** – The SLC compiler turns prose into strict GEARS/FSM states, optionally optimizing mechanical steps into safe shell scripts.

<a id="side-by-side-playbook-vs-ad-hoc-prompting"></a>
### Side-by-Side: Playbook vs. Ad-hoc Prompting

#### Visual Walkthrough

```mermaid
flowchart LR
    subgraph Without["Ad-hoc (Single LLM)"]
        direction LR
        W1(("Boss")) --> W2[Single Agent] --> W3[Vague Execution] --> W4[Errors & Loops] --> W5[High Cost]
    end

    subgraph With["Playbook (Compiled FSM)"]
        direction LR
        P1(("Boss")) --> P2[Captain] --> P3[State Machine] --> P4[Cross-Review] --> P5[Verified Delivery]
    end
```

#### Detailed Comparison

| Aspect | With Playbook | Without Playbook (The Risk) |
| :--- | :--- | :--- |
| **Workflow Predictability** | Compiled **state machine (FSM)** enforces deterministic step-by-step execution. The Captain cannot deviate from the defined triggers, actors, and outcomes. | The LLM infers actions from vague prompts → false assumptions, infinite tool-call loops, and wasted API costs without a deliverable. |
| **Error & Hallucination Detection** | **Adversarial multi-LLM checks** – `CODE` (Claude) and `REVIEW` (Codex) bind to different providers, autonomously challenging each other. | Single LLM echo-chamber → confidently produces plausible but incorrect outputs. Hallucinations survive to delivery, making late-stage debugging significantly more expensive. |
| **Session Memory & Continuity** | **Stable player IDs** (e.g., `dev.coder`) preserve full conversation history across nested playbooks and multiple Boss turns. The player remembers past decisions. | Stateless or truncated sessions → LLM forgets architectural decisions and contradicts its own fixes. Forces hours of re-prompting; long-horizon jobs become unmanageable. |
| **Tool & System Execution Safety** | Mechanical steps are **optimized into deterministic shell scripts** (removing the LLM entirely). The FSM physically prevents the agent from stepping outside defined boundaries. | LLM interprets "clean up temp" arbitrarily → destructive `rm` commands, malformed migrations, data corruption, and security vulnerabilities with unchecked freedom. |
| **Specification Integrity** | Prose (`SKILL.md`) is compiled into **explicit GEARS → FSM → runtime artifacts**. Tests and downstream specs are automatically verified. | Human-written skill files remain inherently incomplete → silent spec drift, diverging agent behaviour, and a debugging nightmare over time. |

### Summary Takeaway

> **Without Playbook**, the **Boss** is left manually policing a single, forgetful, hallucination-prone agent—bearing all the risk of costly mistakes.  
> **With Playbook**, the **Captain** orchestrates a compiled state machine, stable **players** with cross-provider checks, and deterministic tooling—delivering reliability, safety, and cost-efficiency that ad-hoc prompting simply cannot match.

---

## Quick Start

Out of the box, Playbook includes:

- **CODE** — implementation
- **REVIEW** — commit-based review and fixes
- **DECIDE** — independently proposed and reviewed specification decisions

`CODE` and `DECIDE` call `REVIEW` as a nested playbook.

The shared starter config uses **Claude** as both Captain and the `dev.coder` player, and **Codex** as `dev.reviewer`. `CODE`, `REVIEW`, and `DECIDE` bind their local roles explicitly to those two stable players, so nested and later engagements share a conversation only where their bindings name the same player ID.

### Install

```bash
npm install -g @sublang/playbook
npm install -g @anthropic-ai/claude-agent-sdk @openai/codex-sdk
```

Custom configurations need the SDKs required by their providers; see [Configuring agents](docs/configuration.md). If an SDK is missing or older than cligent supports, Playbook prints the pinned install command before launching anything; see [Installing agent SDKs](docs/cli.md#installing-agent-sdks) for upgrades, `npx`, and other adapters.

### Prerequisites

- Node.js >= 20.6.0
- Authenticated [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) or `ANTHROPIC_API_KEY`
- Authenticated [Codex CLI](https://github.com/openai/codex) or `OPENAI_API_KEY`

Interactive `playbook` additionally needs `tmux` and [`glow`](https://github.com/charmbracelet/glow#installation) on `PATH`; headless `playbook run` does not.

> ⚠️ `CODE` works in the current directory and can edit and commit autonomously, so **use a clean branch or worktree**.

### Run

```bash
cd /path/to/your/project
playbook
```

Type a task, enter `/code <task>` for implementation, or enter `/decide <task>` for an independently proposed and reviewed decision.

On first launch, Playbook writes its config to:

```
${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml
```

The same config, compiled Captain, enabled playbooks, stable players, and nested calls power headless runs.

---

<a id="headless--session-management"></a>
## Headless & Session Management

Both front ends create the same durable logical session: copy the reported session ID to reopen an interactive session headlessly or a headless session interactively.

Run `REVIEW` explicitly:

```bash
playbook run "/review review the latest commit"
```

Pipe a longer request to Captain:

```bash
printf '%s\n' 'Implement the approved specification, then review it.' | playbook run
```

Later, either presentation can reopen the returned/reported session id:

```bash
playbook --session 4f2c0000-0000-4000-8000-000000009ab1
playbook run --session 4f2c0000-0000-4000-8000-000000009ab1 "continue"
```

`playbook run` prints the one Boss-visible Captain reply to stdout and operational status to stderr; `CODE` and `DECIDE` can complete their nested `REVIEW` calls there too.

See [Using the CLI](docs/cli.md) for flags and durable continuation, [Configuring agents](docs/configuration.md) for the shared lineup, [Embedding](docs/embedding.md) for custom hosts, and the [changelog](CHANGELOG.md) for releases.

---

## Create Your Own Playbook

The separate [SLC compiler](https://github.com/sublang-ai/slc) requires Node.js >= 23.6 and compiles a plain-language `.md` or `.txt` procedure:

```bash
npm install -g @sublang/slc
slc playbook my-workflow.md
```

SLC writes `my-workflow.ts`, a registry entry ready for Playbook, beside the source, and the inspectable intermediates and tests under `my-workflow.playbook/`.

Enable that entry and bind each role it declares under `playbooks.my-workflow` in the shared config, then invoke `/my-workflow`; see [External playbooks](docs/configuration.md#external-playbooks) and the [SLC documentation](https://github.com/sublang-ai/slc#quick-start).

---

## How It Compiles

SLC's `playbook` pipeline has three phases:

1. **text → GEARS** ([slc/text2gears.md](slc/text2gears.md)) — makes each behavior explicit with its trigger, actor, prompt, and outcomes.
2. **GEARS → FSM** ([slc/gears2fsm.md](slc/gears2fsm.md)) — maps each item to an XState state that invokes the Captain, a player, another playbook, or a local script.
3. **FSM → runtime** ([slc/link.md](slc/link.md)) — links the machine to a host-independent interface for user input, agent calls, status, and telemetry.

The default [optimization pass](slc/optimize.md) replaces eligible mechanical steps with local shell scripts; `--no-optimize` skips it.

Inspect the complete [Captain](reference/sdlc/captain.md), [CODE](reference/sdlc/code.md), [REVIEW](reference/sdlc/review.md), and [DECIDE](reference/sdlc/decide.md) examples.

---

## Contributing

We welcome contributions of all kinds.

- 🌟 Star our repo if you find Playbook useful.
- [Open an issue](https://github.com/sublang-ai/playbook/issues) for bugs or feature requests.
- [Open a PR](https://github.com/sublang-ai/playbook/pulls) for fixes or improvements.
- Discuss on [Discord](https://discord.gg/XxTPjNqy9g) for support or new ideas.

From source:

```bash
git clone https://github.com/sublang-ai/playbook.git
cd playbook
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm playbook   # drive a Boss turn against the source tree
```

Playbook is itself spec-driven: the compiler phases are specs in [`slc/`](slc), and the reference playbooks are regenerated from their prose sources.

Edit a source, regenerate its GEARS, FSM, and runtime artifacts, sync the tests and downstream specs until `pnpm test` passes, and commit with co-author trailers per [`specs/packages/git.md`](specs/packages/git.md).

The gears↔FSM contract ([the playbook package](specs/packages/playbook.md)) and runtime contract ([the playbook-runtime package](specs/packages/playbook-runtime.md)) are pinned in [`specs/packages/`](specs/packages) and verified by the test suite.

---

## License

[Apache-2.0](LICENSE)
