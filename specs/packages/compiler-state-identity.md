<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-state-identity: Public State Metadata Placement

## Intent

This package defines the GEARS-to-FSM producer boundary between the machine root and the public workflow state nodes.

## External Behavior

### compiler-state-identity-1

When emitting an FSM, the compiler shall place public `meta.playbook` state metadata only on nodes declared under `states` and omit that namespace from the machine root, without restricting the root's XState `id`, description, or metadata outside that namespace.

## Verification

### compiler-state-identity-2

When the integration suite starts and transitions real XState machines through the shared public snapshot reader, it shall verify the producer definition's namespace rule with this case matrix [[compiler-state-identity-1](#compiler-state-identity-1)]:

| Machine-root metadata | Expected observation |
| --- | --- |
| Root id, description, and another metadata namespace | Only the current declared workflow state has public identity. |
| Root `meta.playbook.stateId` alongside valid child state metadata | Root identity remains active alongside the workflow state and violates the intended single-state identity. |
| Root `meta.playbook` without stateId | The shared metadata reader rejects the incomplete public-state declaration. |
