<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-091: An Unrevealed Shape Is the Machine's to Judge

## Status

Accepted (2026-10-12).
Amends [DR-089](089-judge-replies-take-the-machines-shapes.md) §1 in its fallback: a semantic field whose shape the machine does not reveal no longer stays a string.

## Context

- Under DR-089 §1 the runtime probes the compiled machine for each semantic field's shape, and a field whose shape no probed combination reveals stays a string, enforced before delivery.
- The probe's record could not tell a field the machine admits as a string from a field no sample revealed: both were left out, and both were enforced as strings.
- A guard that reads context the probe's sample does not satisfy, throws, or sits beyond the probe's field limit reveals nothing, so the runtime refused the judge's list, corrected it into a string, and delivered a string the machine itself refuses: the step failed as a runtime defect after its commit stood.
- A run of the ten-team simulation failed with exactly these symptoms at a list-typed `committed` outcome; its installed artifact bundled an engine from before DR-089 that enforced a string everywhere, and DR-089's fallback reproduces them wherever the probe reveals nothing.

## Decision

- The probe records the shape it finds for every semantic field, a string included.
- A field whose shape the probe does not reveal has no recorded shape: the reconciler admits any JSON value there, and the machine's own guard decides it after delivery.
- A recorded shape, a string included, stays enforced with DR-089 §1's validation error and correction; the judge prompt names each recorded non-string shape and otherwise shows the authored placeholder.

## Consequences

- A reply the machine admits is delivered on the first judge reply even where the probe could not read the machine.
- Where the probe reveals nothing, a reply the machine refuses reaches the machine's own malformed-output arm without a correction, as the forced string did before.
- Every built-in's semantic fields reveal string shapes, so the built-ins keep their contract.
- An artifact whose registry module bundles an earlier engine keeps that engine's rule until it is rebuilt.
