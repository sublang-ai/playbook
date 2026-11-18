<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# artifact-environment: Shared Artifact Environment Preparation

## Intent

This package specifies Playbook's compiler-facing and host-facing service for preparing and validating the runtime environment of filesystem workflow bundles under [DR-110](../decisions/110-managed-artifact-environments.md).
Essential project-specific references are `@sublang/playbook`, its public `./artifact-environment` subpath, the SLC compiler consuming that service without becoming a dependency, and the interactive and headless Playbook hosts.
It owns environment preparation and loading identity, not compilation semantics or Agent execution.

## External Behavior

### artifact-environment-1

The distributable shall expose `@sublang/playbook/artifact-environment` as a JavaScript and declaration surface supporting environment inspection, parsed executable-file closure inspection, workflow-environment preparation, and manifest validation for both external compilers and launchers, with explicit artifact directory, selected package roots, and provisioning authority supplied by the caller, returning immutable JSON environment facts or structured failures without CLI prefixes.

### artifact-environment-2

On macOS, Linux and native Windows, when inspecting a selected environment, the service shall identify the canonical Playbook and XState package roots, versions and relevant runtime-content digests, exported engine entry, runtime ABI and supported artifact schemas, refusing missing or incompatible required surfaces and missing fresh-loader surfaces or unsupported actual module formats, including TypeScript where the host cannot load it, before artifact import instead of substituting another package or relying on an undeclared loader.

### artifact-environment-3

