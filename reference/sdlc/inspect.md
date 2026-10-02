<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Inspect

Roles:

- Inspector

The caller supplies an inspection request, including the subject, any requested comparison or explanation, and relevant context.
The host supplies only the attachments selected for this engagement and any explicitly enabled browser tools.
`inspect` investigates and explains existing material or a running interface without changing the repository, implementing a fix, or making a commit.

At the start of `inspect` and after each Boss reply, Captain shall relay the inspection request and relevant discussion context to Inspector in quotes (`>`), along with the following instruction:

> Inspection request: <inspection-request>
> Discussion context: <discussion-context>

```markdown
Inspect the requested material and give an evidence-based explanation.
Use the attachments actually supplied to this call. Attachment names and metadata alone do not prove what their bytes show.
For a request about a running interface, use the available browser tools to open the requested location, inspect it, and capture a screenshot when needed to support the explanation. Request screenshots as native image content by omitting an explicit filename when the tool supports that form.
Reason from the images or tool results you actually receive, and explain the concrete observations that support your conclusions. Distinguish observed behavior from inference. Never claim to have opened, captured, or viewed something that the available evidence does not establish.
Do not edit repository files, create commits, implement changes, or make unrelated changes to the inspected application. Browser interaction remains within the inspection Boss requested.
If a missing choice or target prevents a useful inspection, ask Boss one concise question carrying every detail needed to answer. Do not invent the missing target.
If required evidence or tools are unavailable, explain exactly what is unavailable and what that prevents you from concluding. Do not substitute a promise to inspect later for a result.
Otherwise, complete the requested inspection and explain the findings, answering Boss's request directly. Make clear which captured figures support the findings without inventing a file path or asset identifier.
```

The inspection has three semantic outcomes: needs Boss reply, completed, and unavailable.
Each outcome requires affirmative support in Inspector's response; no outcome depends on a fixed presentation format.
Every Inspector call requires the repository to remain unchanged.

For needs Boss reply, `inspect` shall use the standard Boss-question suspension with Inspector's complete response.
After Boss replies, it shall resume Inspector in the same conversation with the answer and original request; include the previous question when the conversation starts fresh.

For completed, `inspect` shall terminate successfully with `{ status: 'complete', report }`, where `report` is Inspector's complete explanation, and its terminal description shall state that the inspection is complete without a repository change.

For unavailable, `inspect` shall terminate as an authored failure with `{ status: 'unavailable', report }`, where `report` is Inspector's complete explanation of the missing evidence or tools, and its terminal description shall state that the requested inspection could not be completed.
A failed or interrupted agent call follows the standard failure or abort path and never establishes completed inspection.
