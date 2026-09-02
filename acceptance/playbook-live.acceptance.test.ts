// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  conversationConfig,
  hermeticConfig,
  liveConfig,
  liveModels,
  liveRetuneOverlay,
} from './live-config.js';
import {
  checklistFixtureSource,
  hermeticArtifactSource,
  notesFixtureSource,
} from './live-fixtures.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const liveTimeoutMs = positiveIntegerEnv(
  'PLAYBOOK_ACCEPTANCE_TIMEOUT_MS',
  20 * 60_000,
);
const startupTimeoutMs = 90_000;
const pollIntervalMs = 1_000;
const bossHistoryLines = 400;
// The conversational case counts markers across a whole multi-turn session,
// not just the window a single wait needs.
const sessionHistoryLines = 8_000;
const launcherTailCharacters = 16 * 1024;
const diagnosticTailCharacters = 8 * 1024;
const liveCommandMaxBufferBytes = 20 * 1024 * 1024;
const liveTerminationGraceMs = 5_000;
const failureSnapshotName = 'acceptance-failure.txt';
// The attached DECIDE scenario spends at most six startup-length waits — a
// new session, attached client, `boss>`, the started marker, and the root and
// nested pane shapes — plus the live turn itself. Under-budgeting here is
// worse than a slow failure:
// vitest's own timeout fires outside the try/finally, so teardown never
// runs and `afterAll` would delete the artifacts while the agents are
// still live.
const scenarioTimeoutMs = liveTimeoutMs + 6 * startupTimeoutMs + 60_000;
// The headless DEV case spends the CODE case's whole budget on its nested
// CODE → REVIEW path and adds one live Analyst planning hop ahead of it.
const devLiveTimeoutMs = liveTimeoutMs + 5 * 60_000;
const turnFailureMarkers = [
  '◆ failed',
  '[turn aborted]',
  '[runtime error]',
  'workflow failed',
] as const;

// DR-026: the adapter SDKs are optional peers that no install acquires on a
// user's behalf — "libraries declare, the deliberately-installed root
// supplies" (§2). Every scenario below spends real Claude and Codex calls
// through the *installed* candidate, in a temp tree outside this repository,
// so this gate is that deliberately-installed root and has to name them on
// its own install lines. DR-026 §1's note that the repository's
// devDependencies keep the acceptance suite on real adapters holds only for
// suites that run in the repository's own module tree; RELEASE-24/25 pin
// this one to a packed install, which the repository's `node_modules` never
// reaches. Without them the launcher's §4 preflight correctly refuses every
// scenario before it starts.
const adapterSdks = [
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex-sdk',
] as const;

// Install the exact SDK builds this repository resolves and tests against,
// never whatever `latest` floats to mid-run. Both reasons are about a gate
// that spends real model calls: a floating install makes the gate less
// reproducible than the `pnpm test` it exists to corroborate, and it hands
// an upstream publish window the power to fail a release gate for reasons
// that have nothing to do with the candidate — observed here as an
// `@openai/codex-sdk` release whose own pinned dependency was missing from
// this host's cached packument, which `--prefer-offline` then honoured as a
// hard ETARGET. Pinning to a version the repository already depends on is
// immune to that: a stale packument still lists it.
//
// This is also the concrete form of DR-026 §1's intent — that the
// repository's devDependencies keep the real-agent acceptance suite on real
// adapters. The suite runs from a packed install outside this tree, so the
// versions have to be carried across rather than resolved again.
function adapterSdkSpecs(): string[] {
  return adapterSdks.map((sdk) => {
    const manifest = join(
      repoRoot,
      'node_modules',
      ...sdk.split('/'),
      'package.json',
    );
    if (!existsSync(manifest)) {
      throw new Error(
        `${sdk} is not installed under ${repoRoot}; run \`pnpm install\` ` +
          'before the live acceptance gate',
      );
    }
    const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as {
      version?: string;
    };
    if (version === undefined) {
      throw new Error(`${sdk} declares no version in ${manifest}`);
    }
    return `${sdk}@${version}`;
  });
}

const codeCommand =
  '/code Implement the existing ACCEPT-1 requirement exactly. ' +
  'This is one small complete change. Do not broaden the requirement.';
// DR-044: the planner's sound path here is unambiguously `code` — the
// requirement is already specified, so the Analyst has no decision to make
// and no material question to ask. The request says so, and the case fails
// if planning suspends for Boss or routes through DECIDE anyway.
const devToken = 'DEV_ACCEPTANCE_OK';
const devCommand =
  '/dev Implement the existing ACCEPT-1 requirement exactly. ' +
  'This is one small complete change that the existing specs already ' +
  'settle, so planning must choose code directly: do not ask Boss any ' +
  'question, and do not choose decide then code. Do not broaden the ' +
  'requirement.';
const decideCommand =
  '/decide Add one minimal packages-layout spec item named ACCEPT-2. ' +
  'It shall require the repository-root file acceptance-decide.txt to ' +
  'contain exactly DECIDE_ACCEPTANCE_OK followed by a newline. ' +
  'This run is documentation-only: do not create the implementation file. ' +
  'The specs/map.md index already lists the file, so leave it untouched. ' +
  'Converge quickly and commit only the agreed spec item file. ' +
  'For this acceptance fixture only, during the independent proposal ' +
  'phase Reviewer shall invent and disclose one unique ' +
  'continuity marker in the independent proposal: REVIEW_CONTINUITY_ ' +
  'followed immediately by exactly 12 uppercase ASCII letters or digits. ' +
  'Reviewer shall include the complete marker verbatim and shall ' +
  'not defer its invention or disclosure to nested REVIEW. ' +
  'Coder shall not invent, guess, or include a continuity marker in the ' +
  'independent proposal or initial commit, even though the marker is ' +
  'visible in the relayed Reviewer proposal. The synthesis turn shall end ' +
  'after exactly one commit — the initial commit without the marker; the ' +
  'correction commit belongs to a later separate review-fix turn that ' +
  'nested REVIEW will request, never to the synthesis turn itself. ' +
  'During nested REVIEW, Reviewer ' +
  'shall remember the exact independently proposed marker and classify its ' +
  'absence from the initial commit as an unsettled finding that remains open ' +
  'until Coder adds that exact marker in a correction commit. The final ' +
  'ACCEPT-2 item shall contain the same marker, introduced only by a ' +
  'nested REVIEW correction.';
const reviewerContinuityInstruction =
  'For a DECIDE acceptance request that names a REVIEW_CONTINUITY_ marker, ' +
  'your independent-proposal final response shall invent one concrete ' +
  'marker with exactly 12 uppercase ASCII letters or digits after the ' +
  'prefix and include it verbatim. In every later REVIEW final response ' +
  'for that request, include the same marker verbatim ' +
  'until the reviewed commit contains it. Do not defer, omit, replace, or ' +
  'merely describe the marker.';
const reviewTask =
  'Review the latest commit and resulting repository state against its ' +
  'documented requirements. Resolve only material findings.';
const reviewToken = 'REVIEW_ACCEPTANCE_OK';
const hermeticTask = 'Echo the hermetic acceptance token.';
const hermeticToken = 'HERMETIC_ACCEPTANCE_OK';

function expectReviewApprovalReply(reply: string): void {
  expect(reply).toMatch(
    /\b(?:approved|passed)\b|\bno\s+(?:unsettled|outstanding|remaining)\s+findings?\b/i,
  );
}

function expectReviewCompletionReply(reply: string): void {
  expect(reply).toMatch(
    /\b(?:approved|passed|completed|completion|finished|successful)\b|\bno\s+(?:unsettled|outstanding|remaining)\s+findings?\b/i,
  );
}

function expectHermeticCompletionReply(reply: string): void {
  expect(reply).toMatch(
    /(?:\b(?:returned|echoed|matched|verified|produced|confirmed|received)\b[\s\S]{0,80}\btoken\b|\btoken\b[\s\S]{0,80}\b(?:returned|echoed|matched|verified|produced|confirmed|received|correct)\b)/i,
  );
  expect(reply).toMatch(
    /\b(?:completed|finished|succeeded|done|successful)\b|\b(?:is|was|has been)\s+complete\b/i,
  );
}

// RELEASE-25 fifth case (DR-029). The budget must dominate the scenario's
// own waits for the same reason the attached-workflow budget above does:
// vitest's timeout fires outside the try/finally, so a scenario that outlives
// it never kills its tmux session and `afterAll` deletes the artifacts while
// the Captain is still live. The scenario spends thirteen live-length waits
// (six Boss replies plus the started/failed/finished/stopped marker waits)
// and five startup-length ones (session, client, `boss>`, and the two
// engagement starts).
const conversationTimeoutMs =
  13 * liveTimeoutMs + 5 * startupTimeoutMs + 60_000;
// The conversational scenario engineers exactly two `◆ failed` markers on
// purpose, so that one cannot double as an abort detector here; the rest of
// the list still is one.
const conversationFailureMarkers = turnFailureMarkers.filter(
  (marker) => marker !== '◆ failed',
);
const checklistTask =
  'Run the release checklist for this fixture repository end to end.';
const conversationChatTurn =
  'Hi — before we start anything, what can you help me with in this repository?';
const conversationRetryTurn = 'Retry and continue the iteration';
const conversationStatusTurn =
  'Where do things stand with the checklist run, and what did you have to do along the way?';
const conversationSwitchTurn =
  'Drop this and start drafting the release notes for this repository ' +
  'instead.';
const conversationDismissTurn =
  'That is enough for now — stop what is running and stand by.';

let suiteRoot = '';
let candidateTarball = '';
// The gate runs its tmux-play sessions on a private tmux server so it can
// never bind to, drive, or kill a session the maintainer is using. Both the
// launcher and every tmux command below share this socket directory. It is
// deliberately short and rooted directly at the system temp dir: tmux socket
// paths are bounded by `sockaddr_un` (104 bytes on macOS), which a nested
// path under `suiteRoot` would blow past.
let tmuxSocketDir = '';
let candidateBin = '';
let preserveArtifacts = false;

