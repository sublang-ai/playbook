// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import createPlaybookRuntime from './code.playbook.js';
// PBRT-29/30: CODE runtime options are carried under
// `captain.options.code`, a namespaced object the host forwards
// verbatim through `captain.options`. cligent neither reads nor
// validates `options.code`; the CODE registry entry is the sole
// validator. The CODE options schema defines one key, `committer`: an
// optional Committer-alias player id, one of the baked player ids
// `coder` / `reviewer`. A valid `options.code` is absent, `{}`, or
// `{ committer: 'coder' | 'reviewer' }`; every other key is unknown
// and rejected with a path-named error, and an out-of-range
// `committer` value is rejected naming `captain.options.code.committer`.
// A further CODE option shall be introduced as its own higher-numbered
// item that widens `CODE_OPTION_KEYS`; the validator still fails closed
// on stray keys.
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
    awaitBossReply: 'Boss reply wait',
    failed: 'failure',
    respondToReview: 'review response',
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
export function validateCodeOptions(captainOptions) {
    const code = readCodeNamespace(captainOptions);
    if (code === undefined)
        return {};
    if (typeof code !== 'object' || code === null || Array.isArray(code)) {
        throw new Error('captain.options.code must be an object');
    }
    for (const key of Object.keys(code)) {
        if (!CODE_OPTION_KEYS.has(key)) {
            throw new Error(`Unknown config field captain.options.code.${key}`);
        }
    }
    const options = {};
    const committer = code.committer;
    if (committer !== undefined) {
        if (typeof committer !== 'string' || !COMMITTER_PLAYER_IDS.has(committer)) {
            throw new Error("captain.options.code.committer must be 'coder' or 'reviewer'");
        }
        options.committer = committer;
    }
    return options;
}
function readCodeNamespace(captainOptions) {
    if (typeof captainOptions !== 'object' ||
        captainOptions === null ||
        Array.isArray(captainOptions)) {
        return undefined;
    }
    return captainOptions.code;
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
    idleStateId: 'ready',
    finalStateId: 'done',
    copyPasteGuardNames: codeCopyPasteGuardNames,
    stateCountLabels: codeStateCountLabels,
    validateOptions: validateCodeOptions,
    createRuntime(options) {
        return createPlaybookRuntime(createCodeRuntimeOptions(options));
    },
};
