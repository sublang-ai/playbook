<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-child-validation: Canonical Child-Result Reuse

## Intent

This package keeps generated authored-child-failure recognition aligned with the shared public nested-result contract through existing stateless validation, per [DR-056](../decisions/056-shared-child-result-validation.md).

## External Behavior

### compiler-child-validation-1

Where a generated FSM recognizes an authored rejected child result, the compilation guidance shall require its helper to accept an actual `Error`, validate the error's `result` through the existing `validatePlaybookCallResult` export from `@sublang/playbook/xstate-runtime` using the actual selected target id, return no authored result on validation failure, and accept the validated result only for `aborted`, `error`, or `ok` with a failure terminal, preserving the shared bridge's result and identity contract [[playbook-runtime-42](playbook-runtime.md#playbook-runtime-42)] and authored-outcome distinction [[playbook-runtime-84](playbook-runtime.md#playbook-runtime-84)].
It shall use the public `PlaybookCallResult` type rather than redeclare the union, shall fabricate no request or child-session id, and shall leave workflow-specific predicates, routes and compact evidence to Source.

### compiler-child-validation-2

When the FSM uses that helper [[compiler-child-validation-1](#compiler-child-validation-1)], its stateless validator import shall be permitted while runtime construction, runner binding, concrete actor implementations, host capabilities and port calls remain excluded from the FSM artifact.
The imported implementation shall resolve from the selected Playbook dependency; it shall not be copied into a new handwritten validator or replaced by a maintained workflow implementation.

## Verification

### compiler-child-validation-3

When the integration suite compiles the emitted helper as standalone strict TypeScript and drives the actual nested bridge, it shall verify agreement for failure terminals with required state identity and optional description, aborts with or without optional state/error, errors, successful child output, wrong target, malformed terminal/state/error and non-JSON data, while retaining exact input bytes and rejecting outer look-alikes [[compiler-child-validation-1](#compiler-child-validation-1)].
The same flow shall verify that the emitted module imports the selected public validator and public type without constructing a runner or replacing its implementation [[compiler-child-validation-2](#compiler-child-validation-2)].
