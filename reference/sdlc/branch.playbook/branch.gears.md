<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# branch: Branch

## Intent

`branch` prepares pull-request delivery of one development request by having Coder create and check out a new branch at the current commit, and ends when the branch exists or Coder reports why none was created.

Roles:

- Coder

## External Behavior

### branch-2

When a caller starts `branch`, the caller shall supply:

- a development request that names a GitHub issue (number or URL) or, when no issue is named, describes the work;
- any relevant context.

### branch-3

When Coder affirmatively reports that it created the new branch from the current commit and checked it out [[branch-1](#branch-1)], `branch` shall complete and return to its caller:

- the exact branch name;
- the exact base revision [[branch-7](#branch-7)];
- the issue summary.

### branch-4

When Coder affirmatively reports that it created no branch and gives the failure with its reason [[branch-1](#branch-1)], `branch` shall fail with no branch created and report Coder's complete result with its reason to its caller.

### branch-5

`branch` shall keep the repository exact in every outcome: a new branch at the current commit changes neither HEAD's commit nor the working tree.

### branch-13

`branch` shall change no files and own no repository commit.

## Internal Behavior

### branch-1

When the caller gives the request [[branch-2](#branch-2)] or Boss answers Coder's question [[branch-6](#branch-6)], Captain shall relay the complete caller input in quotes (`>`) to Coder, along with the following instruction:

> Prepare a new branch for this work without changing any file or making any commit.
> Identify the GitHub issue the request names, if any, and read it with its comments (`gh issue view --comments` with the issue number).
> If the request could refer to more than one issue, or does not say which work to branch for, ask Boss before creating anything.
> Confirm that the working tree is clean and that `gh` is authenticated for the repository's GitHub remote.
> Name the branch `issue-N-short-kebab-slug` for issue number N, otherwise a short kebab-case slug of the request.
> Create the branch from the current commit and check it out; do not pull, reset, stash, or move HEAD to another commit.
> Report the exact branch name, the commit it was created from, and a concise summary of the issue and its comments, or of the request when no issue is named.
> If the working tree is not clean, `gh` is not authenticated, the named issue does not exist or cannot be read, or a branch with that name already exists locally or on the remote, create nothing and report the failure with its reason.
>
> > Original request: <caller-input>

Results:
- `branched`: Coder affirmatively reported that it created the new branch from the current commit and checked it out, with the exact branch name and a concise summary of the issue and its comments, or of the request when no issue is named; the absence of a reported obstacle is not support. The branch workflow is then complete and returns the exact branch name, the exact base revision taken from repository authority, and the issue summary to its caller. Output shall include `branch: <exact branch name>`, `baseRevision: <exact base revision from repository authority, not from Coder's prose>`, and `issueSummary: <concise summary of the issue and its comments, or of the request when no issue is named>`.
- `refused`: Coder affirmatively reported that it created no branch and gave the failure with its reason, such as a working tree that is not clean, gh not being authenticated, a named issue that does not exist or cannot be read, or a branch with that name already existing locally or on the remote. The branch workflow then fails and reports Coder's complete result with its reason to its caller; no branch was created. Output shall include `coderOutput: <verbatim final text>`.

### branch-6

When Boss answers Coder's question about which issue or work the request means, `branch` shall resume the behavior that raised the question [[branch-1](#branch-1)] with that answer.

### branch-7

`branch` shall take the base revision from repository authority, not from Coder's prose.

### branch-8

`branch` shall select an outcome [[branch-3](#branch-3)] [[branch-4](#branch-4)] only on affirmative support in Coder's result [[branch-1](#branch-1)]:

- the absence of a reported obstacle is not support for a created branch;
- no outcome depends on a fixed presentation format of Coder's reply.

## Verification

### branch-9

When Coder affirmatively reports that it created the branch from the current commit and checked it out, a `branch` run shall:

- prompt Coder once, relaying the caller's complete input in quotes [[branch-1](#branch-1)] [[branch-2](#branch-2)];
- return the exact branch name, the exact base revision and the issue summary to the caller [[branch-3](#branch-3)];
- take that base revision from repository authority, whatever revision Coder's reply states [[branch-7](#branch-7)];
- leave HEAD's commit and the working tree as they were [[branch-5](#branch-5)];
- change no files and own no repository commit [[branch-13](#branch-13)].

### branch-10

When Coder affirmatively reports that it created no branch because the working tree is not clean, a `branch` run shall:

- fail with no branch created and report Coder's complete result with its reason to the caller [[branch-4](#branch-4)];
- leave HEAD's commit and the working tree as they were [[branch-5](#branch-5)].

### branch-11

While Coder has asked Boss which issue the request means, when Boss answers, a `branch` run shall prompt Coder again with the same instruction and the caller's complete input [[branch-1](#branch-1)], carrying Boss's answer [[branch-6](#branch-6)].

### branch-12

A `branch` run shall select its outcome on affirmative support in Coder's result alone [[branch-8](#branch-8)]:

- a reply that reports no obstacle without affirming that the branch was created does not complete the run with a branch name;
- the same result in a different presentation format yields the same outcome.
