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

## Players

Both Source and Target use player names to refer to AI agents and the user.

The playbook has two default players:

- Boss: the human user who provides input
- Captain: the coordinating agent that drives the procedure

Source may define additional players in an opening `Players:` section.
A player may be declared as an alias of other players using `=` and `|`; at runtime, Boss picks one of the listed players to play it.
E.g.:

- Coder
- Reviewer
- Committer = Coder | Reviewer

The playbook runtime maps these players to AI agents and invokes them.

For accurate mapping, capitalize English player names (e.g., `Writer`).
In other languages, quote player names such as `作者` if necessary to
distinguish them from ordinary text.

## Behaviors

Target specifies state-machine behaviors including which prompt to give to which player under which conditions.
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

## Composition

Source may contain individual prompt snippets with overlapping or duplicate content.
text2gears composes these snippets into Target spec items without any concern about duplication.

Each spec item shall address one well-defined state behavior and carry the full final prompt (the static part) for that state.
Duplicate prompt lines across items are acceptable: Source is what users maintain; spec items are compiled artifacts that can be regenerated anytime.

Test: a human shall be able to simulate an agent run by reading individual spec items and copying their full prompts verbatim, without manually composing prompts across items.

## References

[1]: [GEARS syntax](/specs/meta.md#item-syntax)
