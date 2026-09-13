<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# compiler-optimization: Environmental Predicate Preservation

## Intent

This package governs exact environmental predicates in the mechanical GEARS optimization defined by [DR-016](../decisions/016-script-actors-and-optimize-pass.md).

## External Behavior

### compiler-optimization-1

When the optimization pass replaces an eligible environmental behavior with a shell script, the pass shall preserve its exact success predicate and effect, including location and scope, rather than accept a weaker predicate or act on a different resource.

### compiler-optimization-2

The shipped optimization definition shall distinguish its repository-setup examples by source intent:

| Source requirement | Required example behavior |
| --- | --- |
| The current directory must be inside a Git working tree, allowing an ancestor repository. | Preserve an already-containing working tree; initialize the current directory when none contains it. |
| The current directory must be the root of its own Git repository, initializing there when `.git` is absent. | Initialize the current directory even when an ancestor contains it, accept an existing root or linked-worktree root, and fail when a present invalid `.git` cannot prove the required root. |

The examples shall use the target GEARS acting syntax: `Captain shall run:`, a blockquote on every script line, and exactly the zero-exit and nonzero-exit `Results:` bullets.

## Verification

### compiler-optimization-3

When the integration suite extracts the two example scripts from their GEARS acting syntax in the shipped definition and executes them with real Git in plain directories, existing roots, subdirectories of ancestor repositories, linked-worktree roots, and an invalid `.git` fixture, it shall verify the respective predicates, required blockquotes and result forms, and resource locations [[compiler-optimization-2](#compiler-optimization-2)] while preserving the existing containing repository and valid root identities [[compiler-optimization-1](#compiler-optimization-1)].
