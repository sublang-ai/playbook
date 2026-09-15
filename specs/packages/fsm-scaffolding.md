<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# fsm-scaffolding: Optional FSM Authoring Scaffold

## Intent

This package defines an optional, unmeasured initializer for a self-contained TypeScript FSM target under [DR-054](../decisions/054-fsm-authoring-scaffold.md).
It owns source-constant copying and a typing scaffold, not workflow compilation or acceptance.

## External Behavior

### fsm-scaffolding-1

When invoked with `--source <GEARS.md> --out <new.fsm.ts>`, the `slc/scaffold-fsm.mjs` initializer shall emit one incomplete TypeScript target containing the supported source constants, only its used actor kinds and the typed XState authoring structure, or return a nonzero diagnostic without replacing an existing target.
The optional guidance shall reside at `slc/experiments/fsm-scaffold-guidance.md`, excluded from ordinary phase discovery, and the default entry definition shall remain unchanged until an explicit experiment selects it.

### fsm-scaffolding-2

Where Source uses LF text with unique `### <ASCII-ID>` items, canonical English Captain acting clauses or static nested calls, exact `Results:` and ``- `guard`: description`` declaration spacing, and one contiguous outer blockquote per prompted item, the initializer shall accept that source profile and reject ambiguous or unsupported item headings, fenced item bodies, noncontiguous prompts, script actors, dynamic calls and parallel groups.
An acting `Results:` label shall immediately follow its quote and contain only unique valid ordered guard bullets and blank lines to the next heading; nested calls shall declare no Results.
The target dependency graph shall provide XState `setup.extend` and `createStateConfig`, or initialization shall refuse.
An unprompted item shall remain available in the original Source for agent interpretation and contribute no prompt or actor constant.

### fsm-scaffolding-3

When copying a supported prompted item, the initializer shall remove exactly one outer blockquote marker and at most one following space or tab per line, preserve all remaining prompt characters and line breaks, and copy each authored result guard and description in order.
Absent Results shall remain absent, without inventing a default result, payload field, universal question outcome or controller policy.
A nested prompt constant shall remain a source template, without prescribing runtime child-text composition or child-result predicates.

### fsm-scaffolding-4

When emitting the typed structure, the initializer shall declare only the source's used Captain, player and static-playbook actor kinds as explicit failing placeholders, export their input/output contracts and machine input, and use `setup(...).extend(...)` for registered assignments followed by `createMachine(...)`.
Unresolved authoring markers shall require the compiler to supply context, external events, machine input/output, acting result payload types, runtime input fields, assignments, complete machine configuration and every workflow decision before the result can pass strict TypeScript.
Nested actor output shall use the readonly JSON boundary with optional absence [[playbook-runtime-42](playbook-runtime.md#playbook-runtime-42)]; the initializer shall infer no child interface.
The target shall embed its constants without initializer imports or auxiliary semantic files and import only XState, plus the selected public stateless validator and its public type when a child actor is used.
For that child profile it shall emit the generic authored-failure helper under [[compiler-child-validation-1](compiler-child-validation.md#compiler-child-validation-1)] without deriving a workflow predicate or recovery route; this pure import shall not bind a runner [[compiler-child-validation-2](compiler-child-validation.md#compiler-child-validation-2)].

### fsm-scaffolding-5

When initialization succeeds or refuses an input, the initializer shall leave Source bytes unchanged and report only status, target byte count and item count on success or a diagnostic on failure, without printing prompts or result descriptions.
Leading source SPDX comment text shall be copied as TypeScript line comments before imports.

## Verification

### fsm-scaffolding-6

When the integration suite invokes the real initializer and completes an original two-actor workflow, it shall verify literal prompt and ordered-result preservation through the supplied SLC parser, strict TypeScript acceptance, actual XState player-to-child execution and a separately carried runtime value [[fsm-scaffolding-3](#fsm-scaffolding-3)] [[fsm-scaffolding-4](#fsm-scaffolding-4)].
The unfinished scaffold and an invalid actor input shall fail strict checking in the same flow [[fsm-scaffolding-4](#fsm-scaffolding-4)].

### fsm-scaffolding-7

When the integration suite invokes the real initializer across supported acting/default-result/nested cases and unsupported source, malformed Results and existing-target cases, it shall verify the closed profile, exact source and existing-target preservation, declared XState/public-validator target imports, licensing and content-free diagnostics [[fsm-scaffolding-1](#fsm-scaffolding-1)] [[fsm-scaffolding-2](#fsm-scaffolding-2)] [[fsm-scaffolding-3](#fsm-scaffolding-3)] [[fsm-scaffolding-4](#fsm-scaffolding-4)] [[fsm-scaffolding-5](#fsm-scaffolding-5)].

### fsm-scaffolding-8

When inspecting the packed definition surface, the integration suite shall verify that the helper and optional guidance are packaged while ordinary SLC discovery finds exactly the four existing phases and the default phase does not select the experimental initializer [[fsm-scaffolding-1](#fsm-scaffolding-1)].
