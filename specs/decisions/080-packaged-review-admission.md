<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-080: Packaged workflow review admission

## Status

Accepted.
This narrowly amends [DR-009](009-generic-playbook-cli-and-registry.md) for fresh engagement of the explicitly configured packaged CODE and DECIDE registries.

## Context

A valid configuration can enable CODE without REVIEW.
The packaged workflow then commits work before its required nested REVIEW fails because that playbook is absent.
Rejecting the whole configuration would unnecessarily disable chat, inspection and unrelated custom workflows.
Generic registry manifests declare no callee-dependency interface.

## Decision

The host retains the exact configured module specifier privately beside each validated enablement.
Fresh start, switch and nested construction of id `code` from `@sublang/playbook/code/registry`, or id `decide` from `@sublang/playbook/decide/registry`, requires an enabled validated entry with id `review`.
The host refuses a missing REVIEW before working-frame construction, Coder dispatch, engagement replacement or nested-child bookkeeping.
The refusal names the selected effective command and missing REVIEW through the existing rejection/result path.
Configuration remains valid; no playbook is automatically enabled.
Custom same-id registries and differently spelled module aliases are outside this identity-specific guard.
Existing engagement delivery, saved assessment and recovery remain governed by their existing contracts.
The private provenance introduces no registry member, public dependency ABI or persisted snapshot field.

## Consequences

An incomplete packaged-workflow setup is diagnosed before its first mutation.
A rejected switch keeps the current root and its pending work.
Existing validated REVIEW configurations and custom workflow identity remain compatible.
