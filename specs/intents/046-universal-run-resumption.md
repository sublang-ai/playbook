<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-046: Universal Run Resumption

## Status

In progress

## Intent

Implement [DR-038](../decisions/038-universal-run-resumption.md): retain each root playbook's last unfinished pre-terminal generation — nested stack included — across engagement disposal and session replacement, let capability-bearing runtimes adopt such a generation under a new engagement, and let the Captain select resumption as one validated action — so an interrupted procedure resumes mid-state through either front end with no per-playbook resume vocabulary and no Boss-side recovery instructions.

## Deliverables

- [ ] The Captain session record retains one unfinished pre-terminal generation per enabled root playbook id — root and nested frame snapshots with their call bridges, as one unit — surviving disposal and session replacement, replaced on later settlement, and cleared by clean completion per the artifact-declared unfinished final-state ids.
- [ ] The shared linked-runtime factory implements the optional adoption capability; a capability-less runtime retains and advertises nothing and the shell degrades as for a capability-less control surface.
- [ ] Cross-session adoption moves the generation from the predecessor record (newest settled, same working directory) in one guarded exchange, validated by the exact structural envelope, with per-role fresh-conversation fallback and ledger-authoritative player binding.
- [ ] Adoption runs under fresh runtime session UUIDs and counters with an adoption-lineage trace.
- [ ] The shell advertises retained generations, the Captain's closed action set gains the resume selection, and both front ends address it with the decided arbitration order.
- [ ] Spec items land in `playbook-runtime.md`, `playbook-captain.md`, and `playbook-cli.md`.
- [ ] Integration coverage spans the interruption matrix — Boss-question suspension, park, failure, real nested suspension, artifact-declared unfinished terminal, dismissed root, and fresh session after an adapter swap — each resuming and completing on real linked artifacts, plus capability-less degradation and a stale-world resume surfacing through review.
- [ ] `spex lint` and the full suites pass.

## Tasks

1. **Declare unfinished final states in linked artifacts.** _[done]_
   Emit the unfinished final-state id set as link-time metadata beside the resumable-state registry, declare it for the maintained artifacts, and land the `slc/link.md` output note and conformance tests.
2. **Retain the pre-terminal generation atomically.** _[done]_
   Extend the captain session record with the per-root-playbook retained generation — root and nested snapshots with call bridges — written at every settlement that leaves unfinished work, replaced in place, cleared on clean completion, and kept across disposal; land the store items in `playbook-cli.md` and the session-store tests.
3. **Expose the adoption capability on the shared factory.** _[done]_
   Add optional generation adoption — restore with engagement identity relaxed to the structural envelope — rebuilding the nested call bridges as live restore does, rejecting envelope mismatches before any effect; land the `playbook-runtime.md` items and unit plus integration tests for accepted, rejected, and capability-less paths.
4. **Bind players from the ledger.** _[done]_
   On adoption, bind each role from the current Captain-session player ledger, never from retained token projections, with fresh conversations for roles the ledger cannot supply; land the continuity items and tests for unchanged, advanced, and swapped players.
5. **Trace the adoption lineage.**
   Run adopted generations under fresh runtime session UUIDs and counters, trace the adoption boundary with source session and generation identity, and land the trace items and tests.
6. **Transfer generations across sessions.**
   Implement predecessor selection (newest settled record, same working directory) and the guarded move-and-clear exchange under the store's lease discipline; land the `playbook-cli.md` items and cross-session store tests.
7. **Advertise and select resumption.**
   Surface retained generations in the shell's control digest labeled by the retained root state's published description, add the validated resume selection to the Captain's closed action set with the decided arbitration order, and land the `playbook-captain.md` items and shell tests.
8. **Address resumption from both front ends.**
   Make a bare continuation request select resumption in `playbook run --continue` and interactive reopen with explicit fresh-start intent winning, and land the `playbook-cli.md` items with headless and interactive tests.
9. **Prove the interruption matrix end to end.**
   Drive real linked artifacts through each matrix class — Boss-question suspension, park, failure, real nested suspension with a child call, artifact-declared unfinished terminal, dismissed root, and adapter-swap fresh session — asserting each resumes mid-state with no initial-state classification and completes; include capability-less degradation, the stale-world resume surfacing through review, and the duplicate-effect warning assertions.
10. **Verify and hand over.**
    Run the full suites and `spex lint` to clean and hand the changes to review.

## Verification

- The store round-trips a retained generation — nested frames and call bridges included — across disposal, session replacement, and process restart, replaces it on later settlement, and clears it on clean completion per the artifact-declared set.
- Adoption accepts a generation matching the exact structural envelope, rejects any mismatch before effects, and is absent without harm on a capability-less runtime.
- Player binding comes only from the live ledger: an advanced shared player never regresses, and a swapped player's role re-grounds fresh.
- A resumed run re-enters its retained mid-procedure state with no initial-state classification call, under both front ends, with the decided arbitration among uncertain retry, live actions, adoption, and fresh start.
- Every matrix class completes after resumption, adoption traces carry the source lineage, and duplicate-effect warnings accompany resumption exactly as they accompany uncertain retry.
