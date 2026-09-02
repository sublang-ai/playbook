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

## Roles

Roles name playbook-local delegated work functions.

Two fixed actors remain outside the role list:

- Boss: the human user
- Captain: the coordinating agent

Source may declare delegated roles in an opening `Roles:` section.
Each role shall be unique and shall not alias another role; concrete player selection and sharing belong to explicit host configuration.
Role names shall also be unique after canonical lowercase-id derivation, so declarations such as `Coder` and `coder` reject rather than collapse to one manifest role.
E.g.:

- Coder
- Reviewer

Capitalize English role names (e.g., `Writer`); quote non-English names (e.g., `作者`) when needed to distinguish from prose.

## Behaviors

Each spec item names a condition, one behavior kind, and the complete prompt
for that behavior.
Every emitted item shall use the exact Markdown heading form `### <ITEM-ID>`.
An item heading at `##`, `####`, or another level is not GEARS item syntax and
will not be visible to downstream compilers or verification.
The behavior kind shall be one of:

- direct Captain work, written `Captain shall <behavior>:` without naming a
  delegated role;
- delegated-role work, written `Captain shall prompt <Role>:` or the
  existing `Captain shall relay ... to <Role> ...:` form; or
- a literal or dynamic nested playbook call as defined below.

Direct Captain work means the coordinating Captain performs the behavior
itself. It shall not be rewritten as `Captain shall prompt Captain`, because
Captain is a distinct runtime actor rather than a role binding.
Delegated work shall name the declared role that receives the prompt.
Prompts shall be blockquoted, one point per line.
When Source already supplies the complete blockquoted acting prompt for a
behavior, text2gears shall preserve those prompt lines exactly (apart from the
documented Markdown unescaping) and shall not promote surrounding conditions,
invariants, result fields, or continuation mechanics into that blockquote.
Those requirements remain in the item's condition or `Results:` metadata.
Adding control-oriented prompt lines merely to restate them changes the
Boss-visible contract and is nonconformant.

### Authored prompt fragments

Source may compose one acting prompt from authored Markdown instruction blocks and runtime context that it explicitly says to relay in quotes (`>`).
A fenced `markdown` block introduced as an instruction or prompt is an authored static prompt fragment: its fence delimiters are Source syntax, while every interior line and blank line is prompt content preserved after documented Markdown unescaping.

An instruction fence and a relayed-context fragment that apply to one behavior shall appear in the target blockquote in their Source order.
Distinct non-empty fragments shall be separated by one blank prompt line unless Source explicitly supplies a different boundary.
text2gears shall not move a shared instruction ahead of behavior-specific context, move quoted evidence after an instruction that Source says follows the evidence, or otherwise regroup fragments for convenience.

Where Source says that a runtime value is relayed in quotes, the leading `>` is prompt content rather than Source-only blockquote syntax.
If Source supplies a blockquoted template for that relay, text2gears shall keep one literal leading `>` on every quoted line; the target GEARS line therefore uses its outer blockquote marker followed by the literal marker, such as `> > Coder output: <coder-output>`.
If Source names the relayed value but supplies no template, text2gears shall emit its canonical typed placeholder on a line beginning with literal `> ` and shall not summarize, paraphrase, or invent a value in its place.
An ordinary Source blockquote that specifies a complete acting prompt without requiring quoted relay retains the existing rule above: its one leading marker is Source syntax and is not prompt content.

An acting prompt whose instructions refer to a runtime value the acting role cannot otherwise observe — for example the Boss input task that triggered the workflow — shall relay that value as a quoted `<placeholder>` line appended to the prompt even when Source states no explicit relay.
A prompt that references an undelivered value asks its player to act on data it never received; omitting the relay is a compilation defect, not a faithful rendering of Source.

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

### Result contracts

When Source gives an acting behavior more than one possible outcome,
text2gears shall emit its machine-facing result contract immediately after the
complete blockquote, outside the acting prompt, in this exact form:

