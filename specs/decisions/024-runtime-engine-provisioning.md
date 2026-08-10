<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-024: Run-Time Engine Provisioning for Thin Artifacts

## Status

Accepted.
Supersedes nothing: [DR-023](023-data-only-machine-ir.md)'s data-only machine IR remains the accepted long-term direction, but it no longer gates dropping the project-local install and `npx` consumption story — this record's provisioning mechanism is the chosen near-term gate, delivered as a 3.x minor.

## Context

- A compiled thin artifact is code: its FSM imports `xstate` and its runtime module imports `@sublang/playbook/xstate-runtime`, both resolved by Node walking up from the **artifact's** directory.
  A globally installed host launches fine but fails at artifact load in any directory without a project-local install ([DR-023](023-data-only-machine-ir.md)).
- The Boss judged the full data-only IR redesign too heavy a prerequisite for the near-term goal; the goal is only that `npm install -g @sublang/playbook` plus a bare `playbook run` work anywhere.
- npm-mediated fixes are rejected for cause:
  - `npm link` maintains a global link registry, writes manifests, and its links are silently removed by later `npm install` runs in the same tree;
  - a default registry `npm install` at run time needs the network, drifts from the host's engine version, and npm's directory walk-up can mutate an unrelated parent `package.json` — the exact bug that recently bit slc's demo docs.

## Decision

### 1. Probe first; an existing install always wins

- Before `playbook run` imports the artifact module (first run and `resume` alike), the command probes resolution of both engine specifiers — `xstate` and `@sublang/playbook/xstate-runtime` — with the artifact's own path as resolution parent (`module.createRequire(artifactPath).resolve(...)`).
- If both resolve, the command touches nothing: a project-local installation is always authoritative, whatever its version — [DR-022](022-runtime-compatibility-contract.md)'s `spec.compat` check remains the arbiter of genuine incompatibility.

### 2. Provision by direct symlink from the host's own tree

- On probe failure the command creates the minimal environment: `<artifactDir>/node_modules/xstate` and `<artifactDir>/node_modules/@sublang/playbook` as symbolic links pointing at the running host's **own** installed package roots, resolved from the host's module scope.
  Only the missing link(s) are created.
- Two links suffice: Node resolves a symlinked package's own imports from its real path, so the engine's transitive dependencies come from the host's tree.
  Engine == host holds by construction, eliminating skew for provisioned runs.
- The links are created with direct `fs.symlink` calls — never `npm link`, and no registry install (a registry-install fallback may exist at most behind an explicit future flag; this cut ships none).
- POSIX-only, per the existing platform stance.

### 3. Implicit by default, one log line, one opt-out

- Provisioning is automatic, with exactly one stderr line naming each created link and its target.
- `--no-provision` disables it; the unresolvable import then surfaces through the ordinary load-diagnostic path.
- No explicit environment subcommand ships in this cut; the implicit-only choice is deliberate — the probe makes the operation idempotent and self-explanatory, and an explicit subcommand can layer on later without changing this contract.
- Idempotence: a repeated run finds the probes resolving and creates nothing.

### 4. Refusal and diagnostics

- Where a `package.json` at or above the artifact's directory **declares** `@sublang/playbook` among its dependencies while resolution fails, the command refuses to provision and prints an instructive diagnostic (install the project's own dependencies): shadow-provisioning a broken project install would mask the real fix.
- A previously provisioned link whose target no longer exists (host uninstalled or moved) is a dangling symlink: with provisioning enabled the command replaces it (it is provisioning again); under `--no-provision` it produces a diagnostic naming the stale link and its missing target — never a raw `ERR_MODULE_NOT_FOUND`.
- A real file or directory already occupying either link path is never removed or overwritten; the command refuses with a named diagnostic.
- Foreign package-manager layouts (pnpm strict trees, yarn PnP without `node_modules`) may make provisioning inapplicable; a clear named error is acceptable there.

### 5. Symlink, not copy

- Symlinks keep provisioning instant, disk-free, and always version-identical to the host.
  The cost is machine-local fragility (the dangling case above), which §4 makes diagnosable.
- Copy-mode is a possible durability option; it is deliberately deferred — the first cut stays minimal.

### 6. Git hygiene

- Artifact directories often become git repositories that player agents commit into, so the two `node_modules` entries can land in their commits.
  Documentation shall recommend ignoring `node_modules/` in such repositories; no automatic `.gitignore` write ships in this cut.

### 7. The acceptance gate moves here

- The [DR-023](023-data-only-machine-ir.md) hermetic global-only test is re-scoped onto this mechanism and joins the opt-in `pnpm test:acceptance` suite ([[release-24](../packages/release.md#release-24)]/[[release-25](../packages/release.md#release-25)]): pack the candidate, install it globally in an isolated prefix with no project-local packages anywhere, run a compiled artifact from a bare directory, assert provisioning triggers (log line and symlinks), the run reaches its terminal JSON outcome, and a second run provisions nothing further.
- Documentation drops the `npx`/project-local story only after this gate passes; slc-side adoption is out of scope here.

## Consequences

- The global-CLI experience ships as a minor release: additive behavior on `playbook run`, no new package surface, no artifact format change.
- Provisioned runs execute under exactly the host's engine, so the remaining artifact/engine skew surface is the one [DR-022](022-runtime-compatibility-contract.md) already checks by declaration.
- Machine-local symlinks are the accepted cost; the dangling-link diagnostic and the never-overwrite rule bound the damage, and copy-mode remains open under a future record.
- [DR-023](023-data-only-machine-ir.md) work is deferred, not abandoned: when a data-only artifact format lands, provisioning simply stops triggering for it (nothing to resolve), so the mechanisms compose rather than conflict.
