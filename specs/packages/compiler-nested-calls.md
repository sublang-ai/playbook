<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-nested-calls: Nested-Call Compilation Duties

## Intent

This package specifies compiler-definition duties for nested playbook call syntax and child-output routing.
It changes no source interpretation, runtime engine behavior, frozen compiler input, or experiment builder output.

## External Behavior

### compiler-nested-calls-1

When Source requires a literal or dynamic nested playbook call, text2gears shall emit the exact behavior verb phrase `Captain shall call playbook ...:`, whose colon immediately follows the literal target or dynamic selection, placing required sequencing in the `When` or `While` clause or in a requirement item that cites the call [DR-108](../decisions/108-compiled-gears-is-a-spec-package.md).

### compiler-nested-calls-4

When Source routes more than one path into one nested playbook call with the same target and the same input template — a later path made "with the same input as" an earlier path's — text2gears shall emit one nested-call action item whose one `When` clause lists the entry paths and state each path's continuation as a requirement item citing it [DR-108](../decisions/108-compiled-gears-is-a-spec-package.md), not one action item per path, so the compiled FSM keeps one call state entered from each path [[playbook-39](playbook.md#playbook-39)].

### compiler-nested-calls-2

When gears2fsm emits nested-call routing, after preserving Source-authored success acceptance and recovery cases plus the public control-error `onError` fallback [[playbook-runtime-84](playbook-runtime.md#playbook-runtime-84)], it shall omit an `onDone` transition whose guard cannot be reached from any legal predecessor/context after the prior ordered `onDone` arms, without requiring arbitrary finite enumeration, dropping valid failure behavior, or relaxing verifier obligations.

## Verification

### compiler-nested-calls-3

When the integration suite inspects the text2gears and gears2fsm definitions and maintained workflow GEARS, it shall verify exact nested-call verb syntax for literal and dynamic forms, forbidden sequencing words within the verb phrase or between its target and colon, canonical nested-call clauses across every maintained workflow GEARS artifact, the one-item-per-shared-call rule with the maintained DEV GEARS carrying exactly six action items whose `code`, `decide`, and `branch` calls each list their paths in one `When` clause, and unreachable nested-call `onDone` omission after authored routes and the control-error fallback are preserved [[compiler-nested-calls-1](#compiler-nested-calls-1)], [[compiler-nested-calls-4](#compiler-nested-calls-4)], [[compiler-nested-calls-2](#compiler-nested-calls-2)].
