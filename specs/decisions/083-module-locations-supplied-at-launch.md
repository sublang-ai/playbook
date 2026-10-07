<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-083: Module Locations Supplied at Launch

## Status

Accepted (2026-10-06).
Amends [DR-009](009-generic-playbook-cli-and-registry.md) §1–§2 in one scope: an enabled playbook's registry module may be supplied by the launch instead of its configured `from`; enablement, validation and everything else of that record stand.

## Context

Spex, the application embedding Playbook, now composes each session's configuration itself and takes every playbook's module from an environment it manages [[1]].
Its core hands the launcher the module location of each playbook its composed configuration enables and writes no path into a shared file [[2]].
Its configuration files therefore name no `playbooks.<id>.from`, which the shared launch-config loader refuses before import.
The `playbook` CLI consequently cannot open or continue a session Spex created without a rewritten launcher config, and Spex could hand a module only by writing a path into a file it shares with other hosts.
A module location is a property of the machine and installation running the launch, not of the configuration a team shares.

## Decision

1. The shared loader accepts an optional `modules` option: a read-only record from playbook id to module specifier.
2. Each enabled playbook takes its module from `modules[id]` when supplied, else from its `from`; a supplied module wins over a configured `from` the way a `--with` fragment wins over the file.
3. A supplied module is canonicalised by the configured-module rules — an absolute path becomes a file URL, a file URL or package specifier is kept — except that the loader refuses a relative path, which has no config directory to anchor it.
4. On a new launch, a supplied module naming no enabled playbook is refused before any import; an ordinary reopen consults only its stored playbook ids, as it ignores every current playbook the session does not hold.
5. A playbook with neither a supplied module nor `from` is refused on a new launch; on a reopen it takes the module the session already records, and otherwise the module so taken — the supplied one, else a present `from` — must equal the stored module; a present `from` beside a supplied module is checked for form only.
6. The CLI exposes the option as a repeatable `--module <id>=<specifier>`, launcher-owned like `--with`: consumed, never forwarded or submitted as Boss input, refused beside a raw `--config`, with a relative path resolved against the invocation's working directory.
7. No supplied module is written to any configuration file; the session record keeps the canonical prepared module exactly as it does for a configured one.

## Consequences

The change is additive: every configuration valid before stays valid and composes the same plan, and the preparation hook, single import, registry checks and stored catalog are unchanged.
A host or user can open a session from a configuration without `from`, and the CLI can continue any recorded session without restating its modules.
A malformed `from` is still refused even when a module is supplied, so a broken shared file is never masked.
The reopen exemption for stray ids lets a host supply the modules of its whole current configuration without first computing the stored subset.

## References

[1]: https://github.com/sublang-ai/spex/blob/main/specs/decisions/104-spec-package-format-and-client-environments.md "Spex DR-104 — Spec package format 2 and client environments"
[2]: https://github.com/sublang-ai/spex/blob/main/specs/packages/environments.md#environments-9 "Spex environments-9"
