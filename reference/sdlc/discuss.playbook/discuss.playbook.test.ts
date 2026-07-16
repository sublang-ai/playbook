// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { validatePlayerResult } from '../../../src/xstate-runtime.js';
import createPlaybookRuntime, {
  _internal,
  type PlayerCallOptions,
  type PlaybookPorts,
  type PlaybookSession,
  type PlaybookTraceEvent,
} from './discuss.playbook.ts';

const {
  requiredFieldsFor,
  extractJson,
  parseAdjudication,
  parseClassification,
  combineSignals,
  normalizeErrorCompact,
} = _internal;

// The DISCUSS-5 wroteChanges description as authored in discuss.fsm.ts —
// one "Output shall include" sentence naming two fields. The integration
// test below exercises the live FSM text; this literal pins the parsing
// contract at unit level.
const WROTE_CHANGES_DESCRIPTION =
  'Host wrote the agreed changes. Output shall include `latestChanges: <summary>` and `reviewScope: "specItems" | "decisionRecords" | "mixed"`.';

const signal = (): AbortSignal => new AbortController().signal;

const discussRuntimeSource = readFileSync(
  new URL('./discuss.playbook.ts', import.meta.url),
  'utf8',
);

const SHARED_RUNTIME_TYPES = [
  'JsonValue',
  'NormalizedError',
  'PlayerCallOptions',
  'PlayerResult',
  'PlaybookCallRequest',
  'PlaybookCallResult',
  'PlaybookCallStart',
  'PlaybookPendingCall',
  'PlaybookPorts',
  'PlaybookRunResult',
  'PlaybookRuntime',
  'PlaybookRuntimeFactory',
  'PlaybookSession',
  'PlaybookState',
  'PlaybookStateValue',
  'PlaybookTraceEvent',
  'PlaybookTraceType',
] as const;

function playbookSession(
  ports: PlaybookPorts,
  sessionId = 'discuss-session-1',
): PlaybookSession {
  return {
    sessionId,
    playbookId: 'discuss',
    rootSessionId: sessionId,
    depth: 0,
    ports: completePlaybookPorts(ports),
  };
}

function completePlaybookPorts(ports: PlaybookPorts): PlaybookPorts {
  const callCaptain =
    typeof ports.callCaptain === 'function'
      ? ports.callCaptain
      : async () => {
          throw new Error('unexpected direct Captain call');
        };
  return { ...ports, callCaptain };
}

type TraceEvent = Omit<PlaybookTraceEvent, 'payload'> & {
  payload: Record<string, unknown>;
};

function terminalDiscussionJudgeReplies(
  topic = 'Decide spec heading case.',
): string[] {
  return [
    JSON.stringify({ event: 'START_DISCUSSION', topic }),
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
    JSON.stringify({
      guard: 'committed',
      latestChanges: 'Commit 753b6c8',
      reviewScope: 'mixed',
    }),
    JSON.stringify({ guard: 'noFindings' }),
    JSON.stringify({ guard: 'committed' }),
  ];
}

describe('DISCUSS shared runtime declaration surface (PBRT-5)', () => {
  it('imports and re-exports every shared contract type without redefining it', () => {
    const imported = discussRuntimeSource.match(
      /import type \{([\s\S]*?)\} from '@sublang\/playbook\/runtime';/,
    )?.[0];
    const reexported = discussRuntimeSource.match(
      /export type \{([\s\S]*?)\};/,
    )?.[0];
    expect(imported).toBeDefined();
    expect(reexported).toBeDefined();
    for (const name of SHARED_RUNTIME_TYPES) {
      expect(imported).toContain(name);
      expect(reexported).toContain(name);
      expect(discussRuntimeSource).not.toMatch(
        new RegExp(`\\b(?:interface|type)\\s+${name}\\b`),
      );
    }
  });
});

