// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import createPlaybookRuntime from './decide.playbook.js';
export const decideStateCountLabels = {
    independentProposals: 'proposal round',
};
export const decideCopyPasteGuardNames = ['proposed'];
function countNoun(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}
export function decideSavedCountsLine(counts, rounds) {
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
export const decideSummaryPolicy = {
    stateCountLabels: decideStateCountLabels,
    copyPasteGuardNames: decideCopyPasteGuardNames,
    savedCountsLine: decideSavedCountsLine,
};
export function validateDecideOptions(optionSlice) {
    if (optionSlice === undefined)
        return Object.freeze({});
    if (optionSlice === null ||
        typeof optionSlice !== 'object' ||
        Array.isArray(optionSlice)) {
        throw new Error('captain.options.playbooks.decide.options must be an object');
    }
    const keys = Object.keys(optionSlice);
    if (keys.length > 0) {
        throw new Error(`Unknown config field captain.options.playbooks.decide.options.${keys[0]}`);
    }
    return Object.freeze({});
}
function playerIdentity(players, id) {
    const player = players.find((entry) => entry.id === id);
    return player?.model ?? player?.adapter ?? id;
}
export function createDecideRuntimeOptions({ captainOptions, players, }) {
    validateDecideOptions(captainOptions);
    return { coderLlm: playerIdentity(players, 'coder') };
}
export const decidePlaybookRegistryEntry = {
    id: 'decide',
    command: 'decide',
    intent: 'turn independent Coder and Reviewer proposals into an approved spec-design commit',
    requiredRoleIds: ['coder', 'reviewer'],
    summaryPolicy: decideSummaryPolicy,
    validateOptions: validateDecideOptions,
    createRuntime(options) {
        return createPlaybookRuntime(createDecideRuntimeOptions(options));
    },
};
export default decidePlaybookRegistryEntry;
