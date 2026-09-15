<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-nested-tags: Nested-Call Tagging

## Intent

This package specifies the compiler's FSM tag duties for nested playbook calls so generated machines agree with the shared runtime's busy and suspended settlement model.
It changes no nested-call result routing or runtime engine behavior.

## External Behavior

### compiler-nested-tags-1

When gears2fsm emits an invoking working leaf, the compiler shall tag direct-Captain, delegated-player, and script leaves with `playbook.busy` while tagging nested-playbook call states with `playbook.suspended` and omitting `playbook.busy` from that call state and every ancestor state including the machine root [[playbook-runtime-41](playbook-runtime.md#playbook-runtime-41)], without forbidding an independently active sibling Captain, player, or script leaf from remaining busy.

## Verification

### compiler-nested-tags-2

When the integration suite inspects the gears2fsm definition and the current runtime snapshot normalizer, it shall verify that the definition limits the busy-tag duty to direct-Captain, delegated-player and script leaves, requires nested call states and all ancestors through the machine root to omit `playbook.busy`, permits independently active sibling busy leaves, and agrees with the runtime by treating a pending suspended call as quiescent only when no active busy tag remains [[compiler-nested-tags-1](#compiler-nested-tags-1)].
