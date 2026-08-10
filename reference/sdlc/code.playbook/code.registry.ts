// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import createPlaybookRuntime, {
  type CodePlaybookOptions,
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

export interface RegistryPlayer {
  id: string;
  adapter?: string;
  model?: string;
}

export interface CreateCodeRuntimeOptions {
  captainOptions: unknown;
  players: readonly RegistryPlayer[];
}

export type CodeOptions = Readonly<Record<string, never>>;

export interface CodePlaybookRegistryEntry {
  id: 'code';
  command: 'code';
  intent: string;
  requiredRoleIds: readonly ['coder'];
  summaryPolicy: PlaybookSummaryPolicy;
  validateOptions(captainOptions: unknown): CodeOptions;
  createRuntime(options: CreateCodeRuntimeOptions): PlaybookRuntime;
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

function playerIdentity(
  players: readonly RegistryPlayer[],
  id: string,
): string | undefined {
  const player = players.find((entry) => entry.id === id);
  return player?.model ?? player?.adapter;
}

export function createCodeRuntimeOptions({
  captainOptions,
  players,
}: CreateCodeRuntimeOptions): CodePlaybookOptions {
  validateCodeOptions(captainOptions);
  const coderPlayer = playerIdentity(players, 'coder');
  return coderPlayer === undefined ? {} : { coderPlayer };
}

export const codePlaybookRegistryEntry: CodePlaybookRegistryEntry = {
  id: 'code',
  command: 'code',
  intent:
    'implement a coding intent in reviewed, one-commit phases, using an intent record when needed',
  requiredRoleIds: ['coder'],
  summaryPolicy: codeSummaryPolicy,
  validateOptions: validateCodeOptions,
  createRuntime(options) {
    return createPlaybookRuntime(createCodeRuntimeOptions(options));
  },
};

export default codePlaybookRegistryEntry;
