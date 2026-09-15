<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-056: Shared Child-Result Validation in FSMs

## Status

Accepted

## Context

Generated FSMs repeatedly rewrote the public nested-result union incorrectly, rejecting valid failure terminals, optional state, and aborts without errors.
The installed shared engine already exports the pure validator used by its nested bridge.
The FSM's prohibition on importing a runner concerns runner binding and concrete actor implementation, not stateless validation of boundary data.

## Decision

- Reuse the existing named `validatePlaybookCallResult` export and type-only `PlaybookCallResult` in generated authored-child-failure helpers.
- Supply the actual selected target id; leave child-session correlation to the bridge rather than fabricating a request or identity in the FSM.
- Catch invalid public data as a nonmatching authored-failure guard; after validation accept only abort, error, or a successful transport carrying a failure terminal.
- Keep source-owned output predicates, routing, compact evidence and control-error handling separate from public envelope validation.
- Permit this named pure import without constructing or binding any runtime, actor implementation, host capability or port; the selected Playbook dependency remains part of artifact identity.
- Include the same generic helper in the optional static-child scaffold, without inferring when a source requires recovery.

## Consequences

- Public union validation has one implementation; generated workflow decisions remain source-owned.
- Importing the public engine loads its ordinary module closure but creates no runtime or host operation.
- Existing malformed artifacts remain failed observations; fewer emitted bytes do not prove compilation latency improvement or live model compliance.
