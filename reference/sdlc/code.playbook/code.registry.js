// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import createPlaybookRuntime from './code.playbook.js';
// PBRT-30: the CODE registry entry validates the option slice the shell
// passes it (`captain.options.playbooks.code.options`), not a namespace
// it extracts from the full Captain options bag. The schema defines one
// key, `committer`: an optional Committer-alias player id, one of the
// baked role ids `coder` / `reviewer`. A valid slice is absent, `{}`, or
// `{ committer: 'coder' | 'reviewer' }`; every other key is unknown and
// rejected with a path-named error. A further CODE option shall be
// introduced as its own higher-numbered item that widens
// `CODE_OPTION_KEYS`; the validator still fails closed on stray keys.
const CODE_OPTION_KEYS = new Set(['committer']);
const COMMITTER_PLAYER_IDS = new Set(['coder', 'reviewer']);
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
];
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
};
function countNoun(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}
// PBRT-15 / CAPTAIN-19: the CODE saved-counts line wording is
// registry-owned. The shell renders this exact line through the active
// entry's summary policy rather than hardcoding CODE phrasing.
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
        return {};
    if (typeof optionSlice !== 'object' ||
        optionSlice === null ||
        Array.isArray(optionSlice)) {
        throw new Error('captain.options.playbooks.code.options must be an object');
    }
    const slice = optionSlice;
    for (const key of Object.keys(slice)) {
        if (!CODE_OPTION_KEYS.has(key)) {
            throw new Error(`Unknown config field captain.options.playbooks.code.options.${key}`);
        }
    }
    const options = {};
    const committer = slice.committer;
    if (committer !== undefined) {
        if (typeof committer !== 'string' || !COMMITTER_PLAYER_IDS.has(committer)) {
            throw new Error("captain.options.playbooks.code.options.committer must be " +
                "'coder' or 'reviewer'");
        }
        options.committer = committer;
    }
    return options;
}
function playerIdentity(players, id) {
    const entry = players.find((p) => p.id === id);
    return entry?.model ?? entry?.adapter;
}
export function createCodeRuntimeOptions({ captainOptions, players, }) {
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
export const codePlaybookRegistryEntry = {
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