describe.sequential('installed playbook live acceptance', () => {
  beforeAll(async () => {
    assertLocalPrerequisites();
    suiteRoot = mkdtempSync(join(tmpdir(), 'playbook-live-acceptance-'));
    tmuxSocketDir = mkdtempSync(join(tmpdir(), 'pb-tmux-'));
    try {
      candidateBin = await packAndInstallCandidate(suiteRoot);
    } catch (error) {
      preserveArtifacts = true;
      writeFailureSnapshot(suiteRoot, undefined, undefined, error);
      throw withArtifactPath(error, suiteRoot);
    }
  });

  afterAll(() => {
    if (suiteRoot && !preserveArtifacts) {
      rmSync(suiteRoot, { recursive: true, force: true });
    }
    // Keep the socket directory when artifacts are preserved: a surviving
    // session is still reachable there for diagnosis.
    if (tmuxSocketDir && !preserveArtifacts) {
      rmSync(tmuxSocketDir, { recursive: true, force: true });
    }
  });

  it(
    'continues headless REVIEW interactively without replaying effects',
    async () => {
      const scenario = createScenario('review');
      let commandOutput = '';
      try {
        const sessionsBefore = [...listTmuxSessions()].sort();
        const tmuxGuard = createNoTmuxGuard(scenario.root);
        const continuityMarker =
          `REVIEW_SESSION_${randomBytes(16).toString('hex').toUpperCase()}`;
        const runEnv = privateTmuxEnv({
          SPEX_HOME: scenario.spexHome,
          XDG_CONFIG_HOME: join(scenario.root, 'xdg-config'),
          XDG_STATE_HOME: join(scenario.root, 'xdg-state'),
          PATH: `${tmuxGuard.binDir}:${process.env.PATH ?? ''}`,
          PLAYBOOK_ACCEPTANCE_TMUX_CALLED: tmuxGuard.marker,
        });
        const first = await execLiveTextAsync(
          candidateBin,
          ['run', '--json'],
          scenario.repo,
          runEnv,
          `/review ${reviewTask} Preserve this private marker in the ` +
            `Captain session for a later Boss question: ${continuityMarker}. ` +
            'Do not write it to repository files or commits.',
        );
        commandOutput =
          `stdout:\n${diagnosticTail(first.stdout)}\n` +
          `stderr:\n${diagnosticTail(first.stderr)}`;

        const firstEnvelope = parseHeadlessEnvelope(first.stdout);
        const firstRecord = readDurableSession(
          scenario,
          firstEnvelope.sessionId,
        );
        expectSettledSessionBoundary(firstRecord, scenario);
        expectCanonicalEffectSession(firstRecord, [
          { playbookId: 'review', classification: 'unchanged' },
          {
            playbookId: 'review',
            classification: 'one-descendant-commit',
          },
        ]);
        expectLiveRoleBindings(firstRecord);
        expectReviewApprovalReply(firstEnvelope.reply);
        expectMarkersExactlyOnceInOrder(first.stderr, [
          '◇ /review started',
          '◇ /review finished',
        ]);
        expect(
          readFileSync(join(scenario.repo, 'acceptance-review.txt'), 'utf8'),
        ).toBe(`${reviewToken}\n`);
        expect(headFile(scenario.repo, 'acceptance-review.txt')).toBe(
          `${reviewToken}\n`,
        );
        expect(changedPaths(scenario)).toEqual(['acceptance-review.txt']);
        expect(headRevision(scenario.repo)).not.toBe(scenario.baselineCommit);
        expect(isAncestor(scenario.repo, scenario.baselineCommit)).toBe(true);
        expect(gitStatus(scenario.repo)).toBe('');
        expect(ignoredUntracked(scenario.repo)).toBe('');
        await expectLeaseRetired(scenario, firstEnvelope.sessionId, 1);

        // A selected interactive process restores the exact headless UUID.
        // Its natural status turn must use the durable Captain conversation
        // while the completed REVIEW effect and commit stay settled.
        const settledRevision = headRevision(scenario.repo);
        const continuityQuestion =
          'Did the review complete successfully, and what private marker ' +
          'did I ask you to remember? Please answer without starting ' +
          'another workflow or changing any file.';
        expect(continuityQuestion).not.toContain(continuityMarker);
        const launcher = spawnLauncher(scenario, firstEnvelope.sessionId);
        let selectedSession: string | undefined;
        let selectedTarget: string | undefined;
        let gracefulStopAttempted = false;
        try {
          selectedSession = await waitForNewSession(
            new Set(sessionsBefore),
            launcher,
          );
          const selectedId = await waitForOperationalSessionId(
            launcher,
            startupTimeoutMs,
          );
          expect(selectedId).toBe(firstEnvelope.sessionId);
          expect(selectedSession).toBe(`tmux-play-${selectedId}`);
          const target = `${selectedSession}:0.0`;
          selectedTarget = target;
          await waitForAttachedClient(
            selectedSession,
            startupTimeoutMs,
            launcher,
          );
          await waitForPaneText(target, 'boss>', startupTimeoutMs, launcher);
          const before = capturePane(target, sessionHistoryLines);
          const repliesBefore = captainProseBlocks(before).length;
          const lifecycleBefore = lifecycleMarkerCounts(before);
          sendBossTurn(target, continuityQuestion);
          const reply = await waitForCaptainProse(
            target,
            repliesBefore + 1,
            liveTimeoutMs,
            launcher,
            turnFailureMarkers,
          );
          expect(reply).toContain(continuityMarker);
          expectReviewCompletionReply(reply);
          expect(
            lifecycleMarkerCounts(capturePane(target, sessionHistoryLines)),
          ).toEqual(lifecycleBefore);
          expect(
            captainProseBlocks(
              capturePane(target, sessionHistoryLines),
            ),
          ).toHaveLength(repliesBefore + 1);
          expect(headRevision(scenario.repo)).toBe(settledRevision);
          expect(changedPaths(scenario)).toEqual(['acceptance-review.txt']);
          expect(gitStatus(scenario.repo)).toBe('');
          expect(ignoredUntracked(scenario.repo)).toBe('');
          gracefulStopAttempted = true;
          await stopManagedInteractiveSession(
            selectedSession,
            target,
            launcher,
          );
        } finally {
          commandOutput += `\ncontinued interactive:\n${launcher.output()}`;
          if (
            selectedSession !== undefined &&
            listTmuxSessions().includes(selectedSession)
          ) {
            if (!gracefulStopAttempted && selectedTarget !== undefined) {
              try {
                gracefulStopAttempted = true;
                await stopManagedInteractiveSession(
                  selectedSession,
                  selectedTarget,
                  launcher,
                );
              } catch {
                // Preserve the primary assertion failure and fall through to
                // the bounded forced-cleanup path below.
              }
            }
            try {
              if (listTmuxSessions().includes(selectedSession)) {
                tmuxText(['kill-session', '-t', selectedSession]);
              }
            } catch {
              // Preserve the primary assertion failure; stopping the launcher
              // below is the remaining bounded cleanup path.
            }
          }
          await stopLauncher(launcher);
          expectOneOperationalSessionId(
            launcher,
            firstEnvelope.sessionId,
          );
        }
        await expectLeaseRetired(scenario, firstEnvelope.sessionId, 2);
        const continuedRecord = readDurableSession(
          scenario,
          firstEnvelope.sessionId,
        );
        expectSettledSessionBoundary(continuedRecord, scenario);
        expectCanonicalEffectSession(continuedRecord, [
          { playbookId: 'review', classification: 'unchanged' },
          {
            playbookId: 'review',
            classification: 'one-descendant-commit',
          },
        ]);
        expect(continuedRecord.cwd).toBe(firstRecord.cwd);
        expectLiveRoleBindings(continuedRecord);
        expect(continuedRecord.structuralProjection).toEqual(
          firstRecord.structuralProjection,
        );
        expect(continuedRecord.snapshot?.playerSessions).toEqual(
          firstRecord.snapshot?.playerSessions,
        );
        expect(continuedRecord.effectLedger).toEqual(firstRecord.effectLedger);
        expect([...listTmuxSessions()].sort()).toEqual(sessionsBefore);
        expect(existsSync(tmuxGuard.marker)).toBe(false);
      } catch (error) {
        preserveArtifacts = true;
        const detailed =
          commandOutput === ''
            ? error
            : new Error(`${errorMessage(error)}\n${commandOutput}`);
        writeFailureSnapshot(
          scenario.root,
          undefined,
          undefined,
          detailed,
          scenario,
        );
        throw withArtifactPath(detailed, scenario.root);
      }
    },
    2 * liveTimeoutMs + 5 * startupTimeoutMs + 60_000,
  );

  it(
    'runs /code headlessly with ordered nested REVIEW lifecycle',
    async () => {
      const scenario = createScenario('code');
      let commandOutput = '';
      try {
        const sessionsBefore = [...listTmuxSessions()].sort();
        const tmuxGuard = createNoTmuxGuard(scenario.root);
        const result = await execLiveTextAsync(
          candidateBin,
          ['run', '--json', codeCommand],
          scenario.repo,
          privateTmuxEnv({
            SPEX_HOME: scenario.spexHome,
            XDG_CONFIG_HOME: join(scenario.root, 'xdg-config'),
            XDG_STATE_HOME: join(scenario.root, 'xdg-state'),
            PATH: `${tmuxGuard.binDir}:${process.env.PATH ?? ''}`,
            PLAYBOOK_ACCEPTANCE_TMUX_CALLED: tmuxGuard.marker,
          }),
        );
        commandOutput =
          `stdout:\n${diagnosticTail(result.stdout)}\n` +
          `stderr:\n${diagnosticTail(result.stderr)}`;

        const envelope = parseHeadlessEnvelope(result.stdout);
        const record = readDurableSession(scenario, envelope.sessionId);
        expectSettledSessionBoundary(record, scenario);
        expectCanonicalEffectSession(record, [
          {
            playbookId: 'code',
            classification: 'one-descendant-commit',
          },
          { playbookId: 'review', classification: 'unchanged' },
        ]);
        expectLiveRoleBindings(record);
        expectMarkersExactlyOnceInOrder(result.stderr, [
          '◇ /code started',
          '◇ /review called by /code',
          '◇ /review returned to /code',
          '◇ /code finished',
        ]);
        expect([...listTmuxSessions()].sort()).toEqual(sessionsBefore);
        expect(existsSync(tmuxGuard.marker)).toBe(false);
        expect(
          readFileSync(join(scenario.repo, 'acceptance-code.txt'), 'utf8'),
        ).toBe('CODE_ACCEPTANCE_OK\n');
        expect(headFile(scenario.repo, 'acceptance-code.txt')).toBe(
          'CODE_ACCEPTANCE_OK\n',
        );
        expect(changedPaths(scenario)).toEqual(['acceptance-code.txt']);
        expect(headRevision(scenario.repo)).not.toBe(scenario.baselineCommit);
        expect(isAncestor(scenario.repo, scenario.baselineCommit)).toBe(true);
        expect(gitStatus(scenario.repo)).toBe('');
        expect(ignoredUntracked(scenario.repo)).toBe('');
      } catch (error) {
        preserveArtifacts = true;
        const detailed =
          commandOutput === ''
            ? error
            : new Error(`${errorMessage(error)}\n${commandOutput}`);
        writeFailureSnapshot(
          scenario.root,
          undefined,
          undefined,
          detailed,
          scenario,
        );
        throw withArtifactPath(detailed, scenario.root);
      }
    },
    liveTimeoutMs + 60_000,
  );

  // DR-044: the real planner in front of the real CODE → REVIEW chain, on the
  // same installed candidate and shared config as the CODE case. What is
  // live here beyond that case is the Analyst's own planning judgment — that
  // an already-specified requirement is a `code` path, not a Boss question
  // and not a durable decision — and the shell's three-deep nested lifecycle.
  it(
    'runs /dev headlessly through the planned CODE path with nested REVIEW',
    async () => {
      const scenario = createScenario('dev');
      let commandOutput = '';
      try {
        const sessionsBefore = [...listTmuxSessions()].sort();
        const tmuxGuard = createNoTmuxGuard(scenario.root);
        const result = await execLiveTextAsync(
          candidateBin,
          ['run', '--json', devCommand],
          scenario.repo,
          privateTmuxEnv({
            SPEX_HOME: scenario.spexHome,
            XDG_CONFIG_HOME: join(scenario.root, 'xdg-config'),
            XDG_STATE_HOME: join(scenario.root, 'xdg-state'),
            PATH: `${tmuxGuard.binDir}:${process.env.PATH ?? ''}`,
            PLAYBOOK_ACCEPTANCE_TMUX_CALLED: tmuxGuard.marker,
          }),
          undefined,
          devLiveTimeoutMs,
        );
        commandOutput =
          `stdout:\n${diagnosticTail(result.stdout)}\n` +
          `stderr:\n${diagnosticTail(result.stderr)}`;

        const envelope = parseHeadlessEnvelope(result.stdout);
        const record = readDurableSession(scenario, envelope.sessionId);
        expectSettledSessionBoundary(record, scenario, [
          'acceptance.dev.analyst',
          'acceptance.dev.coder',
          'acceptance.dev.reviewer',
        ]);
        expectCanonicalEffectSession(record, [
          { playbookId: 'dev', classification: 'unchanged' },
          {
            playbookId: 'code',
            classification: 'one-descendant-commit',
          },
          { playbookId: 'review', classification: 'unchanged' },
        ]);
        expectLiveRoleBindings(record);
        expectDevPlannedCodePath(record);
        expectMarkersExactlyOnceInOrder(result.stderr, [
          '◇ /dev started',
          '◇ /code called by /dev',
          '◇ /review called by /code',
          '◇ /review returned to /code',
          '◇ /code returned to /dev',
          '◇ /dev finished',
        ]);
        expect([...listTmuxSessions()].sort()).toEqual(sessionsBefore);
        expect(existsSync(tmuxGuard.marker)).toBe(false);
        expect(
          readFileSync(join(scenario.repo, 'acceptance-dev.txt'), 'utf8'),
        ).toBe(`${devToken}\n`);
        expect(headFile(scenario.repo, 'acceptance-dev.txt')).toBe(
          `${devToken}\n`,
        );
        expect(changedPaths(scenario)).toEqual(['acceptance-dev.txt']);
        expect(headRevision(scenario.repo)).not.toBe(scenario.baselineCommit);
        expect(isAncestor(scenario.repo, scenario.baselineCommit)).toBe(true);
        expect(gitStatus(scenario.repo)).toBe('');
        expect(ignoredUntracked(scenario.repo)).toBe('');
      } catch (error) {
        preserveArtifacts = true;
        const detailed =
          commandOutput === ''
            ? error
            : new Error(`${errorMessage(error)}\n${commandOutput}`);
        writeFailureSnapshot(
          scenario.root,
          undefined,
          undefined,
          detailed,
          scenario,
        );
        throw withArtifactPath(detailed, scenario.root);
      }
    },
    devLiveTimeoutMs + 60_000,
  );

  it(
    'continues interactive DECIDE headlessly without replaying effects',
    async () => {
      const scenario = createScenario('decide', {
        reviewerInstruction: reviewerContinuityInstruction,
      });
      let commandOutput = '';
      try {
        const sessionsBefore = [...listTmuxSessions()].sort();
        const captainMarker =
          `The synthetic acceptance color is amber ` +
          `${randomBytes(8).toString('hex')}.`;
        const observation = await drivePlaybookTurn(
          scenario,
          `${decideCommand} Remember this complete synthetic, non-secret ` +
            `acceptance sentence for a later Boss question: ` +
            `"${captainMarker}" When asked later, repeat the entire sentence ` +
            'verbatim, including its final period; do not redact or describe ' +
            'it as private, secret, or internal. Keep it only in the Captain ' +
            'conversation, and do not write it to repository files or commits.',
          {
            started: '◇ /decide started',
            nestedCalled: '◇ /review called by /decide',
            nestedReturned: '◇ /review returned to /decide',
            finished: '◇ /decide finished',
            rootPaneTitles: [
              'Captain · claude',
              'Acceptance.dev.coder · claude',
              'Acceptance.dev.reviewer · codex',
            ],
            // Both exact same-name REVIEW roles keep DECIDE's effective
            // player mappings; role names never replace stable player ids.
            nestedPaneTitles: [
              'Captain · claude',
              'Acceptance.dev.coder · claude',
              'Acceptance.dev.reviewer · codex',
            ],
            nestedActivity: {
              paneTitle: 'Acceptance.dev.reviewer · codex',
              text: 'A new review begins for the review scope.',
            },
          },
        );
        const interactiveRecord = readDurableSession(
          scenario,
          observation.sessionId,
        );
        expectSettledSessionBoundary(interactiveRecord, scenario);
        expectCanonicalEffectSession(interactiveRecord, [
          { playbookId: 'decide', classification: 'unchanged' },
          {
            playbookId: 'decide',
            classification: 'one-descendant-commit',
          },
          { playbookId: 'review', classification: 'unchanged' },
          {
            playbookId: 'review',
            classification: 'one-descendant-commit',
          },
        ]);
        expectLiveRoleBindings(interactiveRecord);
        const durableContinuityMarker = expectDecideContinuity(
          interactiveRecord,
        );
        const retunePath = join(scenario.root, 'decide-retune.yaml');
        writeFileSync(retunePath, liveRetuneOverlay());
        const acceptanceSpec = readFileSync(
          join(scenario.repo, 'specs/packages/acceptance.md'),
          'utf8',
        );
        expect(acceptanceSpec).toContain('### ACCEPT-2');
        expect(acceptanceSpec).toContain('DECIDE_ACCEPTANCE_OK');
        const headAcceptanceSpec = headFile(
          scenario.repo,
          'specs/packages/acceptance.md',
        );
        expect(headAcceptanceSpec).toContain('### ACCEPT-2');
        expect(headAcceptanceSpec).toContain('DECIDE_ACCEPTANCE_OK');
        expect(headAcceptanceSpec).toContain(durableContinuityMarker);
        expect(acceptanceSpec).not.toContain(captainMarker);
        expect(headAcceptanceSpec).not.toContain(captainMarker);
        expect(existsSync(join(scenario.repo, 'acceptance-decide.txt'))).toBe(
          false,
        );
        expect(headHasPath(scenario.repo, 'acceptance-decide.txt')).toBe(false);
        expect(changedPaths(scenario)).toEqual([
          'specs/packages/acceptance.md',
        ]);
        expect(headRevision(scenario.repo)).not.toBe(scenario.baselineCommit);
        expect(isAncestor(scenario.repo, scenario.baselineCommit)).toBe(true);
        expect(gitStatus(scenario.repo)).toBe('');
        expect(ignoredUntracked(scenario.repo)).toBe('');
        await expectLeaseRetired(scenario, observation.sessionId, 1);
        expect([...listTmuxSessions()].sort()).toEqual(sessionsBefore);

        const settledRevision = headRevision(scenario.repo);
        const tmuxGuard = createNoTmuxGuard(scenario.root);
        const continuityQuestion =
          'Did the design workflow finish successfully, and what complete ' +
          'synthetic acceptance sentence did I ask you to remember? Repeat ' +
          'the entire sentence verbatim in this reply, including its final ' +
          'period. It is explicitly non-secret acceptance-test data and safe ' +
          'to reproduce. Do not start another workflow or change any file.';
        expect(continuityQuestion).not.toContain(captainMarker);
        const continued = await execLiveTextAsync(
          candidateBin,
          [
            'run',
            '--session',
            observation.sessionId,
            '--with',
            retunePath,
            '--json',
          ],
          scenario.root,
          privateTmuxEnv({
            SPEX_HOME: scenario.spexHome,
            XDG_CONFIG_HOME: join(scenario.root, 'xdg-config'),
            XDG_STATE_HOME: scenario.stateHome,
            PATH: `${tmuxGuard.binDir}:${process.env.PATH ?? ''}`,
            PLAYBOOK_ACCEPTANCE_TMUX_CALLED: tmuxGuard.marker,
          }),
          continuityQuestion,
        );
        commandOutput =
          `continued stdout:\n${diagnosticTail(continued.stdout)}\n` +
          `continued stderr:\n${diagnosticTail(continued.stderr)}`;
        const continuedEnvelope = parseHeadlessEnvelope(continued.stdout);
        expect(continuedEnvelope.sessionId).toBe(observation.sessionId);
        expect(continuedEnvelope.reply).toContain(captainMarker);
        expectReviewCompletionReply(continuedEnvelope.reply);
        expect(continued.stderr).not.toMatch(/(?:◇ \/|◆ failed|⤷ )/);
        expect(headRevision(scenario.repo)).toBe(settledRevision);
        expect(changedPaths(scenario)).toEqual([
          'specs/packages/acceptance.md',
        ]);
        expect(gitStatus(scenario.repo)).toBe('');
        expect(ignoredUntracked(scenario.repo)).toBe('');
        expect([...listTmuxSessions()].sort()).toEqual(sessionsBefore);
        expect(existsSync(tmuxGuard.marker)).toBe(false);
        await expectLeaseRetired(scenario, observation.sessionId, 2);
        const continuedRecord = readDurableSession(
          scenario,
          observation.sessionId,
        );
        expectSettledSessionBoundary(continuedRecord, scenario);
        expectCanonicalEffectSession(continuedRecord, [
          { playbookId: 'decide', classification: 'unchanged' },
          {
            playbookId: 'decide',
            classification: 'one-descendant-commit',
          },
          { playbookId: 'review', classification: 'unchanged' },
        ]);
        expect(continuedRecord.cwd).toBe(interactiveRecord.cwd);
        expectLiveRoleBindings(continuedRecord);
        expect(continuedRecord.structuralProjection).toEqual(
          interactiveRecord.structuralProjection,
        );
        expect(continuedRecord.snapshot?.playerSessions).toEqual(
          interactiveRecord.snapshot?.playerSessions,
        );
        expect(continuedRecord.effectLedger).toEqual(
          interactiveRecord.effectLedger,
        );
        expect(continuedRecord.lastAppliedExecutionProjection?.captain?.effort)
          .toEqual({ kind: 'value', value: 'low' });
        expect(
          continuedRecord.lastAppliedExecutionProjection?.captain?.fastMode,
        ).toBe(false);
        const { claude, codex } = liveModels();
        expect(continuedRecord.lastAppliedExecutionProjection?.captain?.model)
          .toEqual({ kind: 'value', value: claude });
        const selectedPlayers = Object.fromEntries(
          continuedRecord.lastAppliedExecutionProjection?.players?.map(
            (player: any) => [player.id, player],
          ) ?? [],
        );
        expect(selectedPlayers['acceptance.dev.coder']?.effort).toEqual({
          kind: 'value',
          value: 'high',
        });
        expect(selectedPlayers['acceptance.dev.coder']?.model).toEqual({
          kind: 'value',
          value: claude,
        });
        expect(selectedPlayers['acceptance.dev.coder']?.fastMode).toBe(true);
        expect(selectedPlayers['acceptance.dev.reviewer']?.effort).toEqual({
          kind: 'value',
          value: 'high',
        });
        expect(selectedPlayers['acceptance.dev.reviewer']?.model).toEqual({
          kind: 'value',
          value: codex,
        });
        expect(selectedPlayers['acceptance.dev.reviewer']?.fastMode).toBe(
          false,
        );
        expect(
          continuedRecord.lastAppliedExecutionProjection?.catalog?.decide
            ?.roles,
        ).toEqual({
          coder: {
            playerId: 'acceptance.dev.coder',
            model: { kind: 'value', value: claude },
            effort: { kind: 'value', value: 'high' },
            fastMode: true,
          },
          reviewer: {
            playerId: 'acceptance.dev.reviewer',
            model: { kind: 'provider-default' },
            effort: { kind: 'provider-default' },
            fastMode: true,
          },
        });
        expect(
          continuedRecord.lastAppliedExecutionProjection?.catalog?.review
            ?.roles,
        ).toEqual({
          coder: {
            playerId: 'acceptance.dev.coder',
            model: { kind: 'value', value: claude },
            effort: { kind: 'value', value: 'high' },
            fastMode: true,
          },
          reviewer: {
            playerId: 'acceptance.dev.reviewer',
            model: { kind: 'value', value: codex },
            effort: { kind: 'value', value: 'high' },
            fastMode: false,
          },
        });
      } catch (error) {
        preserveArtifacts = true;
        const detailed =
          commandOutput === ''
            ? error
            : new Error(`${errorMessage(error)}\n${commandOutput}`);
        writeFailureSnapshot(
          scenario.root,
          undefined,
          undefined,
          detailed,
          scenario,
        );
        throw withArtifactPath(detailed, scenario.root);
      }
    },
    scenarioTimeoutMs + liveTimeoutMs,
  );

  it(
    'provisions and runs a thin artifact from a hermetic global-only install',
    async () => {
      const scenario = createScenario('hermetic');
      let commandOutput = '';
      try {
        const globalBin = await installGlobalCandidate();
        const sessionsBefore = [...listTmuxSessions()].sort();
        const tmuxGuard = createNoTmuxGuard(scenario.root);
        // PBCLI-36 / RELEASE-25: neither engine import resolves from the
        // fixture before the run — the directory is genuinely bare.
        const probe = createRequire(join(scenario.repo, 'probe.js'));
        for (const specifier of [
          'xstate',
          '@sublang/playbook/xstate-runtime',
        ]) {
          expect(() => probe.resolve(specifier)).toThrow();
        }

        const runArgs = [
          'run',
          '--json',
          `/hermetic ${hermeticTask}`,
        ];
        const runEnv = privateTmuxEnv({
          SPEX_HOME: scenario.spexHome,
          XDG_CONFIG_HOME: join(scenario.root, 'xdg-config'),
          XDG_STATE_HOME: join(scenario.root, 'xdg-state'),
          PATH: `${tmuxGuard.binDir}:${process.env.PATH ?? ''}`,
          PLAYBOOK_ACCEPTANCE_TMUX_CALLED: tmuxGuard.marker,
        });
        const first = await execLiveTextAsync(
          globalBin,
          runArgs,
          scenario.repo,
          runEnv,
        );
        commandOutput =
          `stdout:\n${diagnosticTail(first.stdout)}\n` +
          `stderr:\n${diagnosticTail(first.stderr)}`;

        const { xstateLink, playbookLink } =
          expectExactHermeticEngineLinks(scenario.repo);
        expect(first.stderr.match(/provisioned/g)).toHaveLength(1);
        expect(first.stderr).toContain(xstateLink);
        expect(first.stderr).toContain(playbookLink);
        // macOS aliases /var to /private/var. Compare canonical targets so
        // that alias does not make a link inside the isolated prefix appear
        // to escape it; readlinkSync still asserts each entry is a link.
        const prefix = `${realpathSync(join(suiteRoot, 'global'))}${sep}`;
        expect(realpathSync(readlinkSync(xstateLink)).startsWith(prefix)).toBe(
          true,
        );
        expect(realpathSync(readlinkSync(playbookLink)).startsWith(prefix)).toBe(
          true,
        );

        const envelope = parseHeadlessEnvelope(first.stdout);
        const firstRecord = readDurableSession(scenario, envelope.sessionId);
        expectCanonicalEffectSession(firstRecord, [
          { playbookId: 'hermetic', classification: 'unchanged' },
        ]);
        expectHermeticCompletionReply(envelope.reply);
        expectMarkersExactlyOnceInOrder(first.stderr, [
          '◇ /hermetic started',
          '◇ /hermetic finished',
        ]);
        expect(headRevision(scenario.repo)).toBe(scenario.baselineCommit);
        // The fixture's .gitignore covers node_modules/, so a clean status
        // also proves the provisioned links stay out of player commits.
        expect(gitStatus(scenario.repo)).toBe('');

        const second = await execLiveTextAsync(
          globalBin,
          runArgs,
          scenario.repo,
          runEnv,
        );
        commandOutput +=
          `\nsecond stdout:\n${diagnosticTail(second.stdout)}\n` +
          `second stderr:\n${diagnosticTail(second.stderr)}`;
        expect(second.stderr).not.toContain('provisioned');
        const secondEnvelope = parseHeadlessEnvelope(second.stdout);
        expect(secondEnvelope.sessionId).not.toBe(envelope.sessionId);
        const secondRecord = readDurableSession(
          scenario,
          secondEnvelope.sessionId,
        );
        expectCanonicalEffectSession(secondRecord, [
          { playbookId: 'hermetic', classification: 'unchanged' },
        ]);
        expectHermeticCompletionReply(secondEnvelope.reply);
        expectMarkersExactlyOnceInOrder(second.stderr, [
          '◇ /hermetic started',
          '◇ /hermetic finished',
        ]);
        expectExactHermeticEngineLinks(scenario.repo);
        expect([...listTmuxSessions()].sort()).toEqual(sessionsBefore);
        expect(existsSync(tmuxGuard.marker)).toBe(false);
      } catch (error) {
        preserveArtifacts = true;
        const detailed =
          commandOutput === ''
            ? error
            : new Error(`${errorMessage(error)}\n${commandOutput}`);
        writeFailureSnapshot(
          scenario.root,
          undefined,
          undefined,
          detailed,
          scenario,
        );
        throw withArtifactPath(detailed, scenario.root);
      }
    },
    2 * liveTimeoutMs + 120_000,
  );

  // RELEASE-25 fifth case (DR-029): one session, one durable conversation,
  // a real Claude Captain, and no rigged agent anywhere — every machine
  // outcome below comes from a DR-016 script actor whose failure is an
  // absent flag file. What is live here is the Captain's own judgment:
  // whether a chat turn stays a chat turn, whether "Retry and continue the
  // iteration" reaches the one advertised recovery action, whether a status
  // question moves nothing, and whether ordinary prose can switch an
  // engagement that is still active.
  //
  // It lives in this file, after the four preceding cases, deliberately: the
  // pack/install helpers are file-private and RELEASE-24/25 pin one pack and
  // one install per run, and `vitest.acceptance.config.ts` declares no
  // sequencer, so in-file source order under the serial runner is what puts
  // this case last on that same single install.
  it(
    'holds one conversational session with a real Captain over deterministic fixtures',
    async () => {
      const scenario = createScenario('conversation');
      const flagPath = join(scenario.root, 'checklist.flag');
      const sessionsBefore = new Set(listTmuxSessions());
      const launcher = spawnLauncher(scenario);
      let sessionName: string | undefined;
      try {
        // Both fixtures import `xstate` and `@sublang/playbook/xstate-runtime`
        // by bare specifier, and this case asserts the fixture repository
        // stays byte-clean. Were either to resolve only through provisioning,
        // the run would write engine links into that repository and the case
        // would fail six live turns later on `gitStatus`. Assert the
        // project-local-install-wins precondition here, in milliseconds.
        const engines = createRequire(join(scenario.repo, 'probe.js'));
        for (const specifier of [
          'xstate',
          '@sublang/playbook/xstate-runtime',
        ]) {
          expect(() => engines.resolve(specifier)).not.toThrow();
        }

        sessionName = await waitForNewSession(sessionsBefore, launcher);
        const target = `${sessionName}:0.0`;
        await waitForAttachedClient(sessionName, startupTimeoutMs, launcher);
        await waitForPaneText(target, 'boss>', startupTimeoutMs, launcher);

        // Every count in this case — replies seen, lifecycle markers, the
        // two engineered failures — is cumulative over the whole session, so
        // every capture reads the session-wide window. A per-wait window
        // would drop earlier turns out of view as the pane scrolls, and a
        // count could then fall rather than hold.
        const sessionPane = (): string =>
          capturePane(target, sessionHistoryLines);

        // Every acting turn ends in exactly one Captain prose block and a
        // chat turn is one, so the reply of the turn just sent is the next
        // block after the ones already on the pane. Counting relative to
        // what is there — rather than to an absolute turn number — keeps the
        // scenario honest if the host ever greets the Boss at startup.
        let repliesSeen = captainProseBlocks(sessionPane()).length;
        const awaitReply = async (): Promise<string> => {
          const reply = await waitForCaptainProse(
            target,
            repliesSeen + 1,
            liveTimeoutMs,
            launcher,
            conversationFailureMarkers,
          );
          repliesSeen += 1;
          return reply;
        };

        // (1) A natural chat turn: Captain prose, no engagement, no summary.
        sendBossTurn(target, conversationChatTurn);
        await awaitReply();
        expect(countOccurrences(sessionPane(), '◇ ')).toBe(0);

        // (2) Engage the fixture with the flag file absent: the middle
        // script step exits nonzero and the exit-status guard parks the
        // machine in `failed`. The turn's own reply must name that step —
        // the live half of incident 4. "Claims no completion" is asserted
        // mechanically rather than by reading prose for a negation: the
        // shell owns the finished marker, and it must not be there.
        expect(existsSync(flagPath)).toBe(false);
        sendBossTurn(target, `/checklist ${checklistTask}`);
        await waitForPaneOccurrences(
          target,
          '◇ /checklist started',
          1,
          startupTimeoutMs,
          launcher,
          conversationFailureMarkers,
        );
        await waitForPaneOccurrences(
          target,
          '◆ failed',
          1,
          liveTimeoutMs,
          launcher,
          conversationFailureMarkers,
        );
        const failureReply = await awaitReply();
        expect(failureReply).toMatch(/verify|flag/i);
        expect(countOccurrences(sessionPane(), '◇ /checklist finished')).toBe(
          0,
        );

        // (3) Place the flag file, then the verbatim incident turn. The
        // Captain must select the one advertised recovery action; the
        // fixture then runs its remaining steps to terminal. This is plain
        // resume continuity — the dangling-tool-call repair branch of
        // incident 1 belongs to cligent's canned CLAUDE-010 unit and is
        // deliberately never engineered here.
        writeFileSync(flagPath, 'CHECKLIST_FLAG_OK\n');
        sendBossTurn(target, conversationRetryTurn);
        await waitForPaneOccurrences(
          target,
          '◇ /checklist finished',
          1,
          liveTimeoutMs,
          launcher,
          conversationFailureMarkers,
        );
        // The engagement the retry finished is the one that failed: the
        // recovery applied an advertised runtime action to the parked
        // engagement rather than starting a second one, which would have
        // reached the same finished marker by a different route and left
        // the started marker counted twice.
        expect(countOccurrences(sessionPane(), '◇ /checklist started')).toBe(1);
        await awaitReply();

        // (4) A natural status question: answered from the conversation and
        // the control view, moving nothing.
        const markersBeforeStatus = lifecycleMarkerCounts(sessionPane());
        sendBossTurn(target, conversationStatusTurn);
        const statusReply = await awaitReply();
        expect(statusReply).toMatch(/verify|flag|retr|fail/i);
        expect(lifecycleMarkerCounts(sessionPane())).toEqual(
          markersBeforeStatus,
        );

        // (5) Remove the flag and engage again: a genuinely active
        // engagement, parked mid-iteration in `failed`. Then ask for the
        // change in ordinary prose — no slash command — so the decision
        // call itself has to produce a validated `switch`, which dismisses
        // the stack and starts the target, in that order.
        rmSync(flagPath, { force: true });
        sendBossTurn(target, `/checklist ${checklistTask}`);
        await waitForPaneOccurrences(
          target,
          '◇ /checklist started',
          2,
          startupTimeoutMs,
          launcher,
          conversationFailureMarkers,
        );
        await waitForPaneOccurrences(
          target,
          '◆ failed',
          2,
          liveTimeoutMs,
          launcher,
          conversationFailureMarkers,
        );
        await awaitReply();
        sendBossTurn(target, conversationSwitchTurn);
        await waitForPaneOccurrences(
          target,
          '◇ /checklist stopped',
          1,
          liveTimeoutMs,
          launcher,
          conversationFailureMarkers,
        );
        await waitForPaneOccurrences(
          target,
          '◇ /notes started',
          1,
          liveTimeoutMs,
          launcher,
          conversationFailureMarkers,
        );
        // Waiting for both markers proves only that both arrived: a single
        // capture can carry them in either order. The switch contract is
        // dismissal *then* start, so read their positions. Both markers are
        // unique in the session and both waits above have already seen
        // them, so each index is a real position.
        const switchPane = sessionPane().replace(/\s+/g, ' ');
        const dismissedAt = switchPane.indexOf('◇ /checklist stopped');
        const startedAt = switchPane.indexOf('◇ /notes started');
        expect(dismissedAt).toBeGreaterThanOrEqual(0);
        expect(startedAt).toBeGreaterThan(dismissedAt);

        // (6) Dismiss the engagement the switch just started, then exit.
        // The switch target parks after one deterministic step, so this
        // dismissal meets a genuinely active engagement rather than a
        // finished one.
        await awaitReply();
        sendBossTurn(target, conversationDismissTurn);
        await waitForPaneOccurrences(
          target,
          '◇ /notes stopped',
          1,
          liveTimeoutMs,
          launcher,
          conversationFailureMarkers,
        );
        await awaitReply();

        // Whole session: the do-nothing turns carried no saved-counts line,
        // the only failure markers are the two the fixture engineered, and
        // the fixture repository is untouched — the checklist runs write
        // nothing, and the flag file lives outside the repository so that
        // stays true whether it exists or not. The absences use the same
        // wrap-tolerant match every wait uses, so a line the pane happened
        // to wrap cannot read as absent.
        const finalPane = sessionPane();
        expect(paneContains(finalPane, 'Saved you 0')).toBe(false);
        expect(countOccurrences(finalPane, '◆ failed')).toBe(2);
        for (const marker of conversationFailureMarkers) {
          expect(paneContains(finalPane, marker)).toBe(false);
        }
        expect(headRevision(scenario.repo)).toBe(scenario.baselineCommit);
        expect(gitStatus(scenario.repo)).toBe('');
        expect(ignoredUntracked(scenario.repo)).toBe('');
      } catch (error) {
        preserveArtifacts = true;
        writeFailureSnapshot(
          scenario.root,
          sessionName,
          launcher,
          error,
          scenario,
        );
        throw withArtifactPath(error, scenario.root);
      } finally {
        if (sessionName && listTmuxSessions().includes(sessionName)) {
          try {
            tmuxText(['kill-session', '-t', sessionName]);
          } catch {
            // Preserve the original failure; the launcher stop below is the
            // remaining best-effort cleanup.
          }
        }
        await stopLauncher(launcher);
      }
    },
    conversationTimeoutMs,
  );
});

