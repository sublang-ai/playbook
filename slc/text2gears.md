<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Text-to-GEARS Transformation

First phase of a playbook (a state-machine agent orchestrating other agents).
Transforms a user's procedure description into normative GEARS [[1]] spec items.

- Source: free-form natural-language description.
- Target: a package of GEARS spec items.

The second phase (spec items → state machine) is out of scope.

## Formats

| Role   | Format | Extension |
| ------ | ------ | --------- |
| source | text   | .md       |
| target | gears  | .md       |

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

Each spec item names a condition, one behavior kind, and the complete prompt
for that behavior.
The behavior kind shall be one of:

- direct Captain work, written `Captain shall <behavior>:` without naming a
  delegated player;
- delegated player work, written `Captain shall prompt <Player>:` or the
  existing `Captain shall relay ... to <Player> ...:` form; or
- a literal or dynamic nested playbook call as defined below.

Direct Captain work means the coordinating Captain performs the behavior
itself. It shall not be rewritten as `Captain shall prompt Captain`, because
Captain is a distinct runtime actor rather than a player binding.
Delegated work shall name the declared player that receives the prompt.
Prompts shall be blockquoted, one point per line.

Source statements that assign active-leaf routing, call identity, suspension,
or return matching to the host describe execution preconditions rather than
behaviors for Captain to perform. text2gears shall use such a statement only as
a condition on an actual behavior when needed and shall not emit a standalone
direct-Captain item that asks Captain to implement host stack bookkeeping.
The same applies to a host-owned input catalog's immutability: retain it as a
condition/invariant on the behaviors that consume the catalog, never as an LLM
action that can replace or mutate host configuration.
Opening source invariants consumed by later behaviors shall remain explicit in
the emitted conditions or prompts rather than being summarized away. In
particular, preserve the declared exact entry shape of a structured host
catalog and any progress invariant that makes a decide-call-observe plan
finite, such as `remainingPlan` containing only calls after the selected call
and strictly shrinking on continuation.
Likewise, a source invariant that restricts a nested-call target to a
non-empty member of an input catalog is a condition on that call item, not a
separate Captain rejection behavior, unless Source requires an observable
response distinct from taking or skipping the call.

E.g.:

```markdown
### CODE-10

When Reviewer is about to review any change, Captain shall prompt Reviewer:

> Flag any issues or improvements (numbered; no duplication).
> Think thoroughly — don't just approve or reject.
> If the change is ready to commit or push, don't raise nitpicks.
> Do not edit files or commit; report findings only.
```

Direct Captain example:

```markdown
### ROUTE-1

When Boss gives an intent, Captain shall decide how to handle it:

> Preserve Boss's intended outcome and constraints.
> Ask one question only when its answer would materially change routing.
```

### Boss-reply continuation

Where a direct-Captain or delegated-player behavior may ask Boss a question
and wait, Boss's answer resumes that same behavior with continuation context;
it is not a distinct behavior item. text2gears shall keep the question result,
the wait, and the answer-dependent continuation on the originating item even
when the answer changes its complete runtime prompt. It shall not emit a
second item solely for "Boss answers," "after the question," or clearing the
consumed question/reply. The FSM and linker own the same-leaf suspension,
continuation blocks, and consumed-context cleanup.

This rule is an exception to splitting by accumulated prompt content below.
Split only when Source requires a genuinely different acting behavior after
the reply, not when the same decision or task continues with Boss's answer.

### Parallel behaviors

Where two or more delegated-player items share one trigger and Source requires
them to run independently before later work uses all results, text2gears shall
place `Parallel group: <stable-kebab-case-id>` immediately below each item
heading.
Every item in one parallel group shall receive the same completed-prior-group
inputs; no item prompt may depend on another member's result from the current
group.
Every member shall delegate to a named player, and the source shall permit
those members to resolve to distinct players. Direct-Captain work shares one
Captain session and nested calls share one pending-child stack slot, so neither
kind may receive parallel-group metadata. If Source explicitly requires either
unsupported kind to run concurrently, text2gears shall report that the source
cannot be represented rather than silently serialize it or emit metadata the
next phase cannot compile.

Example:

```markdown
### DISCUSS-1

Parallel group: initial-proposals

When Boss gives a topic, Captain shall prompt Host:

> Propose your design independently.
```

### Nested playbook calls

Where Source requires one playbook to call a statically known playbook,
text2gears shall emit an item whose behavior uses
`Captain shall call playbook <playbook-id>:` and whose blockquote is the
complete JSON-safe input-text template for that call.
The literal target id shall be a stable configured playbook id, not a slash
command or module specifier.

Example:

```markdown
### RELEASE-8

When implementation is ready for review, Captain shall call playbook `code-review`:

> Review these changes:
> <changes>
```

Where Source selects the target at runtime, text2gears shall instead emit the
first-class dynamic form
``Captain shall call playbook selected by `<playbook-id-context>`:``.
The backtick-delimited name identifies a typed FSM context field whose runtime
value is the target playbook id; it is not itself a target id.
The blockquote shall be exactly one placeholder naming the typed context field
whose runtime string is the complete child input text.

Example:

```markdown
### CAPTAIN-2

When Captain selects a next call, Captain shall call playbook selected by `nextPlaybookId`:

> <nextPlaybookInput>
```

Here `nextPlaybookId` and `nextPlaybookInput` are stable context-field names.
The dynamic form shall not use a slash command, module specifier, opaque
expression, or prose from which a downstream compiler would have to infer
either field.

Target should be written in the same language as Source.

## Transformation-spec sources

A Source may itself be the normative specification of a transformation — e.g., a compiler phase definition, as when a meta pipeline compiles this file.
Such a Source declares no players and prompts none; its implied procedure is that Captain performs the specified transformation on request.
Compose Captain-acting spec items for it: when a transformation request names the specification's source and target, Captain shall carry out the transformation as specified.
Prompts shall carry the specification's normative requirements as instructions to Captain — deduplicated, one point per line — without inventing players, triggers, or requirements the specification does not state.

## Composition

Source snippets may overlap or duplicate.
When composing them into a spec item, text2gears shall deduplicate identical prompt lines.

Each spec item addresses one state behavior and carries its full final prompt (the static part).
Cross-item duplication is acceptable: spec items are compiled artifacts; Source is what users maintain.

Test: a human shall be able to simulate a run by copying any single item's prompt verbatim — no cross-item composition needed.

### Placeholders vs literals

Use `<placeholder>` for dynamic values in blockquoted prompts.
Everything else inside a blockquote is static text, not an example; examples belong in surrounding prose.

Markdown escaping is Source syntax, not content: extraction shall resolve escapes (e.g. `\<placeholder\>` becomes `<placeholder>`), so compiled artifacts carry plain text.

### Split by content discriminator

Partition items by every variable that determines prompt content — including accumulated state when the trigger alone doesn't.

### Prune dead disjuncts

Drop disjunctive branches incompatible with the rest of an item's condition or prompt.
Dead branches mislead readers and downstream phases.

## References

[1]: [GEARS syntax](/specs/meta.md#item-syntax)
