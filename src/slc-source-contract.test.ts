// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { _internal as codeInternal } from '../reference/sdlc/code.playbook/code.playbook.js';
import { _internal as decideInternal } from '../reference/sdlc/decide.playbook/decide.playbook.js';
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
  'Players:',
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

Players:

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
  },
  {
    id: 'DECIDE',
    sourceUrl: new URL('../reference/sdlc/decide.md', import.meta.url),
    gearsUrl: new URL(
      '../reference/sdlc/decide.playbook/decide.gears.md',
      import.meta.url,
    ),
    linkedFields: decideInternal.VERBATIM_PAYLOAD_FIELDS,
    expectedFields: ['coderProposal', 'reviewerProposal', 'coderOutput'],
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
