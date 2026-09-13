<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-070: Labelled Nested Materialization

## Status

Completed correctness prototype (2026-09-12); experimental performance remains unmeasured.

## Intent

Evaluate a bounded extension of the optional materializer in [DR-051](../decisions/051-link-materialization-tool.md) for the labelled string relays and nested calls of CODE and DEV, preserving their authored FSMs and the full link contract.

## Deliverables

- [x] Explicit descriptor and emitter profile with strict refusal boundaries.
- [x] Real-CLI, strict-type, composer and maintained nested-runtime integration evidence.
- [x] Frozen candidate ready for an independently controlled performance comparison.

## Tasks

1. [x] Implement and verify the experimental profile under [[link-materialization-22](../packages/link-materialization.md#link-materialization-22)] through [[link-materialization-26](../packages/link-materialization.md#link-materialization-26)].

## Verification

No live timing or retention claim is made by this implementation intent. Maintained artifacts are local correctness fixtures only and are not supplied as provider oracles.

The real CLI emits and strictly type-checks modules over the unchanged maintained CODE and DEV FSMs.
The integration harness reruns all 57 maintained runtime and prompt assertions, including actual shared-runtime execution, real Git effects, nested success/failure/suspension, CODE phase progression and last-commit ownership, DEV plain/pull-request paths, and fresh/resumed Q&A.
Only import targets are rebound to the emitted factories and local registry copies; all maintained behavioral assertions remain unchanged.
A separate emitted-composer matrix covers literal replacement, exact optional-line removal, CRLF and blank lines, missing values, source preservation, local-role lookup, and a valid `toString` token that must not read an inherited mapping entry.
Invalid metadata preserves accepted targets; a nonexistent erased type export is rejected by the independent strict check, since runtime factory preflight cannot validate TypeScript-only declarations.
The [existing materializer suite](../../src/link-materialization.test.ts), [labelled integration suite](../../src/link-materialization-labelled.test.ts), and [package/archive suite](../../src/compact-link-definition.test.ts) pass 25 top-level cases with one explicitly opt-in historical reconstruction case skipped, including the maintained assertions above.
The existing default profile remains byte-identical to its frozen predecessor, and quoted-relay rendering and continuation checks remain green.
Root type checking passes, Spex reports zero errors with 233 advisory warnings, and 2,795 relative links resolve.
Independent review found and resolved the inherited-key lookup issue, then reported no remaining scope or escaping findings.
The private sanitized record `/private/tmp/playbook-labelled-candidate-evidence.json` preserves exact tested helper, definition, FSM, runtime and log identities with reproduction commands; the tracked suites provide the durable reproduction.
No runtime, dependency, maintained source, or FSM bytes change, and no provider calls or performance measurements occur in this intent.
