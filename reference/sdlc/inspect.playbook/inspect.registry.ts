// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import createPlaybookRuntime, {
  validateOptions,
  type PlaybookRuntimeOptions,
  type PlaybookHostCapabilities,
  type PlaybookRuntime,
} from './inspect.playbook.js';
import type { PlaybookHostConstructionCapabilities } from '../code.playbook/playbook-captain.js';

export interface PlaybookSummaryPolicy {
  stateCountLabels: Readonly<Record<string, string>>;
  copyPasteGuardNames: readonly string[];
  savedCountsLine(
    counts: { interruptions: number; copyPastes: number },
    rounds: number,
  ): string;
}

export type InspectOptions = PlaybookRuntimeOptions;

export interface InspectPlaybookRegistryEntry {
  id: 'inspect';
  command: 'inspect';
  intent: string;
  artifactSchema: 3;
  runtimeProfile: {
    readonly kind: 'shared-factory';
    readonly compat: {
      readonly artifactSchema: 3;
      readonly runtimeAbi: number;
    };
  };
  requiredRoleIds: readonly ['inspector'];
  concurrentRoleSets: readonly [];
  summaryPolicy: PlaybookSummaryPolicy;
  validateOptions(optionSlice: unknown): InspectOptions;
  // The linked module types live authority as opaque (link-materialization);
  // the Captain entry binds its own construction capabilities here.
  createRuntime(
    options: InspectOptions,
    hostCapabilities: PlaybookHostConstructionCapabilities &
      PlaybookHostCapabilities,
  ): PlaybookRuntime;
}

// INSPECT counts its delegated evidence-gathering calls as inspection rounds.
export const inspectStateCountLabels = {
  inspecting: 'inspection round',
} as const;

export const inspectCopyPasteGuardNames = ['completed'] as const;

function countNoun(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function inspectSavedCountsLine(
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
    'of inspection.',
  ].join(' ');
}

export const inspectSummaryPolicy: PlaybookSummaryPolicy = {
  stateCountLabels: inspectStateCountLabels,
  copyPasteGuardNames: inspectCopyPasteGuardNames,
  savedCountsLine: inspectSavedCountsLine,
};

export function validateInspectOptions(optionSlice: unknown): InspectOptions {
  return validateOptions(optionSlice);
}

export const inspectPlaybookRegistryEntry: InspectPlaybookRegistryEntry = {
  id: 'inspect',
  command: 'inspect',
  intent:
    'inspect supplied material or a running web interface and explain observed evidence without changing the repository',
  artifactSchema: 3,
  runtimeProfile: Object.freeze({
    kind: 'shared-factory',
    compat: createPlaybookRuntime.compat,
  }),
  requiredRoleIds: ['inspector'],
  concurrentRoleSets: [],
  summaryPolicy: inspectSummaryPolicy,
  validateOptions: validateInspectOptions,
  createRuntime(options, hostCapabilities) {
    return createPlaybookRuntime({
      configuredOptions: options,
      hostCapabilities,
    });
  },
};

export default inspectPlaybookRegistryEntry;
