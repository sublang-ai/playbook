<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Controlled FSM scaffold inputs

This repository-only builder prepares a fixed-GEARS comparison of ordinary FSM authoring and the optional incomplete scaffold.
It reuses the [catalog-aware link baseline](link-experiment-13.2.md), performs no provider call, and makes no runtime or performance acceptance claim.

```sh
node scripts/build-fsm-scaffold-experiment-13.2.mjs /absolute/frozen-compiler /private/tmp/new-fsm-scaffold-pair
```

The absent output root must be outside the supplied compiler and builder checkout, with an existing parent directory.
Its `baseline/` and `scaffold/` children are pipeline-path roots, each containing `playbook/`; a sibling `experiment-proof.json` records the complete pair.
Both arms contain the same corrected producer/catalog, retained Results guidance and terminal-return correction, ordinary link contract, optimizer, copied published semantic inputs, scaffold initializer and subdirectory guide.
The helper and guide are undirected visible files in the baseline; their existence is not hidden.
Only the scaffold arm's `gears2fsm.md` appends the optional guide, rebasing its helper link from the guide subdirectory to the phase directory.
Exactly the four existing phases remain discoverable.
Every active phase closure protects the same catalog, helper and guide because it reaches the active FSM rules directly or through adjacent references.

The proof contains the reused baseline's published/inverse checks and actual compiler package, lock and complete `dist/` inventory, each arm's output identities and the precise appended text identity.
Before publication, assembly rechecks input identity and requires only `playbook/gears2fsm.md` to differ between the arms.
No maintained workflow source, FSM, linked module, registry or runtime package is copied into the pair.
Staged sibling publication follows the existing single-writer absent-target assumption.
Historical output roots and the 12.3 builder remain untouched.

For a measurement, supply the exact same immutable GEARS source to ordinary `playbook.gears2fsm` phase invocations in fresh workspaces, using the same frozen compiler, dependency graph, effective model/settings and deadline.
Run the two arms sequentially and retain complete actual phase/call/usage metrics and applicable compiler checks.
Treat initialization as incomplete authoring: accepted output still requires all authoring markers replaced, strict typing, Source/GEARS/FSM fidelity and independently reviewed source semantics.
Neither a quick initializer run nor an incomplete or refused compilation counts as a performance win.
Full cold compilation and runtime acceptance remain separate outcomes.

```sh
PLAYBOOK_EXPERIMENT_COMPILER=/absolute/frozen-compiler \
  node node_modules/vitest/vitest.mjs run src/link-experiment-13.2.test.ts src/fsm-scaffold-experiment.test.ts
```

The integration tests execute actual CLI assembly, supplied-compiler discovery and closure, exact appended-only comparison, source identity and refusal controls.
Without the supplied compiler, help tests alone do not establish a valid pair.

[Final C3 assembly evidence](link-experiment-13.2-catalog-scaffold-evidence.json) records the first verified pair and unchanged input inventories; this is preparation evidence, not an accepted provider performance result.

The [common-boundary C3 evidence](link-experiment-13.2-boundary-evidence.json) records scaffold-v3 with the IR081/IR082/IR083 common corrections and unchanged C3 plus prior-pair inventories.
