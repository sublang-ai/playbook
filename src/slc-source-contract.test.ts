// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import {
  checkLinkedVerbatimContract,
  checkSourceGearsContract,
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

describe('SLC Source -> GEARS prompt contract', () => {
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

  it('fails when a relayed player field is left judge-authored', () => {
    const changed = GEARS.replace('<verbatim final text>', '<complete text>');
    expect(checkSourceGearsContract(SOURCE, changed)).toContain(
      'FLOW-2: relayed player field coderOutput is not annotated verbatim',
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
});
