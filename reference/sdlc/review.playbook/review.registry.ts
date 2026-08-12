// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import createPlaybookRuntime, {
  type PlaybookRuntime,
} from './review.playbook.js';

export interface PlaybookSummaryPolicy {
  stateCountLabels: Readonly<Record<string, string>>;
  copyPasteGuardNames: readonly string[];
  savedCountsLine(
    counts: { interruptions: number; copyPastes: number },
    rounds: number,
  ): string;
}

export type ReviewOptions = Readonly<Record<string, never>>;

export interface ReviewPlaybookRegistryEntry {
  id: 'review';
  command: 'review';
  intent: string;
  artifactSchema: 2;
  requiredRoleIds: readonly ['coder', 'reviewer'];
  concurrentRoleSets: readonly [];
  summaryPolicy: PlaybookSummaryPolicy;
  validateOptions(optionSlice: unknown): ReviewOptions;
  createRuntime(options: ReviewOptions): PlaybookRuntime;
}

export const reviewStateCountLabels = {
  reviewInitial: 'review round',
  reviewAfterCommit: 'review round',
  reviewAfterRebuttal: 'rebuttal',
} as const;

export const reviewCopyPasteGuardNames = [
  'hasFindings',
  'committed',
  'rejectedAll',
] as const;

function countNoun(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function reviewSavedCountsLine(
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

export const reviewSummaryPolicy: PlaybookSummaryPolicy = {
  stateCountLabels: reviewStateCountLabels,
  copyPasteGuardNames: reviewCopyPasteGuardNames,
  savedCountsLine: reviewSavedCountsLine,
};

export function validateReviewOptions(optionSlice: unknown): ReviewOptions {
  if (optionSlice === undefined) return Object.freeze({});
  if (
    optionSlice === null ||
    typeof optionSlice !== 'object' ||
    Array.isArray(optionSlice)
  ) {
    throw new Error(
      'captain.options.playbooks.review.options must be an object',
    );
  }
  const keys = Object.keys(optionSlice);
  if (keys.length > 0) {
    throw new Error(
      `Unknown config field captain.options.playbooks.review.options.${keys[0]}`,
    );
  }
  return Object.freeze({});
}

export const reviewPlaybookRegistryEntry: ReviewPlaybookRegistryEntry = {
  id: 'review',
  command: 'review',
  intent:
    'review the latest commit until no material correctness or spec findings remain',
  artifactSchema: 2,
  requiredRoleIds: ['coder', 'reviewer'],
  concurrentRoleSets: [],
  summaryPolicy: reviewSummaryPolicy,
  validateOptions: validateReviewOptions,
  createRuntime(options) {
    return createPlaybookRuntime(options);
  },
};

export default reviewPlaybookRegistryEntry;
