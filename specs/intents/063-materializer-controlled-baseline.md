<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-063: Reproduce a Materializer Control Definition

## Status

Done (2026-09-12)

## Intent

Create an exact-version control for measuring the materializer independently of compact context and compiler definition-location fixes.

## Deliverables

- [x] Mutually exclusive baseline and full experiment-builder modes.
- [x] Exact reconstruction and identical non-entry inputs across the paired outputs.
- [x] Immutable candidate paths and repeatable integration evidence.

## Tasks

1. [x] Add and verify the controlled baseline builder mode without modifying existing frozen outputs.

## Verification

The baseline entry retains the complete installed 12.3 contract with the reviewed repository-disposition and completion-mapper corrections, while omitting exactly the optional helper recipe.
The same helper, companion, corrected optimizer, corrected FSM producer and explicit semantic-input sidecar remain in both directories; the conservative extra closure inputs do not instruct the baseline linker to use the helper.

Reproduce the baseline with `node scripts/build-link-experiment-12.3.mjs <installed-playbook-package-root> <new-directory> --baseline`; `--full` selects the matched helper-instructed entry and the flags are mutually exclusive.
The integration matrix verifies exact helper-section removal, absence of helper citations, identical remaining semantic-input hashes, and refusal of conflicting flags before output.
The builder removes the two reviewed correctness additions to recover the original installed link-definition hash exactly.
The immutable candidates are `/private/tmp/playbook-materializer-baseline-matched-12.3` and `/private/tmp/playbook-materializer-full-matched-12.3`; the baseline entry is 154,727 bytes and hashes to `cc81015ddcae5d7c6cb58f9932e9ffd5d765dc6f0489c5a0915f79e4daaec117`, while the full entry is 158,687 bytes and hashes to `683e4fbe489c8e70e03651ae725c1f85d9bdd93e4e4ebcf4bd51eee55173d8ec`.
Both actual SLC discovery/closure probes pass, including unchanged reuse and helper/companion invalidation; audit proof JSON records the selected mode and entry hash separately from the identical non-entry semantic inputs.
