<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-053: Seeding Picks an Adapter You Have

## Status

Accepted.
Amends [DR-044](044-dev-planning-workflow.md)'s seeded-lineup consequence in one scope: the seeded agents' adapter and model are selected at seed time rather than fixed, while the players, their role bindings, and everything else that consequence settles stand.

## Context

The bundled starter carries a fixed agent lineup, and seeding is a byte copy: nothing about the machine reaches it.
A starter that names an adapter the user never set up therefore installs cleanly and fails on the first run, at the launcher's readiness gate ([[playbook-cli-12](../packages/playbook-cli.md#playbook-cli-12)]).

That gate is good — it names the adapter, gives the setup command, and exits without touching anything.
Nobody is stranded.
What is wrong is earlier: the seed's choice of adapter has nothing to do with the person receiving it, so the first run of a fresh install can fail for a reason the installer could have known and avoided.

One honest limit, recorded because the change would otherwise be read as fixing more than it does.
The failure that prompted this — a seeded Coder on an adapter whose provider quota was exhausted — would not have been prevented.
Readiness here means a credential is present: an API key in the environment, or the adapter's dotfile directory in the home.
A quota is invisible to that test, and the exhausted account had both.
What this decision prevents is narrower and still worth having: a starter that names an adapter the user has never configured at all.

## Decision

- Seeding shall choose the seeded agents' adapter from the adapters whose credentials the launcher can already see, using the credential check of [[playbook-cli-12](../packages/playbook-cli.md#playbook-cli-12)] — environment variables and home-directory probes, nothing else.
- The runtime-availability probe of [[playbook-cli-39](../packages/playbook-cli.md#playbook-cli-39)] shall take no part in seeding. It constructs an adapter and awaits `isAvailable()`, which reads what happens to be installed on the host and spawns a subprocess for CLI-backed adapters; a seed that consulted it would differ between a developer's machine and a clean one, and would make a file-creation step asynchronous.
- Where several adapters are ready, one fixed documented order decides, highest first. An order fixed in the specification, rather than whichever the probe reports first, is what makes the same machine seed the same file twice.
- Where no adapter is ready, seeding shall write the documented default lineup anyway and say on stderr that nothing probed ready and what it wrote. A first run must end with a config: refusing to seed leaves a new user with nothing to edit, and the readiness gate states the same diagnosis a moment later with its remedies.
- The per-adapter model and effort defaults shall be a fixed table. Model currency is out of scope: a model name ages on a schedule of its own, unrelated to whether its adapter is configured, and tracking it needs a source of current models that does not exist here. A seeded model will go stale, and remains tunable in place [[playbook-cli-6](../packages/playbook-cli.md#playbook-cli-6)].
- The bundled template stays the one source of the starter's structure, comments, and documented default lineup. Selection rewrites only the seeded agents' `adapter`, `model`, and `effort` values, so the comments a reader needs survive the seed.
- Seeding stays one exclusive create. A selected lineup is written in the same single atomic step that a copy was, so two seeding calls in one invocation cannot race or disagree.

## Consequences

- A fresh install on a machine with one configured adapter seeds that adapter, and its first run works.
- A fresh install on a machine with none seeds the documented default and says so, which is a better first message than silence followed by a gate failure.
- The seed still cannot promise the adapter will work: a present credential is not a funded account, an authorized key, or an installed SDK. The readiness gate and the SDK gate remain the things that answer those, at launch, where they belong.
- Seeding becomes a function of the environment, so every test that asserts a seeded lineup must pin the environment it seeds under. The tests already inject a home directory and an explicit environment, so each case is stateable; a clean continuous-integration runner has no credential for any adapter and therefore exercises the none-ready case by default.
- The desktop app seeds this same template by copying it directly, so its first-run config does not select. Whichever front end runs first wins, and the two can disagree about the lineup on the same machine until the desktop adopts this rule.
- While one adapter is the only candidate a user permits, selection has one outcome. The none-ready notice is the part that still earns its place, and the mechanism is correct for the day a second candidate returns.
