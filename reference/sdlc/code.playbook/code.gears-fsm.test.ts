// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// IR-005 Task 3 — GEARS ↔ FSM conformance.
// Cross-references `code.gears.md` (the canonical source of CODE-N
// items and player prompts) against `code.fsm.ts` via the
// introspection helper. Catches:
//   (a) CODE-N in gears without a matching FSM `sourceItem`,
//   (b) FSM `sourceItem` not declared in gears,
//   (c) player binding drift (gears section vs FSM `input.player`),
//   (d) prompt-body drift (gears blockquote vs FSM `input.prompt`),
//   (e) generated `needsBossReply` result-map drift,
//   (f) hidden prompt lines not traceable to `code.md`,
//   (g) stale source/gears `needsBossReply` metadata.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { codingMachine } from './code.fsm.js';
import { enumerateCaptainStates } from './code.fsm.introspect.js';

type Player = 'Coder' | 'Reviewer' | 'Committer';

interface GearsItem {
  id: string;
  player: Player;
  promptBody: string;
  resultGuards: ReadonlyMap<string, string>;
}

interface SourceBehavior {
  promptBody: string;
}

function parseSource(text: string): SourceBehavior[] {
  const behaviors: SourceBehavior[] = [];
  let buf: string[] | undefined;

  function commit(): void {
    if (buf !== undefined) {
      behaviors.push({ promptBody: buf.join('\n') });
    }
    buf = undefined;
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('> ')) {
      buf = buf ?? [];
      buf.push(line.slice(2));
      continue;
    }
    if (line === '>') {
      buf = buf ?? [];
      buf.push('');
      continue;
    }
    if (buf !== undefined) {
      commit();
    }
  }
  commit();
  return behaviors;
}

