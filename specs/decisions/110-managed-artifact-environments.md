<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-110: Managed Artifact Environments and Included Agent SDKs

## Status

Approved direction; implementation and delivery acceptance authorized by the user on 2026-11-17.
Amends [DR-024](024-runtime-engine-provisioning.md) and [DR-027](027-runtime-compatibility-from-cligent.md) in provisioning scope and SDK delivery, retaining runtime compatibility ownership and preflight gates.

## Context

Existing launch-time provisioning repairs unresolved thin-artifact engine imports, but compilation needs the same environment before generation and checking.
Unrelated ancestor module settings, independently resolved runtimes, and unchecked changes to globally linked packages can make successful compilation differ from actual loading.
SDKs installed as sibling global roots are not necessarily reachable from another root's nested Cligent.
The approved installation contract favors both default Agent stacks being available over minimizing a single-vendor installation's footprint.

## Decision

- Adopt the Cligent release that ordinarily depends on both Claude Agent SDK and Codex SDK; retain no duplicate SDK runtime ranges in Playbook.
- Keep SLC an external compiler consumer of Playbook's published definitions and environment service; installing Playbook does not install or depend on SLC.
- Expose one artifact-environment service for compiler preparation and both launcher front ends, while retaining legacy filesystem provisioning for artifacts without a managed manifest.
- Standalone managed bundles own a private ESM package scope and direct links to one selected Playbook/XState pair inside their artifact directory, without registry installs, `npm link`, or project-root mutations.
- A versioned build manifest records the selected environment and entry; loading checks runtime-code identity and compatibility before registry import, never silently substitutes the launcher's different engine, and does not depend on compiler archives.
- An explicit entry marker locates the manifest across supported output layouts; loss of managed metadata is a preparation failure rather than an automatic legacy fallback.
- Every newly managed workflow uses its own internal environment, independently of surrounding project dependencies; occupied internal paths are refused without modifying user content, and the historical no-manifest provisioning contract remains separate.
- Managed `.mjs` entries are first-class configured registry modules; legacy `.ts` entries remain supported, and a new artifact revision loads in a fresh execution context.
- Fresh managed imports use one revision identity across ESM, CommonJS and JSON. Loader-internal URLs and ESM `import.meta.url`/`filename` are logical revision identifiers, not guaranteed physical self-file locators; their directory remains the original directory. Canonical configured registry locators and CommonJS lexical `__filename`/`__dirname` stay physical. A local, idempotent native-Module require adapter prevents directory-cache reuse without replacing Module objects, patching global Module methods, or deleting another live revision's cached modules.
- The separate `spex-playbook` Skill is outside this change and is not a release-acceptance prerequisite.
- Compiler definitions direct generated-code verification through compiler-owned checks and may provide finite public-entry witnesses; they do not guess project tooling or use patched private context as reachability proof.
- Release gates exercise the actual packed global install, managed and legacy artifacts, and both SDKs through nested Cligent; credentialed live acceptance remains separate from deterministic package checks.

- Pre-merge validation separates locally built/installed functional candidates from real branch prerelease registry installs, retaining stable publication gates without making a formal stable release a prerequisite.
- The shared compilation dependency/environment contract supports macOS, Linux and native Windows; POSIX-only historical front-end constraints do not exempt the native Windows compiler/library path.

## Consequences

The compiler and runtime host share environment preparation without creating a circular package dependency.
Global Playbook installation includes both default SDK stacks through Cligent, at the cost of larger downloads and broader production dependency audits.
Authentication, provider access, native-host compatibility, and optional external adapters still have independent readiness requirements.
Managed runtime links remain machine-local; upgrades may require verified compatible repair or recompilation, and this change does not promise a portable standalone dependency bundle.
Historical provisioning behavior remains available, while newly managed artifacts receive stricter identity checks before loading.
