<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Global CLI delivery candidate evidence

Candidate: `@sublang/playbook@19.1.0-rc.4`, paired with Cligent `0.40.0-rc.2` and SLC `0.23.0-rc.6` (frozen cohort 07). The Playbook tarball is byte-identical to cohort 04 used for the completed native matrix. These are alternative branch-registry candidates, not public npm releases.

- `full-suite.log.gz`: complete required suite, 3,244 passing tests and 34 existing skips, including the separate 156-test release-capability suite.
- `delta-suite.log.gz`: 250 passing targeted regression tests.
- `prepush.log.gz`: spec lint and TypeScript verification. Existing warnings remain visible.
- `frozen-cohort.json`: exact package tarball and per-file digests. Frozen source inventories and full native evidence are retained in the sibling `slc-global-delivery-20261117` delivery directory.

The full cohort-04 native matrix observed 30 successful cold CLI compilations (24 Codex, 6 Claude Code/GLM) and 18 GLM quota-blocked failures. Those 18 are not passing tests. A read-only post-check correlates source snapshots, checker input/start/report/finish chains and accepted executable hashes. Final-candidate bridge observations and independent delivery judgments are recorded in the consolidated evidence addendum.

Public candidate publication and merge remain blocked until exact-head required CI and public acquisition verification pass. Cligent's current distributable job is blocked by an unpatched development dependency audit finding; the audit gate has not been weakened. No workflow business task has been executed by these compilation acceptance tests. The separate spex-playbook Skill is excluded.

Raw command streams are gzip-compressed without changing their bytes; `raw-streams.json` records decompressed and compressed hashes.
