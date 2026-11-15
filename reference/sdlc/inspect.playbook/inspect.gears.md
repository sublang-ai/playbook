<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# inspect: Inspect

## Intent

`inspect` has Inspector investigate and explain existing material or a running interface, and ends when the inspection is complete or Inspector reports that required evidence or tools are unavailable.

Roles:

- Inspector

## External Behavior

### inspect-2

When a caller starts `inspect`, the caller shall supply an inspection request holding:

- the subject;
- any requested comparison or explanation;
- relevant context.

### inspect-3

The host shall supply only the attachments selected for this engagement and any explicitly enabled browser tools.

### inspect-4

When Inspector's response affirmatively supports a completed inspection [[inspect-1](#inspect-1)], `inspect` shall terminate successfully with:

- `{ status: 'complete', report }`, where `report` is Inspector's complete explanation;
- a terminal description stating that the inspection is complete without a repository change.

### inspect-5

When Inspector's response affirmatively supports that required evidence or tools are unavailable [[inspect-1](#inspect-1)], `inspect` shall terminate as an authored failure with:

- `{ status: 'unavailable', report }`, where `report` is Inspector's complete explanation of the missing evidence or tools;
- a terminal description stating that the requested inspection could not be completed.

### inspect-6

When an agent call fails or is interrupted [[inspect-1](#inspect-1)], `inspect` shall follow the standard failure or abort path and never establish a completed inspection.

### inspect-7

`inspect` shall require the repository to remain unchanged across every Inspector call [[inspect-1](#inspect-1)].

### inspect-16

`inspect` shall implement no fix and make no commit.

### inspect-8

When Inspector's response needs a Boss reply [[inspect-1](#inspect-1)], `inspect` shall use the standard Boss-question suspension with Inspector's complete response.

## Internal Behavior

### inspect-1

When the caller starts `inspect` [[inspect-2](#inspect-2)] or Boss replies to Inspector's question [[inspect-8](#inspect-8)], Captain shall relay the inspection request and relevant discussion context to Inspector in quotes (`>`):

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

### inspect-9

When Boss replies to Inspector's question [[inspect-8](#inspect-8)], `inspect` shall resume Inspector [[inspect-1](#inspect-1)] in the same conversation with:

- the answer and the original request;
- the previous question as well, when the conversation starts fresh.

### inspect-10

`inspect` shall select an outcome [[inspect-4](#inspect-4)] [[inspect-5](#inspect-5)] [[inspect-8](#inspect-8)] only on affirmative support in Inspector's response [[inspect-1](#inspect-1)], depending on no fixed presentation format.

## Verification

### inspect-11

When Inspector completes the requested inspection, an `inspect` run shall:

- prompt Inspector once, relaying the inspection request and discussion context in quotes [[inspect-1](#inspect-1)] [[inspect-2](#inspect-2)];
- make that call with only the attachments the host selected for this engagement and the browser tools it explicitly enabled [[inspect-3](#inspect-3)];
- terminate successfully, its terminal description stating that the inspection is complete without a repository change, and return `{ status: 'complete', report }` with Inspector's complete explanation as `report` [[inspect-4](#inspect-4)];
- leave the repository unchanged [[inspect-7](#inspect-7)];
- implement no fix and make no commit [[inspect-16](#inspect-16)].

### inspect-12

When Inspector reports that required evidence or tools are unavailable, an `inspect` run shall:

- terminate as an authored failure, its terminal description stating that the requested inspection could not be completed [[inspect-5](#inspect-5)];
- return `{ status: 'unavailable', report }` with Inspector's complete explanation of the missing evidence or tools as `report` [[inspect-5](#inspect-5)].

### inspect-13

While Inspector has asked Boss for a missing target, when Boss replies, an `inspect` run shall:

- have suspended on the standard Boss question, carrying Inspector's complete response [[inspect-8](#inspect-8)];
- prompt Inspector again in the same conversation with the answer and the original request, adding the previous question when the conversation starts fresh [[inspect-1](#inspect-1)] [[inspect-9](#inspect-9)];
- leave the repository unchanged across both Inspector calls [[inspect-7](#inspect-7)].

### inspect-14

An `inspect` run shall establish no completed inspection from:

- an agent call that fails or is interrupted, the run taking the standard failure or abort path [[inspect-6](#inspect-6)];
- an Inspector call that changes the repository [[inspect-7](#inspect-7)].

### inspect-15

An `inspect` run shall select its outcome on affirmative support in Inspector's response alone [[inspect-10](#inspect-10)]:

- a response that affirmatively supports no outcome completes no inspection, reports nothing unavailable and puts no question to Boss;
- the same response in a different presentation format yields the same outcome.
