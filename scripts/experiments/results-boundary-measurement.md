<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Results boundary measurement

The Results guidance is retained in `slc/text2gears.md` after one matched DECIDE source-to-GEARS comparison.
The baseline took 129,649 ms and three calls; treatment took 98,559 ms and two calls: 31,090 ms less (23.98%).
Both used the same source, frozen C2 compiler, Opus 5 low settings, interpreted executor, disabled independent Reviewer, and complete input closure; only the 379-byte guidance differed.
Both first corrections still addressed quote and Results placement errors.
Baseline needed one further correction containing only four malformed Results entries; treatment did not.

Independent source review found both final artifacts preserve concurrent independent proposals, the completion barrier and whole-pair restart, full acting prompts, receipt authority, and scoped child success and failure.
The four parsed prompt bodies are byte-identical between the final artifacts, and the actual SLC source/result checks pass.
Coder's first single-outcome proposal lawfully has no Results label because no later placeholder consumes it.
Nested REVIEW also retains its required no-Results continuation prose.

This is a single sequential, baseline-first phase observation, not a randomized estimate, universal speed guarantee, or full-compilation acceptance.
The recorded call elapsed windows overlap adapter cleanup; use phase execution time for the comparison and the separately partitioned dispatch windows for call attribution.
All attempts remain identified in [the sanitized evidence](results-boundary-evidence.json), with original task-specific trace hashes and private visible write/edit projections.
Those projections retain only current numbered findings from each correction request and visible tool inputs, excluding model reasoning.
The frozen pair and original run files remain unchanged.

Reproduction inputs and instructions remain under `/private/tmp/slc-results-boundary-experiment`; original measurements are `/private/tmp/slc-results-boundary-evidence/phase-HzK0ck` and `/private/tmp/slc-results-boundary-evidence/phase-bhO9RV`.
Local recapture and final parser checks are `/private/tmp/slc-results-boundary-adjudication/capture.py` and `check-finals.mjs`.
New link and FSM-scaffold comparison arms must include the retained Results guidance in common, preserving their own single-variable comparisons.
