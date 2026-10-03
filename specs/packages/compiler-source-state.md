<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-source-state: Source-State Preservation

## Intent

This package specifies compiler-definition duties for generated-FSM state that controls outcome availability or supplies prompt context, including Source-owned history and canonical Boss-reply fields.

## External Behavior

### compiler-source-state-1

Where a Source outcome's availability condition is deterministically knowable from execution state, when gears2fsm emits the generated FSM, it shall enforce that condition with authored guards or typed state before the result can be accepted, update or reset those source-owned facts only at their actual Source lifecycle boundaries, never treat a Results description, Judge prose, or prompt text as the only enforcement of that condition, and never mechanically decide semantic judgments that Source leaves to the acting agent.

### compiler-source-state-2

Where Source requires earlier discussion or constraints on a later invocation, when gears2fsm emits Boss-reply suspension and continuation, it shall persist the needed earlier exchanges or constraints in serializable machine context before replacing or clearing pending Q/A fields, relay that source-owned context on fresh as well as resumed calls, preserve Source-owned relevance and format, avoid imposing all-history semantics on sources that do not require them, and avoid treating shared continuation's latest Q/A pair [[playbook-runtime-92](playbook-runtime.md#playbook-runtime-92)] or a backend continuation token [[playbook-runtime-38](playbook-runtime.md#playbook-runtime-38)] as durable Source history.

### compiler-source-state-4

When gears2fsm emits Boss-reply suspension for direct-Captain or delegated-player working leaves, the generated FSM shall keep pending questions visible to the runtime's reply-wait projection [[playbook-runtime-45](playbook-runtime.md#playbook-runtime-45)] through these canonical machine-context paths ([DR-005](../decisions/005-boss-reply-suspension-path.md)):

| Form | Pending question | Boss reply |
| --- | --- | --- |
| Scalar, required for a machine declaring no root parallel group | `context.pendingBossQuestion` | `context.bossReply` |
| Keyed, required throughout a machine declaring a root parallel group, including sequential working leaves | `context.pendingBossQuestions[stateId]` | `context.bossReplies[stateId]` |

Each working leaf's `invoke.input` shall pass its selected question and reply, when present, unchanged as singular `pendingBossQuestion` and `bossReply` fields for shared continuation [[playbook-runtime-92](playbook-runtime.md#playbook-runtime-92)], regardless of context form; a private wrapper such as `context.continuation` shall not replace the canonical context fields.
This topology selection preserves the shared factory's flat scalar and parallel keyed projections [[playbook-runtime-88](playbook-runtime.md#playbook-runtime-88)] ([DR-079](../decisions/079-topology-selects-question-storage.md)).

### compiler-source-state-6

Where Source requires the complete received Boss reply retained after an acting agent accepts it semantically, when gears2fsm emits that accepted boundary, the FSM shall first verify the current question's state, Source-item and asker binding and receipt of a nonempty reply, then retain the exact canonical reply in serializable context before clearing the question and reply, preserving surrounding whitespace, CRLF/LF separators, blank lines and trailing separators rather than requiring or substituting a model-produced echo ([DR-082](../decisions/082-retain-input-owned-boss-replies.md)).
Neither stale question/reply context nor a different actor-supplied value shall establish that binding or semantic approval.

### compiler-source-state-8

Where Source owns array-valued retained discussion with no initial history, when gears2fsm emits that context field, it shall initialize and reset its empty value as a JSON-safe empty array only at Source lifecycle boundaries, preserving the declared array shape in ordinary and continuation actor inputs and the Source-owned retention duty [[compiler-source-state-2](#compiler-source-state-2)], without inventing caller intent, domain evidence, prerequisite reports, approvals or prior-stage results ([DR-086](../decisions/086-empty-typed-history-shapes.md)).

## Verification

### compiler-source-state-3

When the integration suite inspects the gears2fsm definition and runs focused XState XState fixtures, it shall verify that a deterministic prior-reply gate blocks a premature terminal outcome and opens only after the source-owned fact is recorded at the reply lifecycle boundary [[compiler-source-state-1](#compiler-source-state-1)], and that two answered Boss questions persist the earlier source-required constraint before the latest pending Q/A is replaced, then relay that context on both resumed and fresh later invocations [[compiler-source-state-2](#compiler-source-state-2)].

### compiler-source-state-5

When the [continuation integration suite](../../src/compiler-continuation.test.ts) drives real XState question/reply flows for direct-Captain and delegated-player inputs, and the [materialization integration suite](../../src/link-materialization.test.ts) emits, compiles, and runs a flat delegated-player artifact through the actual shared factory and Git worktree capabilities, the suites shall verify exact question discovery and resumed Q/A through scalar context, no question discovery for flat keyed or private-wrapper controls even when a manually injected reply can reach an invocation, and the definition's topology-specific storage requirement [[compiler-source-state-4](#compiler-source-state-4)].

### compiler-source-state-7

When the integration suite runs the shared factory against a real Git worktree, it shall verify that an accepted reply is retained exactly through Q/A clearing and a later invocation for LF, CRLF, blank lines and surrounding whitespace [[compiler-source-state-6](#compiler-source-state-6)].
It shall verify that semantic refusal, malformed results, mismatched question identity or authority, stale Source-item context and empty replies confer no retained approval or later call [[compiler-source-state-6](#compiler-source-state-6)].
The suite shall verify unchanged repository receipts and the shipped lifecycle guidance [[compiler-source-state-6](#compiler-source-state-6)], without claiming that a fixture proves a future model-produced artifact conforms.

### compiler-source-state-9

When the [history-shape integration suite](../../src/compiler-history-shape.test.ts) drives real XState fresh, reset and repeated-question flows, it shall verify that initialized/reset empty retained arrays preserve their declared ordinary and continuation input shape with byte-identical actual prompts and terminal outcomes, and that malformed actual histories and absent required caller or approval evidence remain rejected [[compiler-source-state-8](#compiler-source-state-8)].
Where the selected compiler is supplied through `PLAYBOOK_EXPERIMENT_COMPILER`, the suite shall also invoke that compiler's real SLC prompt-composition checker and verify that an absent-history control yields the documented scalar-probe composition refusal while the initialized array shape passes [[compiler-source-state-8](#compiler-source-state-8)].
The suite shall verify the shipped initialization/reset guidance [[compiler-source-state-8](#compiler-source-state-8)], without claiming that its fixture establishes future generated-artifact conformance.
