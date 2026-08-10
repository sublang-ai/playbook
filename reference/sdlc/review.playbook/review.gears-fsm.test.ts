// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  reviewMachine,
  type PlayerInput,
  type ReviewContext,
} from './review.fsm.js';

interface GearsItem {
  id: string;
  prompt: string;
  guards: string[];
}

interface RawState {
  tags?: readonly string[];
  meta?: unknown;
  invoke?: {
    src?: unknown;
    input?: (args: { context: ReviewContext }) => PlayerInput;
    onDone?: unknown;
  };
}

interface RawMachineConfig {
  states?: Record<string, RawState>;
}

const ITEM_HEADING = /^### (REVIEW-\d+)$/;
const RESULT = /^- `([A-Za-z_$][A-Za-z0-9_$]*)`:/;

function parseGears(source: string): Map<string, GearsItem> {
  const lines = source.split('\n');
  const starts = lines.flatMap((line, index) => {
    const match = ITEM_HEADING.exec(line);
    return match === null ? [] : [{ id: match[1], index }];
  });
  return new Map(
    starts.map((start, ordinal) => {
      const section = lines.slice(
        start.index + 1,
        starts[ordinal + 1]?.index ?? lines.length,
      );
      const quoteStart = section.findIndex((line) => line.startsWith('>'));
      const prompt: string[] = [];
      for (let index = quoteStart; index >= 0 && index < section.length; index++) {
        const match = /^> ?(.*)$/.exec(section[index]);
        if (match === null) break;
        prompt.push(match[1]);
      }
      const guards = section.flatMap((line) => {
        const match = RESULT.exec(line);
        return match === null ? [] : [match[1]];
      });
      return [
        start.id,
        { id: start.id, prompt: prompt.join('\n'), guards },
      ];
    }),
  );
}

const gears = parseGears(
  readFileSync(new URL('./review.gears.md', import.meta.url), 'utf8'),
);

const states = (
  reviewMachine as unknown as { config: RawMachineConfig }
).config.states ?? {};

const expected = [
  ['reviewInitial', 'REVIEW-1', 'Reviewer'],
  ['addressFindings', 'REVIEW-2', 'Coder'],
  ['reviewAfterCommit', 'REVIEW-3', 'Reviewer'],
  ['reviewAfterRebuttal', 'REVIEW-4', 'Reviewer'],
] as const;

const context: ReviewContext = {
  coderLlm: 'GPT-5.6 Sol',
  reviewerLlm: 'Claude Opus 5',
  callerInput: 'Initial request',
  reviewerOutput: 'Reviewer findings',
  coderOutput: 'Coder disposition',
};

describe('REVIEW GEARS to FSM compilation', () => {
  it('maps every REVIEW item once with its exact player and prompt', () => {
    expect([...gears.keys()]).toEqual(expected.map(([, item]) => item));
    for (const [stateId, sourceItem, player] of expected) {
      const input = states[stateId]?.invoke?.input?.({ context });
      expect(input).toBeDefined();
      expect(input?.stateId).toBe(stateId);
      expect(input?.sourceItem).toBe(sourceItem);
      expect(input?.player).toBe(player);
      expect(input?.prompt).toBe(gears.get(sourceItem)?.prompt);
      expect(states[stateId]?.tags).toContain('playbook.busy');
      expect(states[stateId]?.meta).toEqual({
        playbook: {
          stateId,
          description: expect.any(String),
          player,
        },
      });
    }
  });

  it('preserves each authored result contract and adds only Boss suspension', () => {
    for (const [stateId, sourceItem] of expected) {
      const input = states[stateId]?.invoke?.input?.({ context });
      expect(Object.keys(input?.result ?? {})).toEqual([
        ...(gears.get(sourceItem)?.guards ?? []),
        'needsBossReply',
      ]);
    }
  });

  it('keeps relayed fields quoted and owned by the preceding player result', () => {
    expect(gears.get('REVIEW-1')?.prompt).toContain('> <caller-input>');
    expect(gears.get('REVIEW-2')?.prompt).toContain('> <reviewer-output>');
    expect(gears.get('REVIEW-3')?.prompt).toContain('> <coder-output>');
    expect(gears.get('REVIEW-4')?.prompt).toContain('> <coder-output>');

    const text = readFileSync(
      new URL('./review.gears.md', import.meta.url),
      'utf8',
    );
    expect(text).toContain(
      '`reviewerOutput: <verbatim final text>`',
    );
    expect(text).toContain('`coderOutput: <verbatim final text>`');
  });
});