describe('PlayerResult port boundary', () => {
  it('detaches and freezes an exact valid result', () => {
    const mutable = {
      status: 'ok' as const,
      resumeToken: 'player-session-1',
      finalText: 'original result',
    };
    const result = validatePlayerResult(mutable);
    mutable.finalText = 'mutated after resolution';

    expect(result).toEqual({
      status: 'ok',
      resumeToken: 'player-session-1',
      finalText: 'original result',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ['non-object', 'ok', 'must be an object'],
    ['unknown status', { status: 'pending' }, 'status is invalid'],
    [
      'unknown field',
      { status: 'ok', finalText: 'text', privateState: 'hidden' },
      'privateState is not a declared property',
    ],
    [
      'non-string final text',
      { status: 'ok', finalText: 42 },
      'finalText must be a string',
    ],
    [
      'undefined optional field',
      { status: 'ok', resumeToken: undefined },
      'resumeToken must be a JSON value',
    ],
  ])('rejects a malformed %s', (_label, malformed, message) => {
    expect(() => validatePlayerResult(malformed)).toThrow(message as string);
  });
});

describe('runtime option snapshots', () => {
  it('rejects strict-JSON violations before constructing a runtime', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.ignored = cyclic;
    expect(() => createPlaybookRuntime(cyclic as never)).toThrow(
      'must not contain a JSON cycle',
    );
    expect(() =>
      createPlaybookRuntime(
        Object.defineProperty({}, 'host', {
          enumerable: true,
          get: () => 'host',
        }) as never,
      ),
    ).toThrow('must be a JSON data property');
  });

  it('detaches player binding from later option mutation', async () => {
    const options = { playerBinding: { Participant: 'original-participant' } };
    const playerIds: string[] = [];
    const runtime = createPlaybookRuntime(options);
    options.playerBinding.Participant = 'mutated-participant';
    const ports: PlaybookPorts = {
      callPlayer: async (playerId) => {
        playerIds.push(playerId);
        return { status: 'error', error: 'stop after routing check' };
      },
      callJudge: async () =>
        JSON.stringify({
          event: 'START_REVIEW',
          latestChanges: 'detached option review',
          reviewScope: 'mixed',
        }),
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      emitStatus: async () => {},
      emitTelemetry: async () => {},
    };
    await runtime.init(playbookSession(ports, 'detached-options'));

    await runtime.handleBossInput({ text: 'write', signal: signal() });
    expect(playerIds).toEqual(['original-participant']);
    await runtime.dispose();
  });
});

describe('delegated-player final text boundary', () => {
  it('fails the invoked state without adjudicating an absent finalText', async () => {
    let judgeCalls = 0;
    const ports: PlaybookPorts = {
      callPlayer: async () => ({ status: 'ok' }),
      callJudge: async () => {
        judgeCalls += 1;
        return JSON.stringify({
          event: 'START_REVIEW',
          latestChanges: 'missing final text review',
          reviewScope: 'mixed',
        });
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      emitStatus: async () => {},
      emitTelemetry: async () => {},
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'missing-final-text'));

    await expect(
      runtime.handleBossInput({ text: 'write it', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'failed' });
    expect(judgeCalls).toBe(1);
    await runtime.dispose();
  });
});

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

describe('tolerant judge JSON extraction', () => {
  it('repairs trailing commas and truncated object/string tails', () => {
    expect(extractJson('{"event":"START_DISCUSSION","topic":"x",}')).toEqual({
      event: 'START_DISCUSSION',
      topic: 'x',
    });
    expect(extractJson('{"guard":"proposalMade","proposal":"draft"')).toEqual({
      guard: 'proposalMade',
      proposal: 'draft',
    });
    expect(extractJson('{"guard":"proposalMade","proposal":"draft')).toEqual({
      guard: 'proposalMade',
      proposal: 'draft',
    });
  });

  it('skips bracketed prose fragments and accepts a whole code fence', () => {
    expect(
      extractJson('See [1] and {n/a}; final: {"guard":"proposalMade"}'),
    ).toEqual({ guard: 'proposalMade' });
    expect(
      extractJson('```json\n{"event":"START_DISCUSSION","topic":"x"}\n```'),
    ).toEqual({ event: 'START_DISCUSSION', topic: 'x' });
    expect(extractJson('[{"guard":"proposalMade"}]')).toBeNull();
  });

  it('prefers the earliest recoverable object over a later clean decoy', () => {
    expect(
      extractJson(
        'Decision: {"guard":"proposalMade","proposal":"first",}\n' +
          'Example: {"guard":"needsBossReply","question":"decoy"}',
      ),
    ).toEqual({
      guard: 'proposalMade',
      proposal: 'first',
    });
  });

  it('applies the same recovery to classification and adjudication', () => {
    expect(
      parseClassification(
        'Result: {"event":"START_DISCUSSION","topic":"Recovered",}',
      ),
    ).toEqual({ type: 'START_DISCUSSION', topic: 'Recovered' });
    expect(
      parseAdjudication('{"guard":"proposalMade","proposal":"Recovered', {
        stateId: 'askHostInitial',
        player: 'Host',
        sourceItem: 'DISCUSS-1',
        prompt: 'propose',
        result: {
          proposalMade:
            'Host proposed. Output shall include `proposal: <proposal>`.',
        },
      }),
    ).toMatchObject({ guard: 'proposalMade', proposal: 'Recovered' });
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

describe('parseClassification (parallel Boss questions)', () => {
  const answer = JSON.stringify({ event: 'BOSS_REPLY', answer: 'Proceed.' });

  it('fills the sole pending question id', () => {
    expect(parseClassification(answer, ['askHostInitial'])).toEqual({
      type: 'BOSS_REPLY',
      questionId: 'askHostInitial',
      answer: 'Proceed.',
    });
  });

  it('rejects an omitted or unknown id when multiple questions are pending', () => {
    const pending = ['askHostInitial', 'askParticipantInitial'];
    expect(parseClassification(answer, pending)).toBeNull();
    expect(
      parseClassification(
        JSON.stringify({
          event: 'BOSS_REPLY',
          questionId: 'hostInitialRound',
          answer: 'Proceed.',
        }),
        pending,
      ),
    ).toBeNull();
  });

  it('routes an explicitly identified pending branch', () => {
    expect(
      parseClassification(
        JSON.stringify({
          event: 'BOSS_REPLY',
          questionId: 'askParticipantInitial',
          answer: 'Proceed.',
        }),
        ['askHostInitial', 'askParticipantInitial'],
      ),
    ).toEqual({
      type: 'BOSS_REPLY',
      questionId: 'askParticipantInitial',
      answer: 'Proceed.',
    });
  });

  it('exposes parallel parents, not branch leaves, as interrupt targets', () => {
    expect(_internal.BOSS_INTERRUPT_TARGETS).toEqual(
      expect.arrayContaining(['initialProposalRound', 'reconciliationRound']),
    );
    for (const branchId of [
      'askHostInitial',
      'askParticipantInitial',
      'hostInitialRound',
      'participantInitialRound',
      'awaitBossReply',
    ]) {
      expect(_internal.BOSS_INTERRUPT_TARGETS).not.toContain(branchId);
      expect(
        parseClassification(
          JSON.stringify({ event: 'BOSS_INTERRUPT', targetId: branchId }),
        ),
      ).toBeNull();
    }
  });
});

describe('normalizeErrorCompact', () => {
  it('rejects an invalid abort signal instead of silently dropping it', () => {
    expect(() =>
      combineSignals({} as AbortSignal, undefined),
    ).toThrow('abort signal 0 must be an AbortSignal');
  });

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
    // The commit adjudication reply in this script mirrors the failed run:
    // guard plus volunteered payload fields on a "may include" description.
    const judgeReplies = terminalDiscussionJudgeReplies();
    let judgeIndex = 0;

    const ports: PlaybookPorts = {
      callPlayer: async (playerId) => {
        playerCalls.push(playerId);
        return { status: 'ok', finalText: `${playerId} output` };
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
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
        if (event.topic === 'playbook.fsm.state') {
          telemetry.push(event.payload as Record<string, unknown>);
        }
      },
    };

    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports));
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

describe('parallel runtime execution (PBRT-40/41/43)', () => {
  it.each(['host', 'participant'] as const)(
    'joins real initial/reconciliation calls when %s completes first',
    async (firstPlayer) => {
      interface GatedPlayerCall {
        playerId: string;
        invocation: number;
        prompt: string;
        signal: AbortSignal;
        resolve(result: { status: 'ok'; finalText: string }): void;
      }

      const calls: GatedPlayerCall[] = [];
      const invocationCounts = new Map<string, number>();
      const initialAdjudicated = new Set<string>();
      const reconciliationAdjudicated = new Set<string>();
      let writerPrompt: string | undefined;
      const ports: PlaybookPorts = {
        callPlayer: async (playerId, prompt, callSignal) => {
          const invocation = (invocationCounts.get(playerId) ?? 0) + 1;
          invocationCounts.set(playerId, invocation);
          if (playerId === 'host' && invocation === 3) {
            writerPrompt = prompt;
            return { status: 'error', error: 'stop after joined rounds' };
          }
          return new Promise((resolve) => {
            calls.push({
              playerId,
              invocation,
              prompt,
              signal: callSignal,
              resolve,
            });
          });
        },
        callPlaybook: async () => {
          throw new Error('unexpected nested playbook call');
        },
        callJudge: async (prompt) => {
          if (prompt.includes('Boss-input classifier')) {
            return JSON.stringify({
              event: 'START_DISCUSSION',
              topic: 'Ordered parallel rounds.',
            });
          }
          for (const playerId of ['host', 'participant']) {
            if (prompt.includes(`${playerId}-initial-output`)) {
              initialAdjudicated.add(playerId);
              return JSON.stringify({
                guard: 'proposalMade',
                proposal: `${playerId} v1`,
              });
            }
            if (prompt.includes(`${playerId}-reconciliation-output`)) {
              reconciliationAdjudicated.add(playerId);
              return JSON.stringify({
                guard: 'endedInitialDiscussion',
                agreement: `${playerId} agreement`,
              });
            }
          }
          throw new Error(`unexpected judge prompt: ${prompt}`);
        },
        emitStatus: async () => {},
        emitTelemetry: async () => {},
      };
      const runtime = createPlaybookRuntime({});
      await runtime.init(
        playbookSession(ports, `ordered-${firstPlayer}-session`),
      );
      const turn = runtime.handleBossInput({
        text: 'Start ordered rounds.',
        signal: signal(),
      });

      await vi.waitFor(() => {
        expect(calls.filter((call) => call.invocation === 1)).toHaveLength(2);
      });
      const secondPlayer = firstPlayer === 'host' ? 'participant' : 'host';
      const initial = (playerId: string): GatedPlayerCall =>
        calls.find(
          (call) => call.playerId === playerId && call.invocation === 1,
        )!;
      initial(firstPlayer).resolve({
        status: 'ok',
        finalText: `${firstPlayer}-initial-output`,
      });
      await vi.waitFor(() => {
        expect(initialAdjudicated.has(firstPlayer)).toBe(true);
      });
      expect(calls.filter((call) => call.invocation === 2)).toHaveLength(0);
      initial(secondPlayer).resolve({
        status: 'ok',
        finalText: `${secondPlayer}-initial-output`,
      });

      await vi.waitFor(() => {
        expect(calls.filter((call) => call.invocation === 2)).toHaveLength(2);
      });
      const reconciliation = (playerId: string): GatedPlayerCall =>
        calls.find(
          (call) => call.playerId === playerId && call.invocation === 2,
        )!;
      expect(reconciliation('host').prompt).toContain(
        "Other agent's proposal: participant v1",
      );
      expect(reconciliation('host').prompt).toContain(
        'Your previous proposal: host v1',
      );
      expect(reconciliation('participant').prompt).toContain(
        "Other agent's proposal: host v1",
      );
      expect(reconciliation('participant').prompt).toContain(
        'Your previous proposal: participant v1',
      );
      reconciliation(firstPlayer).resolve({
        status: 'ok',
        finalText: `${firstPlayer}-reconciliation-output`,
      });
      await vi.waitFor(() => {
        expect(reconciliationAdjudicated.has(firstPlayer)).toBe(true);
      });
      expect(writerPrompt).toBeUndefined();
      expect(reconciliation(secondPlayer).signal.aborted).toBe(false);
      reconciliation(secondPlayer).resolve({
        status: 'ok',
        finalText: `${secondPlayer}-reconciliation-output`,
      });

      const result = await turn;
      expect(result.outcome).toBe('failed');
      expect(writerPrompt).toContain('Agreement: participant agreement');
      await runtime.dispose();
    },
  );

  it('overlaps distinct players, serializes judges, and keys branch replies', async () => {
    const fsmTelemetry: Array<Record<string, unknown>> = [];
    const playerCounts = new Map<string, number>();
    const resumedPlayers: string[] = [];
    const initiallyStarted = new Set<string>();
    let resolveBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    let releaseInitialPlayers!: () => void;
    const initialPlayerGate = new Promise<void>((resolve) => {
      releaseInitialPlayers = resolve;
    });
    let activePlayers = 0;
    let maxActivePlayers = 0;
    let activeJudges = 0;
    let maxActiveJudges = 0;
    let classifierCalls = 0;

    const ports: PlaybookPorts = {
      callPlayer: async (playerId) => {
        const count = (playerCounts.get(playerId) ?? 0) + 1;
        playerCounts.set(playerId, count);
        if (count > 1) {
          resumedPlayers.push(playerId);
          return { status: 'error', error: 'stop after branch selection' };
        }

        activePlayers++;
        maxActivePlayers = Math.max(maxActivePlayers, activePlayers);
        initiallyStarted.add(playerId);
        if (initiallyStarted.size === 2) resolveBothStarted();
        await initialPlayerGate;
        activePlayers--;
        return { status: 'ok', finalText: `${playerId} proposal` };
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async (prompt) => {
        activeJudges++;
        maxActiveJudges = Math.max(maxActiveJudges, activeJudges);
        await Promise.resolve();
        try {
          if (prompt.includes('Boss-input classifier')) {
            classifierCalls++;
            if (classifierCalls === 1) {
              return JSON.stringify({
                event: 'START_DISCUSSION',
                topic: 'Parallel topic.',
              });
            }
            if (classifierCalls === 2) {
              return JSON.stringify({
                event: 'BOSS_REPLY',
                answer: 'Ambiguous answer.',
              });
            }
            return JSON.stringify({
              event: 'BOSS_REPLY',
              questionId: 'askParticipantInitial',
              answer: 'Participant answer.',
            });
          }
          return JSON.stringify({
            guard: 'needsBossReply',
            question: prompt.includes('host proposal')
              ? 'Host question?'
              : 'Participant question?',
          });
        } finally {
          activeJudges--;
        }
      },
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.fsm.state') {
          fsmTelemetry.push(event.payload as Record<string, unknown>);
        }
      },
    };

    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'parallel-runtime-session'));
    const firstTurn = runtime.handleBossInput({
      text: 'Start parallel discussion.',
      signal: signal(),
    });
    await bothStarted;
    expect(initiallyStarted).toEqual(new Set(['host', 'participant']));
    expect(maxActivePlayers).toBe(2);
    releaseInitialPlayers();

    const parked = await firstTurn;
    expect(parked).toMatchObject({
      outcome: 'quiescent',
      state: {
        activeStateIds: [
          'initialProposalHost',
          'initialProposalParticipant',
          'initialProposalRound',
          'waitHostInitialReply',
          'waitParticipantInitialReply',
        ],
        quiescent: true,
      },
    });
    expect(maxActiveJudges).toBe(1);
    expect(
      fsmTelemetry.some((payload) => {
        const pending = payload.pendingBossQuestions;
        return Array.isArray(pending) && pending.length === 2;
      }),
    ).toBe(true);

    const ambiguous = await runtime.handleBossInput({
      text: 'Ambiguous answer.',
      signal: signal(),
    });
    expect(ambiguous.outcome).toBe('no-action');
    expect(resumedPlayers).toEqual([]);

    const selected = await runtime.handleBossInput({
      text: 'Answer Participant only.',
      signal: signal(),
    });
    expect(selected.outcome).toBe('failed');
    expect(resumedPlayers).toEqual(['participant']);
    await runtime.dispose();
  });

  it('parks and resumes a sole real-runtime branch question by implicit id', async () => {
    const playerCounts = new Map<string, number>();
    let classifierCalls = 0;
    const ports: PlaybookPorts = {
      callPlayer: async (playerId) => {
        const count = (playerCounts.get(playerId) ?? 0) + 1;
        playerCounts.set(playerId, count);
        return count === 1
          ? { status: 'ok', finalText: `${playerId} initial` }
          : { status: 'error', error: 'stop after sole branch resumed' };
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Boss-input classifier')) {
          classifierCalls++;
          return classifierCalls === 1
            ? JSON.stringify({
                event: 'START_DISCUSSION',
                topic: 'One branch question.',
              })
            : JSON.stringify({
                event: 'BOSS_REPLY',
                answer: 'Implicit Host answer.',
              });
        }
        return prompt.includes('host initial')
          ? JSON.stringify({
              guard: 'needsBossReply',
              question: 'Host-only question?',
            })
          : JSON.stringify({
              guard: 'proposalMade',
              proposal: 'participant v1',
            });
      },
      emitStatus: async () => {},
      emitTelemetry: async () => {},
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'sole-question-session'));

    const parked = await runtime.handleBossInput({
      text: 'Start.',
      signal: signal(),
    });
    expect(parked).toMatchObject({
      outcome: 'quiescent',
      state: {
        activeStateIds: [
          'initialProposalHost',
          'initialProposalParticipant',
          'initialProposalRound',
          'participantInitialProposalComplete',
          'waitHostInitialReply',
        ],
      },
    });

    const resumed = await runtime.handleBossInput({
      text: 'Answer the only question.',
      signal: signal(),
    });
    expect(resumed.outcome).toBe('failed');
    expect(playerCounts).toEqual(
      new Map([
        ['host', 2],
        ['participant', 1],
      ]),
    );
    await runtime.dispose();
  });

  it('rejects overlapping calls that resolve to the same player id', async () => {
    const playerCalls: string[] = [];
    const ports: PlaybookPorts = {
      callPlayer: async (playerId, _prompt, callSignal) => {
        playerCalls.push(playerId);
        if (callSignal.aborted) throw callSignal.reason;
        await new Promise<void>((_resolve, reject) => {
          callSignal.addEventListener(
            'abort',
            () => reject(callSignal.reason),
            { once: true },
          );
        });
        return { status: 'ok' };
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () =>
        JSON.stringify({ event: 'START_DISCUSSION', topic: 'Collision.' }),
      emitStatus: async () => {},
      emitTelemetry: async () => {},
    };
    const runtime = createPlaybookRuntime({
      playerBinding: { Host: 'same', Participant: 'same' },
    });
    await runtime.init(playbookSession(ports, 'same-player-session'));

    const result = await runtime.handleBossInput({
      text: 'Start.',
      signal: signal(),
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      state: { activeStateIds: ['failed'], quiescent: true },
    });
    expect(playerCalls.length).toBeLessThanOrEqual(1);
    expect(new Set(playerCalls)).toEqual(
      playerCalls.length === 0 ? new Set() : new Set(['same']),
    );
    await runtime.dispose();
  });

  it('cancels a sibling branch and drains its boundary/emission trace on failure', async () => {
    const traces: TraceEvent[] = [];
    const fsmTelemetry: Array<Record<string, unknown>> = [];
    const startedPlayers = new Set<string>();
    let resolveBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    let releaseLateParticipant!: () => void;
    const lateParticipantGate = new Promise<void>((resolve) => {
      releaseLateParticipant = resolve;
    });
    let participantCancelled = false;
    let participantResumeAfterFailure: string | false | undefined;
    let classifierCalls = 0;
    const playerCounts = new Map<string, number>();
    let pendingEmissions = 0;
    const ports: PlaybookPorts = {
      callPlayer: async (playerId, _prompt, callSignal, options) => {
        const count = (playerCounts.get(playerId) ?? 0) + 1;
        playerCounts.set(playerId, count);
        if (playerId === 'participant' && count === 2) {
          participantResumeAfterFailure = options.resume;
          return { status: 'error', error: 'stop after continuity assertion' };
        }
        startedPlayers.add(playerId);
        if (startedPlayers.size === 2) resolveBothStarted();
        if (playerId === 'host') {
          await bothStarted;
          return { status: 'error', error: 'host branch failed' };
        }
        await new Promise<void>((resolve) => {
          const onAbort = (): void => {
            participantCancelled = true;
            resolve();
          };
          if (callSignal.aborted) onAbort();
          else callSignal.addEventListener('abort', onAbort, { once: true });
        });
        await lateParticipantGate;
        return {
          status: 'ok',
          resumeToken: 'late-participant-token',
          finalText: 'late participant success',
        };
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async (prompt) => {
        if (!prompt.includes('Boss-input classifier')) {
          throw new Error('unexpected adjudication after branch failure');
        }
        classifierCalls++;
        return classifierCalls === 1
          ? JSON.stringify({
              event: 'START_DISCUSSION',
              topic: 'Failure cancellation.',
            })
          : JSON.stringify({
              event: 'START_REVIEW',
              latestChanges: 'continuity review',
              reviewScope: 'mixed',
            });
      },
      emitStatus: async () => {
        pendingEmissions++;
        await Promise.resolve();
        pendingEmissions--;
      },
      emitTelemetry: async (event) => {
        pendingEmissions++;
        try {
          await Promise.resolve();
          if (event.topic === 'playbook.trace') {
            traces.push(event.payload as TraceEvent);
          } else if (event.topic === 'playbook.fsm.state') {
            fsmTelemetry.push(event.payload as Record<string, unknown>);
          }
        } finally {
          pendingEmissions--;
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'branch-failure-session'));

    let firstTurnSettled = false;
    const firstTurn = runtime.handleBossInput({
      text: 'Start failing branches.',
      signal: signal(),
    });
    void firstTurn.then(
      () => {
        firstTurnSettled = true;
      },
      () => {
        firstTurnSettled = true;
      },
    );
    await vi.waitFor(() => {
      expect(participantCancelled).toBe(true);
    });

    expect(firstTurnSettled).toBe(false);
    expect(
      traces.find(
        (trace) => trace.type === 'boss.input.settled' && trace.turnId === 1,
      ),
    ).toBeUndefined();
    expect(
      traces.find(
        (trace) =>
          trace.type === 'player.call.finished' &&
          trace.payload.playerId === 'participant',
      ),
    ).toBeUndefined();
    expect(JSON.stringify(traces)).not.toContain('late-participant-token');
    releaseLateParticipant();
    const result = await firstTurn;

    expect(result).toMatchObject({
      outcome: 'failed',
      state: { activeStateIds: ['failed'], quiescent: true },
      error: {
        name: 'Error',
        message: 'player "host" returned status "error": host branch failed',
      },
    });
    expect(startedPlayers).toEqual(new Set(['host', 'participant']));
    expect(participantCancelled).toBe(true);
    expect(pendingEmissions).toBe(0);
    expect(fsmTelemetry.at(-1)).toMatchObject({
      state: { activeStateIds: ['failed'], quiescent: true },
      lastError: {
        name: 'Error',
        message: 'player "host" returned status "error": host branch failed',
      },
    });
    const finished = traces.filter(
      (trace) => trace.type === 'player.call.finished',
    );
    expect(finished).toHaveLength(2);
    expect(finished.map((trace) => trace.payload.status).sort()).toEqual([
      'aborted',
      'error',
    ]);
    expect(JSON.stringify(traces)).not.toContain('late-participant-token');
    expect(JSON.stringify(traces)).not.toContain('late participant success');
    const settled = traces.find(
      (trace) => trace.type === 'boss.input.settled' && trace.turnId === 1,
    );
    expect(settled).toBeDefined();
    for (const finish of finished) {
      expect(finish.sequence).toBeLessThan(settled!.sequence);
    }
    await runtime.handleBossInput({
      text: 'Check Participant continuity.',
      signal: signal(),
    });
    expect(participantResumeAfterFailure).toBe(false);
    await runtime.dispose();
  });

  it('drains a cancelled late judge wrapper before settling the failed turn', async () => {
    const traces: TraceEvent[] = [];
    let markParticipantJudgeStarted!: () => void;
    const participantJudgeStarted = new Promise<void>((resolve) => {
      markParticipantJudgeStarted = resolve;
    });
    let releaseLateJudge!: () => void;
    const lateJudgeGate = new Promise<void>((resolve) => {
      releaseLateJudge = resolve;
    });
    let lateJudgeCancelled = false;
    const ports: PlaybookPorts = {
      callPlayer: async (playerId) => {
        if (playerId === 'host') {
          await participantJudgeStarted;
          return {
            status: 'error',
            error: 'host failed during sibling adjudication',
          };
        }
        return { status: 'ok', finalText: 'participant output for late judge' };
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async (prompt, judgeSignal) => {
        if (prompt.includes('Boss-input classifier')) {
          return JSON.stringify({
            event: 'START_DISCUSSION',
            topic: 'Late judge cancellation.',
          });
        }
        if (!prompt.includes('participant output for late judge')) {
          throw new Error('unexpected adjudicator prompt');
        }
        markParticipantJudgeStarted();
        await new Promise<void>((resolve) => {
          const onAbort = (): void => {
            lateJudgeCancelled = true;
            resolve();
          };
          if (judgeSignal.aborted) onAbort();
          else judgeSignal.addEventListener('abort', onAbort, { once: true });
        });
        await lateJudgeGate;
        return JSON.stringify({
          guard: 'proposalMade',
          proposal: 'late judge proposal',
        });
      },
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'late-judge-session'));
    let turnSettled = false;
    const turn = runtime.handleBossInput({
      text: 'Start.',
      signal: signal(),
    });
    void turn.then(
      () => {
        turnSettled = true;
      },
      () => {
        turnSettled = true;
      },
    );
    await vi.waitFor(() => {
      expect(lateJudgeCancelled).toBe(true);
    });

    expect(turnSettled).toBe(false);
    expect(
      traces.find(
        (trace) => trace.type === 'boss.input.settled' && trace.turnId === 1,
      ),
    ).toBeUndefined();
    expect(
      traces.find(
        (trace) =>
          trace.type === 'judge.call.finished' &&
          trace.payload.purpose === 'player-output-adjudication',
      ),
    ).toBeUndefined();
    releaseLateJudge();

    const result = await turn;
    expect(result).toMatchObject({
      outcome: 'failed',
      error: {
        name: 'Error',
        message:
          'player "host" returned status "error": host failed during sibling adjudication',
      },
    });
    const lateFinish = traces.find(
      (trace) =>
        trace.type === 'judge.call.finished' &&
        trace.payload.purpose === 'player-output-adjudication',
    );
    expect(lateFinish).toMatchObject({ payload: { status: 'aborted' } });
    expect(lateFinish?.payload).not.toHaveProperty('reply');
    expect(JSON.stringify(traces)).not.toContain('late judge proposal');
    const settled = traces.find(
      (trace) => trace.type === 'boss.input.settled' && trace.turnId === 1,
    );
    expect(lateFinish!.sequence).toBeLessThan(settled!.sequence);
    await runtime.dispose();
  });
});

describe('DISCUSS runtime queue and lifecycle regressions', () => {
  it('attempts a judge finish when the start trace records then rejects', async () => {
    const traces: TraceEvent[] = [];
    const startError = new Error('judge start sink failed after recording');
    const ports: PlaybookPorts = {
      callPlayer: async () => ({ status: 'error', error: 'unexpected' }),
      callJudge: async () => '{}',
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as TraceEvent;
        traces.push(trace);
        if (trace.type === 'judge.call.started') throw startError;
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'judge-start-sink'));

    await expect(
      runtime.handleBossInput({ text: 'classify', signal: signal() }),
    ).rejects.toBe(startError);
    const starts = traces.filter(
      (trace) => trace.type === 'judge.call.started',
    );
    const finishes = traces.filter(
      (trace) => trace.type === 'judge.call.finished',
    );
    expect(starts).toHaveLength(1);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.callId).toBe(starts[0]?.callId);
    expect(finishes[0]?.payload).toMatchObject({ status: 'error' });
    await runtime.dispose();
  });

  it('never retries a player finish trace whose sink records then rejects', async () => {
    const traces: TraceEvent[] = [];
    const sinkError = new TypeError('player finish trace sink failed');
    let rejectFirstFinish = true;
    const ports: PlaybookPorts = {
      callPlayer: async () => ({
        status: 'ok',
        resumeToken: 'host-session',
        finalText: 'written changes',
      }),
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async (prompt) =>
        prompt.includes('Boss-input classifier')
          ? JSON.stringify({
              event: 'START_REVIEW',
              latestChanges: 'finish sink review',
              reviewScope: 'mixed',
            })
          : JSON.stringify({
              guard: 'wroteChanges',
              latestChanges: 'updated specs',
              reviewScope: 'specItems',
            }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as TraceEvent;
        traces.push(trace);
        if (trace.type === 'player.call.finished' && rejectFirstFinish) {
          rejectFirstFinish = false;
          throw sinkError;
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'single-finish-session'));

    await expect(
      runtime.handleBossInput({ text: 'write it', signal: signal() }),
    ).rejects.toBe(sinkError);

    const starts = traces.filter(
      (trace) => trace.type === 'player.call.started',
    );
    expect(starts).toHaveLength(1);
    expect(
      traces.filter(
        (trace) =>
          trace.type === 'player.call.finished' &&
          trace.callId === starts[0].callId,
      ),
    ).toHaveLength(1);
    await runtime.dispose();
  });

  it('preserves a judge port error when its paired finish trace also rejects', async () => {
    const traces: TraceEvent[] = [];
    const judgeError = new TypeError('judge transport failed');
    const sinkError = new Error('judge finish trace sink failed');
    let rejectFinish = true;
    const ports: PlaybookPorts = {
      callPlayer: async () => ({ status: 'error', error: 'unexpected player' }),
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () => {
        throw judgeError;
      },
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as TraceEvent;
        traces.push(trace);
        if (trace.type === 'judge.call.finished' && rejectFinish) {
          rejectFinish = false;
          throw sinkError;
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'judge-finish-precedence'));

    await expect(
      runtime.handleBossInput({ text: 'classify me', signal: signal() }),
    ).rejects.toBe(judgeError);

    const starts = traces.filter(
      (trace) => trace.type === 'judge.call.started',
    );
    expect(starts).toHaveLength(1);
    expect(
      traces.filter(
        (trace) =>
          trace.type === 'judge.call.finished' &&
          trace.callId === starts[0].callId,
      ),
    ).toHaveLength(1);
    await expect(
      runtime.handleBossInput({ text: ' ', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'no-action' });
    await runtime.dispose();
  });

  it('preserves a player port error when its paired finish trace also rejects', async () => {
    const traces: TraceEvent[] = [];
    const playerError = new TypeError('original participant port error');
    const sinkError = new Error('participant finish sink error');
    let rejectFinish = true;
    const ports: PlaybookPorts = {
      callPlayer: async () => {
        throw playerError;
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () =>
        JSON.stringify({
          event: 'START_REVIEW',
          latestChanges: 'review this change',
          reviewScope: 'mixed',
        }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as TraceEvent;
        traces.push(trace);
        if (trace.type === 'player.call.finished' && rejectFinish) {
          rejectFinish = false;
          throw sinkError;
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'player-port-precedence'));

    await expect(
      runtime.handleBossInput({ text: 'review it', signal: signal() }),
    ).rejects.toBe(playerError);
    expect(
      traces.filter((trace) => trace.type === 'player.call.finished'),
    ).toHaveLength(1);
    await expect(
      runtime.handleBossInput({ text: ' ', signal: signal() }),
    ).resolves.toMatchObject({
      outcome: 'no-action',
      state: { stateId: 'failed' },
    });
    await runtime.dispose();
  });

  it('keeps malformed PlayerResult ahead of coincident abort and finish-sink failure', async () => {
    const traces: TraceEvent[] = [];
    const controller = new AbortController();
    const sinkError = new Error('player finish trace sink failed');
    let rejectFinish = true;
    const ports: PlaybookPorts = {
      callPlayer: async () =>
        ({
          status: 'ok',
          finalText: 'malformed player output',
          privateState: 'must not cross the boundary',
        }) as never,
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () =>
        JSON.stringify({
          event: 'START_REVIEW',
          latestChanges: 'malformed result review',
          reviewScope: 'mixed',
        }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as TraceEvent;
        traces.push(trace);
        if (trace.type === 'player.call.finished' && rejectFinish) {
          rejectFinish = false;
          controller.abort(new DOMException('Boss aborted', 'AbortError'));
          throw sinkError;
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'player-finish-precedence'));

    await expect(
      runtime.handleBossInput({
        text: 'write the agreement',
        signal: controller.signal,
      }),
    ).rejects.toThrow('privateState is not a declared property');

    const starts = traces.filter(
      (trace) => trace.type === 'player.call.started',
    );
    expect(starts).toHaveLength(1);
    expect(
      traces.filter(
        (trace) =>
          trace.type === 'player.call.finished' &&
          trace.callId === starts[0].callId,
      ),
    ).toHaveLength(1);
    expect(
      traces.find((trace) => trace.type === 'boss.input.settled'),
    ).toMatchObject({
      payload: {
        outcome: 'failed',
        error: {
          name: 'TypeError',
          message: 'player result.privateState is not a declared property',
        },
      },
    });
    await expect(
      runtime.handleBossInput({ text: ' ', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'no-action' });
    await runtime.dispose();
  });

  it('drains entering-state emissions before either parallel player call', async () => {
    const traces: TraceEvent[] = [];
    const playerCalls: string[] = [];
    let releaseEnteringTrace!: () => void;
    const enteringTraceGate = new Promise<void>((resolve) => {
      releaseEnteringTrace = resolve;
    });
    let enteringTraceReached!: () => void;
    const enteringTraceStarted = new Promise<void>((resolve) => {
      enteringTraceReached = resolve;
    });
    let releasePlayers!: () => void;
    const bothPlayersStarted = new Promise<void>((resolve) => {
      releasePlayers = resolve;
    });
    let blockedEnteringTrace = false;
    const ports: PlaybookPorts = {
      callPlayer: async (playerId) => {
        playerCalls.push(playerId);
        if (playerCalls.length === 2) releasePlayers();
        await bothPlayersStarted;
        return { status: 'error', error: 'stop after ordering assertion' };
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () =>
        JSON.stringify({ event: 'START_DISCUSSION', topic: 'Order entries.' }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as TraceEvent;
        const activeStateIds = (
          trace.payload.state as { activeStateIds?: unknown } | undefined
        )?.activeStateIds;
        if (
          !blockedEnteringTrace &&
          trace.type === 'fsm.transition' &&
          Array.isArray(activeStateIds) &&
          activeStateIds.includes('askHostInitial') &&
          activeStateIds.includes('askParticipantInitial')
        ) {
          blockedEnteringTrace = true;
          enteringTraceReached();
          await enteringTraceGate;
        }
        traces.push(trace);
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'entry-drain-session'));
    const turn = runtime.handleBossInput({ text: 'start', signal: signal() });

    await enteringTraceStarted;
    expect(playerCalls).toEqual([]);
    releaseEnteringTrace();
    await vi.waitFor(() => expect(playerCalls).toHaveLength(2));
    await turn;

    const enteringTrace = traces.find(
      (trace) =>
        trace.type === 'fsm.transition' &&
        Array.isArray(
          (trace.payload.state as { activeStateIds?: unknown } | undefined)
            ?.activeStateIds,
        ) &&
        (
          trace.payload.state as { activeStateIds: unknown[] }
        ).activeStateIds.includes('askHostInitial'),
    );
    const playerStarts = traces.filter(
      (trace) => trace.type === 'player.call.started',
    );
    expect(playerStarts).toHaveLength(2);
    for (const start of playerStarts) {
      expect(enteringTrace!.sequence).toBeLessThan(start.sequence);
    }
    await runtime.dispose();
  });

  it('rejects disposal during a live turn and coalesces later disposal', async () => {
    const traces: TraceEvent[] = [];
    const playerCalls: string[] = [];
    let releasePlayers!: () => void;
    const playerGate = new Promise<void>((resolve) => {
      releasePlayers = resolve;
    });
    const ports: PlaybookPorts = {
      callPlayer: async (playerId) => {
        playerCalls.push(playerId);
        await playerGate;
        return { status: 'error', error: `${playerId} stopped` };
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () =>
        JSON.stringify({ event: 'START_DISCUSSION', topic: 'Dispose safely.' }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'dispose-race-session'));
    const turn = runtime.handleBossInput({ text: 'start', signal: signal() });
    await vi.waitFor(() => expect(playerCalls).toHaveLength(2));

    await expect(runtime.dispose()).rejects.toThrow(
      /cannot dispose while a runtime turn is active/,
    );
    expect(traces.some((trace) => trace.type === 'session.disposed')).toBe(
      false,
    );

    releasePlayers();
    await expect(turn).resolves.toMatchObject({ outcome: 'failed' });
    const first = runtime.dispose();
    const second = runtime.dispose();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(runtime.dispose()).toBe(first);
    expect(
      traces.filter((trace) => trace.type === 'session.disposed'),
    ).toHaveLength(1);
    expect(traces.at(-1)?.type).toBe('session.disposed');
  });

  it('snapshots trace events against observer mutation', async () => {
    const traces: TraceEvent[] = [];
    let rejectedMutations = 0;
    const ports: PlaybookPorts = {
      callPlayer: async () => ({ status: 'error', error: 'unexpected call' }),
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () => JSON.stringify({ event: null }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as TraceEvent;
        expect(Object.isFrozen(trace)).toBe(true);
        expect(Object.isFrozen(trace.payload)).toBe(true);
        for (const mutate of [
          () => {
            (trace as { sequence: number }).sequence = 999;
          },
          () => {
            trace.payload.observerMutation = true;
          },
        ]) {
          try {
            mutate();
          } catch (error) {
            expect(error).toBeInstanceOf(TypeError);
            rejectedMutations++;
          }
        }
        traces.push(trace);
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'immutable-trace-session'));
    await runtime.handleBossInput({ text: ' ', signal: signal() });
    await runtime.dispose();

    expect(rejectedMutations).toBe(traces.length * 2);
    expect(traces.map((trace) => trace.sequence)).toEqual(
      traces.map((_, index) => index + 1),
    );
    expect(
      traces.every((trace) => !('observerMutation' in trace.payload)),
    ).toBe(true);
  });

  it('detaches described FSM telemetry from authoritative prior state', async () => {
    const statePayloads: Array<{
      from?: unknown;
      state?: { value?: unknown };
    }> = [];
    let rejectedMutation = false;
    const ports: PlaybookPorts = {
      callPlayer: async () => ({ status: 'error', error: 'unexpected call' }),
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () =>
        JSON.stringify({ event: 'BOSS_INTERRUPT', targetId: 'ready' }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.fsm.state') return;
        const payload = event.payload as {
          from?: unknown;
          state?: { value?: unknown };
        };
        statePayloads.push(payload);
        if (statePayloads.length === 1 && payload.state) {
          expect(Object.isFrozen(payload)).toBe(true);
          expect(Object.isFrozen(payload.state)).toBe(true);
          try {
            payload.state.value = 'observer-tampered';
          } catch (error) {
            expect(error).toBeInstanceOf(TypeError);
            rejectedMutation = true;
          }
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'immutable-state-session'));
    await runtime.handleBossInput({ text: 'stay ready', signal: signal() });

    expect(rejectedMutation).toBe(true);
    expect(statePayloads).toHaveLength(2);
    expect(statePayloads[1]?.from).toBe('ready');
    await runtime.dispose();
  });

  it('rejects a non-string judge reply before a success finish', async () => {
    const traces: TraceEvent[] = [];
    let playerCalls = 0;
    const ports: PlaybookPorts = {
      callPlayer: async () => {
        playerCalls++;
        return { status: 'error', error: 'unexpected player call' };
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () => ({ event: null }) as never,
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'malformed-judge-session'));

    await expect(
      runtime.handleBossInput({ text: 'classify this', signal: signal() }),
    ).rejects.toThrow('judge result must be a string');
    expect(playerCalls).toBe(0);
    const finishes = traces.filter(
      (trace) => trace.type === 'judge.call.finished',
    );
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      payload: {
        status: 'error',
        error: { name: 'TypeError', message: 'judge result must be a string' },
      },
    });
    expect(finishes[0].payload).not.toHaveProperty('reply');
    await runtime.dispose();
  });

  it('rejects malformed player results without recording their resume token', async () => {
    const traces: TraceEvent[] = [];
    const hostResumes: Array<string | false> = [];
    let hostCalls = 0;
    let classifierCalls = 0;
    const ports: PlaybookPorts = {
      callPlayer: async (playerId, _prompt, callSignal, options) => {
        if (playerId === 'host') {
          hostCalls++;
          hostResumes.push(options.resume);
          if (hostCalls === 1) {
            return {
              status: 'ok',
              resumeToken: 'must-not-be-recorded',
              finalText: 'malformed host output',
              privateState: 'must not cross the boundary',
            } as never;
          }
          return { status: 'error', error: 'stop after continuity assertion' };
        }
        return new Promise((_resolve, reject) => {
          const onAbort = (): void =>
            reject(callSignal.reason ?? new Error('participant aborted'));
          if (callSignal.aborted) onAbort();
          else callSignal.addEventListener('abort', onAbort, { once: true });
        });
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async (prompt) => {
        if (!prompt.includes('Boss-input classifier')) {
          throw new Error('unexpected adjudication for malformed result');
        }
        classifierCalls++;
        return classifierCalls === 1
          ? JSON.stringify({
              event: 'START_DISCUSSION',
              topic: 'Validate player result.',
            })
          : JSON.stringify({
              event: 'START_DISCUSSION',
              topic: 'Retry malformed Host result.',
            });
      },
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'malformed-player-session'));

    await expect(
      runtime.handleBossInput({ text: 'start', signal: signal() }),
    ).rejects.toThrow('privateState is not a declared property');
    const malformedFinish = traces.find(
      (trace) =>
        trace.type === 'player.call.finished' &&
        trace.payload.playerId === 'host',
    );
    expect(malformedFinish).toMatchObject({
      payload: {
        status: 'error',
        error: {
          name: 'TypeError',
          message: 'player result.privateState is not a declared property',
        },
      },
    });
    expect(malformedFinish?.payload).not.toHaveProperty('resumeToken');

    await expect(
      runtime.handleBossInput({ text: 'retry host', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'failed' });
    expect(hostResumes).toEqual([false, false]);
    expect(JSON.stringify(traces)).not.toContain('must-not-be-recorded');
    await runtime.dispose();
  });
});

describe('session trace and player continuation (PBRT-37/38/39)', () => {
  it('rejects an overlapping Boss turn without corrupting turn identity', async () => {
    const traces: TraceEvent[] = [];
    let judgeCalls = 0;
    let classifierStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      classifierStarted = resolve;
    });
    let releaseClassifier!: () => void;
    const classifierGate = new Promise<void>((resolve) => {
      releaseClassifier = resolve;
    });
    const ports: PlaybookPorts = {
      callPlayer: async () => ({ status: 'ok' }),
      callCaptain: async () => {
        throw new Error('unexpected direct Captain call');
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () => {
        judgeCalls++;
        classifierStarted();
        await classifierGate;
        return JSON.stringify({ event: null });
      },
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'overlap-turn-session'));
    const firstTurn = runtime.handleBossInput({
      text: 'Hold this classifier.',
      signal: signal(),
    });
    await started;

    await expect(
      runtime.handleBossInput({ text: 'Must reject.', signal: signal() }),
    ).rejects.toThrow(/another runtime turn is active/);
    releaseClassifier();
    await expect(firstTurn).resolves.toMatchObject({ outcome: 'no-action' });
    await expect(
      runtime.handleBossInput({ text: ' ', signal: signal() }),
    ).resolves.toMatchObject({ outcome: 'no-action' });

    expect(judgeCalls).toBe(1);
    expect(
      traces
        .filter((trace) => trace.type === 'boss.input.received')
        .map((trace) => trace.turnId),
    ).toEqual([1, 2]);
    expect(
      traces
        .filter((trace) => trace.type === 'boss.input.settled')
        .map((trace) => trace.turnId),
    ).toEqual([1, 2]);
    await runtime.dispose();
  });

  it('validates root/child causality and freezes child trace lineage', async () => {
    const traces: TraceEvent[] = [];
    const ports: PlaybookPorts = {
      callPlayer: async () => ({ status: 'ok' }),
      callCaptain: async () => {
        throw new Error('unexpected direct Captain call');
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () => JSON.stringify({ event: null }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await expect(
      runtime.init({
        sessionId: 'bad-root',
        playbookId: 'discuss',
        rootSessionId: 'different-root',
        depth: 0,
        ports,
      }),
    ).rejects.toThrow(/must be its own rootSessionId/);
    await expect(
      runtime.init({
        sessionId: 'bad-child',
        playbookId: 'discuss',
        rootSessionId: 'root-session',
        depth: 1,
        ports,
      }),
    ).rejects.toThrow(/parentSessionId must be a non-empty string/);

    for (const portName of [
      'callPlayer',
      'callCaptain',
      'callJudge',
      'callPlaybook',
      'emitStatus',
      'emitTelemetry',
    ] as const) {
      const malformedPorts = {
        ...ports,
        [portName]: undefined,
      } as unknown as PlaybookPorts;
      await expect(
        runtime.init({
          sessionId: `missing-${portName}`,
          playbookId: 'discuss',
          rootSessionId: `missing-${portName}`,
          depth: 0,
          ports: malformedPorts,
        }),
      ).rejects.toThrow(`ports.${portName} must be a function`);
    }
    await expect(
      runtime.init({
        sessionId: 'unsafe-depth',
        playbookId: 'discuss',
        rootSessionId: 'unsafe-depth',
        depth: Number.MAX_SAFE_INTEGER + 1,
        ports,
      }),
    ).rejects.toThrow(/depth must be a non-negative integer/);
    await expect(
      runtime.init({
        sessionId: 'self-child',
        playbookId: 'discuss',
        rootSessionId: 'self-child',
        parentSessionId: 'parent-session',
        parentCallId: 'playbook-self',
        depth: 1,
        ports,
      }),
    ).rejects.toThrow(
      /child playbook sessionId must differ from its root and parent/,
    );

    const childSession: PlaybookSession = {
      sessionId: 'child-session',
      playbookId: 'discuss',
      rootSessionId: 'root-session',
      parentSessionId: 'parent-session',
      parentCallId: 'playbook-7',
      depth: 2,
      ports,
    };
    await runtime.init(childSession);
    childSession.rootSessionId = 'mutated-root';
    childSession.parentSessionId = 'mutated-parent';
    childSession.parentCallId = 'mutated-call';
    childSession.depth = 99;
    const mutatedTelemetry = vi.fn(async () => {
      throw new Error('mutated session port must not be retained');
    });
    childSession.ports.emitTelemetry = mutatedTelemetry;
    await expect(
      runtime.resumePlaybookCall({
        callId: 'never-started',
        result: {
          status: 'error',
          playbookId: 'child',
          error: { name: 'Error', message: 'not used' },
        },
        signal: signal(),
      }),
    ).rejects.toThrow(/unknown or stale playbook call id never-started/);
    await runtime.dispose();
    expect(mutatedTelemetry).not.toHaveBeenCalled();

    for (const trace of traces) {
      expect(trace).toMatchObject({
        schemaVersion: 2,
        sessionId: 'child-session',
        playbookId: 'discuss',
        rootSessionId: 'root-session',
        parentSessionId: 'parent-session',
        parentCallId: 'playbook-7',
        depth: 2,
      });
    }
  });

  it('emits a boundary-complete ordered trace and rotates independent player tokens', async () => {
    const traces: TraceEvent[] = [];
    const fsmTelemetry: Array<Record<string, unknown>> = [];
    const statuses: Array<{ message: string; data: unknown }> = [];
    const playerCalls: Array<{
      playerId: string;
      prompt: string;
      options: PlayerCallOptions;
    }> = [];
    const judgePrompts: string[] = [];
    const judgeReplies = terminalDiscussionJudgeReplies('Trace this topic.');
    const playerResults = [
      { status: 'ok' as const, resumeToken: 'host-1', finalText: 'host one' },
      {
        status: 'ok' as const,
        resumeToken: 'participant-1',
        finalText: 'participant one',
      },
      { status: 'ok' as const, resumeToken: 'host-2', finalText: 'host two' },
      {
        status: 'ok' as const,
        resumeToken: 'participant-2',
        finalText: 'participant two',
      },
      // A whitespace-only token is not resumable and clears Host.
      { status: 'ok' as const, resumeToken: ' \t', finalText: 'host writes' },
      {
        status: 'ok' as const,
        resumeToken: 'host-3',
        finalText: 'host commits',
      },
      {
        status: 'ok' as const,
        resumeToken: 'participant-3',
        finalText: 'participant reviews',
      },
      {
        status: 'ok' as const,
        resumeToken: 'host-4',
        finalText: 'host commits',
      },
    ];
    let judgeIndex = 0;
    let playerIndex = 0;

    const ports: PlaybookPorts = {
      callPlayer: async (playerId, prompt, _signal, options) => {
        const started = traces.findLast(
          (trace) =>
            trace.type === 'player.call.started' &&
            trace.payload.playerId === playerId &&
            trace.payload.prompt === prompt,
        );
        expect(started?.type).toBe('player.call.started');
        expect(started?.payload).toMatchObject({
          playerId,
          prompt,
          resume: options.resume,
        });
        playerCalls.push({ playerId, prompt, options: { ...options } });
        const result = playerResults[playerIndex++];
        if (!result) throw new Error(`unscripted player call #${playerIndex}`);
        return result;
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async (prompt) => {
        const started = traces.findLast(
          (trace) =>
            trace.type === 'judge.call.started' &&
            trace.payload.prompt === prompt,
        );
        expect(started?.type).toBe('judge.call.started');
        expect(started?.payload.prompt).toBe(prompt);
        judgePrompts.push(prompt);
        const reply = judgeReplies[judgeIndex++];
        if (reply === undefined) {
          throw new Error(`unscripted judge call #${judgeIndex}`);
        }
        return reply;
      },
      emitStatus: async (message, data) => {
        const statusTrace = traces.at(-1);
        expect(statusTrace?.type).toBe('status.emitted');
        expect(statusTrace?.payload).toMatchObject({ message });
        statuses.push({ message, data });
      },
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
          return;
        }
        if (event.topic === 'playbook.fsm.state') {
          const stateTrace = traces.at(-1);
          expect(stateTrace?.type).toBe('fsm.transition');
          expect(stateTrace?.payload).toEqual(event.payload);
          fsmTelemetry.push(event.payload as Record<string, unknown>);
        }
      },
    };

    const runtime = createPlaybookRuntime({});
    const initSession = playbookSession(ports, 'immutable-discuss-session');
    await runtime.init(initSession);
    // The runtime snapshots identity instead of retaining this mutable input.
    initSession.sessionId = 'mutated-session';
    initSession.playbookId = 'mutated-playbook';

    await runtime.handleBossInput({
      text: 'Trace this topic.',
      signal: signal(),
    });
    await runtime.dispose();

    expect(playerCalls).toHaveLength(8);
    expect(judgePrompts).toHaveLength(judgeReplies.length);
    expect(fsmTelemetry.length).toBeGreaterThan(1);
    expect(statuses.length).toBeGreaterThan(0);
    expect(
      traces.filter((trace) => trace.type === 'status.emitted'),
    ).toHaveLength(statuses.length);
    expect(playerCalls.map((call) => call.playerId)).toEqual([
      'host',
      'participant',
      'host',
      'participant',
      'host',
      'host',
      'participant',
      'host',
    ]);
    expect(playerCalls.map((call) => call.options.resume)).toEqual([
      false,
      false,
      'host-1',
      'participant-1',
      'host-2',
      false,
      'participant-2',
      'host-3',
    ]);

    expect(traces.map((trace) => trace.sequence)).toEqual(
      traces.map((_, index) => index + 1),
    );
    for (const trace of traces) {
      expect(trace).toMatchObject({
        schemaVersion: 2,
        sessionId: 'immutable-discuss-session',
        playbookId: 'discuss',
        rootSessionId: 'immutable-discuss-session',
        depth: 0,
      });
      expect(Number.isInteger(trace.timestamp)).toBe(true);
      expect(trace.timestamp).toBeGreaterThan(0);
    }
    expect(JSON.parse(JSON.stringify(traces))).toEqual(traces);

    expect(traces[0]).toMatchObject({
      type: 'session.started',
      payload: {
        stateId: 'ready',
        state: { value: 'ready', activeStateIds: ['ready'], quiescent: true },
      },
    });
    expect(traces.at(-1)).toMatchObject({
      type: 'session.disposed',
      payload: {
        stateId: 'done',
        state: { value: 'done', activeStateIds: ['done'], quiescent: true },
      },
    });
    const traceTypes = new Set(traces.map((trace) => trace.type));
    expect(traceTypes).toEqual(
      new Set([
        'session.started',
        'boss.input.received',
        'judge.call.started',
        'judge.call.finished',
        'player.call.started',
        'player.call.finished',
        'fsm.transition',
        'status.emitted',
        'boss.input.settled',
        'session.disposed',
      ]),
    );

    const received = traces.find(
      (trace) => trace.type === 'boss.input.received',
    );
    const settled = traces.find((trace) => trace.type === 'boss.input.settled');
    expect(received).toMatchObject({
      turnId: 1,
      payload: { text: 'Trace this topic.' },
    });
    expect(settled).toMatchObject({
      turnId: 1,
      payload: { outcome: 'terminal', stateId: 'done' },
    });
    expect(received!.sequence).toBeLessThan(settled!.sequence);

    for (const kind of ['judge', 'player'] as const) {
      const started = traces.filter(
        (trace) => trace.type === `${kind}.call.started`,
      );
      const finished = traces.filter(
        (trace) => trace.type === `${kind}.call.finished`,
      );
      expect(started.map((trace) => trace.callId)).toEqual(
        started.map((_, index) => `${kind}-${index + 1}`),
      );
      expect(finished.map((trace) => trace.callId)).toEqual(
        started.map((trace) => trace.callId),
      );
      for (const start of started) {
        const finish = finished.find((trace) => trace.callId === start.callId);
        expect(start.turnId).toBe(1);
        expect(finish?.turnId).toBe(1);
        expect(start.sequence).toBeLessThan(finish!.sequence);
      }
    }

    const firstPlayerStart = traces.find(
      (trace) => trace.type === 'player.call.started',
    );
    const firstPlayerFinish = traces.find(
      (trace) => trace.type === 'player.call.finished',
    );
    expect(firstPlayerStart?.payload).toMatchObject({
      purpose: 'captain',
      stateId: 'askHostInitial',
      sourceItem: 'DISCUSS-1',
      playerId: 'host',
      resume: false,
      prompt: playerCalls[0].prompt,
    });
    expect(firstPlayerFinish?.payload).toMatchObject({
      status: 'ok',
      resumeToken: 'host-1',
      finalText: 'host one',
    });
    expect(
      traces.find(
        (trace) =>
          trace.type === 'player.call.finished' &&
          trace.payload.resumeToken === ' \t',
      ),
    ).toBeDefined();

    const firstJudgeStart = traces.find(
      (trace) => trace.type === 'judge.call.started',
    );
    const firstJudgeFinish = traces.find(
      (trace) => trace.type === 'judge.call.finished',
    );
    expect(firstJudgeStart?.payload).toMatchObject({
      purpose: 'boss-input-classification',
      stateId: 'ready',
      prompt: judgePrompts[0],
    });
    expect(firstJudgeFinish?.payload).toMatchObject({
      status: 'ok',
      reply: judgeReplies[0],
    });

    expect(fsmTelemetry[0]).toMatchObject({
      from: null,
      to: 'ready',
      previousState: null,
      state: {
        value: 'ready',
        activeStateIds: ['ready'],
        quiescent: true,
      },
    });
  });

  it('traces empty input as received/settled without any runtime action', async () => {
    const traces: TraceEvent[] = [];
    let judgeCalls = 0;
    let playerCalls = 0;
    let stateTelemetry = 0;
    let statuses = 0;
    const ports: PlaybookPorts = {
      callPlayer: async () => {
        playerCalls++;
        return { status: 'ok' };
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () => {
        judgeCalls++;
        return JSON.stringify({ event: null });
      },
      emitStatus: async () => {
        statuses++;
      },
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        } else if (event.topic === 'playbook.fsm.state') {
          stateTelemetry++;
        }
      },
    };

    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'empty-input-session'));
    const traceStart = traces.length;
    const statusStart = statuses;
    const stateStart = stateTelemetry;
    await runtime.handleBossInput({ text: '  \n\t ', signal: signal() });

    expect(traces.slice(traceStart).map((trace) => trace.type)).toEqual([
      'boss.input.received',
      'boss.input.settled',
    ]);
    expect(traces.at(-2)).toMatchObject({
      turnId: 1,
      payload: { text: '  \n\t ' },
    });
    expect(traces.at(-1)).toMatchObject({
      turnId: 1,
      payload: { outcome: 'no-action', stateId: 'ready' },
    });
    expect(judgeCalls).toBe(0);
    expect(playerCalls).toBe(0);
    expect(statuses).toBe(statusStart);
    expect(stateTelemetry).toBe(stateStart);
    await runtime.dispose();
  });

  it('traces a same-state reentering FSM transition', async () => {
    const traces: TraceEvent[] = [];
    const ports: PlaybookPorts = {
      callPlayer: async () => ({ status: 'ok' }),
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () =>
        JSON.stringify({ event: 'BOSS_INTERRUPT', targetId: 'ready' }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'same-state-session'));
    const traceStart = traces.length;

    await runtime.handleBossInput({ text: 'stay ready', signal: signal() });

    expect(
      traces.slice(traceStart).find((trace) => trace.type === 'fsm.transition'),
    ).toMatchObject({
      turnId: 1,
      payload: {
        from: 'ready',
        to: 'ready',
        event: 'BOSS_INTERRUPT',
      },
    });
    await runtime.dispose();
  });

  it('atomically suppresses state telemetry when its trace fails and then recovers', async () => {
    const traces: TraceEvent[] = [];
    const fsmTelemetry: Array<Record<string, unknown>> = [];
    const statuses: string[] = [];
    const telemetryError = new TypeError('state trace offline');
    let failNextStateTrace = false;
    const ports: PlaybookPorts = {
      callPlayer: async () => ({
        status: 'error',
        error: 'stop after entering the state',
      }),
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () =>
        JSON.stringify({ event: 'START_DISCUSSION', topic: 'Queue recovery.' }),
      emitStatus: async (message) => {
        statuses.push(message);
      },
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          const trace = event.payload as TraceEvent;
          if (failNextStateTrace && trace.type === 'fsm.transition') {
            failNextStateTrace = false;
            throw telemetryError;
          }
          traces.push(trace);
        } else if (event.topic === 'playbook.fsm.state') {
          fsmTelemetry.push(event.payload as Record<string, unknown>);
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'emission-recovery-session'));
    failNextStateTrace = true;

    await expect(
      runtime.handleBossInput({ text: 'start', signal: signal() }),
    ).rejects.toBe(telemetryError);

    expect(
      traces.find(
        (trace) => trace.type === 'boss.input.settled' && trace.turnId === 1,
      ),
    ).toMatchObject({
      payload: {
        outcome: 'failed',
        error: {
          name: 'TypeError',
          message: 'state trace offline',
        },
      },
    });
    expect(
      fsmTelemetry.some((payload) => payload.event === 'START_DISCUSSION'),
    ).toBe(false);
    expect(statuses.length).toBeGreaterThan(0);
    await runtime.handleBossInput({ text: '  ', signal: signal() });
    expect(
      traces.find(
        (trace) => trace.type === 'boss.input.settled' && trace.turnId === 2,
      ),
    ).toMatchObject({ payload: { outcome: 'no-action' } });
    await runtime.dispose();
  });

  it('does not emit a described status when its status trace fails', async () => {
    const traces: TraceEvent[] = [];
    const statuses: string[] = [];
    const traceError = new TypeError('failed status trace offline');
    const failedMessage =
      'The discussion workflow failed and is waiting for Boss recovery.';
    let failFailedStatusTrace = false;
    const ports: PlaybookPorts = {
      callPlayer: async () => ({ status: 'ok' }),
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () =>
        JSON.stringify({ event: 'BOSS_INTERRUPT', targetId: 'failed' }),
      emitStatus: async (message) => {
        statuses.push(message);
      },
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as TraceEvent;
        if (
          failFailedStatusTrace &&
          trace.type === 'status.emitted' &&
          trace.payload.message === failedMessage
        ) {
          failFailedStatusTrace = false;
          throw traceError;
        }
        traces.push(trace);
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'atomic-status-session'));
    failFailedStatusTrace = true;

    await expect(
      runtime.handleBossInput({ text: 'fail directly', signal: signal() }),
    ).rejects.toBe(traceError);

    expect(statuses).toContain('BOSS_INTERRUPT');
    expect(statuses).not.toContain(failedMessage);
    expect(
      traces.find(
        (trace) => trace.type === 'boss.input.settled' && trace.turnId === 1,
      ),
    ).toMatchObject({
      payload: {
        outcome: 'failed',
        error: {
          name: 'TypeError',
          message: 'failed status trace offline',
        },
      },
    });
    await runtime.dispose();
  });

  it('omits unavailable failed-state status data from its JSON-safe trace', async () => {
    const traces: TraceEvent[] = [];
    const ports: PlaybookPorts = {
      callPlayer: async () => ({ status: 'ok' }),
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () =>
        JSON.stringify({ event: 'BOSS_INTERRUPT', targetId: 'failed' }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        }
      },
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'json-safe-failed-session'));
    await runtime.handleBossInput({ text: 'fail directly', signal: signal() });

    const failedStatus = traces.find(
      (trace) =>
        trace.type === 'status.emitted' && trace.payload.stateId === 'failed',
    );
    expect(failedStatus?.payload).toEqual({
      stateId: 'failed',
      message:
        'The discussion workflow failed and is waiting for Boss recovery.',
      state: {
        value: 'failed',
        activeStateIds: ['failed'],
        tags: ['playbook.parked'],
        status: 'active',
        quiescent: true,
        stateId: 'failed',
      },
    });
    expect(JSON.parse(JSON.stringify(failedStatus))).toEqual(failedStatus);
    await runtime.dispose();
  });

  it('retains returned error tokens and preserves the prior token on rejection', async () => {
    const traces: TraceEvent[] = [];
    const resumes: Array<string | false> = [];
    const judgeReplies = [
      JSON.stringify({
        event: 'START_REVIEW',
        latestChanges: 'first failure review',
        reviewScope: 'mixed',
      }),
      JSON.stringify({
        event: 'START_REVIEW',
        latestChanges: 'question review',
        reviewScope: 'mixed',
      }),
      JSON.stringify({ guard: 'needsBossReply', question: 'Proceed?' }),
      JSON.stringify({ event: 'BOSS_REPLY', answer: 'Yes.' }),
      JSON.stringify({
        event: 'START_REVIEW',
        latestChanges: 'final failure review',
        reviewScope: 'mixed',
      }),
    ];
    let judgeIndex = 0;
    let playerIndex = 0;
    const ports: PlaybookPorts = {
      callPlayer: async (_playerId, _prompt, _signal, options) => {
        resumes.push(options.resume);
        playerIndex++;
        if (playerIndex === 1) {
          return {
            status: 'error',
            resumeToken: 'error-token',
            error: 'player stopped',
          };
        }
        if (playerIndex === 2) {
          return {
            status: 'ok',
            resumeToken: 'stable-token',
            finalText: 'I need Boss.',
          };
        }
        if (playerIndex === 3) {
          throw new TypeError('transport broke');
        }
        return {
          status: 'error',
          resumeToken: 'next-error-token',
          error: 'stop after assertion',
        };
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
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
        if (event.topic === 'playbook.trace') {
          traces.push(event.payload as TraceEvent);
        }
      },
    };

    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'failure-resume-session'));
    await runtime.handleBossInput({ text: 'start', signal: signal() });
    await runtime.handleBossInput({ text: 'retry', signal: signal() });
    await expect(
      runtime.handleBossInput({ text: 'Yes.', signal: signal() }),
    ).rejects.toThrow('transport broke');
    await runtime.handleBossInput({ text: 'retry again', signal: signal() });

    expect(resumes).toEqual([
      false,
      'error-token',
      'stable-token',
      'stable-token',
    ]);
    const rejected = traces.find(
      (trace) =>
        trace.type === 'player.call.finished' &&
        trace.payload.error !== undefined &&
        (trace.payload.error as { message?: string }).message ===
          'transport broke',
    );
    expect(rejected).toMatchObject({
      callId: 'player-3',
      payload: {
        status: 'error',
        resume: 'stable-token',
        error: { name: 'TypeError', message: 'transport broke' },
      },
    });
    const failedSettlements = traces.filter(
      (trace) =>
        trace.type === 'boss.input.settled' &&
        trace.payload.outcome === 'failed',
    );
    expect(failedSettlements.length).toBeGreaterThanOrEqual(3);
    await runtime.dispose();
  });

  it('retains an aborted token and clears continuity when a result omits one', async () => {
    const resumes: Array<string | false> = [];
    const judgeReplies = [
      JSON.stringify({
        event: 'START_REVIEW',
        latestChanges: 'aborted review',
        reviewScope: 'mixed',
      }),
      JSON.stringify({
        event: 'START_REVIEW',
        latestChanges: 'question review',
        reviewScope: 'mixed',
      }),
      JSON.stringify({ guard: 'needsBossReply', question: 'Proceed?' }),
      JSON.stringify({
        event: 'START_REVIEW',
        latestChanges: 'fresh review',
        reviewScope: 'mixed',
      }),
    ];
    let judgeIndex = 0;
    let playerIndex = 0;
    const ports: PlaybookPorts = {
      callPlayer: async (_playerId, _prompt, _signal, options) => {
        resumes.push(options.resume);
        playerIndex++;
        if (playerIndex === 1) {
          return {
            status: 'aborted',
            resumeToken: 'aborted-token',
            error: 'interrupted',
          };
        }
        if (playerIndex === 2) {
          return { status: 'ok', finalText: 'I need Boss.' };
        }
        return { status: 'error', error: 'stop after assertion' };
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () => {
        const reply = judgeReplies[judgeIndex++];
        if (reply === undefined) {
          throw new Error(`unscripted judge call #${judgeIndex}`);
        }
        return reply;
      },
      emitStatus: async () => {},
      emitTelemetry: async () => {},
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'aborted-and-omitted-session'));

    await runtime.handleBossInput({ text: 'start', signal: signal() });
    await runtime.handleBossInput({ text: 'retry', signal: signal() });
    await runtime.handleBossInput({ text: 'retry fresh', signal: signal() });

    expect(resumes).toEqual([false, 'aborted-token', false]);
    await runtime.dispose();
  });

  it('starts distinct runtime sessions fresh and rejects a second init', async () => {
    const observed: Array<{
      sessionId: string;
      resume: string | false;
    }> = [];

    for (const sessionId of ['fresh-session-1', 'fresh-session-2']) {
      const traces: TraceEvent[] = [];
      const ports: PlaybookPorts = {
        callPlayer: async (_playerId, _prompt, _signal, options) => {
          observed.push({ sessionId, resume: options.resume });
          return {
            status: 'error',
            resumeToken: `${sessionId}-token`,
            error: 'stop',
          };
        },
        callPlaybook: async () => {
          throw new Error('unexpected nested playbook call');
        },
        callJudge: async () =>
          JSON.stringify({
            event: 'START_REVIEW',
            latestChanges: sessionId,
            reviewScope: 'mixed',
          }),
        emitStatus: async () => {},
        emitTelemetry: async (event) => {
          if (event.topic === 'playbook.trace') {
            traces.push(event.payload as TraceEvent);
          }
        },
      };
      const runtime = createPlaybookRuntime({});
      const session = playbookSession(ports, sessionId);
      await runtime.init(session);
      await expect(runtime.init(session)).rejects.toThrow(
        /only be called once/,
      );
      await runtime.handleBossInput({ text: sessionId, signal: signal() });
      await runtime.dispose();
      expect(new Set(traces.map((trace) => trace.sessionId))).toEqual(
        new Set([sessionId]),
      );
    }

    expect(observed).toEqual([
      { sessionId: 'fresh-session-1', resume: false },
      { sessionId: 'fresh-session-2', resume: false },
    ]);
  });

  it('disposes a failed session start, preserves its error, and permits retry', async () => {
    const runtime = createPlaybookRuntime({});
    const basePorts = (): PlaybookPorts => ({
      callPlayer: async () => ({ status: 'error', error: 'unexpected call' }),
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () => JSON.stringify({ event: 'NO_ACTION' }),
      emitStatus: async () => {},
      emitTelemetry: async () => {},
    });
    const failedTraces: TraceEvent[] = [];
    const failedPorts: PlaybookPorts = {
      ...basePorts(),
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as TraceEvent;
        failedTraces.push(trace);
        if (trace.type === 'session.started') {
          throw new Error('original DISCUSS session-start sink failure');
        }
        if (trace.type === 'session.disposed') {
          throw new Error('secondary DISCUSS session-disposal sink failure');
        }
      },
    };

    await expect(
      runtime.init(playbookSession(failedPorts, 'failed-discuss-session')),
    ).rejects.toThrow('original DISCUSS session-start sink failure');
    expect(failedTraces.map(({ type }) => type)).toEqual([
      'session.started',
      'session.disposed',
    ]);

    const retryTraces: TraceEvent[] = [];
    const retryPorts: PlaybookPorts = {
      ...basePorts(),
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          retryTraces.push(event.payload as TraceEvent);
        }
      },
    };
    await expect(
      runtime.init(playbookSession(retryPorts, 'retry-discuss-session')),
    ).resolves.toBeUndefined();
    expect(retryTraces[0]).toMatchObject({
      sessionId: 'retry-discuss-session',
      sequence: 1,
      type: 'session.started',
    });
    await runtime.dispose();
  });

  it('serializes concurrent disposal behind failed initialization', async () => {
    const traces: TraceEvent[] = [];
    const startError = new Error('deferred DISCUSS session-start failure');
    let observeStart!: () => void;
    const startObserved = new Promise<void>((resolve) => {
      observeStart = resolve;
    });
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const ports: PlaybookPorts = {
      callPlayer: async () => ({ status: 'error', error: 'unexpected call' }),
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () => JSON.stringify({ event: 'NO_ACTION' }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.trace') return;
        const trace = event.payload as TraceEvent;
        traces.push(trace);
        if (trace.type === 'session.started') {
          observeStart();
          await startGate;
          throw startError;
        }
      },
    };
    const runtime = createPlaybookRuntime({});

    const initialization = runtime.init(
      playbookSession(ports, 'discuss-init-dispose-race'),
    );
    await startObserved;
    const firstDisposal = runtime.dispose();
    expect(runtime.dispose()).toBe(firstDisposal);
    releaseStart();

    await expect(initialization).rejects.toBe(startError);
    await expect(firstDisposal).resolves.toBeUndefined();
    expect(
      traces.filter((trace) => trace.type === 'session.disposed'),
    ).toHaveLength(1);
    await expect(
      runtime.init(
        playbookSession(ports, 'discuss-init-after-disposal-started'),
      ),
    ).rejects.toThrow('may only be called once');
  });

  it('retains terminal disposal identity before initialization', async () => {
    const runtime = createPlaybookRuntime({});
    const firstDisposal = runtime.dispose();
    expect(runtime.dispose()).toBe(firstDisposal);
    await firstDisposal;
    expect(runtime.dispose()).toBe(firstDisposal);

    await expect(
      runtime.init(
        playbookSession(
          {
            callPlayer: async () => ({
              status: 'error',
              error: 'unexpected call',
            }),
            callPlaybook: async () => {
              throw new Error('unexpected nested playbook call');
            },
            callJudge: async () => JSON.stringify({ event: 'NO_ACTION' }),
            emitStatus: async () => {},
            emitTelemetry: async () => {},
          },
          'disposed-before-init',
        ),
      ),
    ).rejects.toThrow('may only be called once');
  });

  it('suppresses teardown snapshots after an initialization transition sink failure', async () => {
    const runtime = createPlaybookRuntime({});
    let transitionAttempts = 0;
    const failedPorts: PlaybookPorts = {
      callPlayer: async () => ({ status: 'error', error: 'unexpected call' }),
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async () => JSON.stringify({ event: 'NO_ACTION' }),
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic !== 'playbook.fsm.state') return;
        transitionAttempts += 1;
        if (transitionAttempts === 1) {
          throw new Error('DISCUSS transition sink unavailable');
        }
      },
    };

    await expect(
      runtime.init(
        playbookSession(failedPorts, 'failed-discuss-transition-session'),
      ),
    ).rejects.toThrow('DISCUSS transition sink unavailable');
    expect(transitionAttempts).toBe(1);

    const retryTraces: TraceEvent[] = [];
    await expect(
      runtime.init(
        playbookSession(
          {
            ...failedPorts,
            emitTelemetry: async (event) => {
              if (event.topic === 'playbook.trace') {
                retryTraces.push(event.payload as TraceEvent);
              }
            },
          },
          'retry-discuss-transition-session',
        ),
      ),
    ).resolves.toBeUndefined();
    expect(retryTraces[0]).toMatchObject({
      sequence: 1,
      type: 'session.started',
    });
    await runtime.dispose();
  });
});

