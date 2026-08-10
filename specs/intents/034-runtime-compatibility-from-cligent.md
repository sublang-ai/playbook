<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-034: Runtime Compatibility from Cligent

## Status

Done

## Intent

Delete playbook's copies of agent-runtime version knowledge and consume
cligent's shipped descriptor and structured verdict instead, per
[DR-027](../decisions/027-runtime-compatibility-from-cligent.md), so a
cligent upgrade alone carries the compatibility policy and an
installed-but-stale runtime is reported with its versions rather than as
absent.

## Deliverables

- [x] DR-027 records the delegation and the clauses of DR-026 it
      supersedes; playbook-cli-39, playbook-cli-40, playbook-cli-41, release-12, and release-27
      state the delegated contract.
- [x] The gate module derives adapter runtimes, floors, and remedies from
      `@sublang/cligent/runtime-targets`, keeps only module-path knowledge,
      and covers every declared adapter with published targets, `gemini`
      included.
- [x] An unusable adapter reports per-runtime verdicts: absent runtimes as
      not installed, below-floor runtimes as unsupported with installed and
      required versions, each with cligent's pinned repair.
- [x] The manifest declares no agent-SDK peer ranges; the SDKs stay
      `devDependencies`; the cligent dependency admits the descriptor and
      verdict surface.
- [x] The changelog records the delegation and corrects this cycle's
      earlier entry, which promised a peer-range mirror this release no
      longer ships.

## Tasks

Each task is one commit and keeps build, typecheck, lint, and unit checks
green at its boundary.

1. [x] **Record the delegation.**
       Record DR-027; amend playbook-cli-39 for the descriptor-derived map and the
       end of `gemini`'s exemption, playbook-cli-40 for the unsupported verdict and
       pinned remedies, playbook-cli-41 for their test counterparts, release-12 to
       drop the identity requirement in favor of no declaration, and
       release-27 to verify the absence; add the DR-027 and IR-034 rows to
       the spec map.
2. [x] **Delegate the gate.**
       Replace `ADAPTER_SDKS` with module paths plus cligent's descriptor;
       classify each unavailable adapter's runtimes through cligent's
       verdict; render missing and unsupported distinctly with pinned
       repairs; build the npx re-run from pinned repair specs; drop the
       manifest's agent-SDK peer entries; update both callers and the
       affected tests.
3. [x] **Record the change.**
       Update the changelog, correct the superseded mirror sentence in this
       cycle's DR-026 entry, and align the README install guidance with the
       pinned remedies the gate prints.

## Verification

- With every declared adapter's runtimes installed at supported versions,
  the gate launches unchanged and prints nothing.
- With an SDK absent, the failure names the adapter and prints cligent's
  pinned install for it; with an SDK or CLI installed below cligent's
  floor, the failure names the installed and required versions and prints
  the same pinned install; the two states are never conflated.
- An `opencode` failure names only the half that is actually at fault when
  the other half is present and in range.
- A `gemini` lineup with the CLI absent or below floor blocks at the gate
  rather than failing mid-turn.
- Under `npx` / `npm exec`, the re-run line names every required SDK at
  cligent's pinned repair spec.
- `package.json` lists no agent SDK under `peerDependencies` or
  `peerDependenciesMeta`; both SDKs remain `devDependencies`.
- Build, typecheck, lint, and unit checks pass.