function parseGears(text: string): Map<string, GearsItem> {
  const items = new Map<string, GearsItem>();
  let currentPlayer: Player | undefined;
  let currentId: string | undefined;
  let buf: string[] | undefined;
  let resultGuards = new Map<string, string>();
  let exitedBlockquote = false;

  function commit(): void {
    if (currentId && currentPlayer && buf) {
      items.set(currentId, {
        id: currentId,
        player: currentPlayer,
        promptBody: buf.join('\n'),
        resultGuards: resultGuards,
      });
    }
    currentId = undefined;
    buf = undefined;
    resultGuards = new Map<string, string>();
    exitedBlockquote = false;
  }

  for (const line of text.split('\n')) {
    const playerMatch = /^## (Coder|Reviewer|Committer)\s*$/.exec(line);
    if (playerMatch) {
      commit();
      currentPlayer = playerMatch[1] as Player;
      continue;
    }
    const idMatch = /^### (CODE-\d+)\s*$/.exec(line);
    if (idMatch) {
      commit();
      currentId = idMatch[1];
      continue;
    }
    if (currentId) {
      const resultMatch = /^Result guard: `([^`]+)` — (.+)$/.exec(line);
      if (resultMatch) {
        resultGuards.set(resultMatch[1], resultMatch[2]);
        continue;
      }
    }
    if (!currentId || exitedBlockquote) continue;
    if (line.startsWith('> ')) {
      buf = buf ?? [];
      buf.push(line.slice(2));
    } else if (line === '>') {
      buf = buf ?? [];
      buf.push('');
    } else if (buf !== undefined) {
      exitedBlockquote = true;
    }
  }
  commit();
  return items;
}

const gearsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'code.gears.md',
);
const sourcePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'code.md',
);
const sourceBehaviors = parseSource(readFileSync(sourcePath, 'utf8'));
const gears = parseGears(readFileSync(gearsPath, 'utf8'));
const states = enumerateCaptainStates(codingMachine);
const fsmBySourceItem = new Map(states.map((s) => [s.sourceItem, s]));

describe('GEARS ↔ FSM conformance — gears parser sanity', () => {
  it('parses CODE-1..19 (19 items)', () => {
    expect(gears.size).toBe(19);
    for (let i = 1; i <= 19; i++) {
      expect(gears.has(`CODE-${i}`)).toBe(true);
    }
  });

  it('assigns each CODE-N to the correct player per section heading', () => {
    const expectedPlayer: Record<number, Player> = {
      1: 'Coder',
      2: 'Coder',
      3: 'Coder',
      4: 'Coder',
      5: 'Reviewer',
      6: 'Reviewer',
      7: 'Reviewer',
      8: 'Reviewer',
      9: 'Reviewer',
      10: 'Reviewer',
      11: 'Reviewer',
      12: 'Reviewer',
      13: 'Reviewer',
      14: 'Reviewer',
      15: 'Reviewer',
      16: 'Reviewer',
      17: 'Reviewer',
      18: 'Committer',
      19: 'Committer',
    };
    for (let i = 1; i <= 19; i++) {
      expect(gears.get(`CODE-${i}`)?.player).toBe(expectedPlayer[i]);
    }
  });

  it('captures a non-empty prompt body for every CODE-N', () => {
    for (const item of gears.values()) {
      expect(item.promptBody.length, item.id).toBeGreaterThan(0);
    }
  });

  it('source carries no Boss-reply annotation lines', () => {
    expect(readFileSync(sourcePath, 'utf8')).not.toContain(
      'Resumable: Boss reply',
    );
  });
});

describe('GEARS ↔ FSM conformance — assertions (a)–(g)', () => {
  it('(a) every CODE-N in gears has an FSM state with matching sourceItem', () => {
    for (const id of gears.keys()) {
      expect(fsmBySourceItem.has(id), `gears CODE-${id.slice(5)} has no FSM state`).toBe(true);
    }
  });

  it('(b) every FSM sourceItem resolves to a known CODE-N in gears', () => {
    for (const s of states) {
      expect(gears.has(s.sourceItem), `FSM state ${s.stateId} references unknown ${s.sourceItem}`).toBe(true);
    }
  });

  it('(c) each FSM state input.player matches the gears section player', () => {
    for (const s of states) {
      const g = gears.get(s.sourceItem);
      if (!g) continue; // (b) already caught it
      const input = s.getInput({});
      expect(
        input.player,
        `${s.stateId} (${s.sourceItem}): player drift`,
      ).toBe(g.player);
    }
  });

  it('(d) each FSM state input.prompt body equals the CODE-N blockquote body verbatim', () => {
    for (const s of states) {
      const g = gears.get(s.sourceItem);
      if (!g) continue;
      const input = s.getInput({});
      expect(
        input.prompt,
        `${s.stateId} (${s.sourceItem}): prompt drift`,
      ).toBe(g.promptBody);
    }
  });

  it('(e) FSM-generated needsBossReply declarations carry the parseable question marker', () => {
    const marker =
      "Output shall include `question: <verbatim question text from the player's prose>`.";

    for (const item of gears.values()) {
      expect(
        item.resultGuards.has('needsBossReply'),
        `${item.id}: GEARS output must not carry needsBossReply metadata`,
      ).toBe(false);
    }

    for (const s of states) {
      const fsmDescription = s.getInput({}).result.needsBossReply;
      expect(
        fsmDescription,
        `${s.stateId} (${s.sourceItem}): FSM result map missing needsBossReply`,
      ).toContain(marker);
    }
  });

  it('(f) every non-empty GEARS blockquote line is present in code.md source blockquotes', () => {
    const sourceLines = new Set(
      sourceBehaviors.flatMap((behavior) =>
        behavior.promptBody.split('\n').filter((line) => line !== ''),
      ),
    );
    const extraLines: string[] = [];

    for (const item of gears.values()) {
      for (const line of item.promptBody.split('\n')) {
        if (line !== '' && !sourceLines.has(line)) {
          extraLines.push(`${item.id}: ${line}`);
        }
      }
    }

    expect(extraLines).toEqual([]);
  });

  it('(g) neither source nor GEARS carries Boss-reply opt-in metadata', () => {
    expect(readFileSync(sourcePath, 'utf8')).not.toContain(
      'Resumable: Boss reply',
    );
    expect(
      [...gears.values()].filter((item) =>
        item.resultGuards.has('needsBossReply'),
      ),
    ).toEqual([]);
  });
});