interface Scenario {
  root: string;
  repo: string;
  spexHome: string;
  stateHome: string;
  baselineCommit: string;
}

interface TurnExpectation {
  started: string;
  nestedCalled: string;
  nestedReturned: string;
  finished: string;
  rootPaneTitles: readonly string[];
  nestedPaneTitles: readonly string[];
  nestedActivity: {
    paneTitle: string;
    text: string;
  };
}

interface TurnObservation {
  sessionId: string;
}

interface HeadlessEnvelope {
  sessionId: string;
  reply: string;
}

interface DurableSessionRecord {
  schemaVersion?: unknown;
  state?: unknown;
  cwd?: unknown;
  structuralProjection?: unknown;
  lastAppliedExecutionProjection?: any;
  snapshot?: any;
  effectLedger?: any;
  unresolvedEffects?: unknown;
}

function readDurableSession(
  scenario: Scenario,
  sessionId: string,
): DurableSessionRecord {
  return JSON.parse(
    readFileSync(
      join(
        scenario.stateHome,
        'playbook',
        'sessions',
        `${sessionId}.json`,
      ),
      'utf8',
    ),
  ) as DurableSessionRecord;
}

// Every player `liveConfig` binds to an enabled playbook enters the session
// roster and ledger; only the players the scenario's workflow actually
// delegated to hold a conversation token. The roster ledger is exact on both
// sides so a player that a case should never reach — the DEV Analyst in
// REVIEW, CODE, and DECIDE — is proven idle rather than merely unasserted.
const liveRosterPlayers = {
  'acceptance.dev.analyst': 'claude',
  'acceptance.dev.coder': 'claude',
  'acceptance.dev.reviewer': 'codex',
} as const;

