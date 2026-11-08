// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { _internal as branchInternal } from '../reference/sdlc/branch.playbook/branch.playbook.js';
import { _internal as codeInternal } from '../reference/sdlc/code.playbook/code.playbook.js';
import { _internal as decideInternal } from '../reference/sdlc/decide.playbook/decide.playbook.js';
import { _internal as devInternal } from '../reference/sdlc/dev.playbook/dev.playbook.js';
import { _internal as prInternal } from '../reference/sdlc/pr.playbook/pr.playbook.js';
import { _internal as reviewInternal } from '../reference/sdlc/review.playbook/review.playbook.js';
import {
  checkLinkedVerbatimContract,
  checkSourceGearsContract,
  parseGearsContract,
  sourcePromptFragments,
  verbatimFieldsFromGears,
} from '../scripts/check-slc-source-gears.mjs';

const SOURCE = [
  '# Review flow',
  '',
  'Roles:',
  '',
  '- Coder',
  '- Reviewer',
  '',
  'When work starts, Captain shall give Coder the following instruction:',
  '',
  '```markdown',
  'Implement the requested change.',
  'Report the result.',
  '```',
  '',
  'After Coder finishes, Captain shall give Reviewer the following instruction:',
  '',
  '```markdown',
  'Review the result.',
  'Do not change files.',
  '```',
  '',
  "Captain shall relay Coder's output in quotes (`>`):",
  '',
  '> Coder output: \\<coder-output\\>',
  '',
].join('\n');

const GEARS = `# Review flow

Roles:

- Coder
- Reviewer

### FLOW-1

When work starts, Captain shall prompt Coder:

> Implement the requested change.
> Report the result.

Results:
- \`done\`: Coder finished. Output shall include \`coderOutput: <verbatim final text>\`.

### FLOW-2

After Coder finishes, Captain shall prompt Reviewer:

> Review the result.
> Do not change files.
>
> > Coder output: <coder-output>
`;

const linkedWorkflows = [
  {
    id: 'CODE',
    sourceUrl: new URL('../reference/sdlc/code.md', import.meta.url),
    gearsUrl: new URL(
      '../reference/sdlc/code.playbook/code.gears.md',
      import.meta.url,
    ),
    linkedFields: codeInternal.VERBATIM_PAYLOAD_FIELDS,
    expectedFields: ['coderOutput'],
    unfinishedFinalStateIds: codeInternal.UNFINISHED_FINAL_STATE_IDS,
    expectedUnfinishedFinalStateIds: ['reviewFailed'],
  },
  {
    id: 'REVIEW',
    sourceUrl: new URL('../reference/sdlc/review.md', import.meta.url),
    gearsUrl: new URL(
      '../reference/sdlc/review.playbook/review.gears.md',
      import.meta.url,
    ),
    linkedFields: reviewInternal.VERBATIM_PAYLOAD_FIELDS,
    expectedFields: ['reviewerOutput', 'coderOutput'],
    unfinishedFinalStateIds: reviewInternal.UNFINISHED_FINAL_STATE_IDS,
    expectedUnfinishedFinalStateIds: ['unsettled'],
  },
  {
    id: 'DECIDE',
    sourceUrl: new URL('../reference/sdlc/decide.md', import.meta.url),
    gearsUrl: new URL(
      '../reference/sdlc/decide.playbook/decide.gears.md',
      import.meta.url,
    ),
    linkedFields: decideInternal.VERBATIM_PAYLOAD_FIELDS,
    // DECIDE-4 relays Coder's own proposal to REVIEW, so DECIDE-1's
    // `coderProposal` stays verbatim beside the other consumed payloads.
    expectedFields: ['coderProposal', 'reviewerProposal', 'coderOutput'],
    unfinishedFinalStateIds: decideInternal.UNFINISHED_FINAL_STATE_IDS,
    expectedUnfinishedFinalStateIds: ['reportedReviewFailure'],
  },
  {
    id: 'DEV',
    sourceUrl: new URL('../reference/sdlc/dev.md', import.meta.url),
    gearsUrl: new URL(
      '../reference/sdlc/dev.playbook/dev.gears.md',
      import.meta.url,
    ),
    linkedFields: devInternal.VERBATIM_PAYLOAD_FIELDS,
    expectedFields: ['planningResult'],
    unfinishedFinalStateIds: devInternal.UNFINISHED_FINAL_STATE_IDS,
    expectedUnfinishedFinalStateIds: ['reportedChildFailure'],
  },
  {
    id: 'BRANCH',
    sourceUrl: new URL('../reference/sdlc/branch.md', import.meta.url),
    gearsUrl: new URL(
      '../reference/sdlc/branch.playbook/branch.gears.md',
      import.meta.url,
    ),
    linkedFields: branchInternal.VERBATIM_PAYLOAD_FIELDS,
    expectedFields: ['coderOutput'],
    unfinishedFinalStateIds: branchInternal.UNFINISHED_FINAL_STATE_IDS,
    expectedUnfinishedFinalStateIds: ['refused'],
  },
  {
    id: 'PR',
    sourceUrl: new URL('../reference/sdlc/pr.md', import.meta.url),
    gearsUrl: new URL(
      '../reference/sdlc/pr.playbook/pr.gears.md',
      import.meta.url,
    ),
    linkedFields: prInternal.VERBATIM_PAYLOAD_FIELDS,
    expectedFields: ['coderOutput'],
    unfinishedFinalStateIds: prInternal.UNFINISHED_FINAL_STATE_IDS,
    expectedUnfinishedFinalStateIds: [
      'notPublished',
      'fixFailed',
      'fixNotPublished',
      'checksFailed',
      'mergeUnconfirmed',
    ],
  },
] as const;

