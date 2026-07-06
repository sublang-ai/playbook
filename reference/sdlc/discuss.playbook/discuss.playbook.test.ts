// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import createPlaybookRuntime, {
  _internal,
  type PlaybookPorts,
} from './discuss.playbook.ts';

const { requiredFieldsFor, parseAdjudication, normalizeErrorCompact } =
  _internal;

// The DISCUSS-5 wroteChanges description as authored in discuss.fsm.ts —
// one "Output shall include" sentence naming two fields. The integration
// test below exercises the live FSM text; this literal pins the parsing
// contract at unit level.
const WROTE_CHANGES_DESCRIPTION =
  'Host wrote the agreed changes. Output shall include `latestChanges: <summary>` and `reviewScope: "specItems" | "decisionRecords" | "mixed"`.';

describe('requiredFieldsFor (slc/link.md §Captain adjudication)', () => {
  it('extracts every field a single "Output shall include" sentence names', () => {
    // Regression: the previous regex anchored each field to the literal
    // phrase, so DISCUSS-5's second field (`reviewScope`) was silently
    // dropped, context.reviewScope stayed undefined, and the commit
    // state's onDone guard chain fell through to `failed`.
    expect(requiredFieldsFor(WROTE_CHANGES_DESCRIPTION)).toEqual([
      'latestChanges',
      'reviewScope',
    ]);
  });

  it('extracts a single named field', () => {
    expect(
      requiredFieldsFor(
        'Host proposed a design. Output shall include `proposal: <host proposal>`.',
      ),
    ).toEqual(['proposal']);
  });

  it('requires nothing from a "may include" description', () => {
    expect(
      requiredFieldsFor(
        'Committer made the initial-discussion commit. Output may include `latestChanges` and `reviewScope`.',
      ),
    ).toEqual([]);
  });

  it('scopes extraction to the "shall include" sentence', () => {
    expect(
      requiredFieldsFor(
        'Output shall include `alpha: <a>`. The reply may mention `beta: <b>`.',
      ),
    ).toEqual(['alpha']);
  });
});

describe('parseAdjudication (slc/link.md §Captain adjudication)', () => {
  const commitInput = {
    player: 'Committer' as const,
    sourceItem: 'DISCUSS-14',
    prompt: 'commit',
    result: {
      committed:
        'Committer made the initial-discussion commit. Output may include `latestChanges` and `reviewScope`.',
    },
  };

  it('carries non-required payload fields through to the output', () => {
    // Regression: only required fields used to be copied, so the judge's
    // volunteered `reviewScope` on the commit adjudication was dropped and
    // `outputOf(event).reviewScope ?? context.reviewScope` could never see
    // it. The judge answer is `{ guard, …payloadFields }` — payload fields
    // flow through.
    const output = parseAdjudication(
      JSON.stringify({
        guard: 'committed',
        latestChanges: 'Commit 753b6c8',
        reviewScope: 'mixed',
      }),
      commitInput,
    );
    expect(output).toEqual({
      guard: 'committed',
      latestChanges: 'Commit 753b6c8',
      reviewScope: 'mixed',
    });
  });

  it('rejects an invalid passthrough reviewScope loudly', () => {
    expect(() =>
      parseAdjudication(
        JSON.stringify({ guard: 'committed', reviewScope: 'everything' }),
        commitInput,
      ),
    ).toThrow(/invalid reviewScope "everything"/);
  });

  it('still fails loudly on a missing required field', () => {
    expect(() =>
      parseAdjudication(JSON.stringify({ guard: 'wroteChanges' }), {
        ...commitInput,
        sourceItem: 'DISCUSS-5',
        result: { wroteChanges: WROTE_CHANGES_DESCRIPTION },
      }),
    ).toThrow(/missing required field "latestChanges"/);
  });

  it('fails loudly when only the second required field is missing', () => {
    expect(() =>
      parseAdjudication(
        JSON.stringify({ guard: 'wroteChanges', latestChanges: 'lc' }),
        {
          ...commitInput,
          sourceItem: 'DISCUSS-5',
          result: { wroteChanges: WROTE_CHANGES_DESCRIPTION },
        },
      ),
    ).toThrow(/missing required field "reviewScope"/);
  });
});

describe('normalizeErrorCompact', () => {
  it('serializes a message-less object instead of "[object Object]"', () => {
    // Regression: a malformed CaptainOutput remembered as lastError used to
    // surface as `message: "[object Object]"`, hiding the payload that
    // explains the failure.
    expect(normalizeErrorCompact({ guard: 'committed' })).toEqual({
      name: 'Error',
      message: '{"guard":"committed"}',
    });
  });

  it('keeps Error name and message', () => {
    expect(normalizeErrorCompact(new TypeError('boom'))).toEqual({
      name: 'TypeError',
      message: 'boom',
    });
  });
});

// End-to-end regression for the production failure: a discussion flow whose
// judge replies mirror the failed run (commit adjudication answering
// `{ guard: "committed", latestChanges, reviewScope }`) must transition from
// commitInitialChanges into the review state and prompt the Participant —
// not fall into `failed` with lastError "[object Object]".
describe('commit → review transition (DISCUSS-14 → DISCUSS-10)', () => {
  it('continues into the mixed review after the Committer commits', async () => {
    const playerCalls: string[] = [];
    const telemetry: Array<Record<string, unknown>> = [];
    const judgeReplies = [
      JSON.stringify({
        event: 'START_DISCUSSION',
        topic: 'Decide spec heading case.',
      }),
      JSON.stringify({ guard: 'proposalMade', proposal: 'host proposal' }),
      JSON.stringify({
        guard: 'proposalMade',
        proposal: 'participant proposal',
      }),
      JSON.stringify({ guard: 'endedInitialDiscussion', agreement: 'agreed' }),
      JSON.stringify({ guard: 'endedInitialDiscussion', agreement: 'agreed' }),
      JSON.stringify({
        guard: 'wroteChanges',
        latestChanges: 'Created DR-001',
        reviewScope: 'mixed',
      }),
      // The commit adjudication reply observed in the failed run: guard plus
      // volunteered payload fields on a "may include" description.
      JSON.stringify({
        guard: 'committed',
        latestChanges: 'Commit 753b6c8',
        reviewScope: 'mixed',
      }),
      JSON.stringify({ guard: 'noFindings' }),
      JSON.stringify({ guard: 'committed' }),
    ];
    let judgeIndex = 0;

    const ports: PlaybookPorts = {
      callPlayer: async (playerId) => {
        playerCalls.push(playerId);
        return { status: 'ok', finalText: `${playerId} output` };
      },
      callJudge: async () => {
        const reply = judgeReplies[judgeIndex++];
        if (reply === undefined) {
          throw new Error(`unscripted judge call #${judgeIndex}`);
        }
        return reply;
      },
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        telemetry.push(event.payload as Record<string, unknown>);
      },
    };

    const runtime = createPlaybookRuntime({});
    await runtime.init(ports);
    await runtime.handleBossInput({
      text: 'Decide spec heading case.',
      signal: new AbortController().signal,
    });
    await runtime.dispose();

    const visited = telemetry.map((payload) => payload.to);
    expect(visited).not.toContain('failed');
    expect(visited).toContain('commitInitialChanges');
    expect(visited).toContain('reviewMixedInitialCommit');
    expect(visited).toContain('done');
    // Host, Participant, rounds, agreement write, commit (Committer→Host),
    // Participant review, reviewed commit — the review call is the one the
    // regression used to lose.
    expect(playerCalls).toContain('participant');
    expect(playerCalls[playerCalls.length - 2]).toBe('participant');
  });
});
