<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-053: Seeding Picks an Adapter You Have

## Status

Accepted.
Amends [DR-044](044-dev-planning-workflow.md).
Amended by [DR-074](074-seeds-name-the-latest-models.md), [DR-096](096-a-second-adapter-reviews.md), [DR-097](097-readiness-reads-each-agents-token-forms.md), [DR-099](099-seeds-run-at-medium-effort.md), [DR-105](105-runtime-owned-seed-and-delegation.md).

## Context

The bundled starter carried a fixed agent lineup, and seeding was a byte copy: nothing about the machine reached it, including the seeded lineup of [DR-044](044-dev-planning-workflow.md).
A starter that names an adapter the user never set up therefore installs cleanly and fails on the first run, at the launcher's readiness gate ([[playbook-cli-12](../packages/playbook-cli.md#playbook-cli-12)]).

That gate is good — it names the adapter, gives the setup command, and exits without touching anything.
Nobody is stranded.
What is wrong is earlier: the seed's choice of adapter has nothing to do with the person receiving it, so the first run of a fresh install can fail for a reason the installer could have known and avoided.

One honest limit, recorded because the change would otherwise be read as fixing more than it does.
The failure that prompted this — a seeded Coder on an adapter whose provider quota was exhausted — would not have been prevented.
Readiness here means a credential is present: any of the agent's documented environment credential forms, or its sign-in folder in the home ([DR-097](097-readiness-reads-each-agents-token-forms.md)).
A quota is invisible to that test, and the exhausted account had both.
What this decision prevents is narrower and still worth having: a starter that names an adapter the user has never configured at all.

## Decision

- Seeding shall choose the seeded agents' adapter from the adapters whose credentials the launcher can already see, using the credential check of [[playbook-cli-12](../packages/playbook-cli.md#playbook-cli-12)] — each agent's documented environment credential forms and sign-in folder, nothing else ([DR-097](097-readiness-reads-each-agents-token-forms.md)).
- The runtime-availability probe of [[playbook-cli-39](../packages/playbook-cli.md#playbook-cli-39)] shall take no part in seeding. It constructs an adapter and awaits `isAvailable()`, which reads what happens to be installed on the host and spawns a subprocess for CLI-backed adapters; a seed that consulted it would differ between a developer's machine and a clean one, and would make a file-creation step asynchronous.
- Where several adapters are ready, one fixed documented order decides, highest first. An order fixed in the specification, rather than whichever the probe reports first, is what makes the same machine seed the same file twice.
- Where no adapter is ready, seeding shall write the documented default lineup anyway and say on stderr that nothing probed ready and what it wrote. A first run must end with a config: refusing to seed leaves a new user with nothing to edit, and the readiness gate states the same diagnosis a moment later with its remedies.
- Each selected adapter seeds the primary and child models Cligent returns for the effective provider, an empty result leaving both model fields unset ([DR-105](105-runtime-owned-seed-and-delegation.md)); a seeded model remains tunable in place [[playbook-cli-6](../packages/playbook-cli.md#playbook-cli-6)].
- Every seeded agent runs at effort `medium` ([DR-099](099-seeds-run-at-medium-effort.md)).
- Where both adapters are ready, only `dev.reviewer` seeds on the second adapter, at effort `high`, so a different adapter reviews ([DR-096](096-a-second-adapter-reviews.md), [DR-099](099-seeds-run-at-medium-effort.md)).
- The bundled template stays the one source of the starter's structure, comments, and documented default lineup. Selection rewrites only the seeded agents' settings, so the comments a reader needs survive the seed.
- The selection ships as the public subpath `@sublang/playbook/seed-config`, which the launcher seeds through too, so a host seeding through it selects the same agent settings under the same credentials and home ([DR-096](096-a-second-adapter-reviews.md)).
- Seeding stays one exclusive create. A selected lineup is written in the same single atomic step that a copy was, so two seeding calls in one invocation cannot race or disagree.

## Consequences

- A fresh install on a machine with one configured adapter seeds that adapter, and its first run works.
- A fresh install on a machine with none seeds the documented default and says so, which is a better first message than silence followed by a gate failure.
- The seed still cannot promise the adapter will work: a present credential is not a funded account, an authorized key, or an installed SDK. The readiness gate and the SDK gate remain the things that answer those, at launch, where they belong.
- Seeding becomes a function of the environment, so every test that asserts a seeded lineup must pin the environment it seeds under. The tests already inject a home directory and an explicit environment, so each case is stateable; a clean continuous-integration runner has no credential for any adapter and therefore exercises the none-ready case by default.
- A host that seeds through the public export selects the same lineup as the launcher; hosts may still choose their own file paths and transform the text.
