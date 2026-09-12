// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import createPlaybookRuntime from './pr.playbook.js';
// CODE owns and labels the rounds of the one fix it may make. PR's suspended
// call state only delegates to that child and must not double-count its
// rounds; its script states run no agent at all. Only the Coder publication
// round is PR's own.
export const prStateCountLabels = {
    openPullRequest: 'publication round',
};
export const prCopyPasteGuardNames = ['opened'];
function countNoun(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}
export function prSavedCountsLine(counts, rounds) {
    return [
        'Saved you',
        countNoun(counts.interruptions, 'interruption'),
        'and',
        countNoun(counts.copyPastes, 'copy-paste'),
        'across',
        countNoun(rounds, 'round'),
        'of delivery.',
    ].join(' ');
}
export const prSummaryPolicy = {
    stateCountLabels: prStateCountLabels,
    copyPasteGuardNames: prCopyPasteGuardNames,
    savedCountsLine: prSavedCountsLine,
};
export function validatePrOptions(optionSlice) {
    if (optionSlice === undefined)
        return Object.freeze({});
    if (optionSlice === null ||
        typeof optionSlice !== 'object' ||
        Array.isArray(optionSlice)) {
        throw new Error('captain.options.playbooks.pr.options must be an object');
    }
    const keys = Object.keys(optionSlice);
    if (keys.length > 0) {
        throw new Error(`Unknown config field captain.options.playbooks.pr.options.${keys[0]}`);
    }
    return Object.freeze({});
}
export const prPlaybookRegistryEntry = {
    id: 'pr',
    command: 'pr',
    intent: 'publish a reviewed branch as a pull request, wait for its checks, fix red checks once through code, and merge it',
    artifactSchema: 3,
    runtimeProfile: Object.freeze({
        kind: 'shared-factory',
        compat: createPlaybookRuntime.compat,
    }),
    requiredRoleIds: ['coder'],
    concurrentRoleSets: [],
    summaryPolicy: prSummaryPolicy,
    validateOptions: validatePrOptions,
    createRuntime(options, hostCapabilities) {
        // The five script states run `gh` and `git` in the repository the host
        // governs: the linked `cwd` option is composed here from the host's
        // authority working directory (DR-040 §2), never from configuration.
        return createPlaybookRuntime({
            configuredOptions: { ...options, cwd: hostCapabilities.authority.cwd },
            hostCapabilities,
        });
    },
};
export default prPlaybookRegistryEntry;
