<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# BRANCH: Pull-Request Branch Preparation Workflow

Roles:

- Coder

The caller supplies a development request that names a GitHub issue (number or URL) or, when no issue is named, describes the work, together with any relevant context.

`branch` prepares pull-request delivery of one development request: it creates and checks out a new branch at the current commit.
It changes no files and owns no repository commit.
Captain takes the base revision from repository authority, not from Coder's prose: the `unchanged` repository-effect receipt of the branching call proves the observed HEAD the branch was created from.

## Coder

### BRANCH-1

When the caller gives the request, Captain shall relay the complete caller input in quotes (`>`) to Coder, along with the branching instruction:

> > Original request: <caller-input>
>
> Prepare a new branch for this work without changing any file or making any commit.
> Identify the GitHub issue the request names, if any, and read it with its comments (`gh issue view --comments` with the issue number).
> If the request could refer to more than one issue, or does not say which work to branch for, ask Boss before creating anything.
> Confirm that the working tree is clean and that `gh` is authenticated for the repository's GitHub remote.
> Name the branch `issue-N-short-kebab-slug` for issue number N, otherwise a short kebab-case slug of the request.
> Create the branch from the current commit and check it out; do not pull, reset, stash, or move HEAD to another commit.
> Report the exact branch name, the commit it was created from, and a concise summary of the issue and its comments, or of the request when no issue is named.
> If the working tree is not clean, `gh` is not authenticated, the named issue does not exist or cannot be read, or a branch with that name already exists locally or on the remote, create nothing and report the failure with its reason.

Results:
- `branched`: Coder created the new branch from the current commit and checked it out, reporting its exact name and a concise summary of the issue and its comments, or of the request when no issue is named; the absence of a reported obstacle is not support. Output shall include `branch: <exact branch name>`, `baseRevision: <repository revision>`, and `issueSummary: <concise summary>`.
- `refused`: Coder created nothing and reported the failure with its reason: the working tree is not clean, `gh` is not authenticated, the named issue does not exist or cannot be read, or a branch with that name already exists locally or on the remote. Output shall include `coderOutput: <verbatim final text>`.

Workflow outcomes:
- The result has two semantic outcomes: branched and refused, plus the Boss question when the request is ambiguous about the issue or work it means.
- Each outcome requires affirmative support in Coder's result; the absence of a reported obstacle is not support for branched, and no outcome depends on a fixed presentation format of Coder's reply.
- Every outcome keeps the repository exact: a new branch at the current commit changes neither HEAD's commit nor the working tree.
- Captain takes the base revision from repository authority, not from Coder's prose.
- The Boss question uses the standard Boss-question suspension with Coder's complete response; after Boss replies, `branch` resumes with the answer in the same Coder conversation, and the previous question is included only when that conversation must start fresh.
- For branched, `branch` is complete and returns the exact branch name, the exact base revision, and the issue summary to its caller.
- For refused, `branch` fails and reports Coder's complete result with its reason to its caller; no branch was created.
