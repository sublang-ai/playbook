// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import createPlaybookRuntime, {
  type DecidePlaybookHostCapabilities,
  type PlaybookRuntime,
} from './decide.playbook.js';

export interface PlaybookSummaryPolicy {
  stateCountLabels: Readonly<Record<string, string>>;
  copyPasteGuardNames: readonly string[];
  savedCountsLine(
    counts: { interruptions: number; copyPastes: number },
    rounds: number,
  ): string;
}

export type DecideOptions = Readonly<Record<string, never>>;

export interface DecidePlaybookRegistryEntry {
  id: 'decide';
  command: 'decide';
  intent: string;
  artifactSchema: 3;
  runtimeProfile: {
    readonly kind: 'bespoke';
    readonly artifactSchema: 3;
  };
  requiredRoleIds: readonly ['coder', 'reviewer'];
  concurrentRoleSets: readonly [readonly ['coder', 'reviewer']];
  summaryPolicy: PlaybookSummaryPolicy;
  validateOptions(optionSlice: unknown): DecideOptions;
  createRuntime(
    options: DecideOptions,
    hostCapabilities: DecidePlaybookHostCapabilities,
  ): PlaybookRuntime;
}

export const decideStateCountLabels = {
  independentProposals: 'proposal round',
} as const;

export const decideCopyPasteGuardNames = ['proposed'] as const;

function countNoun(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function decideSavedCountsLine(
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
    'of proposals/reviews.',
  ].join(' ');
}

export const decideSummaryPolicy: PlaybookSummaryPolicy = {
  stateCountLabels: decideStateCountLabels,
  copyPasteGuardNames: decideCopyPasteGuardNames,
  savedCountsLine: decideSavedCountsLine,
};

export function validateDecideOptions(optionSlice: unknown): DecideOptions {
  if (optionSlice === undefined) return Object.freeze({});
  if (
    optionSlice === null ||
    typeof optionSlice !== 'object' ||
    Array.isArray(optionSlice)
  ) {
    throw new Error(
      'captain.options.playbooks.decide.options must be an object',
    );
  }
  const keys = Object.keys(optionSlice);
  if (keys.length > 0) {
    throw new Error(
      `Unknown config field captain.options.playbooks.decide.options.${keys[0]}`,
    );
  }
  return Object.freeze({});
}

export const decidePlaybookRegistryEntry: DecidePlaybookRegistryEntry = {
  id: 'decide',
  command: 'decide',
  intent:
    'turn independent Coder and Reviewer proposals into an approved spec-design commit',
  artifactSchema: 3,
  runtimeProfile: Object.freeze({
    kind: 'bespoke',
    artifactSchema: 3,
  }),
  requiredRoleIds: ['coder', 'reviewer'],
  concurrentRoleSets: [['coder', 'reviewer']],
  summaryPolicy: decideSummaryPolicy,
  validateOptions: validateDecideOptions,
  createRuntime(options, hostCapabilities) {
    return createPlaybookRuntime({
      configuredOptions: options,
      hostCapabilities,
    });
  },
};

export default decidePlaybookRegistryEntry;
