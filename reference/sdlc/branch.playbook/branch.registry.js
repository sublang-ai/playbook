// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import createPlaybookRuntime from './branch.playbook.js';
// BRANCH's one Coder call is its only round: the branching call that reads
// the issue and creates and checks out the branch.
export const branchStateCountLabels = {
    createBranch: 'branching round',
};
export const branchCopyPasteGuardNames = ['branched'];
function countNoun(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}
export function branchSavedCountsLine(counts, rounds) {
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
export const branchSummaryPolicy = {
    stateCountLabels: branchStateCountLabels,
    copyPasteGuardNames: branchCopyPasteGuardNames,
    savedCountsLine: branchSavedCountsLine,
};
export function validateBranchOptions(optionSlice) {
    if (optionSlice === undefined)
        return Object.freeze({});
    if (optionSlice === null ||
        typeof optionSlice !== 'object' ||
        Array.isArray(optionSlice)) {
        throw new Error('captain.options.playbooks.branch.options must be an object');
    }
    const keys = Object.keys(optionSlice);
    if (keys.length > 0) {
        throw new Error(`Unknown config field captain.options.playbooks.branch.options.${keys[0]}`);
    }
    return Object.freeze({});
}
export const branchPlaybookRegistryEntry = {
    id: 'branch',
    command: 'branch',
    intent: 'create and check out a new branch for a GitHub issue or request before pull-request delivery',
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
