// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import createPlaybookRuntime, {
  type PlaybookRuntime,
} from './code.playbook.js';

export interface PlaybookSummaryPolicy {
  stateCountLabels: Readonly<Record<string, string>>;
  copyPasteGuardNames: readonly string[];
  savedCountsLine(
    counts: { interruptions: number; copyPastes: number },
    rounds: number,
  ): string;
}

export type CodeOptions = Readonly<Record<string, never>>;

export interface CodePlaybookRegistryEntry {
  id: 'code';
  command: 'code';
  intent: string;
  artifactSchema: 2;
  runtimeProfile: {
    readonly kind: 'shared-factory';
    readonly compat: {
      readonly artifactSchema: 2;
      readonly runtimeAbi: number;
    };
  };
  requiredRoleIds: readonly ['coder'];
  concurrentRoleSets: readonly [];
  summaryPolicy: PlaybookSummaryPolicy;
  validateOptions(optionSlice: unknown): CodeOptions;
  createRuntime(options: CodeOptions): PlaybookRuntime;
}

// REVIEW owns and labels its real review rounds. CODE's two suspended wrapper
// states only delegate to that child and must not double-count those rounds.
export const codeStateCountLabels = {} as const;

export const codeCopyPasteGuardNames = [
  'directCommit',
  'irCommit',
  'moreTasks',
  'finalTask',
] as const;

function countNoun(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

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

export const codeSummaryPolicy: PlaybookSummaryPolicy = {
  stateCountLabels: codeStateCountLabels,
  copyPasteGuardNames: codeCopyPasteGuardNames,
  savedCountsLine: codeSavedCountsLine,
};

export function validateCodeOptions(optionSlice: unknown): CodeOptions {
  if (optionSlice === undefined) return Object.freeze({});
  if (
    optionSlice === null ||
    typeof optionSlice !== 'object' ||
    Array.isArray(optionSlice)
  ) {
    throw new Error('captain.options.playbooks.code.options must be an object');
  }
  const keys = Object.keys(optionSlice);
  if (keys.length > 0) {
    throw new Error(
      `Unknown config field captain.options.playbooks.code.options.${keys[0]}`,
    );
  }
  return Object.freeze({});
}

export const codePlaybookRegistryEntry: CodePlaybookRegistryEntry = {
  id: 'code',
  command: 'code',
  intent:
    'implement a coding intent in reviewed, one-commit phases, using an intent record when needed',
  artifactSchema: 2,
  runtimeProfile: Object.freeze({
    kind: 'shared-factory',
    compat: createPlaybookRuntime.compat,
  }),
  requiredRoleIds: ['coder'],
  concurrentRoleSets: [],
  summaryPolicy: codeSummaryPolicy,
  validateOptions: validateCodeOptions,
  createRuntime(options) {
    return createPlaybookRuntime(options);
  },
};

export default codePlaybookRegistryEntry;
