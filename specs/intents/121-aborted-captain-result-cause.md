<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-121: Aborted Captain Result Cause

## Status

Implemented and verified by the failure-cause suite (2026-11-08).

## Intent

A direct-Captain call the Boss aborts parks the machine with the `aborted` cause, as a player call does — whether the host settles the call `aborted` on a live signal, or the turn's signal stops the step and the host then settles `aborted` or rejects with the signal's reason — and any player, direct-Captain, or script step the signal stops before or around its host call parks the same cause wherever the stop lands, so a host no longer reports the Boss's own stop as a Playbook defect [[playbook-runtime-47](../packages/playbook-runtime.md#playbook-runtime-47)] [[playbook-runtime-96](../packages/playbook-runtime.md#playbook-runtime-96)].

## Deliverables

- [x] `playbook-runtime-47` names the cause an aborted or errored Captain result carries, `playbook-runtime-96` decides the `aborted` cause once per step wherever the signal's stop lands and its `player-failed` and `aborted` rows no longer overlap on an `aborted` result; DR-063 §1 is amended to match.
- [x] The direct-Captain funnel decides `aborted` for an `aborted` host result on a live signal, and the shared step wrapper decides `aborted` once for every player, direct-Captain, or script step the signal's own stop parks, wherever within the step it lands — covering the default Captain actor and the compiled Captain's strategy calls alike.
- [x] The failure-cause suite drives an `aborted` Captain result and a signal-aborted Captain call at a direct-Captain state and at the compiled Captain's decision state, the stop landing in the started-trace sink, before the host call, in the output adjudication, at a player call's started-trace sink, at a running script, and in a progress record, plus an `error` Captain result with and without a host error string, and asserts the published cause on every surface [[playbook-runtime-98](../packages/playbook-runtime.md#playbook-runtime-98)].
- [x] The changelog records the fix under Unreleased.

## Tasks

1. Amend the spec items, fix the funnel and the step wrapper, add the verification, and record the fix in one `fix(runtime)` commit.

## Verification

The existing failure-cause suite covered a signal-aborted turn at a player call and a non-`ok` player result, but drove no Captain host result with `status: 'aborted'` and no signal-aborted Captain call, so the Captain funnel's default `runtime-defect` cause and the bare abort reason's `runtime-defect` fallback went unasserted.
Every added Captain case, the player started-trace-sink case, the script case, and the progress-record case fail against the unfixed code with `runtime-defect` carrying the host's "aborted by the Boss" message and pass with the fix; the player host-call cases and the `error` Captain result cases pass before and after, pinning the decisions the fixed cases are held to.