describe('SLC Source -> GEARS prompt contract', () => {
  it.each(linkedWorkflows)(
    '$id keeps its protected Source, GEARS prompts, and linked field ownership aligned',
    ({ sourceUrl, gearsUrl, linkedFields, expectedFields }) => {
      const source = readFileSync(sourceUrl, 'utf8');
      const gears = readFileSync(gearsUrl, 'utf8');

      expect(checkSourceGearsContract(source, gears)).toEqual([]);
      expect([...verbatimFieldsFromGears(gears)]).toEqual(expectedFields);
      expect([...linkedFields]).toEqual(expectedFields);
      expect(checkLinkedVerbatimContract(gears, linkedFields)).toEqual([]);
    },
  );

  it.each(linkedWorkflows)(
    '$id declares its exact unfinished root final states',
    ({ unfinishedFinalStateIds, expectedUnfinishedFinalStateIds }) => {
      expect([...unfinishedFinalStateIds]).toEqual(
        expectedUnfinishedFinalStateIds,
      );
    },
  );

  it('preserves instruction fragments, literal relayed quotes, and verbatim fields', () => {
    expect(checkSourceGearsContract(SOURCE, GEARS)).toEqual([]);
    expect([...verbatimFieldsFromGears(GEARS)]).toEqual(['coderOutput']);
    expect(checkLinkedVerbatimContract(GEARS, ['coderOutput'])).toEqual([]);
    expect(sourcePromptFragments(SOURCE).map((fragment) => fragment.kind)).toEqual([
      'instruction',
      'instruction',
      'relay',
    ]);
  });

  it('derives each delegated player from its GEARS acting sentence', () => {
    expect(parseGearsContract(GEARS).map(({ player }) => player)).toEqual([
      'Coder',
      'Reviewer',
    ]);

    const changed = GEARS.replace(
      'Captain shall prompt Reviewer:',
      'Captain shall prompt Coder:',
    );
    expect(parseGearsContract(changed).map(({ player }) => player)).toEqual([
      'Coder',
      'Coder',
    ]);
  });

  it('fails when an authored instruction line is dropped', () => {
    const changed = GEARS.replace('> Do not change files.\n', '');
    expect(checkSourceGearsContract(SOURCE, changed)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^source instruction fragment .* was dropped or changed$/),
      ]),
    );
  });

  it('preserves a reused labeled relay inside a later complete instruction', () => {
    const source = [
      'Captain shall relay the request in quotes (`>`):',
      '',
      '> Original request: <caller-input>',
      '',
      'Captain shall later give Coder this instruction:',
      '',
      '```markdown',
      'Implement the request below.',
      '> Original request: <caller-input>',
      '```',
    ].join('\n');
    const gears = `### FLOW-1

When work starts, Captain shall prompt Coder:

> > Original request: <caller-input>

### FLOW-2

After planning, Captain shall prompt Coder:

> Implement the request below.
> > Original request: <caller-input>
`;
    expect(checkSourceGearsContract(source, gears)).toEqual([]);
  });

  it('fails when Source order is lost', () => {
    const reordered = GEARS.replace(
      '> Review the result.\n> Do not change files.\n>\n> > Coder output: <coder-output>',
      '> > Coder output: <coder-output>\n>\n> Review the result.\n> Do not change files.',
    );
    expect(checkSourceGearsContract(SOURCE, reordered)).toContain(
      'FLOW-2: authored prompt fragments are out of Source order',
    );
  });

  it('fails when the literal relay marker is lost', () => {
    const unquoted = GEARS.replace(
      '> > Coder output: <coder-output>',
      '> Coder output: <coder-output>',
    );
    expect(checkSourceGearsContract(SOURCE, unquoted)).toContain(
      'FLOW-2: relayed player field coderOutput lacks a literal quote marker',
    );
  });

  it('keeps a relayed value the Source authored inside a command line in its own form', () => {
    // pr.md relays the pull request in quotes to `code` and then compares it
    // as a single-quoted shell word inside two commands it authors verbatim.
    const source = [
      'When the checks fail, Captain shall call playbook `code` with the pull request in quotes (`>`):',
      '',
      '> Pull request: \\<pull-request-url\\>',
      '',
      '`pr` makes no more than one fix attempt.',
      'Only after `code` succeeds does `pr` publish the fix.',
      'The checkout can change while the nested `code` call suspends.',
      'The command therefore compares the pull request as data.',
      '',
      'When `code` succeeds, Captain shall publish the fix by running exactly the following command:',
      '',
      `> [ "$(gh pr view --json url --jq .url)" = '<pull-request-url>' ] || exit 1`,
      '> git push',
      '',
    ].join('\n');
    const command = [
      `> [ "$(gh pr view --json url --jq .url)" = '<pull-request-url>' ] || exit 1`,
      '> git push',
    ].join('\n');
    const results = [
      'Results:',
      '- `published`: The command exited with status zero.',
      '- `notPublished`: The command exited with a nonzero status.',
    ].join('\n');
    const gears = (acting: string, lines: string) =>
      `### PR-3\n\nWhen the checks fail, Captain shall call playbook \`code\`:\n\n> > Pull request: <pull-request-url>\n\n### PR-4\n\n${acting}\n\n${lines}\n\n${results}\n`;

    // Before the optimize pass the item is Captain's own work; after it, a
    // script. Both carry the Source's line, so neither owes a quote marker.
    expect(
      checkSourceGearsContract(
        source,
        gears(
          'When `code` succeeds, Captain shall publish the fix by running exactly the following command:',
          command,
        ),
      ),
    ).toEqual([]);
    expect(
      checkSourceGearsContract(
        source,
        gears('When `code` succeeds, Captain shall run:', command),
      ),
    ).toEqual([]);

    // A line the compiler composed still owes the marker.
    expect(
      checkSourceGearsContract(
        source,
        gears(
          'When `code` succeeds, Captain shall prompt Coder:',
          `> Publish the fix to <pull-request-url>.\n${command}`,
        ),
      ),
    ).toEqual([
      'PR-4: prompt line is not an authored fragment: "Publish the fix to <pull-request-url>."',
      'PR-4: relayed player field pullRequestUrl lacks a literal quote marker',
    ]);
  });

  it('fails when link omits a GEARS-derived verbatim field', () => {
    expect(checkLinkedVerbatimContract(GEARS, [])).toEqual([
      'linked runtime omits verbatim field coderOutput',
    ]);
  });

  it('does not mistake a typed extracted placeholder for a full-output relay', () => {
    const source = [
      'When planning starts, Captain shall give Coder this instruction:',
      '',
      '```markdown',
      'Choose the next IR number.',
      '```',
      '',
      'After planning, Captain shall give Coder this instruction:',
      '',
      '```markdown',
      'Implement IR-<#>.',
      '```',
      '',
    ].join('\n');
    const gears = `### FLOW-1

When planning starts, Captain shall prompt Coder:

> Choose the next IR number.

Results:
- \`planned\`: Coder chose the next IR number. Output shall include \`irNumber: <number>\`.

### FLOW-2

After planning, Captain shall prompt Coder:

> Implement IR-<#>.
`;

    expect(checkSourceGearsContract(source, gears)).toEqual([]);
  });

  it('allows an exact quoted structured field to remain judge-authored', () => {
    const source = [
      'When planning starts, Captain shall give Coder this instruction:',
      '',
      '```markdown',
      'Choose the next IR task.',
      '```',
      '',
      'Captain shall relay the exact task in quotes (`>`):',
      '',
      '> IR task: \\<ir-task\\>',
      '',
    ].join('\n');
    const gears = `### FLOW-1

When planning starts, Captain shall prompt Coder:

> Choose the next IR task.

Results:
- \`planned\`: Coder chose the next task. Output shall include \`irTask: <complete task>\`.

### FLOW-2

After planning, Captain shall prompt Coder:

> > IR task: <ir-task>
`;

    expect(checkSourceGearsContract(source, gears)).toEqual([]);
    expect([...verbatimFieldsFromGears(gears)]).toEqual([]);
  });
});