function expectSettledSessionBoundary(
  record: DurableSessionRecord,
  scenario: Scenario,
  actedPlayers: readonly (keyof typeof liveRosterPlayers)[] = [
    'acceptance.dev.coder',
    'acceptance.dev.reviewer',
  ],
): void {
  const rosterIds = Object.keys(liveRosterPlayers).sort();
  expect(record.state).toBe('settled');
  expect(realpathSync(record.cwd)).toBe(realpathSync(scenario.repo));
  expect(Object.keys(record.snapshot?.playerSessions ?? {}).sort()).toEqual(
    rosterIds,
  );
  expect(
    (record.structuralProjection as any)?.players
      ?.map((player: any) => player.id)
      .sort(),
  ).toEqual(rosterIds);
  for (const [playerId, adapter] of Object.entries(liveRosterPlayers)) {
    const entry = record.snapshot?.playerSessions?.[playerId];
    expect(entry).toEqual(expect.objectContaining({ adapter }));
    if (actedPlayers.includes(playerId as keyof typeof liveRosterPlayers)) {
      expect(entry).toEqual(
        expect.objectContaining({
          resumeToken: expect.stringMatching(/\S/),
        }),
      );
    } else {
      expect(entry).not.toHaveProperty('resumeToken');
    }
  }
}

