<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Text-to-GEARS Transformation

This is the first phase in defining a playbook — a state-machine-powered AI agent that coordinates multiple AI agents to carry out a defined procedure.
This phase transforms user input into normative spec items.

- Source: the user's description of the procedure in free-form natural language.
- Target: a package of spec items in the GEARS format [[1]] that define the procedure.

The second phase transforms spec items into state machines, which is outside the scope of this transformation.

## Formats

| Role | Format | Extension |
| --- | --- | --- |
| source | text | .md |
| target | gears | .md |

## Roles

Both Source and Target use role names to refer to AI agents and the user.

The playbook has two default roles:

- Boss: the human user who provides input
- Captain: the coordinating agent that drives the procedure

Source may define additional roles in an opening `## Roles` section.
A role may be declared as an alias of other roles using `=` and `|`; at runtime, Boss picks one of the listed roles to play it.
E.g.:

- Coder
- Reviewer
- Committer = Coder | Reviewer

The playbook runtime maps these roles to AI agents and invokes them.

For accurate mapping, capitalize English role names (e.g., `Writer`).
In other languages, quote role names such as `作者` if necessary to
distinguish them from ordinary text.

## Behaviors

Target specifies state-machine behaviors including which prompt to give to which role under which conditions.
All prompts shall be blockquoted.
A prompt consists of concise, clearly organized points, one per line.

E.g.:

```markdown
### CODE-10

When Reviewer is about to review any change, Captain shall prompt Reviewer:
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> If the change is ready to commit or push, don't raise nitpicks.
```

Target should be written in the same language as Source.

## Abstraction

Prompt lines may duplicate across spec items.

If duplicate prompt lines share a common condition and identical roles, they may be abstracted into an independent spec item, and they do not need to be restated or cited by other spec items.
This improves maintainability.

E.g., the prompt lines in `CODE-10` above may apply when reviewing a commit or unstaged changes, or as part of a longer prompt, so they are abstracted under the shared condition "when Reviewer is about to review any change".

## References

[1]: [GEARS syntax](/specs/meta.md#item-syntax)
