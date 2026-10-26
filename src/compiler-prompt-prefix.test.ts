// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkSourceGearsContract,
  parseGearsContract,
} from '../scripts/check-slc-source-gears.mjs';
import { defaultComposePlayerPrompt } from './xstate-runtime.js';

const tool = fileURLToPath(new URL('../slc/prefix-prompts.mjs', import.meta.url));
const definition = readFileSync(new URL('../slc/prefix.md', import.meta.url), 'utf8');
const SECTION = '## Prefixed prompts';

const workflows = [
  { id: 'code', prefixed: ['CODE-1', 'CODE-3'], nested: ['CODE-2', 'CODE-4'] },
  { id: 'review', prefixed: ['REVIEW-1', 'REVIEW-2', 'REVIEW-3', 'REVIEW-4'], nested: [] },
  { id: 'decide', prefixed: ['DECIDE-1', 'DECIDE-2'], nested: ['DECIDE-4'] },
  { id: 'dev', prefixed: ['DEV-1'], nested: ['DEV-2', 'DEV-3', 'DEV-4', 'DEV-5', 'DEV-6'] },
  { id: 'branch', prefixed: ['BRANCH-1'], nested: [] },
  { id: 'pr', prefixed: ['PR-1'], nested: ['PR-3'] },
] as const;

function reference(id: string): { source: string; gears: string } {
  const base = new URL(`../reference/sdlc/${id}`, import.meta.url);
  return {
    source: readFileSync(new URL(`${base.href}.md`), 'utf8'),
    gears: readFileSync(new URL(`${base.href}.playbook/${id}.gears.md`), 'utf8'),
  };
}