```markdown
Results:
- `question`: Captain asked one material question. Output shall include `question: <verbatim final text>`.
- `delegation`: Captain selected a call. Output shall include `remainingPlan: <JSON-safe array>`, `nextPlaybookId: <stable id>`, and `nextPlaybookInput: <complete request>`.
```

`Results:` shall be a plain label rather than a heading.
Every result shall occupy one bullet with exactly a backtick-delimited guard
name, a colon, and a non-empty description.
The guard name shall match the ASCII identifier pattern
`[A-Za-z_$][A-Za-z0-9_$]*`.
The bullet order is authoritative, guard names are unique within the item, and
the description shall name every required output property with its exact
case-sensitive identifier.

A produced value consumed later shall have a declared producer: where any
later item's blockquote reads a value through a `<placeholder>`, the item
whose behavior produces that value shall declare the `Results:` contract
whose relevant description names the produced output property, using the
placeholder's exact identifier — this is what lets the FSM thread the value
through typed context.
A single-outcome producer then declares exactly one bullet naming the
property; this consumed-output case is the sole one in which a
single-outcome behavior carries a `Results:` label.

Where a later prompt relays a delegated player's whole final response as quoted context, the producer shall declare that property in the exact annotated form `` `<field>: <verbatim final text>` ``.
The annotation makes the field runtime-owned: the adjudicator selects the result guard, while the linked runtime carries the player's canonical final text into that field instead of asking a judge to reproduce it.
A distinct typed field extracted from that response remains judge-authored even when a later prompt quotes its exact value; quoting a field does not turn it into the player's whole final response.
One property name shall not be annotated as verbatim in one result contract and judge-authored in another; text2gears shall choose distinct properties or report that the Source cannot be represented by the current contract.

Result metadata is compiler control data, not part of the acting agent's
prompt.
text2gears shall not put guard names, result-property schema, JSON control
instructions, or adjudicator instructions inside the blockquote unless Source
explicitly requires the acting agent to show that machine syntax to the user.
It shall move Source's outcome contract into `Results:` while preserving the
human domain instructions in the blockquote.
It shall not emit the framework-owned `needsBossReply` result; gears2fsm adds
that universal result for every Captain- or player-invoking state.

Where Source restricts an initial Captain to routing, text2gears shall preserve
only the authored question and delegation outcomes and shall not infer a
direct-answer or terminal result merely because Captain is the acting agent.

