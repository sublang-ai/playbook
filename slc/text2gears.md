<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Text-to-GEARS Transformation

First phase of a playbook (a state-machine agent orchestrating other agents).
Transforms a user's procedure description into normative GEARS [[1]] spec items.

- Source: free-form natural-language description.
- Target: a package of GEARS spec items.

The second phase (spec items → state machine) is out of scope.

## Formats

| Role | Format | Extension |
| --- | --- | --- |
| source | text | .md |
| target | gears | .md |

## Players

Players name AI agents and the user.

Two default players:

- Boss: the human user
- Captain: the coordinating agent

Source may declare additional players in an opening `Players:` section.
A player may alias other players with `=` and `|`; Boss picks one at runtime.
E.g.:

- Coder
- Reviewer
- Committer = Coder | Reviewer

Capitalize English player names (e.g., `Writer`); quote non-English names (e.g., `作者`) when needed to distinguish from prose.

## Behaviors

Each spec item names a condition, the player to prompt, and the prompt itself.
Prompts shall be blockquoted, one point per line.

E.g.:

```markdown
### CODE-10

When Reviewer is about to review any change, Captain shall prompt Reviewer:
> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> If the change is ready to commit or push, don't raise nitpicks.
```

Target should be written in the same language as Source.

### Resumable Boss replies

A source behavior may opt in to Boss-reply suspension by placing this standalone annotation after the behavior's prompt block:

```markdown
Resumable: Boss reply
```

The annotation is per behavior, non-inheriting, and not prompt text.
It means the prompted player may surface a specific question that Boss must answer before the same state can continue.
It does not apply to nearby behaviors unless they carry their own annotation.

When `text2gears` emits a GEARS item for an annotated behavior, the item's blockquote shall contain only the domain prompt lines from source.
The compiler shall not add the standard Boss-question instruction to the blockquote.
Instead, it shall carry the opt-in as result metadata:

```markdown
Result guard: `needsBossReply` — The player's prose surfaces a clarifying question for Boss that the player cannot answer alone. Output shall include `question: <verbatim question text from the player's prose>`.
```

This metadata is consumed by [gears2fsm](gears2fsm.md#boss-reply-suspension).
The player-visible instruction that tells the player how to ask is supplied later by [link](link.md#player-prompt-composition), outside the domain prompt body.

## Composition

Source snippets may overlap or duplicate.
When composing them into a spec item, text2gears shall deduplicate identical prompt lines.

Each spec item addresses one state behavior and carries its full final prompt (the static part).
Cross-item duplication is acceptable: spec items are compiled artifacts; Source is what users maintain.

Test: a human shall be able to simulate a run by copying any single item's prompt verbatim — no cross-item composition needed.

### Placeholders vs literals

Use `<placeholder>` for dynamic values in blockquoted prompts.
Everything else inside a blockquote is static text, not an example; examples belong in surrounding prose.

### Split by content discriminator

Partition items by every variable that determines prompt content — including accumulated state when the trigger alone doesn't.

### Prune dead disjuncts

Drop disjunctive branches incompatible with the rest of an item's condition or prompt.
Dead branches mislead readers and downstream phases.

## References

[1]: [GEARS syntax](/specs/meta.md#item-syntax)
