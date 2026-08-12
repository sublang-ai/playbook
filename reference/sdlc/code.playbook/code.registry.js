// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import createPlaybookRuntime from './code.playbook.js';
// REVIEW owns and labels its real review rounds. CODE's two suspended wrapper
// states only delegate to that child and must not double-count those rounds.
export const codeStateCountLabels = {};
export const codeCopyPasteGuardNames = [
    'directCommit',
    'irCommit',
    'moreTasks',
    'finalTask',
];
function countNoun(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}
export function codeSavedCountsLine(counts, rounds) {
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
export const codeSummaryPolicy = {
    stateCountLabels: codeStateCountLabels,
    copyPasteGuardNames: codeCopyPasteGuardNames,
    savedCountsLine: codeSavedCountsLine,
};
export function validateCodeOptions(optionSlice) {
    if (optionSlice === undefined)
        return Object.freeze({});
    if (optionSlice === null ||
        typeof optionSlice !== 'object' ||
        Array.isArray(optionSlice)) {
        throw new Error('captain.options.playbooks.code.options must be an object');
    }
    const keys = Object.keys(optionSlice);
    if (keys.length > 0) {
        throw new Error(`Unknown config field captain.options.playbooks.code.options.${keys[0]}`);
    }
    return Object.freeze({});
}
export const codePlaybookRegistryEntry = {
    id: 'code',
    command: 'code',
    intent: 'implement a coding intent in reviewed, one-commit phases, using an intent record when needed',
    artifactSchema: 2,
    requiredRoleIds: ['coder'],
    concurrentRoleSets: [],
    summaryPolicy: codeSummaryPolicy,
    validateOptions: validateCodeOptions,
    createRuntime(options) {
        return createPlaybookRuntime(options);
    },
};
export default codePlaybookRegistryEntry;
