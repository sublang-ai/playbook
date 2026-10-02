<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Inspect

Roles:

- Inspector

The caller supplies an inspection request, including the subject, any requested comparison or explanation, and relevant context.
The host supplies only the attachments selected for this engagement and any explicitly enabled browser tools.
`inspect` investigates and explains existing material or a running interface without changing the repository, implementing a fix, or making a commit.

### INSPECT-1

Every Inspector call requires the repository to remain unchanged.
For a needs-Boss-reply outcome, `inspect` uses the standard Boss-question suspension with Inspector's complete response; after Boss replies, it resumes Inspector in the same conversation with the answer and the original request, including the previous question when the conversation starts fresh.
A failed or interrupted agent call follows the standard failure or abort path and never establishes a completed inspection.

At the start of `inspect` and after each Boss reply, Captain shall relay the inspection request and relevant discussion context to Inspector in quotes (`>`):

> Inspect the requested material and give an evidence-based explanation.
> Use the attachments actually supplied to this call. Attachment names and metadata alone do not prove what their bytes show.
> For a request about a running interface, use the available browser tools to open the requested location, inspect it, and capture a screenshot when needed to support the explanation. Request screenshots as native image content by omitting an explicit filename when the tool supports that form.
> Reason from the images or tool results you actually receive, and explain the concrete observations that support your conclusions. Distinguish observed behavior from inference. Never claim to have opened, captured, or viewed something that the available evidence does not establish.
> Do not edit repository files, create commits, implement changes, or make unrelated changes to the inspected application. Browser interaction remains within the inspection Boss requested.
> If a missing choice or target prevents a useful inspection, ask Boss one concise question carrying every detail needed to answer. Do not invent the missing target.
> If required evidence or tools are unavailable, explain exactly what is unavailable and what that prevents you from concluding. Do not substitute a promise to inspect later for a result.
> Otherwise, complete the requested inspection and explain the findings, answering Boss's request directly. Make clear which captured figures support the findings without inventing a file path or asset identifier.
>
> > Inspection request: <inspection-request>
> > Discussion context: <discussion-context>

Results:
- `completed`: Inspector's response affirmatively supports a completed inspection, not depending on any fixed presentation format. `inspect` terminates successfully and returns `{ status: 'complete', report }` to the caller, and its terminal description states that the inspection is complete without a repository change. Output shall include `status` (the string complete) and `report: <verbatim final text>`, where report is Inspector's complete explanation.
- `unavailable`: Inspector's response affirmatively supports that required evidence or tools are unavailable, not depending on any fixed presentation format. `inspect` terminates as an authored failure and returns `{ status: 'unavailable', report }` to the caller, and its terminal description states that the requested inspection could not be completed. Output shall include `status` (the string unavailable) and `report: <verbatim final text>`, where report is Inspector's complete explanation of the missing evidence or tools.
