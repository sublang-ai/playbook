// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import createPlaybookRuntime from './discuss.playbook.js';
const DISCUSS_OPTION_KEYS = new Set(['committer']);
const COMMITTER_PLAYER_IDS = new Set(['host', 'participant']);
export function validateDiscussOptions(optionSlice) {
    if (optionSlice === undefined)
        return {};
    if (typeof optionSlice !== 'object' ||
        optionSlice === null ||
        Array.isArray(optionSlice)) {
        throw new Error('captain.options.playbooks.discuss.options must be an object');
    }
    const slice = optionSlice;
    for (const key of Object.keys(slice)) {
        if (!DISCUSS_OPTION_KEYS.has(key)) {
            throw new Error(`Unknown config field captain.options.playbooks.discuss.options.${key}`);
        }
    }
    const options = {};
    const committer = slice.committer;
    if (committer !== undefined) {
        if (typeof committer !== 'string' || !COMMITTER_PLAYER_IDS.has(committer)) {
            throw new Error("captain.options.playbooks.discuss.options.committer must be " +
                "'host' or 'participant'");
        }
        options.committer = committer;
    }
    return options;
}
function playerIdentity(players, id) {
    const entry = players.find((p) => p.id === id);
    return entry?.model ?? entry?.adapter;
}
export function createDiscussRuntimeOptions({ captainOptions, players, }) {
    const discussOptions = validateDiscussOptions(captainOptions);
    const options = {
        host: playerIdentity(players, 'host'),
        participant: playerIdentity(players, 'participant'),
    };
    if (discussOptions.committer !== undefined) {
        options.committer = discussOptions.committer;
    }
    return options;
}
// CAPTAIN-19/20: the DISCUSS turn-summary policy — counted round states,
// the payload-carrying guards whose content Boss would otherwise relay
// between the players by hand, and the saved-counts wording — so the shell
// reports how many interruptions a run saved.
const discussStateCountLabels = {
    askHostInitial: 'proposal round',
    askParticipantInitial: 'proposal round',
    hostInitialRound: 'proposal round',
    participantInitialRound: 'proposal round',
    reviewSpecInitialCommit: 'review round',
    reviewSpecHostChanges: 'review round',
    reviewDrInitialCommit: 'review round',
    reviewDrHostChanges: 'review round',
    reviewMixedInitialCommit: 'review round',
    reviewMixedHostChanges: 'review round',
};
const discussCopyPasteGuardNames = [
    'proposalMade',
    'findingsRaised',
    'rebuttalsRaised',
    'rebuttalsAddressed',
    'changesMade',
];
function countNoun(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}
export function discussSavedCountsLine(counts, rounds) {
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
export const discussSummaryPolicy = {
    stateCountLabels: discussStateCountLabels,
    copyPasteGuardNames: discussCopyPasteGuardNames,
    savedCountsLine: discussSavedCountsLine,
};
export const discussPlaybookRegistryEntry = {
    id: 'discuss',
    command: 'discuss',
    intent: 'design discussion: two agents converge on spec items or decision records',
    requiredRoleIds: ['host', 'participant'],
    idleStateId: 'ready',
    finalStateId: 'done',
    parkStateIds: ['failed', 'awaitBossReply'],
    summaryPolicy: discussSummaryPolicy,
    validateOptions: validateDiscussOptions,
    createRuntime(options) {
        return createPlaybookRuntime(createDiscussRuntimeOptions(options));
    },
};
export default discussPlaybookRegistryEntry;
