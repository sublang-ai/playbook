## Optional deterministic materialization

For an ordinary flat workflow using only `player` and `script` actors,
shared default strategies, and primitive configured options, the linker may
use the adjacent `materialize-link.mjs` tool to emit the thin module.
The complete definition below remains binding; the tool replaces repetitive
module generation, not semantic analysis or emitted conformance verification.
Read the actual FSM and supply every erased or authored contract exactly.
Do not use this profile when a custom composer, classifier, required-field
extractor, session-derived input mapping, controller strategy, nested call,
parallel state, or compound state is needed.

Invoke the tool with the actual definition directory, source FSM, and declared
target; supply a JSON descriptor on standard input:

```sh
node "<definition-directory>/materialize-link.mjs" --fsm "<source.fsm.ts>" --out "<target.playbook.ts>" <<'JSON'
{
  "schema": "sublang.playbook.link.v1",
  "profile": "flat-defaults",
  "machineExport": "exampleMachine",
  "label": "EXAMPLE",
  "options": {},
  "inputMapping": {},
  "entryEvent": { "type": "BOSS_TASK", "textField": "bossIntent", "contextField": "bossIntent" },
  "bossEvents": [],
  "outcomeAuthority": {
    "governedPlayerStates": {
      "work": {
        "done": { "fields": {}, "repositoryDisposition": "one-descendant-commit" },
        "needsBossReply": { "fields": { "question": "presentation" }, "repositoryDisposition": "deferred" }
      }
    }
  },
  "placeholderFields": {},
  "transitionEventFields": ["bossIntent", "answer", "questionId"],
  "verbatimPayloadFields": [],
  "resumableStateIds": ["work"],
  "unfinishedFinalStateIds": [],
  "controlContextFields": []
}
JSON
```

This descriptor is an example shape, not default workflow semantics.
Every top-level member is required; unknown members are errors.
`options` maps each configured option to `{ "type": "string" | "number" |
"boolean", "required": true | false }`; `inputMapping` maps each FSM input
field to its supplying option name.
Option unions, closed values, range constraints, nested structures, and
session-derived input values are outside this profile; do not widen their
contracts to an unconstrained primitive.
The tool adds optional string `cwd` for script-bearing machines; it does not
put `cwd` in FSM input unless the descriptor explicitly maps it.
An explicit `entryEvent: null` selects the shared classifier only where this
definition permits no deterministic entry; it does not relax entry rules.
`bossEvents` retains the exact additional erased event fields, source ownership,
requiredness, and closed values specified under Output.
The state/outcome/field authority map, placeholder exceptions, transition and
verbatim fields, resumable states, unfinished finals, and safe ordered context
projection retain their exact obligations under Output.
The tool copies role labels and identities from the machine and never guesses
result semantics by executing an invocation against invented context.

The helper resolves the installed shared engine from the source and target
locations and refuses differing engine resolutions.
Its factory preflight checks linked metadata.
It accepts `.fsm.js` on supported Node versions; `.fsm.ts` requires native
type stripping (Node 23.6+, or Node 22.18+).
On success it atomically writes only the declared target after factory
preflight; run all existing conformance checks afterward.
Exit 2 reports `unsupported` without changing the target: continue ordinary
linking under this complete definition.
Exit 1 reports invalid metadata, loading, preflight, or output failure:
correct the identified problem before treating linking as successful.