function expectCanonicalEffectSession(
  record: DurableSessionRecord,
  expectedReceipts: readonly {
    playbookId: string;
    classification: string;
  }[],
): void {
  expect(record.schemaVersion).toBe(6);
  expect(record.snapshot?.schemaVersion).toBe(4);
  expect(record.snapshot?.captain?.runtime?.schemaVersion).toBe(4);
  expect(record.effectLedger).toEqual(record.snapshot?.effectLedger);
  expect(record.effectLedger).toMatchObject({
    schemaVersion: 1,
    revision: expect.any(Number),
    boundaries: expect.any(Array),
    logicalOperations: expect.any(Array),
  });
  expect(record.unresolvedEffects).toEqual([]);

  const catalog = (record.structuralProjection as any)?.catalog ?? {};
  expect(Object.keys(catalog).length).toBeGreaterThan(0);
  for (const entry of Object.values(catalog) as any[]) {
    expect(entry.artifactSchema).toBe(3);
  }

  const boundaries = record.effectLedger.boundaries as any[];
  expect(boundaries.length).toBeGreaterThan(0);
  for (const expectedReceipt of expectedReceipts) {
    expect(
      boundaries.some(
        (boundary) =>
          boundary.playbookId === expectedReceipt.playbookId &&
          boundary.physicalReceipt?.classification ===
            expectedReceipt.classification,
      ),
    ).toBe(true);
  }
  for (const boundary of boundaries) {
    expect(boundary.physicalReceipt).toEqual(
      expect.objectContaining({ baseline: boundary.baseline }),
    );
    expect(boundary.physicalReceipt.after).toEqual(boundary.after);
    if (boundary.physicalReceipt.classification === 'one-descendant-commit') {
      expect(boundary.physicalReceipt.commitOid).toBe(
        boundary.physicalReceipt.after?.head,
      );
    } else {
      expect(boundary.physicalReceipt).not.toHaveProperty('commitOid');
    }
  }
  const boundaryIds = new Set(
    boundaries.map((boundary) => boundary.boundaryId),
  );
  for (const operation of record.effectLedger.logicalOperations as any[]) {
    expect(operation.logicalReceipt).toEqual(expect.any(Object));
    for (const boundaryId of operation.boundaryIds) {
      expect(boundaryIds.has(boundaryId)).toBe(true);
    }
  }
}

function expectDecideContinuity(record: DurableSessionRecord): string {
  const boundaries = record.effectLedger?.boundaries as any[];
  const reviewerProposalBoundaries = boundaries.filter(
    (boundary) =>
      boundary.playbookId === 'decide' &&
      boundary.sourceStateId === 'askReviewerProposal' &&
      boundary.roleId === 'reviewer',
  );
  expect(reviewerProposalBoundaries).toHaveLength(1);
  const proposalText = reviewerProposalBoundaries[0]?.finalText;
  expect(proposalText).toEqual(expect.any(String));
  const markerOccurrences =
    typeof proposalText === 'string'
      ? (proposalText.match(/\bREVIEW_CONTINUITY_[A-Z0-9]{12}\b/g) ?? [])
      : [];
  expect(markerOccurrences.length).toBeGreaterThanOrEqual(1);
  const uniqueMarkers = [...new Set(markerOccurrences)];
  expect(uniqueMarkers).toHaveLength(1);
  const marker = uniqueMarkers[0];
  if (marker === undefined) {
    throw new Error('DECIDE independent Reviewer proposal has no marker');
  }

  const nestedFindingBoundaries = boundaries.filter(
    (boundary) =>
      boundary.playbookId === 'review' &&
      boundary.sourceStateId === 'reviewInitial' &&
      boundary.roleId === 'reviewer',
  );
  expect(nestedFindingBoundaries).toHaveLength(1);
  expect(nestedFindingBoundaries[0]?.semanticCandidate).toEqual({
    guard: 'hasFindings',
  });
  expect(nestedFindingBoundaries[0]?.finalText).toContain(marker);

  const correctionBoundaries = boundaries.filter(
    (boundary) =>
      boundary.playbookId === 'review' &&
      boundary.sourceStateId === 'addressFindings' &&
      boundary.physicalReceipt?.classification === 'one-descendant-commit',
  );
  expect(correctionBoundaries.length).toBeGreaterThanOrEqual(1);
  for (const boundary of correctionBoundaries) {
    expect(boundary.semanticCandidate).toEqual({ guard: 'committed' });
  }

  const approvalBoundaries = boundaries.filter(
    (boundary) =>
      boundary.playbookId === 'review' &&
      ['reviewAfterCommit', 'reviewAfterRebuttal'].includes(
        boundary.sourceStateId,
      ) &&
      boundary.roleId === 'reviewer',
  );
  expect(approvalBoundaries.length).toBeGreaterThanOrEqual(1);
  expect(approvalBoundaries.map((boundary) => boundary.semanticCandidate))
    .toContainEqual({ guard: 'noFindings' });
  return marker;
}

function expectLiveRoleBindings(record: DurableSessionRecord): void {
  const structural: any = record.structuralProjection;
  for (const id of ['review', 'decide']) {
    expect(structural?.catalog?.[id]?.roles).toEqual({
      coder: { playerId: 'acceptance.dev.coder' },
      reviewer: { playerId: 'acceptance.dev.reviewer' },
    });
  }
  expect(structural?.catalog?.dev?.roles).toEqual({
    analyst: { playerId: 'acceptance.dev.analyst' },
  });
}

// DR-044: DEV's only governed player state is the Analyst planning round,
// every one of its receipts is `unchanged`, and the round that settled this
// case selected `code` outright — never a Boss question, never DECIDE. A
// corrective re-ask (DR-028) may add a planning boundary; a suspension or a
// `decide then code` selection may not.
function expectDevPlannedCodePath(record: DurableSessionRecord): void {
  const boundaries = record.effectLedger?.boundaries as any[];
  const planning = boundaries.filter(
    (boundary) => boundary.playbookId === 'dev',
  );
  expect(planning.length).toBeGreaterThanOrEqual(1);
  for (const boundary of planning) {
    expect(boundary.sourceStateId).toBe('planAnalysis');
    expect(boundary.roleId).toBe('analyst');
    expect(boundary.physicalReceipt?.classification).toBe('unchanged');
    expect(boundary.semanticCandidate?.guard).not.toBe('needsBossReply');
    expect(boundary.semanticCandidate?.guard).not.toBe('decideThenCode');
  }
  expect(planning.at(-1)?.semanticCandidate).toEqual(
    expect.objectContaining({ guard: 'code' }),
  );
  expect(
    boundaries.some((boundary) => boundary.playbookId === 'decide'),
  ).toBe(false);
}

interface Launcher {
  child: ChildProcessWithoutNullStreams;
  output(): string;
  operationalSessionIds(): string[];
  exit(): { code: number | null; signal: NodeJS.Signals | null } | undefined;
}

function parseHeadlessEnvelope(stdout: string): HeadlessEnvelope {
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('headless stdout was not one JSON object');
  }
  const record = value as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual(['reply', 'sessionId']);
  expect(record.sessionId).toEqual(
    expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    ),
  );
  expect(record.reply).toEqual(expect.stringMatching(/\S/));
  return record as unknown as HeadlessEnvelope;
}

function expectExactHermeticEngineLinks(repo: string): {
  xstateLink: string;
  playbookLink: string;
} {
  const nodeModules = join(repo, 'node_modules');
  const sublangScope = join(nodeModules, '@sublang');
  const xstateLink = join(nodeModules, 'xstate');
  const playbookLink = join(sublangScope, 'playbook');

  expect(readdirSync(nodeModules).sort()).toEqual(['@sublang', 'xstate']);
  expect(lstatSync(sublangScope).isDirectory()).toBe(true);
  expect(readdirSync(sublangScope).sort()).toEqual(['playbook']);
  expect(lstatSync(xstateLink).isSymbolicLink()).toBe(true);
  expect(lstatSync(playbookLink).isSymbolicLink()).toBe(true);
  return { xstateLink, playbookLink };
}

function expectMarkersExactlyOnceInOrder(
  output: string,
  markers: readonly string[],
): void {
  let priorIndex = -1;
  for (const marker of markers) {
    const index = output.indexOf(marker);
    if (index === -1) {
      throw new Error(
        `headless stderr is missing lifecycle marker ${JSON.stringify(marker)}`,
      );
    }
    if (index <= priorIndex) {
      throw new Error(
        `headless lifecycle marker ${JSON.stringify(marker)} is out of order`,
      );
    }
    if (output.indexOf(marker, index + marker.length) !== -1) {
      throw new Error(
        `headless lifecycle marker ${JSON.stringify(marker)} appeared more than once`,
      );
    }
    priorIndex = index;
  }
}

function assertLocalPrerequisites(): void {
  for (const [command, args] of [
    ['git', ['--version']],
    ['glow', ['--version']],
    ['npm', ['--version']],
    ['tmux', ['-V']],
    ['expect', ['-v']],
  ] as const) {
    try {
      execText(command, args);
    } catch (error) {
      throw new Error(
        `live acceptance requires ${command} on PATH: ${errorMessage(error)}`,
      );
    }
  }

  const home = process.env.HOME ?? homedir();
  const missingAuth = [
    !process.env.ANTHROPIC_API_KEY && !existsSync(join(home, '.claude'))
      ? 'Claude (run Claude Code once or set ANTHROPIC_API_KEY)'
      : undefined,
    !process.env.OPENAI_API_KEY && !existsSync(join(home, '.codex'))
      ? 'Codex (run Codex once or set OPENAI_API_KEY)'
      : undefined,
  ].filter((value): value is string => value !== undefined);
  if (missingAuth.length > 0) {
    throw new Error(
      `live acceptance requires local authentication for: ${missingAuth.join(
        ', ',
      )}`,
    );
  }
}

async function packAndInstallCandidate(root: string): Promise<string> {
  const installRoot = join(root, 'candidate');
  mkdirSync(installRoot, { recursive: true });
  console.info('[acceptance] packing and installing the release candidate');

  const packOutput = await execTextAsync(
    'npm',
    ['pack', '--json', '--pack-destination', installRoot],
    repoRoot,
  );
  const packResult = JSON.parse(packOutput) as Array<{ filename?: string }>;
  const filename = packResult[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack did not report a tarball: ${packOutput}`);
  }
  const tarball = join(installRoot, filename);
  candidateTarball = tarball;

  writeFileSync(
    join(installRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'playbook-live-acceptance-consumer',
        version: '0.0.0',
        private: true,
      },
      null,
      2,
    )}\n`,
  );
  await execTextAsync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--prefer-offline',
      tarball,
      ...adapterSdkSpecs(),
    ],
    installRoot,
  );

  const installedBin = join(
    installRoot,
    'node_modules/.bin/playbook',
  );
  if (!existsSync(installedBin)) {
    throw new Error(`installed playbook command is missing: ${installedBin}`);
  }
  assertAdapterSdksVisible(
    installRoot,
    installedCligentDir(installRoot),
    'candidate consumer',
  );
  return installedBin;
}

// npm hoists cligent flat in a project install and nests it under
// `@sublang/playbook` in a global one. Either is fine — what the SDK check
// below needs is where cligent actually landed, not where it usually does.
function installedCligentDir(installRoot: string): string {
  const found = [
    join(installRoot, 'node_modules/@sublang/cligent'),
    join(
      installRoot,
      'node_modules/@sublang/playbook/node_modules/@sublang/cligent',
    ),
  ].find((path) => existsSync(path));
  if (!found) {
    throw new Error(`@sublang/cligent did not install under ${installRoot}`);
  }
  return found;
}

// DR-026 §3: a supplied SDK is only usable if it sits on the directory
// ancestor walk from cligent's installed location — the same walk the
// adapter's own dynamic import performs. Assert that here, at install time
// and in milliseconds, rather than discovering it from a preflight refusal
// once a scenario has already claimed a live turn's budget.
//
// `require.resolve` cannot stand in for this: DR-026 §4 records that neither
// SDK exposes `./package.json` and that `@openai/codex-sdk` is ESM-only, so
// resolution reports both missing when they are present.
function assertAdapterSdksVisible(
  installRoot: string,
  cligentDir: string,
  shape: string,
): void {
  const missing = adapterSdks.filter(
    (sdk) => !sdkVisibleFrom(installRoot, cligentDir, sdk),
  );
  if (missing.length > 0) {
    throw new Error(
      `the ${shape} install left ${missing.join(' and ')} off the module ` +
        `walk from ${cligentDir}; the live scenarios would be refused at ` +
        'the DR-026 §4 adapter preflight before spending a model call',
    );
  }
}

function sdkVisibleFrom(
  installRoot: string,
  cligentDir: string,
  sdk: string,
): boolean {
  const segments = sdk.split('/');
  for (let dir = cligentDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', ...segments))) return true;
    // Bounded at the install root deliberately. Node's own walk keeps
    // climbing, but an SDK found above the gate's temp tree would be the
    // maintainer's machine answering rather than the install under test.
    if (dir === installRoot || dirname(dir) === dir) return false;
  }
}

