<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-nested-calls: Nested-Call Compilation Duties

## Intent

This package specifies compiler-definition duties for nested playbook call syntax and child-output routing.
It changes no source interpretation, runtime engine behavior, frozen compiler input, or experiment builder output.

## External Behavior

### compiler-nested-calls-1

When Source requires a literal or dynamic nested playbook call, text2gears shall emit the exact behavior verb phrase `Captain shall call playbook ...:` with any required sequencing in the `When` or `While` clause or continuation prose, not as an inserted word between `shall` and `call`.

### compiler-nested-calls-2

When gears2fsm emits nested-call routing, after preserving Source-authored success acceptance and recovery cases plus the public control-error `onError` fallback [[playbook-runtime-84](playbook-runtime.md#playbook-runtime-84)], it shall omit an `onDone` transition whose guard cannot be reached from any legal predecessor/context after the prior ordered `onDone` arms, without requiring arbitrary finite enumeration, dropping valid failure behavior, or relaxing verifier obligations.

## Verification

### compiler-nested-calls-3

When the integration suite inspects the text2gears and gears2fsm definitions, it shall verify exact nested-call verb syntax for literal and dynamic forms, forbidden sequencing words between `shall` and `call`, and unreachable nested-call `onDone` omission after authored routes and the control-error fallback are preserved [[compiler-nested-calls-1](#compiler-nested-calls-1)], [[compiler-nested-calls-2](#compiler-nested-calls-2)].
