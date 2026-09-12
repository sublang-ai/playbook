// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import createPlaybookRuntime, {
  type BranchPlaybookHostCapabilities,
  type PlaybookRuntime,
} from './branch.playbook.js';

export interface PlaybookSummaryPolicy {
  stateCountLabels: Readonly<Record<string, string>>;
  copyPasteGuardNames: readonly string[];
  savedCountsLine(
    counts: { interruptions: number; copyPastes: number },
    rounds: number,
  ): string;
}

export type BranchOptions = Readonly<Record<string, never>>;

export interface BranchPlaybookRegistryEntry {
  id: 'branch';
  command: 'branch';
  intent: string;
  artifactSchema: 3;
  runtimeProfile: {
    readonly kind: 'shared-factory';
    readonly compat: {
      readonly artifactSchema: 3;
      readonly runtimeAbi: number;
    };
  };
  requiredRoleIds: readonly ['coder'];
  concurrentRoleSets: readonly [];
  summaryPolicy: PlaybookSummaryPolicy;
  validateOptions(optionSlice: unknown): BranchOptions;
  createRuntime(
    options: BranchOptions,
    hostCapabilities: BranchPlaybookHostCapabilities,
  ): PlaybookRuntime;
}

// BRANCH's one Coder call is its only round: the branching call that reads
// the issue and creates and checks out the branch.
export const branchStateCountLabels = {
  createBranch: 'branching round',
} as const;

export const branchCopyPasteGuardNames = ['branched'] as const;

function countNoun(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function branchSavedCountsLine(
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
    'of branching.',
  ].join(' ');
}

export const branchSummaryPolicy: PlaybookSummaryPolicy = {
  stateCountLabels: branchStateCountLabels,
  copyPasteGuardNames: branchCopyPasteGuardNames,
  savedCountsLine: branchSavedCountsLine,
};

export function validateBranchOptions(optionSlice: unknown): BranchOptions {
  if (optionSlice === undefined) return Object.freeze({});
  if (
    optionSlice === null ||
    typeof optionSlice !== 'object' ||
    Array.isArray(optionSlice)
  ) {
    throw new Error(
      'captain.options.playbooks.branch.options must be an object',
    );
  }
  const keys = Object.keys(optionSlice);
  if (keys.length > 0) {
    throw new Error(
      `Unknown config field captain.options.playbooks.branch.options.${keys[0]}`,
    );
  }
  return Object.freeze({});
}

export const branchPlaybookRegistryEntry: BranchPlaybookRegistryEntry = {
  id: 'branch',
  command: 'branch',
  intent:
    'create and check out a new branch for a GitHub issue or request before pull-request delivery',
  artifactSchema: 3,
  runtimeProfile: Object.freeze({
    kind: 'shared-factory',
    compat: createPlaybookRuntime.compat,
  }),
  requiredRoleIds: ['coder'],
  concurrentRoleSets: [],
  summaryPolicy: branchSummaryPolicy,
  validateOptions: validateBranchOptions,
  createRuntime(options, hostCapabilities) {
    return createPlaybookRuntime({
      configuredOptions: options,
      hostCapabilities,
    });
  },
};

export default branchPlaybookRegistryEntry;