// RELEASE-25 fourth case: install the same packed candidate globally into
// an isolated npm prefix. Inherited prefix configuration is neutralized so
// a version manager's npm_config_prefix cannot leak the maintainer's real
// global root into the gate, and the nested-cligent guard below fails
// loudly if a machine-global standalone @sublang/cligent shadows the copy
// nested under the prefix's @sublang/playbook.
async function installGlobalCandidate(): Promise<string> {
  const prefix = join(suiteRoot, 'global');
  mkdirSync(prefix, { recursive: true });
  console.info('[acceptance] installing the candidate into a global prefix');
  const env = { ...process.env };
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  await execTextAsync(
    'npm',
    [
      'install',
      '-g',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      candidateTarball,
      // DR-026 §3: each SDK its own top-level install root, so it lands on
      // the ancestor walk from the cligent nested under @sublang/playbook.
      ...adapterSdkSpecs(),
    ],
    suiteRoot,
    env,
  );
  const installedPlaybook = join(
    prefix,
    'lib/node_modules/@sublang/playbook',
  );
  const nestedCligent = join(
    installedPlaybook,
    'node_modules/@sublang/cligent',
  );
  if (!existsSync(nestedCligent)) {
    throw new Error(
      `@sublang/cligent did not install nested under ${installedPlaybook}`,
    );
  }
  const globalBin = join(prefix, 'bin/playbook');
  if (!existsSync(globalBin)) {
    throw new Error(`global playbook command is missing: ${globalBin}`);
  }
  assertAdapterSdksVisible(prefix, nestedCligent, 'global prefix');
  return globalBin;
}

function createScenario(
  name: 'review' | 'code' | 'dev' | 'decide' | 'hermetic' | 'conversation',
  options: { readonly reviewerInstruction?: string } = {},
): Scenario {
  // Every fixture path derives from `suiteRoot`. A relative value here would
  // silently build the fixture tree inside the real repository instead.
  if (!isAbsolute(suiteRoot)) {
    throw new Error(
      `live acceptance suite root must be an absolute path, got "${suiteRoot}"`,
    );
  }
  // PBCLI-36: headless REVIEW nests under the candidate consumer tree, while
  // the hermetic fixture stays outside every node_modules ancestry on
  // purpose.
  // The conversational fixtures nest under the same consumer tree for the
  // same reason: their registry modules import `xstate` and
  // `@sublang/playbook/xstate-runtime` by bare specifier, and the installed
  // candidate is what must satisfy those imports.
  const root =
    name === 'review' || name === 'conversation'
      ? join(suiteRoot, 'candidate', 'fixtures', name)
      : join(suiteRoot, name);
  const repo = join(root, 'repo');
  const spexHome = join(root, 'spex');
  const stateHome = join(root, 'xdg-state');
  mkdirSync(join(repo, 'specs/packages'), { recursive: true });
  mkdirSync(join(spexHome, 'playbook'), { recursive: true });

  writeFileSync(
    join(repo, 'AGENTS.md'),
    [
      '# Repository instructions',
      '',
      'Before changing specifications, read specs/map.md and specs/meta.md.',
      'Keep changes scoped to the Boss request.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repo, 'README.md'),
    '# Live acceptance fixture\n\nA fresh repository for playbook release verification.\n',
  );
  writeFileSync(
    join(repo, 'specs/meta.md'),
    [
      '# Specification format',
      '',
      'Specification item files live under `specs/packages/`.',
      'Each requirement is headed by `### <PACKAGE>-<number>` and uses',
      'normative “shall” language. Keep items minimal and',
      'implementation-neutral.',
      '`specs/map.md` indexes every specification item file.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repo, 'specs/map.md'),
    [
      '# Spec map',
      '',
      '| Package | File | Summary |',
      '| --- | --- | --- |',
      '| ACCEPT | [acceptance.md](packages/acceptance.md) | Live acceptance fixture requirements |',
      '| GIT | [git.md](packages/git.md) | Commit conventions |',
      '',
    ].join('\n'),
  );
  // Each implementing case has its own ACCEPT-1 file and token, so a commit
  // from one case can never satisfy another's assertions.
  const [requiredFile, requiredToken] =
    name === 'review'
      ? ['acceptance-review.txt', reviewToken]
      : name === 'dev'
        ? ['acceptance-dev.txt', devToken]
        : ['acceptance-code.txt', 'CODE_ACCEPTANCE_OK'];
  writeFileSync(
    join(repo, 'specs/packages/acceptance.md'),
    [
      '# ACCEPT: Live acceptance fixture',
      '',
      '### ACCEPT-1',
      '',
      `The repository root shall contain \`${requiredFile}\` whose entire`,
      `content is \`${requiredToken}\` followed by one newline.`,
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repo, 'specs/packages/git.md'),
    [
      '# GIT: Commit conventions',
      '',
      '### GIT-1',
      '',
      'Each commit shall have a concise imperative subject.',
      '',
      '### GIT-2',
      '',
      'An agent-authored commit shall append a `Co-authored-by` trailer using',
      'the agent model as the name and `cligent@sublang.xyz` as the email.',
      '',
    ].join('\n'),
  );
  if (name === 'conversation') {
    // Only the two deterministic fixtures are enabled here. The scenario's
    // subject is the Captain's own decisions, and a real CODE or DECIDE
    // target would spend a full multi-player workflow on the switch turn —
    // which also runs to terminal, leaving nothing for the dismissal turn
    // to dismiss. A command-mapped workflow switch stays a hermetic
    // A29-7 row; what is live here is the model-decided one.
    writeFileSync(
      join(spexHome, 'playbook/playbook.config.yaml'),
      conversationConfig(repo),
    );
    writeFileSync(
      join(repo, 'checklist.registry.mjs'),
      checklistFixtureSource(join(root, 'checklist.flag')),
    );
    writeFileSync(join(repo, 'notes.registry.mjs'), notesFixtureSource());
  } else if (name === 'hermetic') {
    writeFileSync(
      join(spexHome, 'playbook/playbook.config.yaml'),
      hermeticConfig(repo),
    );
  } else {
    writeFileSync(
      join(spexHome, 'playbook/playbook.config.yaml'),
      liveConfig(options),
    );
  }
  if (name === 'hermetic') {
    // The documented practice for artifact repositories: ignore the
    // provisioned engine links so player commits never carry them.
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(
      join(repo, 'acceptance-hermetic-token.txt'),
      `${hermeticToken}\n`,
    );
    writeFileSync(
      join(repo, 'hermetic.playbook.mjs'),
      hermeticArtifactSource(),
    );
  }

  execText('git', ['init', '-b', 'main'], repo);
  execText('git', ['config', 'user.name', 'Playbook Acceptance'], repo);
  execText(
    'git',
    ['config', 'user.email', 'acceptance@sublang.invalid'],
    repo,
  );
  execText('git', ['config', 'commit.gpgsign', 'false'], repo);
  execText('git', ['add', '.'], repo);
  execText('git', ['commit', '-m', 'Initialize acceptance fixture'], repo);
  const baselineCommit = headRevision(repo);
  return { root, repo, spexHome, stateHome, baselineCommit };
}

// Installed headless children receive this PATH shim, while the gate's own
// tmux probes keep the parent PATH. Any child tmux use is therefore a hard
// failure, including probes that happen before session creation.
function createNoTmuxGuard(root: string): {
  binDir: string;
  marker: string;
} {
  const binDir = join(root, 'no-tmux-bin');
  const marker = join(root, 'tmux-was-called');
  const shim = join(binDir, 'tmux');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" > "$PLAYBOOK_ACCEPTANCE_TMUX_CALLED"',
      'exit 97',
      '',
    ].join('\n'),
  );
  chmodSync(shim, 0o755);
  return { binDir, marker };
}

async function drivePlaybookTurn(
  scenario: Scenario,
  command: string,
  expectation: TurnExpectation,
): Promise<TurnObservation> {
  const sessionsBefore = new Set(listTmuxSessions());
  const launcher = spawnLauncher(scenario);
  let sessionName: string | undefined;
  let target: string | undefined;
  let gracefulStopAttempted = false;
  try {
    sessionName = await waitForNewSession(sessionsBefore, launcher);
    const sessionId = await waitForOperationalSessionId(
      launcher,
      startupTimeoutMs,
    );
    expect(sessionName).toBe(`tmux-play-${sessionId}`);
    target = `${sessionName}:0.0`;
    await waitForAttachedClient(sessionName, startupTimeoutMs, launcher);
    await waitForPaneText(target, 'boss>', startupTimeoutMs, launcher);
    const repliesBefore = captainProseBlocks(
      capturePane(target, sessionHistoryLines),
    ).length;
    console.info(`[acceptance] ${scenario.root.split('/').at(-1)}: ${command}`);
    // Bound the whole real-agent workflow, not each nested milestone. A
    // stalled call must not multiply the model-call budget by three merely
    // because the gate observes call, return, and finish separately.
    const liveDeadline = Date.now() + liveTimeoutMs;
    tmuxText(['send-keys', '-t', target, '-l', command]);
    tmuxText(['send-keys', '-t', target, 'Enter']);
    await waitForPaneText(
      target,
      expectation.started,
      startupTimeoutMs,
      launcher,
      turnFailureMarkers,
    );
    await waitForPaneShape(
      sessionName,
      expectation.rootPaneTitles,
      startupTimeoutMs,
      launcher,
    );
    await waitForPaneText(
      target,
      expectation.nestedCalled,
      remainingTime(liveDeadline),
      launcher,
      turnFailureMarkers,
    );
    await waitForPaneShape(
      sessionName,
      expectation.nestedPaneTitles,
      startupTimeoutMs,
      launcher,
    );
    await waitForPlayerPaneText(
      sessionName,
      expectation.nestedActivity.paneTitle,
      expectation.nestedActivity.text,
      remainingTime(liveDeadline),
      launcher,
    );
    await waitForPaneText(
      target,
      expectation.nestedReturned,
      remainingTime(liveDeadline),
      launcher,
      turnFailureMarkers,
    );
    await waitForPaneText(
      target,
      expectation.finished,
      remainingTime(liveDeadline),
      launcher,
      turnFailureMarkers,
    );
    await waitForCaptainProse(
      target,
      repliesBefore + 1,
      remainingTime(liveDeadline),
      launcher,
      turnFailureMarkers,
    );
    expectMarkersExactlyOnceInOrder(
      capturePane(target, sessionHistoryLines),
      [
        expectation.started,
        expectation.nestedCalled,
        expectation.nestedReturned,
        expectation.finished,
      ],
    );
    console.info(
      `[acceptance] ${scenario.root.split('/').at(-1)}: ${expectation.finished}`,
    );
    gracefulStopAttempted = true;
    await stopManagedInteractiveSession(sessionName, target, launcher);
    return { sessionId };
  } catch (error) {
    writeFailureSnapshot(
      scenario.root,
      sessionName,
      launcher,
      error,
      scenario,
    );
    throw error;
  } finally {
    if (sessionName && listTmuxSessions().includes(sessionName)) {
      if (!gracefulStopAttempted && target !== undefined) {
        try {
          gracefulStopAttempted = true;
          await stopManagedInteractiveSession(sessionName, target, launcher);
        } catch {
          // Preserve the primary assertion failure and fall through to the
          // bounded forced-cleanup path below.
        }
      }
      try {
        if (listTmuxSessions().includes(sessionName)) {
          tmuxText(['kill-session', '-t', sessionName]);
        }
      } catch {
        // Preserve the original test failure; launcher termination below is
        // the remaining best-effort cleanup.
      }
    }
    await stopLauncher(launcher);
  }
}

function spawnLauncher(scenario: Scenario, sessionId?: string): Launcher {
  // Keep the launched session on the gate's private tmux server, so it is
  // the only session this run can see, drive, or kill.
  const env = privateTmuxEnv({
    SPEX_HOME: scenario.spexHome,
    XDG_CONFIG_HOME: join(scenario.root, 'xdg-config'),
    XDG_STATE_HOME: scenario.stateHome,
    PLAYBOOK_ACCEPTANCE_BIN: candidateBin,
    PLAYBOOK_ACCEPTANCE_REPO: scenario.repo,
    ...(sessionId === undefined
      ? {}
      : { PLAYBOOK_ACCEPTANCE_SESSION: sessionId }),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  });

  const expectScript = [
    'set stty_init "rows 49 columns 174"',
    'set timeout -1',
    'log_user 1',
    sessionId === undefined
      ? 'spawn -noecho $env(PLAYBOOK_ACCEPTANCE_BIN) --cwd $env(PLAYBOOK_ACCEPTANCE_REPO)'
      : 'spawn -noecho $env(PLAYBOOK_ACCEPTANCE_BIN) --session $env(PLAYBOOK_ACCEPTANCE_SESSION)',
    'expect eof',
  ].join('\n');
  const child = spawn('expect', ['-c', expectScript], {
    cwd: sessionId === undefined ? scenario.repo : scenario.root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const operationalSessionIds: string[] = [];
  const stdoutLineCollector = createOperationalSessionIdCollector(
    operationalSessionIds,
  );
  const stderrLineCollector = createOperationalSessionIdCollector(
    operationalSessionIds,
  );
  let exit:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined;
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stdoutLineCollector(text);
    stdout = appendTail(stdout, text);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderrLineCollector(text);
    stderr = appendTail(stderr, text);
  });
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });
  return {
    child,
    output: () =>
      `stdout:\n${diagnosticTail(stdout)}\n` +
      `stderr:\n${diagnosticTail(stderr)}`,
    operationalSessionIds: () => [...operationalSessionIds],
    exit: () => exit,
  };
}