A single-outcome behavior whose output no later item consumes carries no
`Results:` label; downstream,
[gears2fsm](gears2fsm.md#setup) gives its state the default single-outcome
contract, so text2gears shall not invent a one-bullet `Results:` block for it.
When a later item does consume its output, the produced-value rule above
applies instead.

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

The same consolidation applies when Source says a fresh directive interrupts
parked work and *restarts the same behavior* with cleared context. When the
acting prompt and result contract are identical, retain the interrupt as an
entry condition on the originating item; do not duplicate that item solely to
describe the restart. Split only when the fresh directive invokes genuinely
different acting work or a different prompt/result contract.

### Parallel behaviors

Where two or more delegated-player items share one trigger and Source requires
them to run independently before later work uses all results, text2gears shall
place `Parallel group: <stable-kebab-case-id>` immediately below each item
heading.
Every item in one parallel group shall receive the same completed-prior-group
inputs; no item prompt may depend on another member's result from the current
group.
Every member shall delegate to a distinct named role; a group that repeats one canonical role is malformed because one role resolves to one player.
Direct-Captain work shares one
Captain session and nested calls share one pending-child stack slot, so neither
kind may receive parallel-group metadata.
If Source explicitly requires either
unsupported kind to run concurrently, text2gears shall report that the source
cannot be represented rather than silently serialize it or emit metadata the
next phase cannot compile.

Example:

```markdown
### DECIDE-1

Parallel group: initial-proposals

When Boss gives a topic, Captain shall prompt Coder:

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

### Script behaviors (optimizer-introduced)

A GEARS package may also contain deterministic script behaviors, written
`Captain shall run:` followed by a blockquote whose lines are the exact POSIX
shell script to execute.
text2gears shall never emit this kind: script items enter a GEARS package only
through the separate [optimize](optimize.md) pass, which rewrites eligible
compiled items.
The kind is defined here so every consumer of the GEARS format shares one
item-syntax contract.

A script item's blockquote is static shell text: it shall contain no
`<placeholder>`, and Markdown escapes resolve exactly as in acting prompts.
A script item shall carry a `Results:` label with exactly two bullets in this
fixed interpretation: the first guard reports the script exiting with status
zero, the second reports a nonzero exit status.
No other result, and no `needsBossReply`, applies to a script item — a script
has no agent to surface questions.

Example:

```markdown
### CODE-1

When the workflow starts, Captain shall run:

> git rev-parse --is-inside-work-tree 2>/dev/null || git init

Results:
- `ok`: The command exited with status zero.
- `failed`: The command exited with a nonzero status.
```

Target shall be written in the same language as Source: an item's condition
prose, acting prompts, and result descriptions follow the Source language,
read per the matching localization of the GEARS definition [[1]].
The four `Captain shall` acting-clause forms defined above (direct,
delegated, nested playbook call, and script), guard names, and the
`Roles:` and `Results:` labels are fixed machine syntax and stay in this
exact English form regardless of Source language.

## Transformation-spec sources

A Source may itself be the normative specification of a transformation — e.g., a compiler phase definition, as when a meta pipeline compiles this file.
Such a Source declares no roles and prompts none; Captain performs the specified transformation on request.
Where such a Source carries a `## Compiled execution` section, text2gears shall compile it from that section alone: the section is the Source's complete behavior — its acting item, prompt, and `Results:` contract — and the remaining definition text is relayed content, not behaviors to transcribe, so the composition below applies only to a Source without that section.
Compose Captain-acting spec items for it: when a transformation request names the specification's source and target, Captain shall carry out the transformation as specified.
Prompts shall carry the specification's normative requirements as instructions to Captain — deduplicated, one point per line — without inventing roles, triggers, or requirements the specification does not state.

## Composition

Source snippets may overlap or duplicate.
When composing them into a spec item, text2gears shall deduplicate identical prompt lines.
It shall not deduplicate across distinct authored fragments when doing so would erase a fragment boundary or change the Source-ordered prompt.

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

## Compiled execution

This section governs compiled execution of this phase; the rules above remain the transformation's normative content for both execution paths.

Where the phase host supplies `<definition>` as the exact bytes of the definition file the request names, when a transformation request names a `text` Source (`.md`) and a `gears` Target (`.md`), Captain shall carry out the text-to-GEARS transformation as specified:

> Follow the definition relayed between the `--- DEFINITION ---` and `--- END DEFINITION ---` lines exactly, adding no rules of your own: read the named Source and write the named Target as the definition specifies.
> If the Source cannot be transformed under the definition, do not guess: leave the Target unwritten and report the concrete reason.
> --- DEFINITION ---
> \<definition\>
> --- END DEFINITION ---

Results:
- `compiled`: Captain wrote the named Target as the relayed definition specifies.
- `rejected`: Captain reported that the Source cannot be transformed under the relayed definition and left the Target unwritten.

## References

[1]: GEARS definition shipped by the installed `@sublang/spex` package: `@sublang/spex/scaffold/specs/meta.md` (English) and `@sublang/spex/scaffold/i18n/zh/specs/meta.md` (Chinese); canonical renditions [GEARS: AI-Ready Spec Syntax](https://sublang.ai/ref/gears-ai-ready-spec-syntax) (en) and [GEARS：面向 AI 的规约语法](https://sublang.ai/zh/ref/gears-ai-ready-spec-syntax) (zh)
