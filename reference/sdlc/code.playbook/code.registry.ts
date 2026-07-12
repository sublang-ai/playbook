// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import createPlaybookRuntime, {
  type CodePlaybookOptions,
  type PlaybookRuntime,
} from './code.playbook.js';

// PBRT-30: the CODE registry entry validates the option slice the shell
// passes it (`captain.options.playbooks.code.options`), not a namespace
// it extracts from the full Captain options bag. The schema defines one
// key, `committer`: an optional Committer-alias player id, one of the
// baked role ids `coder` / `reviewer`. A valid slice is absent, `{}`, or
// `{ committer: 'coder' | 'reviewer' }`; every other key is unknown and
// rejected with a path-named error. A further CODE option shall be
// introduced as its own higher-numbered item that widens
// `CODE_OPTION_KEYS`; the validator still fails closed on stray keys.
const CODE_OPTION_KEYS = new Set<string>(['committer']);
const COMMITTER_PLAYER_IDS = new Set<string>(['coder', 'reviewer']);
export const codeCopyPasteGuardNames = [
  'accepted',
  'approved',
  'challengeAccepted',
  'challengeRejected',
  'challengesRaised',
  'changesMadeCode',
  'changesMadeCodeAndChallenged',
  'changesMadeMixed',
  'changesMadeMixedAndChallenged',
  'changesMadeSpecs',
  'changesMadeSpecsAndChallenged',
  'hasFindings',
  'needsRevision',
  'noFindings',
  'noOpenItems',
] as const;

export const codeStateCountLabels = {
  adjudicateChallenges: 'rebuttal',
  reviewBossCommitSpecs: 'review round',
  reviewBossCommitCode: 'review round',
  reviewBossCommitMixed: 'review round',
  reviewIrTaskCommitSpecs: 'review round',
  reviewIrTaskCommitCode: 'review round',
  reviewIrTaskCommitMixed: 'review round',
  reviewChangesSpecs: 'review round',
  reviewChangesCode: 'review round',
  reviewChangesMixed: 'review round',
  reviewChangesAndChallengesSpecs: 'review round',
  reviewChangesAndChallengesCode: 'review round',
  reviewChangesAndChallengesMixed: 'review round',
} as const;

function countNoun(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// PBRT-15 / CAPTAIN-19: the CODE saved-counts line wording is
// registry-owned. The shell renders this exact line through the active
// entry's summary policy rather than hardcoding CODE phrasing.
export function codeSavedCountsLine(
  counts: { interruptions: number; copyPastes: number },
  rounds: number,
): string {
  return [
    'Saved you',
    countNoun(counts.interruptions, 'interruption'),
    'and',
    countNoun(counts.copyPastes, 'copy-paste'),
    'across',
    countNoun(rounds, 'round'),
    'of reviews/rebuttals.',
  ].join(' ');
}

// CAPTAIN-20 summary policy: the counted state-id labels, the
// copy-paste guard names, and the saved-counts line wording an entry
// owns for the shell's turn-summary aggregation. An entry without a
// summary policy opts out of visible turn summaries.
export interface PlaybookSummaryPolicy {
  stateCountLabels: Readonly<Record<string, string>>;
  copyPasteGuardNames: readonly string[];
  savedCountsLine(
    counts: { interruptions: number; copyPastes: number },
    rounds: number,
  ): string;
}

export const codeSummaryPolicy: PlaybookSummaryPolicy = {
  stateCountLabels: codeStateCountLabels,
  copyPasteGuardNames: codeCopyPasteGuardNames,
  savedCountsLine: codeSavedCountsLine,
};

// The validated CODE options set. `committer`, when present, is the
// resolved Committer-alias player id (PBRT-8 / PBRT-30); a future CODE
// option widens both this type and `CODE_OPTION_KEYS`.
export interface CodeOptions {
  committer?: 'coder' | 'reviewer';
}

export interface RegistryPlayer {
  id: string;
  adapter?: string;
  model?: string;
}

export interface CreateCodeRuntimeOptions {
  captainOptions: unknown;
  players: readonly RegistryPlayer[];
}

export interface CodePlaybookRegistryEntry {
  id: 'code';
  command: 'code';
  intent: string;
  requiredRoleIds: readonly string[];
  summaryPolicy: PlaybookSummaryPolicy;
  validateOptions(captainOptions: unknown): CodeOptions;
  createRuntime(options: CreateCodeRuntimeOptions): PlaybookRuntime;
}

export function validateCodeOptions(optionSlice: unknown): CodeOptions {
  if (optionSlice === undefined) return {};
  if (
    typeof optionSlice !== 'object' ||
    optionSlice === null ||
    Array.isArray(optionSlice)
  ) {
    throw new Error('captain.options.playbooks.code.options must be an object');
  }
  const slice = optionSlice as Record<string, unknown>;
  for (const key of Object.keys(slice)) {
    if (!CODE_OPTION_KEYS.has(key)) {
      throw new Error(
        `Unknown config field captain.options.playbooks.code.options.${key}`,
      );
    }
  }
  const options: CodeOptions = {};
  const committer = slice.committer;
  if (committer !== undefined) {
    if (typeof committer !== 'string' || !COMMITTER_PLAYER_IDS.has(committer)) {
      throw new Error(
        "captain.options.playbooks.code.options.committer must be " +
          "'coder' or 'reviewer'",
      );
    }
    options.committer = committer as 'coder' | 'reviewer';
  }
  return options;
}

function playerIdentity(
  players: readonly RegistryPlayer[],
  id: string,
): string | undefined {
  const entry = players.find((p) => p.id === id);
  return entry?.model ?? entry?.adapter;
}

export function createCodeRuntimeOptions({
  captainOptions,
  players,
}: CreateCodeRuntimeOptions): CodePlaybookOptions {
  const codeOptions = validateCodeOptions(captainOptions);
  const coderPlayer = playerIdentity(players, 'coder');
  const reviewerPlayer = playerIdentity(players, 'reviewer');
  return {
    coderPlayer,
    reviewerPlayer,
    ...(codeOptions.committer !== undefined
      ? { committerPlayer: codeOptions.committer }
      : {}),
  };
}

export const codePlaybookRegistryEntry: CodePlaybookRegistryEntry = {
  id: 'code',
  command: 'code',
  intent: 'software development / SDLC coding workflow',
  requiredRoleIds: ['coder', 'reviewer'],
  summaryPolicy: codeSummaryPolicy,
  validateOptions: validateCodeOptions,
  createRuntime(options) {
    return createPlaybookRuntime(createCodeRuntimeOptions(options));
  },
};

// CAPTAIN-16 / PBRT-16: the published `@sublang/playbook/code/registry`
// module's default export is the CODE registry entry the Playbook Captain
// shell loads when a playbook block's `from` names this module.
export default codePlaybookRegistryEntry;