async function waitForOperationalSessionId(
  launcher: Launcher,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ids = launcher.operationalSessionIds();
    if (ids.length === 1) return ids[0]!;
    if (ids.length > 1) {
      throw new Error(
        `launcher printed multiple operational session ids\n${launcher.output()}`,
      );
    }
    const exit = launcher.exit();
    if (exit) {
      throw new Error(
        `launcher exited before printing its operational session id ` +
          `(code=${String(exit.code)}, signal=${String(exit.signal)})\n` +
          launcher.output(),
      );
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `timed out waiting for the operational session id\n${launcher.output()}`,
  );
}

function expectOneOperationalSessionId(
  launcher: Launcher,
  expectedId: string,
): void {
  expect(launcher.operationalSessionIds()).toEqual([expectedId]);
}

function createOperationalSessionIdCollector(
  ids: string[],
): (chunk: string) => void {
  let pending = '';
  const line = new RegExp(
    '^playbook: session ' +
      '([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-' +
      '[89ab][0-9a-f]{3}-[0-9a-f]{12})$',
    'i',
  );
  return (chunk) => {
    const complete = (pending + chunk).split('\n');
    pending = complete.pop() ?? '';
    for (const raw of complete) {
      const match = line.exec(
        stripVTControlCharacters(raw).replaceAll('\r', ''),
      );
      if (match) ids.push(match[1]!);
    }
  };
}

async function waitForNewSession(
  previous: Set<string>,
  launcher: Launcher,
): Promise<string> {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const added = listTmuxSessions().filter(
      (name) => name.startsWith('tmux-play-') && !previous.has(name),
    );
    if (added.length === 1) return added[0];
    if (added.length > 1) {
      throw new Error(
        `launcher created multiple tmux sessions: ${added.join(', ')}`,
      );
    }
    const exit = launcher.exit();
    if (exit) {
      throw new Error(
        `playbook launcher exited before creating a tmux session ` +
          `(code=${String(exit.code)}, signal=${String(exit.signal)})\n` +
          launcher.output(),
      );
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `timed out waiting for a new tmux-play session\n${launcher.output()}`,
  );
}

async function waitForAttachedClient(
  sessionName: string,
  timeoutMs: number,
  launcher: Launcher,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const clients = tmuxText([
        'list-clients',
        '-t',
        sessionName,
        '-F',
        '#{client_name}',
      ]);
      if (clients !== '') return;
    } catch {
      // tmux exits nonzero while the newly created session has no client.
    }
    const exit = launcher.exit();
    if (exit) {
      throw new Error(
        `playbook launcher exited before attaching a tmux client ` +
          `(code=${String(exit.code)}, signal=${String(exit.signal)})\n` +
          launcher.output(),
      );
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `timed out waiting for an attached tmux client\n${launcher.output()}`,
  );
}

async function waitForPaneText(
  target: string,
  expected: string,
  timeoutMs: number,
  launcher: Launcher,
  failureMarkers: readonly string[] = [],
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastPane = '';
  let nextProgressAt = startedAt + 60_000;
  while (Date.now() < deadline) {
    try {
      lastPane = capturePane(target);
    } catch (error) {
      throw new Error(
        `tmux session ended while waiting for ${JSON.stringify(expected)}: ` +
          `${errorMessage(error)}\n${launcher.output()}\nLast Boss pane:\n` +
          diagnosticTail(lastPane),
      );
    }
    if (paneContains(lastPane, expected)) return;
    for (const marker of failureMarkers) {
      if (paneContains(lastPane, marker)) {
        throw new Error(
          `playbook turn failed while waiting for ${JSON.stringify(expected)}; ` +
            `Boss pane contains ${JSON.stringify(marker)}\n` +
            `${launcher.output()}\nLast Boss pane:\n${diagnosticTail(lastPane)}`,
        );
      }
    }
    const exit = launcher.exit();
    if (exit) {
      throw new Error(
        `playbook launcher exited while waiting for ${JSON.stringify(expected)} ` +
          `(code=${String(exit.code)}, signal=${String(exit.signal)})\n` +
          `${launcher.output()}\nLast Boss pane:\n${diagnosticTail(lastPane)}`,
      );
    }
    if (Date.now() >= nextProgressAt) {
      console.info(
        `[acceptance] waiting for ${expected} ` +
          `(${Math.floor((Date.now() - startedAt) / 1_000)}s)`,
      );
      nextProgressAt += 60_000;
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `timed out waiting for ${JSON.stringify(expected)}\n` +
      `${launcher.output()}\nLast Boss pane:\n${diagnosticTail(lastPane)}`,
  );
}

function sendBossTurn(target: string, text: string): void {
  console.info(`[acceptance] boss> ${text}`);
  tmuxText(['send-keys', '-t', target, '-l', text]);
  tmuxText(['send-keys', '-t', target, 'Enter']);
}

// Whitespace-insensitive occurrence count. One shell session replays the
// same lifecycle markers turn after turn, so the four existing scenarios'
// "does the pane contain it yet" waits cannot tell a fresh marker from the
// one still sitting in the scrollback — the conversational case waits on
// counts instead.
function countOccurrences(pane: string, needle: string): number {
  const haystack = pane.replace(/\s+/g, ' ');
  const target = needle.replace(/\s+/g, ' ');
  if (target === '') return 0;
  let count = 0;
  for (
    let index = haystack.indexOf(target);
    index !== -1;
    index = haystack.indexOf(target, index + target.length)
  ) {
    count += 1;
  }
  return count;
}

function lifecycleMarkerCounts(pane: string): Record<string, number> {
  return Object.fromEntries(
    ['◇ ', '◆ failed'].map((marker) => [
      marker,
      countOccurrences(pane, marker),
    ]),
  );
}

// The Boss pane's Captain prose blocks: TMUX-038's grammar puts the
// `captain> ` prefix on the first rendered line of a block, and an
// operational line is bracketed (`captain> [status] …`), so prose is the
// unbracketed form. Counting blocks is what tells one turn's reply from
// the next in a session that keeps its scrollback.
function captainProseBlocks(pane: string): string[] {
  const blocks: string[] = [];
  let current: string[] | undefined;
  for (const line of pane.split('\n')) {
    const speaker = /^(captain|boss)>\s?(.*)$/.exec(line);
    if (speaker) {
      if (current) blocks.push(current.join('\n').trim());
      current =
        speaker[1] === 'captain' && !speaker[2].startsWith('[')
          ? [speaker[2]]
          : undefined;
      continue;
    }
    if (current) current.push(line);
  }
  if (current) blocks.push(current.join('\n').trim());
  return blocks.filter((block) => block !== '');
}

async function waitForCaptainProse(
  target: string,
  minimumBlocks: number,
  timeoutMs: number,
  launcher: Launcher,
  failureMarkers: readonly string[] = [],
): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastPane = '';
  let nextProgressAt = startedAt + 60_000;
  while (Date.now() < deadline) {
    lastPane = capturePaneOrFail(target, launcher, `${minimumBlocks} replies`);
    const blocks = captainProseBlocks(lastPane);
    if (blocks.length >= minimumBlocks) return blocks[blocks.length - 1];
    assertNoFailureMarker(
      lastPane,
      failureMarkers,
      `Captain reply ${minimumBlocks}`,
      launcher,
    );
    assertLauncherAlive(launcher, `Captain reply ${minimumBlocks}`, lastPane);
    if (Date.now() >= nextProgressAt) {
      console.info(
        `[acceptance] waiting for Captain reply ${minimumBlocks} ` +
          `(${Math.floor((Date.now() - startedAt) / 1_000)}s)`,
      );
      nextProgressAt += 60_000;
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `timed out waiting for Captain reply ${minimumBlocks}\n` +
      `${launcher.output()}\nLast Boss pane:\n${diagnosticTail(lastPane)}`,
  );
}

async function waitForPaneOccurrences(
  target: string,
  expected: string,
  minimumCount: number,
  timeoutMs: number,
  launcher: Launcher,
  failureMarkers: readonly string[] = [],
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const what = `${JSON.stringify(expected)} ×${minimumCount}`;
  let lastPane = '';
  let nextProgressAt = startedAt + 60_000;
  while (Date.now() < deadline) {
    lastPane = capturePaneOrFail(target, launcher, what);
    if (countOccurrences(lastPane, expected) >= minimumCount) return;
    assertNoFailureMarker(lastPane, failureMarkers, what, launcher);
    assertLauncherAlive(launcher, what, lastPane);
    if (Date.now() >= nextProgressAt) {
      console.info(
        `[acceptance] waiting for ${what} ` +
          `(${Math.floor((Date.now() - startedAt) / 1_000)}s)`,
      );
      nextProgressAt += 60_000;
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `timed out waiting for ${what}\n` +
      `${launcher.output()}\nLast Boss pane:\n${diagnosticTail(lastPane)}`,
  );
}

// The count-based waiters below serve the conversational case alone, and a
// count there is cumulative over the session: an occurrence that scrolled
// out of a per-wait window would make a count fall, so a wait for the
// second one could never be satisfied. They read the session-wide window.
function capturePaneOrFail(
  target: string,
  launcher: Launcher,
  what: string,
): string {
  try {
    return capturePane(target, sessionHistoryLines);
  } catch (error) {
    throw new Error(
      `tmux session ended while waiting for ${what}: ` +
        `${errorMessage(error)}\n${launcher.output()}`,
    );
  }
}

function assertNoFailureMarker(
  pane: string,
  failureMarkers: readonly string[],
  what: string,
  launcher: Launcher,
): void {
  for (const marker of failureMarkers) {
    if (paneContains(pane, marker)) {
      throw new Error(
        `playbook turn failed while waiting for ${what}; Boss pane contains ` +
          `${JSON.stringify(marker)}\n${launcher.output()}\n` +
          `Last Boss pane:\n${diagnosticTail(pane)}`,
      );
    }
  }
}

function assertLauncherAlive(
  launcher: Launcher,
  what: string,
  pane: string,
): void {
  const exit = launcher.exit();
  if (exit) {
    throw new Error(
      `playbook launcher exited while waiting for ${what} ` +
        `(code=${String(exit.code)}, signal=${String(exit.signal)})\n` +
        `${launcher.output()}\nLast Boss pane:\n${diagnosticTail(pane)}`,
    );
  }
}

async function waitForPlayerPaneText(
  sessionName: string,
  paneTitle: string,
  expected: string,
  timeoutMs: number,
  launcher: Launcher,
): Promise<void> {
  await waitForPlayerPaneValue(
    sessionName,
    paneTitle,
    JSON.stringify(expected),
    timeoutMs,
    launcher,
    (pane) => (paneContains(pane, expected) ? true : undefined),
  );
}

async function waitForPlayerPaneValue<T>(
  sessionName: string,
  paneTitle: string,
  expected: string,
  timeoutMs: number,
  launcher: Launcher,
  valueFromPane: (pane: string) => T | undefined,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastPane = '';
  let lastShape = '';
  while (Date.now() < deadline) {
    try {
      lastShape = tmuxText([
        'list-panes',
        '-t',
        `${sessionName}:0`,
        '-F',
        '#{pane_id}|#{pane_title}',
      ]);
      const matches = lastShape
        .split('\n')
        .map((line) => line.split('|'))
        .filter(([, title]) => title === paneTitle);
      if (matches.length > 1) {
        throw new Error(`multiple panes have title ${JSON.stringify(paneTitle)}`);
      }
      const paneId = matches[0]?.[0];
      if (paneId !== undefined) {
        lastPane = capturePane(paneId);
        const value = valueFromPane(lastPane);
        if (value !== undefined) return value;
      }
    } catch {
      // Visibility reconciliation briefly destroys and rebuilds player panes.
    }
    let bossPane = '';
    try {
      bossPane = capturePane(`${sessionName}:0.0`);
    } catch (error) {
      throw new Error(
        `tmux session ended while waiting for ${expected} in ${paneTitle}: ` +
          `${errorMessage(error)}\n${launcher.output()}`,
      );
    }
    assertNoFailureMarker(
      bossPane,
      turnFailureMarkers,
      `${expected} in ${paneTitle}`,
      launcher,
    );
    assertLauncherAlive(
      launcher,
      `${expected} in ${paneTitle}`,
      bossPane,
    );
    await delay(pollIntervalMs);
  }
  throw new Error(
    `timed out waiting for ${expected} in ${paneTitle}\n` +
      `${launcher.output()}\nLast pane shape:\n${lastShape}\n` +
      `Last ${paneTitle} pane:\n${diagnosticTail(lastPane)}`,
  );
}

async function waitForPaneShape(
  sessionName: string,
  expectedTitles: readonly string[],
  timeoutMs: number,
  launcher: Launcher,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastShape = '';
  while (Date.now() < deadline) {
    try {
      lastShape = tmuxText([
        'list-panes',
        '-t',
        `${sessionName}:0`,
        '-F',
        '#{pane_index}|#{pane_title}|#{pane_active}',
      ]);
      const panes = lastShape.split('\n').filter(Boolean);
      const titles = panes.map((pane) => pane.split('|')[1]).sort();
      const boss = panes.find((pane) => pane.startsWith('0|'));
      if (
        panes.length === expectedTitles.length &&
        titles.join('\n') === [...expectedTitles].sort().join('\n') &&
        boss?.endsWith('|1') === true
      ) {
        return;
      }
    } catch {
      // Visibility changes rebuild the player panes; retry until stable.
    }
    const exit = launcher.exit();
    if (exit) {
      throw new Error(
        `playbook launcher exited while waiting for the selected pane layout ` +
          `(code=${String(exit.code)}, signal=${String(exit.signal)})\n` +
          `${launcher.output()}\nLast pane shape:\n${lastShape}`,
      );
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `timed out waiting for pane titles ${expectedTitles.join(', ')} ` +
      `with the Boss pane focused\n${launcher.output()}\n` +
      `Last pane shape:\n${lastShape}`,
  );
}

async function stopLauncher(launcher: Launcher): Promise<void> {
  if (launcher.child.exitCode !== null || launcher.child.signalCode !== null) {
    return;
  }
  const gracefulExit = new Promise<boolean>((resolveExit) => {
    launcher.child.once('exit', () => resolveExit(true));
  });
  launcher.child.kill('SIGTERM');
  const exited = await Promise.race([
    gracefulExit,
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    const forcedExit = new Promise<void>((resolveExit) => {
      launcher.child.once('exit', () => resolveExit());
    });
    launcher.child.kill('SIGKILL');
    await Promise.race([
      forcedExit,
      delay(5_000).then(() => {
        throw new Error('playbook launcher did not exit after SIGKILL');
      }),
    ]);
  }
}

async function stopManagedInteractiveSession(
  sessionName: string,
  target: string,
  launcher: Launcher,
): Promise<void> {
  tmuxText(['send-keys', '-t', target, 'C-c']);
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (!listTmuxSessions().includes(sessionName) && launcher.exit()) return;
    await delay(pollIntervalMs);
  }
  throw new Error(
    `managed interactive session did not retire after Boss-pane Ctrl-C\n` +
      launcher.output(),
  );
}

async function expectLeaseRetired(
  scenario: Scenario,
  sessionId: string,
  expectedTombstones: number,
): Promise<void> {
  const sessionsDir = join(scenario.stateHome, 'playbook', 'sessions');
  const lease = join(sessionsDir, `.${sessionId}.lock`);
  const retiredPrefix = `.${sessionId}.lock.retired.`;
  const retired = (): string[] =>
    readdirSync(sessionsDir)
      .filter((name) => name.startsWith(retiredPrefix))
      .sort();
  const deadline = Date.now() + 5_000;
  while (
    (existsSync(lease) || retired().length !== expectedTombstones) &&
    Date.now() < deadline
  ) {
    await delay(pollIntervalMs);
  }
  expect(existsSync(lease)).toBe(false);
  expect(retired()).toHaveLength(expectedTombstones);
}

function listTmuxSessions(): string[] {
  try {
    return tmuxText(['list-sessions', '-F', '#{session_name}'])
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    const message = errorMessage(error);
    if (
      message.includes('no server running') ||
      message.includes('failed to connect to server') ||
      (message.includes('error connecting to') &&
        message.includes('No such file or directory'))
    ) {
      return [];
    }
    throw error;
  }
}

function headRevision(repo: string): string {
  return execText('git', ['rev-parse', 'HEAD'], repo);
}

function isAncestor(repo: string, ancestor: string): boolean {
  try {
    execText('git', ['merge-base', '--is-ancestor', ancestor, 'HEAD'], repo);
    return true;
  } catch {
    return false;
  }
}

function gitStatus(repo: string): string {
  return execText(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    repo,
  );
}

function ignoredUntracked(repo: string): string {
  return execText(
    'git',
    ['ls-files', '--others', '--ignored', '--exclude-standard'],
    repo,
  );
}

function changedPaths(scenario: Scenario): string[] {
  const output = execText(
    'git',
    ['diff', '--name-only', `${scenario.baselineCommit}..HEAD`],
    scenario.repo,
  );
  return output === '' ? [] : output.split('\n').sort();
}

function headFile(repo: string, path: string): string {
  return execRaw('git', ['show', `HEAD:${path}`], repo);
}

function headHasPath(repo: string, path: string): boolean {
  try {
    execText('git', ['cat-file', '-e', `HEAD:${path}`], repo);
    return true;
  } catch {
    return false;
  }
}

// Point a process at the gate's private tmux server under `tmuxSocketDir`.
// Clearing `TMUX` and `TMUX_PANE` is load-bearing, not hygiene: when the
// gate itself is run from inside tmux, an inherited `TMUX` names the
// caller's socket and takes precedence over `TMUX_TMPDIR`, so commands
// would reach the maintainer's server and could drive or kill their
// session. Every tmux invocation and the launcher share this one recipe so
// the two cannot drift apart.
function privateTmuxEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Between the inherited environment and the caller's overrides: it must
    // beat a non-UTF-8 inherited locale, but never an explicit override.
    ...utf8Locale(),
    ...overrides,
    TMUX_TMPDIR: tmuxSocketDir,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

// tmux decides at startup whether it may keep non-ASCII, and under a
// non-UTF-8 locale it rewrites every multi-byte character of a pane title to
// `_` — its own `utf8_sanitize`. This gate asserts `Captain · claude` on the
// pane titles and the `◇`/`◆`/`⤷` glyphs in pane content, so a shell with
// `LC_ALL=C` (or with no locale set at all, as a non-interactive one often
// has) turns a healthy candidate into a pane-title mismatch that reads
// exactly like a cligent presentation regression. Measured on tmux 3.6a:
// `select-pane -T 'Captain · claude'` reads back as `Captain _ claude` under
// LANG=C and intact under LANG=en_US.UTF-8.
//
// The gate already pins TERM and COLORTERM so the terminal cannot drift
// between hosts; the character encoding belongs with them. An inherited
// UTF-8 locale is kept untouched — the maintainer's own terminal is the
// environment this gate exists to reproduce.
function utf8Locale(): NodeJS.ProcessEnv {
  const inherited = [
    process.env.LC_ALL,
    process.env.LC_CTYPE,
    process.env.LANG,
  ].find((value) => value !== undefined && value !== '');
  if (inherited !== undefined && /utf-?8/i.test(inherited)) return {};
  // tmux's own first choice when it has to pick a UTF-8 locale itself.
  return { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
}

function tmuxText(args: readonly string[]): string {
  return execFileSync('tmux', [...args], {
    env: privateTmuxEnv(),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function execText(
  command: string,
  args: readonly string[],
  cwd?: string,
): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function execRaw(
  command: string,
  args: readonly string[],
  cwd?: string,
): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function execTextAsync(
  command: string,
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        ...(env ? { env } : {}),
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stderr });
          rejectCommand(error);
          return;
        }
        resolveCommand(stdout.trimEnd());
      },
    );
  });
}