// PBRT-46 (DR-014): parked-session snapshot export/restore round trip over
// the real DISCUSS linked runtime with a sole parked branch question.
describe('parked-session snapshot (PBRT-46)', () => {
  it('round-trips a parked branch question through export and restore', async () => {
    const firstResumeSelections: Array<{
      playerId: string;
      resume: string | false;
    }> = [];
    const ports: PlaybookPorts = {
      callPlayer: async (playerId, _prompt, _signal, options) => {
        firstResumeSelections.push({ playerId, resume: options.resume });
        return {
          status: 'ok',
          finalText: `${playerId} initial`,
          resumeToken: `tok-${playerId}-1`,
        };
      },
      callCaptain: async () => {
        throw new Error('unexpected direct captain call');
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Boss-input classifier')) {
          return JSON.stringify({
            event: 'START_DISCUSSION',
            topic: 'One branch question.',
          });
        }
        return prompt.includes('host initial')
          ? JSON.stringify({
              guard: 'needsBossReply',
              question: 'Host-only question?',
            })
          : JSON.stringify({
              guard: 'proposalMade',
              proposal: 'participant v1',
            });
      },
      emitStatus: async () => {},
      emitTelemetry: async () => {},
    };
    const runtime = createPlaybookRuntime({});
    await runtime.init(playbookSession(ports, 'discuss-snapshot-session'));
    const parked = await runtime.handleBossInput({
      text: 'Start.',
      signal: signal(),
    });
    expect(parked.outcome).toBe('quiescent');
    expect(parked.state.activeStateIds).toContain('waitHostInitialReply');

    const exported = runtime.exportSnapshot!();
    expect(exported).toBeDefined();
    expect(exported!).toMatchObject({
      schemaVersion: 1,
      playbookId: 'discuss',
      playerResumeTokens: {
        host: 'tok-host-1',
        participant: 'tok-participant-1',
      },
      pendingBossQuestions: [
        {
          questionId: 'askHostInitial',
          player: 'Host',
          question: 'Host-only question?',
        },
      ],
    });
    const rehydrated = JSON.parse(JSON.stringify(exported)) as NonNullable<
      typeof exported
    >;

    // "New process": a fresh runtime instance from the same factory.
    const traces2: Array<{ type?: string; sequence?: number }> = [];
    const resumedSelections: Array<{
      playerId: string;
      prompt: string;
      resume: string | false;
    }> = [];
    const ports2: PlaybookPorts = {
      callPlayer: async (playerId, prompt, _signal, options) => {
        resumedSelections.push({ playerId, prompt, resume: options.resume });
        return { status: 'error', error: 'stop after sole branch resumed' };
      },
      callCaptain: async () => {
        throw new Error('unexpected direct captain call');
      },
      callPlaybook: async () => {
        throw new Error('unexpected nested playbook call');
      },
      callJudge: async (prompt) => {
        if (prompt.includes('Boss-input classifier')) {
          return JSON.stringify({
            event: 'BOSS_REPLY',
            answer: 'Implicit Host answer.',
          });
        }
        throw new Error(`unexpected judge prompt: ${prompt}`);
      },
      emitStatus: async () => {},
      emitTelemetry: async (event) => {
        if (event.topic === 'playbook.trace') {
          traces2.push(event.payload as { type?: string; sequence?: number });
        }
      },
    };
    const restored = createPlaybookRuntime({});
    await restored.restore!(
      playbookSession(ports2, 'discuss-snapshot-session'),
      rehydrated,
    );
    // Rehydration emits no session.started or transition trace.
    expect(traces2).toEqual([]);

    const resumed = await restored.handleBossInput({
      text: 'Answer the only question.',
      signal: signal(),
    });

    // The sole parked branch resumes its player with the pre-park token
    // and the labelled Q+A continuation; the scripted branch error then
    // fails the round.
    expect(resumedSelections).toHaveLength(1);
    expect(resumedSelections[0].playerId).toBe('host');
    expect(resumedSelections[0].resume).toBe('tok-host-1');
    expect(resumedSelections[0].prompt).toContain('Host-only question?');
    // The continuation block carries the classifier's extracted answer.
    expect(resumedSelections[0].prompt).toContain('Implicit Host answer.');
    expect(resumed.outcome).toBe('failed');
    expect(traces2.every((event) => event.type !== 'session.started')).toBe(
      true,
    );
    expect(traces2[0]?.sequence).toBe(rehydrated.sequences.trace + 1);

    await runtime.dispose();
    await restored.dispose();
  });
});
