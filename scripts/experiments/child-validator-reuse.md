<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Canonical child validation: structural evidence

The generated CKr2Ni FSM reimplemented the public child-result envelope and rejected valid failure terminals, optional state and aborts without an error. The separate candidate uses the existing `validatePlaybookCallResult` export, the actual selected target id and the public result type. Source still determines acceptance, recovery and compact reporting. The original failed FSM is unchanged.

The replaceable original block is 2,899 bytes; the reusable wrapper plus imports is 591 bytes, removing 2,308 bytes (6.01% of that 38,429-byte FSM). Other JSON helpers remain used elsewhere. This is a structural comparison, not measured compilation acceleration. A single local feasibility run took 1,242.7 ms for strict checking, 65.7 ms for module import and 0.34 ms for a first synthetic validation. These timings are neither paired nor provider measurements.

The real initializer and existing actual bridge pass 22 focused tests, including 15 envelope cases, standalone strict NodeNext imports, six valid authored failure variants, success, wrong target, malformed terminal/state/error, non-JSON data and outer-error look-alikes. The incomplete scaffold still fails strict compilation until its source-owned authoring is complete. Pure imports do not bind a runner or concrete actor.

Reproduce the maintained checks with the chosen frozen compiler graph:

```sh
PLAYBOOK_EXPERIMENT_COMPILER=/private/tmp/slc-fidelity-compiler-ehkjoo54 /private/tmp/slc-fidelity-compiler-ehkjoo54/node_modules/.bin/vitest run src/compiler-child-validation.test.ts src/fsm-scaffolding.test.ts --root /private/tmp/playbook-complex-performance
```

[The aggregate](child-validator-reuse-evidence.json) records exact historical source, replacement, test-log and private reproduction identities. Replay the private measurement with `node /private/tmp/slc-child-validator-reuse-proof/replay.mjs /private/tmp/NEW-child-validator-proof`; the initializer intentionally refuses to replace an existing target. No original generated artifact was repaired or accepted. New immutable compilation inputs and a live cohort are required to assess whether models adopt this reuse and whether compilation improves.