function execLiveTextAsync(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin?: string,
  timeoutMs: number = liveTimeoutMs,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveCommand, rejectCommand) => {
    // A detached child is a new POSIX process group. That lets timeout
    // cleanup reach adapter subprocesses as well as the installed CLI.
    const child = spawn(command, [...args], {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let stopReason: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group may already be gone; fall back to the direct child for
        // spawn failures and platforms that reject negative process ids.
        child.kill(signal);
      }
    };
    const clearTimers = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    const failure = (reason: string): Error =>
      new Error(
        `installed playbook run failed: ${reason}\n` +
          `stdout:\n${diagnosticTail(stdout)}\n` +
          `stderr:\n${diagnosticTail(stderr)}`,
      );
    const rejectOnce = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      rejectCommand(failure(reason));
    };
    const stop = (reason: string): void => {
      if (settled || stopReason !== undefined) return;
      stopReason = reason;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        rejectOnce(reason);
      }, liveTerminationGraceMs);
    };
    const collect = (stream: 'stdout' | 'stderr', chunk: string): void => {
      outputBytes += Buffer.byteLength(chunk);
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (outputBytes > liveCommandMaxBufferBytes) {
        stop(`output exceeded ${liveCommandMaxBufferBytes} bytes`);
      }
    };
    const timeoutTimer = setTimeout(
      () => stop(`timed out after ${timeoutMs}ms`),
      timeoutMs,
    );

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: string) => collect('stderr', chunk));
    child.once('error', (error) => rejectOnce(error.message));
    child.once('close', (code, signal) => {
      // Once the CLI closes, nothing it started should outlive this smoke
      // case. This is a no-op when the process group drained normally.
      signalGroup('SIGKILL');
      if (stopReason !== undefined) {
        rejectOnce(stopReason);
        return;
      }
      if (code !== 0) {
        rejectOnce(
          `exited with code ${String(code)} and signal ${String(signal)}`,
        );
        return;
      }
      if (settled) return;
      settled = true;
      clearTimers();
      resolveCommand({ stdout, stderr });
    });
    child.stdin.setDefaultEncoding('utf8');
    child.stdin.once('error', (error: NodeJS.ErrnoException) => {
      // A fast CLI argument/config failure may close stdin before the parent
      // finishes writing. Its exit and stderr remain the authoritative
      // diagnostic; every other producer failure terminates the process
      // group so a partial Boss turn is never left running.
      if (error.code !== 'EPIPE' && !settled) {
        stop(`cannot write stdin: ${error.message}`);
      }
    });
    child.stdin.end(stdin ?? '');
  });
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

function withArtifactPath(error: unknown, path: string): Error {
  if (error instanceof Error) {
    error.message =
      `${error.message}\nAcceptance artifacts preserved at ${path}`;
    return error;
  }
  return new Error(
    `${String(error)}\nAcceptance artifacts preserved at ${path}`,
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as Error & { stderr?: Buffer | string }).stderr;
    const detail = stderr?.toString().trim();
    return detail ? `${error.message}\n${detail}` : error.message;
  }
  return String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function remainingTime(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function appendTail(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= launcherTailCharacters
    ? combined
    : combined.slice(combined.length - launcherTailCharacters);
}

function paneContains(pane: string, expected: string): boolean {
  return (
    pane.includes(expected) ||
    pane.replace(/\s+/g, ' ').includes(expected) ||
    pane.replace(/\s+/g, '').includes(expected.replace(/\s+/g, ''))
  );
}

function capturePane(
  target: string,
  historyLines: number = bossHistoryLines,
): string {
  return tmuxText([
    'capture-pane',
    '-p',
    '-S',
    `-${historyLines}`,
    '-t',
    target,
  ]);
}

function diagnosticTail(value: string): string {
  const stripped = stripVTControlCharacters(value).replace(/\r/g, '');
  return stripped.length <= diagnosticTailCharacters
    ? stripped
    : stripped.slice(stripped.length - diagnosticTailCharacters);
}

function writeFailureSnapshot(
  root: string,
  sessionName: string | undefined,
  launcher: Launcher | undefined,
  error: unknown,
  scenario?: Scenario,
): void {
  const snapshotPath = join(root, failureSnapshotName);
  if (existsSync(snapshotPath)) return;

  const sections = [
    `Error:\n${diagnosticTail(errorMessage(error))}`,
    launcher ? `Launcher:\n${launcher.output()}` : undefined,
  ];
  if (sessionName !== undefined) {
    try {
      sections.push(
        `Boss pane:\n${diagnosticTail(
          capturePane(`${sessionName}:0.0`),
        )}`,
      );
    } catch (captureError) {
      sections.push(
        `Boss pane capture failed:\n${diagnosticTail(
          errorMessage(captureError),
        )}`,
      );
    }
    try {
      sections.push(
        `Pane shape:\n${tmuxText([
          'list-panes',
          '-t',
          `${sessionName}:0`,
          '-F',
          '#{pane_index}|#{pane_title}|#{pane_active}',
        ])}`,
      );
    } catch (shapeError) {
      sections.push(
        `Pane shape capture failed:\n${diagnosticTail(
          errorMessage(shapeError),
        )}`,
      );
    }
  }
  if (scenario !== undefined) {
    try {
      sections.push(
        [
          'Repository:',
          execText('git', ['log', '--oneline', '-3'], scenario.repo),
          execText(
            'git',
            ['status', '--porcelain', '--untracked-files=all'],
            scenario.repo,
          ),
          execText(
            'git',
            [
              'diff',
              '--stat',
              `${scenario.baselineCommit}..HEAD`,
            ],
            scenario.repo,
          ),
        ].join('\n'),
      );
    } catch (repositoryError) {
      sections.push(
        `Repository capture failed:\n${diagnosticTail(
          errorMessage(repositoryError),
        )}`,
      );
    }
  }

  try {
    writeFileSync(
      snapshotPath,
      `${sections.filter((section) => section !== undefined).join('\n\n')}\n`,
    );
  } catch {
    // A diagnostic write must never replace the acceptance failure.
  }
}
