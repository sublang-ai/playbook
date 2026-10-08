<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-115: Leases Name the Machine

## Status

In progress (2026-09-30): the specs, the module, the facade, the store and coordinator changes, and the tests are in place; the verification below is recorded.

## Intent

Realize [DR-087](../decisions/087-leases-name-the-machine.md): one machine identity published under the XDG state directory, read through `@sublang/playbook/machine-identity`, carried in the `hostname` field of session leases and repository claims, with legacy host names still reclaimable under the old rule and the identity file preserved by migration.

## Deliverables

- [x] DR-087 with its reciprocal DR-042 and DR-046 links and map row.
- [x] playbook-cli-23, playbook-cli-59, the lease-code table, and session-storage-11 name the machine identity and the legacy rule; playbook-cli-97 and playbook-cli-98 specify the identity file and the public facade; playbook-cli-24, playbook-cli-62, playbook-cli-91, and playbook-cli-99 verify them; release-38 gates the coordinated upgrade.
- [x] The private `machine-identity` module, the public facade with its declaration, the package exports and files, and the shared private-path rule factored from `prepareSessionPermissions`.
- [x] The session store and the repository coordinator resolve the identity by default and classify owners as tagged, legacy, or unverifiable.
- [x] Tests: the identity suite with two real processes, the tagged and legacy lease and claim rows, migration preserving the file, and the package surface; a changelog entry.

## Tasks

1. Record DR-087 with its reciprocal links and map row, and amend the affected items.
2. Add the private module, the facade, its declaration, the exports and files, and factor the private-path rule.
3. Resolve the identity by default in the session store and the repository coordinator with the owner classification.
4. Add the identity suite, the lease and claim rows, the migration and package-surface assertions, and the changelog entry.
5. Record the verification.

## Verification

Under Node 22, as CI runs it, `pnpm test` (which runs `spex lint`), `pnpm build` leaving every committed `.js` and `.d.ts` sibling unchanged, `pnpm check:links`, and `scripts/check-spdx.sh`.

Verified on 2026-09-30 under Node 24.21.0 (the CI Node 22 run stands with the pull request): `pnpm test` passed — `spex lint` 0 errors, 2,572 tests passed and 23 skipped across 94 files, and the Cligent release-capability suite 86 of 86; `pnpm build` left every committed `.js` and `.d.ts` sibling unchanged; `pnpm check:links` resolved all 3,851 relative links in 215 files; `scripts/check-spdx.sh` passed 449 files.
The identity suite ran three times in a row with its three real child processes agreeing on one value each time.
