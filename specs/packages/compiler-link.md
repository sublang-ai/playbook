<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-link: Link Definition Retrieval

## Intent

This package governs retrieval of the compiler's link definition and its normative runtime companion, per [DR-050](../decisions/050-compact-link-definition.md).
The emitted runtime's behavior remains owned by its existing contract.

## External Behavior

### compiler-link-1

The published link definition shall declare `link-runtime.md` as its relative normative dependency, with both files available through the compiler-definition package surface [[release-16](release.md#release-16)].
Where a compiler host snapshots or pins that definition, the definition shall require the host to retain both files and their relative layout and treat a change to either file as a change to the definition.

### compiler-link-2

For ordinary flat shared-factory workflows, the link definition shall provide an authoring procedure covering the workflow-specific option, construction, event, role, outcome-authority, prompt, controller-metadata, compatibility, and verification obligations without requiring the linker to reread runtime machinery already delegated to the shared factory [[playbook-runtime-5](playbook-runtime.md#playbook-runtime-5)].
When the Source or selected strategy needs a specialized override, the procedure shall direct the linker to the relevant normative runtime section, and when the Source needs a bespoke parallel runtime, it shall require the complete runtime contract.

### compiler-link-3

When runtime sections move from `link.md` into `link-runtime.md`, the definition split shall retain their exact text and retain each original `link.md` heading as a forwarding link to the same runtime concern.

## Verification

### compiler-link-4

When the packed-package integration suite resolves the compiler entry and companion through their public subpaths, it shall assert both files are readable and every dependency and forwarding link resolves within the package, verifying the published dependency closure [[compiler-link-1](#compiler-link-1)] and preserved section destinations [[compiler-link-3](#compiler-link-3)].

### compiler-link-5

When runtime-contract conformance checks read the entry definition and its companion together and compare their declarations with the real shared-runtime module, they shall retain the existing type and runtime assertions, verifying that compact authoring still binds the same shared runtime [[compiler-link-2](#compiler-link-2)].
When auditing the definition split against its parent revision, the verification shall assert every moved section remains byte-identical in its companion and the existing input, role, output, and compiled-execution sections remain byte-identical in the entry definition, verifying preserved contract content [[compiler-link-3](#compiler-link-3)].
