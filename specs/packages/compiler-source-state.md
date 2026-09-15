<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-source-state: Source-State Preservation

## Intent

This package specifies compiler-definition duties for source-owned state that affects later generated-FSM availability or prompt context.

## External Behavior

### compiler-source-state-1

Where a Source outcome's availability condition is deterministically knowable from execution state, when gears2fsm emits the generated FSM, it shall enforce that condition with authored guards or typed state before the result can be accepted, update or reset those source-owned facts only at their actual Source lifecycle boundaries, never treat a Results description, Judge prose, or prompt text as the only enforcement of that condition, and never mechanically decide semantic judgments that Source leaves to the acting agent.

### compiler-source-state-2

Where Source requires earlier discussion or constraints on a later invocation, when gears2fsm emits Boss-reply suspension and continuation, it shall persist the needed earlier exchanges or constraints in serializable machine context before replacing or clearing pending Q/A fields, relay that source-owned context on fresh as well as resumed calls, preserve Source-owned relevance and format, avoid imposing all-history semantics on sources that do not require them, and avoid treating shared continuation's latest Q/A pair [[playbook-runtime-92](playbook-runtime.md#playbook-runtime-92)] or a backend continuation token [[playbook-runtime-38](playbook-runtime.md#playbook-runtime-38)] as durable Source history.

## Verification

### compiler-source-state-3

When the integration suite inspects the gears2fsm definition and runs focused XState XState fixtures, it shall verify that a deterministic prior-reply gate blocks a premature terminal outcome and opens only after the source-owned fact is recorded at the reply lifecycle boundary [[compiler-source-state-1](#compiler-source-state-1)], and that two answered Boss questions persist the earlier source-required constraint before the latest pending Q/A is replaced, then relay that context on both resumed and fresh later invocations [[compiler-source-state-2](#compiler-source-state-2)].