Where workflow-environment preparation is authorized, when the service prepares the environment, it shall create only compiler-owned private `package.json` metadata with `private: true`, `type: module` and ownership marker `sublangArtifactEnvironment: 1` and direct directory links at `<artifactDir>/node_modules/xstate` and `<artifactDir>/node_modules/@sublang/playbook` to the inspected selected roots [[artifact-environment-2](#artifact-environment-2)], using POSIX symbolic links or native Windows directory junctions/equivalent unprivileged directory links, without requiring Administrator or Developer Mode solely for preparation, and without registry installation, `npm link`, or SDK, TypeScript, and Node-typing installations inside the bundle.

### artifact-environment-4

When planning environment mutations, the service shall validate every destination before creating anything, refuse a real or foreign occupied path inside the workflow environment, ignore enclosing project dependency declarations for environment selection, preserve project manifests, locks, dependency trees and ancestor module settings, and restrict replacements to links proven owned by its recorded environment, returning the offending path and repair without overwriting user content.

### artifact-environment-5

When validating a managed bundle, the service shall accept only `build-manifest.json` schema `sublang.slc.build.v1` with the following data contract and verify runtime-required executable paths, digests and selected runtime identity before registry import:

| Member | Contract |
| --- | --- |
| `schema` | Exactly `sublang.slc.build.v1`; each managed workflow owns its internal environment, with no environment-mode member. |
| `entry` | `{ path, format }`, with `path` relative to the manifest directory and identifying the actual caller-selected entry either inside that artifact directory or beside it, and `format` equal to `esm-javascript` for `.mjs` or `typescript` for a historical `.ts` entry. |
| `compiler` | `{ package, version, buildIdentity }` identifying the producing compiler. |
| `runtime` | `{ playbook, xstate, runtimeAbi, artifactSchema }`, each package record containing `{ name, version, root, identityFiles, contentHash }` with its canonical physical root and a relative-path/digest list for the installed public runtime and declaration files used by the artifact and its checks. |
| `inputs` | Source/definition/semantic-input evidence `{ path, sha256, snapshot }`; original paths and retained snapshots are provenance, not runtime dependencies. |
| `files` | `{ path, kind, format, sha256 }` records, with runtime kinds `entry`, `fsm`, `linked` and `runtime-support`, and archival kinds `gears` and `checker-evidence`; relative paths begin at the manifest directory, with no manifest self-digest. |
| `verification` | `{ checks, attemptRecord }`, recording accepted checks of shape `{ name, status: "passed", evidence }` and the retained invocation-record reference; evidence paths are archival metadata, not files required for execution. |

- Runtime refusal: malformed metadata, escaping runtime entry/import/identity paths, missing or changed runtime-required files, or incompatible package, ABI or schema identities; every actual entry/FSM/linked module and required local runtime import belongs to the checked runtime file set.
- Runtime closure: parse actual JavaScript and TypeScript syntax without executing the inspected modules or requiring a project compiler, follow literal ESM and CommonJS imports while excluding comments, prompt examples and type-only imports, and refuse unprovable dynamic module paths rather than omit them from the accepted identity.
- Runtime scope: only required generated code, its runtime-support closure, the declared entry and selected package roots; missing or changed original Source, GEARS, snapshots, logs, generated test files or other archival evidence does not by itself prevent loading unchanged runtime code.
- Runtime identity: `identityFiles` covers the installed public runtime entry, the same-package runtime dependency closure and declarations actually used for artifact checking; unrelated documentation, tests, repository metadata and logs are excluded.
- Runtime `contentHash`: SHA-256 over the sorted identity-file paths and bytes, using UTF-8 `/`-separated relative paths and unsigned 64-bit big-endian byte lengths before each path and file; verify the recorded per-file SHA-256 values, and reject identity-file links escaping the selected package.
- Compilation and reuse: Source/GEARS fidelity and archival completeness remain compiler-owned acceptance checks; the runtime host does not recompile Source or judge compilation history.

### artifact-environment-6

Where managed runtime links are dangling or the selected installation has changed, when preparation is requested, the service shall apply the caller's explicit provisioning authority without treating candidate preparation as runtime acceptance:

| Caller authority | Outcome |
| --- | --- |
| Runtime host | Restore only the exact recorded target; a different installed target requires the producing compiler's revalidation or rebuild, with no silent redirect to the host's engine. |
| Producing compiler preparing a candidate | Prepare the explicitly selected compatible roots, replacing only links proven owned by the workflow, and mark this as an unaccepted candidate until compiler checks pass and a new manifest is atomically published. |
| Candidate check fails or is canceled | Restore prior owned links where possible, retain the prior accepted manifest and report any unavailable original installation; never publish candidate success. |
| Host encounters an unaccepted or identity-mismatched candidate | Refuse the new load rather than consume the pending environment as accepted. |

### artifact-environment-7

When a host resolves a configured filesystem registry, it shall classify and load it without using a filename-derived manifest path as its only evidence:

1. Recognize the compiler-owned entry-header comment `// @sublang/slc-build-manifest <JSON string>` before the first executable statement, resolving that relative manifest path from the actual entry directory without executing the entry.
2. Recognize an internal package footprint by `sublangArtifactEnvironment: 1` in the entry directory or its canonical sibling bundle directory; treat that footprint or the entry header marker as evidence of a managed workflow; a missing, malformed, duplicate or mismatched marker/manifest for such a workflow is a preparation failure, never permission to downgrade to legacy loading.
3. Support both the normal sibling bundle and the existing case where the invocation directory is already the artifact directory; use the recorded actual entry and artifact paths rather than append another `<basename>.playbook` directory.
4. Validate runtime-required identity [[artifact-environment-5](#artifact-environment-5)] before registry import, recognize the new `.mjs` entry, and load changed revisions with fresh transitive module state rather than query-string-only CommonJS cache invalidation.
5. Retain the existing provisioning behavior only for genuinely historical modules with no managed-workflow marker or footprint [[playbook-cli-36](playbook-cli.md#playbook-cli-36)], including historical `.ts` entries, without offering another compilation environment mode.

Loader-internal module URLs may identify a virtual revision rather than a physical self-file; relative directory resolution and CommonJS lexical file names shall remain anchored to the original artifact, while configured registry locators retain their canonical declared paths.

### artifact-environment-8

When environment preparation completes or fails, the service shall return structured created-link notices, selected environment facts, or a failure naming category, path or package, actual and required compatibility where known, and restore, project-install, or rebuild remedy, with no successful mutation notice on a no-op and no requirement to expose provider credentials.

## Verification

### artifact-environment-9

Where the packed package alone is installed into an isolated global prefix on macOS, Linux or native Windows, when an external consumer invokes its public service and the platform-supported launch front ends load configured fixtures, the integration suite shall verify the managed-environment matrix, with native Windows exercising the shared service and Node registry/runtime lifecycle without requiring the POSIX tmux front end:

| Fixture | Assertions |
| --- | --- |
| Empty destination under unrelated ESM or CommonJS ancestors, including spaces and Chinese paths | Public inspection and preparation through the exported surface [[artifact-environment-1](#artifact-environment-1)], selected package identity [[artifact-environment-2](#artifact-environment-2)], private ESM metadata and exactly the two runtime links without destination SDK or tooling installation [[artifact-environment-3](#artifact-environment-3)]. |
| Surrounding project has a compatible, incompatible or missing declared runtime; separate internal-path fixtures contain a real occupied path, live foreign link or unsafe metadata | Independence from surrounding dependencies, complete internal-path preflight and unchanged user content on refusal [[artifact-environment-4](#artifact-environment-4)]. |
| Correct manifest, changed runtime-code digest, escaping path, unsupported schema or actual module format, changed runtime or missing target | Validation before registry import [[artifact-environment-5](#artifact-environment-5)], exact-target host repair or compiler candidate revalidation, with rollback on failure and refusal of pending candidates [[artifact-environment-6](#artifact-environment-6)]. |
| Managed `.mjs`, historical `.ts`, missing or malformed managed manifest/marker, normal sibling bundle, already-in-artifact invocation directory, and a changed CommonJS dependency | First-class entry support, correct actual-path discovery, refusal of a managed-to-legacy downgrade, genuine legacy provisioning, and current exports through a fresh checking/loading context [[artifact-environment-7](#artifact-environment-7)]. |
| Deleted or modified Source snapshots, GEARS, compiler logs and checker evidence; unrelated installed-package documentation changes | Unchanged executable code remains loadable and runtime identity remains unchanged [[artifact-environment-5](#artifact-environment-5)]. |
| First preparation, repeat, `--no-provision`, and refusal | Structured notices or actionable failure, no notice or mutation for an unchanged repeat [[artifact-environment-8](#artifact-environment-8)]. |