/** Run the shipped tool on `gears`, returning the target text and stdout. */
function prefix(
  dir: string,
  gears: string,
  keep: readonly string[] = [],
): { text: string; stdout: string } {
  const source = join(dir, 'in.gears.md');
  const target = join(dir, 'out.gears.md');
  writeFileSync(source, gears);
  const stdout = execFileSync(
    process.execPath,
    [tool, '--source', source, '--target', target, ...keep.flatMap((id) => ['--keep', id])],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  expect(readFileSync(source, 'utf8')).toBe(gears);
  return { text: readFileSync(target, 'utf8'), stdout };
}

/**
 * A relay-first pre-image of a GEARS the pass already rewrote: the trailing
 * relay block of each named item's prompt moves back to the head of its
 * blockquote. For REVIEW-2 this is exactly its Source order, and the shipped
 * tool rewrites the result back to the maintained GEARS byte for byte.
 */
function relayFirst(gears: string, ids: readonly string[]): string {
  const lines = gears.split('\n');
  const out: string[] = [];
  let item: string | undefined;
  for (let index = 0; index < lines.length; ) {
    if (/^#{1,3}\s/.test(lines[index])) item = /^###\s+(\S+)\s*$/.exec(lines[index])?.[1];
    if (!lines[index].startsWith('>') || item === undefined || !ids.includes(item)) {
      out.push(lines[index++]);
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end].startsWith('>')) end++;
    const quote = lines.slice(index, end);
    let relay = quote.length;
    while (relay > 0 && quote[relay - 1].startsWith('> > ')) relay--;
    out.push(
      ...(relay > 1 && relay < quote.length && quote[relay - 1] === '>'
        ? [...quote.slice(relay), '>', ...quote.slice(0, relay - 1)]
        : quote),
    );
    index = end;
  }
  return out.join('\n');
}

/** Prompt lines of each item, keyed by item id. */
function prompts(gears: string): Map<string, readonly string[]> {
  return new Map(parseGearsContract(gears).map((item) => [item.id, item.prompt]));
}

/** Whether every relay line of a prompt follows every instruction line. */
function relaysTrail(prompt: readonly string[]): boolean {
  const lastInstruction = prompt.reduce(
    (last, line, index) => (line !== '' && !line.startsWith('>') ? index : last),
    -1,
  );
  return prompt.every((line, index) => !line.startsWith('>') || index > lastInstruction);
}

/** A legacy provenance section as the pass wrote it before DR-065's revision. */
function legacySection(ids: readonly string[]): string {
  return `${SECTION}\n\n${ids.map((id) => `- ${id}: relays → tail`).join('\n')}\n`;
}

/** IDs of the items whose acting clause calls a nested playbook. */
function nestedCallItems(gears: string): string[] {
  return gears
    .split(/^(?=### )/m)
    .filter((part) => /\bCaptain shall call playbook\b/.test(part))
    .map((part) => /^###\s+(\S+)/.exec(part)![1]);
}

/** A Source of fenced instructions and its faithful raw GEARS, one item per instruction. */
function flow(instructions: readonly (readonly string[])[]): { source: string; gears: string } {
  const head = ['# Flow', '', 'Roles:', '', '- Coder', ''];
  const source = [
    ...head,
    ...instructions.flatMap((lines, index) => [
      `When step ${index + 1} starts, Captain shall give Coder the following instruction:`,
      '',
      '```markdown',
      ...lines,
      '```',
      '',
    ]),
  ].join('\n');
  const gears = [
    ...head,
    ...instructions.flatMap((lines, index) => [
      `### FLOW-${index + 1}`,
      '',
      `When step ${index + 1} starts, Captain shall prompt Coder:`,
      '',
      ...lines.map((line) => (line === '' ? '>' : `> ${line}`)),
      '',
      'Results:',
      '- `done`: Coder finished.',
      '',
    ]),
  ].join('\n');
  return { source, gears };
}

/** An instruction whose fenced template carries an authored run of two blank lines. */
const TEMPLATE = [
  '> Request: <caller-input>',
  '',
  'Create `notes.txt` with exactly this content:',
  '',
  '~~~text',
  'first',
  '',
  '',
  'second',
  '~~~',
];

/** A faithful raw GEARS of one Flow item with the given prompt lines. */
function oneItem(prompt: readonly string[]): string {
  return [
    '# Flow', '', 'Roles:', '', '- Coder', '',
    '### FLOW-1', '', 'When step 1 starts, Captain shall prompt Coder:', '',
    ...prompt.map((line) => (line === '' ? '>' : `> ${line}`)), '',
    'Results:', '- `done`: Coder finished.', '',
  ].join('\n');
}

const FLOW_HEAD = ['# Flow', '', 'Roles:', '', '- Coder', ''];

describe('prompt-prefix pass tool (compiler-prompt-prefix-6)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'playbook-prefix-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(workflows)('$id: rewrites exactly the relay-first items', ({ id, prefixed }) => {
    const { gears } = reference(id);
    // The recompiled bundle carries the pass's output and nothing beside it:
    // every relay trails its instructions, so nothing is eligible again.
    expect(gears).not.toContain(SECTION);
    for (const [itemId, prompt] of prompts(gears)) {
      expect(relaysTrail(prompt), itemId).toBe(true);
    }
    const again = prefix(dir, gears);
    expect(again.stdout).toBe('no eligible item; target equals source\n');
    expect(again.text).toBe(gears);

    // A relay-first pre-image rewrites back byte for byte: exactly the
    // relay-first items are rewritten, and every other item, the metadata,
    // and an `## Optimizations` section are untouched.
    const before = relayFirst(gears, prefixed);
    for (const [itemId, prompt] of prompts(before)) {
      expect(relaysTrail(prompt), itemId).toBe(!prefixed.includes(itemId as never));
    }
    const { text, stdout } = prefix(dir, before);
    expect(stdout.trim().split('\n')).toEqual([...prefixed]);
    expect(text).toBe(gears);

    // A legacy provenance section is removed, alone or beside a rewrite.
    const legacy = `${gears}\n${legacySection(prefixed)}`;
    const removed = prefix(dir, legacy);
    expect(removed.stdout).toBe('no eligible item; legacy ## Prefixed prompts section removed\n');
    expect(removed.text).toBe(gears);
    expect(prefix(dir, `${before}\n${legacySection(prefixed)}`).text).toBe(gears);
    if (id === 'pr') {
      const inner = gears.replace('\n## Optimizations\n', `\n${legacySection(prefixed)}\n## Optimizations\n`);
      expect(inner).not.toBe(gears);
      expect(prefix(dir, inner).text).toBe(gears);
    }
  });

  it('skips a kept item and leaves an ineligible package untouched', () => {
    const review = workflows.find(({ id }) => id === 'review')!;
    const gears = relayFirst(reference('review').gears, review.prefixed);
    const { text, stdout } = prefix(dir, gears, ['REVIEW-2']);
    expect(stdout.trim().split('\n')).toEqual(['REVIEW-1', 'REVIEW-3', 'REVIEW-4']);
    expect(prompts(text).get('REVIEW-2')).toEqual(prompts(gears).get('REVIEW-2'));

    const captain = readFileSync(
      new URL('../reference/sdlc/captain.playbook/captain.gears.md', import.meta.url),
      'utf8',
    );
    const untouched = prefix(dir, captain);
    expect(untouched.text).toBe(captain);
    expect(untouched.text).not.toContain(SECTION);
  });

  it('keeps a quoted line adjacent to an instruction with that instruction', () => {
    const gears = [
      '### FLOW-1',
      '',
      'When work starts, Captain shall prompt Coder:',
      '',
      '> > Original request: <caller-input>',
      '>',
      '> Implement the request below.',
      '> > Original request: <caller-input>',
      '',
      'Results:',
      '- `done`: Coder finished.',
      '',
    ].join('\n');
    const { text } = prefix(dir, gears);
    expect(prompts(text).get('FLOW-1')).toEqual([
      'Implement the request below.',
      '> Original request: <caller-input>',
      '',
      '> Original request: <caller-input>',
    ]);
  });

  it('moves a blank-separated quoted block inside a fenced instruction and keeps an adjacent one', () => {
    const source = [
      '# Flow',
      '',
      'Roles:',
      '',
      '- Coder',
      '',
      'Captain shall give Coder the following instruction:',
      '',
      '```markdown',
      '> Request: <caller-input>',
      '',
      'Read the request and act on it.',
      'Quote it back like this:',
      '> Request: <caller-input>',
      '```',
      '',
    ].join('\n');
    const gears = [
      '# Flow',
      '',
      'Roles:',
      '',
      '- Coder',
      '',
      '### FLOW-1',
      '',
      'When work starts, Captain shall prompt Coder:',
      '',
      '> > Request: <caller-input>',
      '>',
      '> Read the request and act on it.',
      '> Quote it back like this:',
      '> > Request: <caller-input>',
      '',
      'Results:',
      '- `done`: Coder acted on the request.',
      '',
    ].join('\n');
    expect(checkSourceGearsContract(source, gears)).toEqual([]);
    const { text, stdout } = prefix(dir, gears);
    expect(stdout.trim()).toBe('FLOW-1');
    expect(prompts(text).get('FLOW-1')).toEqual([
      'Read the request and act on it.',
      'Quote it back like this:',
      '> Request: <caller-input>',
      '',
      '> Request: <caller-input>',
    ]);
    // Nothing lists the rewrite: the checker reads it from the layout.
    expect(text).not.toContain(SECTION);
    expect(checkSourceGearsContract(source, text)).toEqual([]);
  });

  it('preserves CRLF line endings', () => {
    const { gears } = reference('branch');
    const crlf = gears.replaceAll('\n', '\r\n');
    const { text } = prefix(dir, crlf);
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text.replaceAll('\r\n', '\n')).toBe(prefix(dir, gears).text);
  });

  it('rewrites the shipped definition example exactly as printed', () => {
    const examples = [...definition.matchAll(/```markdown\n([\s\S]*?)```/g)].map((match) => match[1]);
    expect(examples).toHaveLength(2);
    const [before, after] = examples;
    const { text, stdout } = prefix(dir, before);
    expect(stdout.trim()).toBe('REVIEW-2');
    expect(text).toBe(after);
  });

  it('rewrites a kept item on a later application to the text of one run', () => {
    const review = workflows.find(({ id }) => id === 'review')!;
    const gears = relayFirst(reference('review').gears, review.prefixed);
    const again = prefix(dir, prefix(dir, gears, ['REVIEW-2']).text);
    expect(again.stdout.trim()).toBe('REVIEW-2');
    expect(again.text).toBe(prefix(dir, gears).text);
    expect(again.text).toBe(reference('review').gears);
    expect(again.text).not.toContain(SECTION);
  });
});

describe('prefix-first prompts share their instructions as a cache prefix (compiler-prompt-prefix-7)', () => {
  it('composes REVIEW-2 with two requests sharing the whole instruction block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'playbook-prefix-'));
    try {
      const review = workflows.find(({ id }) => id === 'review')!;
      const gears = relayFirst(reference('review').gears, review.prefixed);
      const { text } = prefix(dir, gears);
      const compose = (prompt: readonly string[], callerInput: string) =>
        defaultComposePlayerPrompt({
          stateId: 'fixFindings',
          role: 'coder',
          sourceItem: 'REVIEW-2',
          prompt: prompt.join('\n'),
          result: {},
          callerInput,
          reviewerOutput: `Findings for ${callerInput}`,
        } as never);
      const commonPrefix = (left: string, right: string) => {
        let index = 0;
        while (index < left.length && left[index] === right[index]) index++;
        return left.slice(0, index);
      };
      const before = prompts(gears).get('REVIEW-2')!;
      const after = prompts(text).get('REVIEW-2')!;
      const instructions = after.filter((line) => !line.startsWith('>')).join('\n').trimEnd();
      expect(instructions).toContain('For each review item, accept or reject it.');

      const shared = commonPrefix(compose(after, 'Add a flag.'), compose(after, 'Remove a flag.'));
      expect(shared.startsWith(instructions)).toBe(true);
      const original = commonPrefix(compose(before, 'Add a flag.'), compose(before, 'Remove a flag.'));
      expect(original).toBe('> Original request: ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fidelity checker reads the prefix-first layout from each prompt (compiler-prompt-prefix-8)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'playbook-prefix-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(workflows)('$id: zero findings for the tool output, legacy sections ignored', ({ id, prefixed, nested }) => {
    const { source, gears } = reference(id);
    const rewritten = prefix(dir, gears).text;
    expect(rewritten).not.toContain(SECTION);
    expect(checkSourceGearsContract(source, rewritten)).toEqual([]);
    // Two legacy sections listing the rewritten items, every nested-call
    // item, an unknown ID, and a malformed entry carry no meaning.
    expect(nestedCallItems(gears)).toEqual([...nested]);
    const unknown = `${id.toUpperCase()}-99`;
    const legacy = [
      rewritten,
      `${legacySection([...prefixed, ...nested, unknown])}- ${prefixed[0]} moved\n`,
      legacySection(prefixed),
    ].join('\n');
    expect(checkSourceGearsContract(source, legacy)).toEqual([]);
  });

  it('reports the mutants', () => {
    const { source, gears } = reference('code');
    // No section lists CODE-1 or CODE-3, yet both pass in the prefix-first
    // layout.
    const prefixed = prefix(dir, gears).text;
    expect(checkSourceGearsContract(source, prefixed)).toEqual([]);
    const dropped = prefixed.replace('> > Run results: <run-results>\n', '');
    expect(checkSourceGearsContract(source, dropped)).toEqual([
      'source relay fragment at line 28 was dropped or changed',
    ]);
    // Moving CODE-1's trailing relays back before its first instruction
    // restores the Source-order layout, which still passes.
    const relays = '>\n> > Original request: <caller-input>\n> > Run results: <run-results>\n';
    const relayFirst = prefixed
      .replace(relays, '')
      .replace(
        '> First determine whether',
        `${relays.slice(2)}>\n> First determine whether`,
      );
    expect(relayFirst).not.toBe(prefixed);
    expect(checkSourceGearsContract(source, relayFirst)).toEqual([]);
    // Moving them between two instruction paragraphs matches neither layout.
    const inside = prefixed
      .replace(relays, '')
      .replace('>\n> For a new change intent', `${relays}>\n> For a new change intent`);
    expect(inside).not.toBe(prefixed);
    expect(checkSourceGearsContract(source, inside)).toEqual([
      'source instruction fragment at line 31 was dropped or changed',
    ]);
  });

  it('reports a relay moved before an instruction the Source put it after', () => {
    const source = [
      ...FLOW_HEAD,
      'When step 1 starts, Captain shall give Coder this instruction:',
      '', '```markdown', 'Act on the request below.', '```', '',
      'and then relay the request in quotes (`>`):',
      '', '> Request: <caller-input>', '',
    ].join('\n');
    const authored = oneItem(['Act on the request below.', '', '> Request: <caller-input>']);
    expect(checkSourceGearsContract(source, authored)).toEqual([]);
    expect(prefix(dir, authored).stdout).toBe('no eligible item; target equals source\n');
    const moved = oneItem(['> Request: <caller-input>', '', 'Act on the request below.']);
    expect(checkSourceGearsContract(source, moved)).toEqual([
      'FLOW-1: authored prompt fragments are out of Source order',
    ]);
  });

  it('reports a relay block kept before the last instruction while another trails', () => {
    const source = [
      ...FLOW_HEAD,
      'When step 1 starts, Captain shall relay the request in quotes (`>`):',
      '', '> Request: <caller-input>', '',
      'and then give Coder this instruction:',
      '', '```markdown', 'Do X.', '```', '',
      'then relay the context in quotes (`>`):',
      '', '> Context: <context>', '',
      'and give Coder this one:',
      '', '```markdown', 'Do Y.', '```', '',
    ].join('\n');
    const request = '> Request: <caller-input>';
    const context = '> Context: <context>';
    const authored = oneItem([request, '', 'Do X.', '', context, '', 'Do Y.']);
    expect(checkSourceGearsContract(source, authored)).toEqual([]);
    // The tool moves both standalone relay blocks after the last instruction.
    const { text } = prefix(dir, authored);
    expect(prompts(text).get('FLOW-1')).toEqual(['Do X.', '', 'Do Y.', '', request, '', context]);
    expect(checkSourceGearsContract(source, text)).toEqual([]);
    // Fragments in Source order would tile a prompt that trails only the
    // request and keeps the context in place, but a standalone relay block
    // before an instruction line is not the pass's layout.
    const partly = oneItem(['Do X.', '', context, '', 'Do Y.', '', request]);
    expect(checkSourceGearsContract(source, partly)).toEqual([
      'FLOW-1: authored prompt fragments are out of Source order',
    ]);
  });

  it('orders every occurrence, so a relay block repeated after a later fragment fails', () => {
    // DECIDE-3's trailing block relays the topic and then the proposal, so a
    // repeated block puts a topic after the proposal; CODE-4's first block
    // repeated after its last stands after the IR-task relay.
    const cases = [
      {
        id: 'decide',
        item: 'DECIDE-3',
        after: "> > Original topic: <caller-topic>\n> > Reviewer's independent proposal: <reviewer-proposal>\n",
        block: "> > Original topic: <caller-topic>\n> > Reviewer's independent proposal: <reviewer-proposal>\n",
      },
      {
        id: 'code',
        item: 'CODE-4',
        after: '> > Current IR task: <ir-task>\n',
        block: [
          '> > Original intent: <caller-input>',
          '> > Review scope: the commit <code-commit> from this coding phase and its resulting repository state.',
          '> > Coder output: <coder-output>',
          '',
        ].join('\n'),
      },
    ];
    for (const { id, item, after, block } of cases) {
      const { source, gears } = reference(id);
      expect(gears.split(after), item).toHaveLength(2);
      const doubled = gears.replace(after, `${after}>\n${block}`);
      expect(prompts(doubled).get(item)!.length, item).toBe(prompts(gears).get(item)!.length + block.split('\n').length);
      expect(checkSourceGearsContract(source, doubled), item).toEqual([
        `${item}: authored prompt fragments are out of Source order`,
      ]);
    }
  });

  it('holds a script item to Source order where a prompted item may take the prefix-first layout', () => {
    const source = [
      ...FLOW_HEAD,
      'When step 1 starts, Captain shall relay the request in quotes (`>`):',
      '', '> Request: <caller-input>', '',
      'and then act on this instruction:',
      '', '```markdown', 'Act on the request.', '```', '',
    ].join('\n');
    const acting = (clause: string, prompt: readonly string[]) =>
      oneItem(prompt).replace('Captain shall prompt Coder:', clause);
    const authored = ['> Request: <caller-input>', '', 'Act on the request.'];
    const prefixFirst = ['Act on the request.', '', '> Request: <caller-input>'];
    // The script item stands in Source order, but not in the layout the
    // pass leaves a prompted item, which a player or Captain item may take.
    expect(checkSourceGearsContract(source, acting('Captain shall run:', authored))).toEqual([]);
    expect(checkSourceGearsContract(source, acting('Captain shall run:', prefixFirst))).toEqual([
      'FLOW-1: authored prompt fragments are out of Source order',
    ]);
    for (const clause of ['Captain shall prompt Coder:', 'Captain shall decide how to act:']) {
      expect(checkSourceGearsContract(source, acting(clause, prefixFirst)), clause).toEqual([]);
    }
  });
});

describe('prefix units keep ownership, multiplicity, and blank lines (compiler-prompt-prefix-9)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'playbook-prefix-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps an instruction's authored blank lines and collapses only a moved block's", () => {
    expect(prompts(prefix(dir, flow([TEMPLATE]).gears).text).get('FLOW-1')).toEqual([
      'Create `notes.txt` with exactly this content:',
      '',
      '~~~text',
      'first',
      '',
      '',
      'second',
      '~~~',
      '',
      '> Request: <caller-input>',
    ]);
    const bounded = flow([['Do X.', '', '', '> Request: <caller-input>', '', 'Do Y.']]);
    expect(prompts(prefix(dir, bounded.gears).text).get('FLOW-1')).toEqual([
      'Do X.',
      '',
      'Do Y.',
      '',
      '> Request: <caller-input>',
    ]);
  });

  it('owns units by fragment and counts each occurrence', () => {
    const shared = flow([
      ['> Request: <caller-input>', '', 'Implement the request.', '', 'Report every result.'],
      ['> Request: <caller-input>', '', 'Test the change.', '', 'Report every result.'],
      ['> Request: <caller-input>', '', 'Run the tests.', '', 'Fix every failure.', '', 'Run the tests.'],
    ]);
    expect(checkSourceGearsContract(shared.source, prefix(dir, shared.gears).text)).toEqual([]);
    const repeated = flow([
      ['> Request: <caller-input>', '', 'Implement the request.', '', '> Request: <caller-input>', '', 'Report every result.'],
    ]);
    const both = prefix(dir, repeated.gears).text;
    expect(checkSourceGearsContract(repeated.source, both)).toEqual([]);
    expect(
      checkSourceGearsContract(repeated.source, both.replace('> > Request: <caller-input>\n>\n', '')),
    ).toEqual([
      'source instruction fragment at line 9 was dropped or changed',
    ]);
    // FLOW-2 already trails its relay, which it shares with FLOW-1's
    // fragment: that relay unit alone never stands for FLOW-1's fragment.
    const masked = flow([
      ['> Request: <caller-input>', '', 'Implement the request.'],
      ['Test the change.', '', '> Request: <caller-input>'],
    ]);
    const maskedText = prefix(dir, masked.gears).text;
    expect(checkSourceGearsContract(masked.source, maskedText)).toEqual([]);
    const firstItem = maskedText.slice(maskedText.indexOf('### FLOW-1'), maskedText.indexOf('### FLOW-2'));
    expect(checkSourceGearsContract(masked.source, maskedText.replace(firstItem, ''))).toEqual([
      'source instruction fragment at line 9 was dropped or changed',
    ]);
  });

  it('accepts a boundary of more than one blank line that the Source put between fragments', () => {
    const source = [
      '# Flow', '', 'Roles:', '', '- Coder', '',
      "When step 1 starts, Captain shall relay the request in quotes (`>`) and give Coder these instructions:",
      '', '> Request: <caller-input>', '',
      '```markdown', 'Implement the request.', '```', '',
      'Two blank lines then separate the second instruction from the first:', '',
      '```markdown', 'Report every result.', '```', '',
    ].join('\n');
    const gears = [
      '# Flow', '', 'Roles:', '', '- Coder', '',
      '### FLOW-1', '', 'When step 1 starts, Captain shall prompt Coder:', '',
      '> > Request: <caller-input>', '>', '> Implement the request.', '>', '>', '> Report every result.', '',
      'Results:', '- `done`: Coder finished.', '',
    ].join('\n');
    expect(checkSourceGearsContract(source, gears)).toEqual([]);
    const { text, stdout } = prefix(dir, gears);
    expect(stdout.trim()).toBe('FLOW-1');
    expect(prompts(text).get('FLOW-1')).toEqual([
      'Implement the request.', '', '', 'Report every result.', '', '> Request: <caller-input>',
    ]);
    expect(checkSourceGearsContract(source, text)).toEqual([]);
  });

  it('keeps the alternative assignment that shows the rewrite', () => {
    // Two items whose fragments mirror each other rewrite to identical prompts.
    const mirrored = flow([
      ['Implement the request.', '', '> Request: <caller-input>'],
      ['> Request: <caller-input>', '', 'Implement the request.'],
    ]);
    const { text, stdout } = prefix(dir, mirrored.gears);
    expect(stdout.trim()).toBe('FLOW-2');
    expect(checkSourceGearsContract(mirrored.source, text)).toEqual([]);
  });

  it('accepts moved bare relays authored through prose, alone and adjacent', () => {
    const source = [
      ...FLOW_HEAD,
      'When step 1 starts, Captain shall relay the caller input and the run results in quotes (`>`) before giving Coder this instruction:',
      '', '```markdown', 'Do X.', '```', '',
    ].join('\n');
    for (const bare of [['> <caller-input>'], ['> <caller-input>', '> <run-results>']]) {
      const gears = oneItem([...bare, '', 'Do X.']);
      expect(checkSourceGearsContract(source, gears)).toEqual([]);
      const { text, stdout } = prefix(dir, gears);
      expect(stdout.trim()).toBe('FLOW-1');
      expect(prompts(text).get('FLOW-1')).toEqual(['Do X.', '', ...bare]);
      expect(checkSourceGearsContract(source, text)).toEqual([]);
    }
  });

  it('accepts the boundaries the Source authored between fragments, including none', () => {
    const cases = [
      {
        // Two instruction fragments joined without a blank line.
        source: [
          ...FLOW_HEAD,
          'When step 1 starts, Captain shall relay the request in quotes (`>`) and give Coder these instructions, the second directly after the first:',
          '', '> Request: <caller-input>', '',
          '```markdown', 'Do X.', '```', '',
          '```markdown', 'Do Y.', '```', '',
        ],
        gears: oneItem(['> Request: <caller-input>', '', 'Do X.', 'Do Y.']),
        rewritten: ['Do X.', 'Do Y.', '', '> Request: <caller-input>'],
      },
      {
        // Two relay fragments joined without a blank line.
        source: [
          ...FLOW_HEAD,
          'When step 1 starts, Captain shall relay the request in quotes (`>`):',
          '', '> Request: <caller-input>', '',
          'and, directly below it, the summary in quotes (`>`):',
          '', '> Summary: <summary>', '',
          'Then Captain shall give Coder this instruction:',
          '', '```markdown', 'Do X.', '```', '',
        ],
        gears: oneItem(['> Request: <caller-input>', '> Summary: <summary>', '', 'Do X.']),
        rewritten: ['Do X.', '', '> Request: <caller-input>', '> Summary: <summary>'],
      },
      {
        // A relay fragment joined directly to an instruction stays beside it.
        source: [
          ...FLOW_HEAD,
          'When step 1 starts, Captain shall relay the summary in quotes (`>`):',
          '', '> Summary: <summary>', '',
          'and the request in quotes (`>`) directly followed by this instruction:',
          '', '> Request: <caller-input>', '',
          '```markdown', 'Do X.', '```', '',
        ],
        gears: oneItem(['> Summary: <summary>', '', '> Request: <caller-input>', 'Do X.']),
        rewritten: ['> Request: <caller-input>', 'Do X.', '', '> Summary: <summary>'],
      },
    ];
    for (const { source: lines, gears, rewritten } of cases) {
      const source = lines.join('\n');
      expect(checkSourceGearsContract(source, gears)).toEqual([]);
      const { text, stdout } = prefix(dir, gears);
      expect(stdout.trim()).toBe('FLOW-1');
      expect(prompts(text).get('FLOW-1')).toEqual(rewritten);
      expect(checkSourceGearsContract(source, text)).toEqual([]);
    }
  });

  it('keeps the authored boundary after a relay that stays in place', () => {
    // The second relay follows `Prepare.` directly, so it stays, and the two
    // blank lines Source authored after it survive with it.
    const source = [
      ...FLOW_HEAD,
      'When step 1 starts, Captain shall give Coder these instructions, the second directly after the first:',
      '', '```markdown', '> First: <first>', '', 'Prepare.', '```', '',
      '```markdown', '> Second: <second>', '', '', 'Execute.', '```', '',
    ].join('\n');
    const gears = oneItem(['> First: <first>', '', 'Prepare.', '> Second: <second>', '', '', 'Execute.']);
    expect(checkSourceGearsContract(source, gears)).toEqual([]);
    const { text, stdout } = prefix(dir, gears);
    expect(stdout.trim()).toBe('FLOW-1');
    expect(prompts(text).get('FLOW-1')).toEqual([
      'Prepare.', '> Second: <second>', '', '', 'Execute.', '', '> First: <first>',
    ]);
    expect(checkSourceGearsContract(source, text)).toEqual([]);
    // The authored count is exact: one or three blank lines there is a change.
    for (const blanks of [1, 3]) {
      const changed = text.replace('> > Second: <second>\n>\n>\n> Execute.', `> > Second: <second>\n${'>\n'.repeat(blanks)}> Execute.`);
      expect(changed).not.toBe(text);
      expect(checkSourceGearsContract(source, changed)).toContain(
        'source instruction fragment at line 15 was dropped or changed',
      );
    }
  });

  it('keeps the authored boundary before a relay that stays in place', () => {
    // The first fragment ends with a relay two blank lines after its
    // instruction; the second fragment's instruction follows it directly, so
    // the relay stays and the two blank lines before it survive.
    const source = [
      ...FLOW_HEAD,
      'When step 1 starts, Captain shall give Coder these instructions, the second directly after the first:',
      '', '```markdown', '> Zero: <zero>', '', 'Prepare.', '', '', '> First: <first>', '```', '',
      '```markdown', 'Execute.', '```', '',
    ].join('\n');
    const gears = oneItem(['> Zero: <zero>', '', 'Prepare.', '', '', '> First: <first>', 'Execute.']);
    expect(checkSourceGearsContract(source, gears)).toEqual([]);
    const { text, stdout } = prefix(dir, gears);
    expect(stdout.trim()).toBe('FLOW-1');
    expect(prompts(text).get('FLOW-1')).toEqual([
      'Prepare.', '', '', '> First: <first>', 'Execute.', '', '> Zero: <zero>',
    ]);
    expect(checkSourceGearsContract(source, text)).toEqual([]);
    for (const blanks of [1, 3]) {
      const changed = text.replace('> Prepare.\n>\n>\n> > First: <first>', `> Prepare.\n${'>\n'.repeat(blanks)}> > First: <first>`);
      expect(changed).not.toBe(text);
      expect(checkSourceGearsContract(source, changed)).toEqual([
        'source instruction fragment at line 9 was dropped or changed',
      ]);
    }
  });

  it('conserves identical fragments across many items without a search bound', () => {
    const same = ['> Context: <context>', '', 'Act.'];
    const seven = flow(Array.from({ length: 7 }, () => same));
    const sevenRewritten = prefix(dir, seven.gears);
    expect(sevenRewritten.stdout.trim().split('\n')).toHaveLength(7);
    expect(checkSourceGearsContract(seven.source, sevenRewritten.text)).toEqual([]);
    // Deleting one of the seven leaves six occurrences for seven fragments.
    const seventh = sevenRewritten.text.slice(sevenRewritten.text.indexOf('### FLOW-7'));
    const dropped = checkSourceGearsContract(seven.source, sevenRewritten.text.replace(seventh, ''));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatch(/^source instruction fragment at line \d+ was dropped or changed$/);
    const many = flow(Array.from({ length: 65 }, () => same));
    const kept = Array.from({ length: 64 }, (_unused, index) => `FLOW-${index + 1}`);
    const last = prefix(dir, many.gears, kept);
    expect(last.stdout.trim()).toBe('FLOW-65');
    expect(checkSourceGearsContract(many.source, last.text)).toEqual([]);
  });

  it('reports a fragment that only a tiling already spent could cover', () => {
    // Mirrored items rewrite to the same prompt: deleting one item leaves one
    // prompt, which can stand for one of the two authored fragments only.
    const mirrored = flow([
      ['Act.', '', '> Context: <context>'],
      ['> Context: <context>', '', 'Act.'],
    ]);
    const rewritten = prefix(dir, mirrored.gears).text;
    expect(checkSourceGearsContract(mirrored.source, rewritten)).toEqual([]);
    const firstItem = rewritten.slice(rewritten.indexOf('### FLOW-1'), rewritten.indexOf('### FLOW-2'));
    expect(checkSourceGearsContract(mirrored.source, rewritten.replace(firstItem, ''))).toEqual([
      'source instruction fragment at line 17 was dropped or changed',
    ]);
    // One prompt composed of both fragments loses one of them the same way.
    const composed = {
      source: [
        ...FLOW_HEAD,
        'When step 1 starts, Captain shall give Coder these two instructions:', '',
        '```markdown', 'Act.', '', '> Context: <context>', '```', '',
        '```markdown', '> Context: <context>', '', 'Act.', '```', '',
      ].join('\n'),
      gears: oneItem(['Act.', '', '> Context: <context>', '', '> Context: <context>', '', 'Act.']),
    };
    const both = prefix(dir, composed.gears).text;
    expect(checkSourceGearsContract(composed.source, both)).toEqual([]);
    const halved = both.replace('> Act.\n>\n> Act.', '> Act.').replace('> > Context: <context>\n>\n> > Context: <context>', '> > Context: <context>');
    expect(prompts(halved).get('FLOW-1')).toEqual(['Act.', '', '> Context: <context>']);
    expect(checkSourceGearsContract(composed.source, halved)).toEqual([
      'source instruction fragment at line 15 was dropped or changed',
    ]);
  });

  it("holds an instruction's interior blank lines exact", () => {
    const { source, gears } = flow([TEMPLATE]);
    const text = prefix(dir, gears).text;
    expect(checkSourceGearsContract(source, text)).toEqual([]);
    for (const blanks of [0, 1, 3]) {
      const changed = text.replace('> first\n>\n>\n> second', `> first\n${'>\n'.repeat(blanks)}> second`);
      expect(checkSourceGearsContract(source, changed)).toContain(
        'source instruction fragment at line 9 was dropped or changed',
      );
    }
  });
});
