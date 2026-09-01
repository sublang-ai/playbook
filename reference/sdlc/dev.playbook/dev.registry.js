// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import createPlaybookRuntime from './dev.playbook.js';
// CODE and DECIDE own and label the rounds of the paths DEV starts. DEV's
// suspended call states only delegate to those children and must not
// double-count their rounds; only the Analyst planning rounds are DEV's own.
export const devStateCountLabels = {
    planAnalysis: 'planning round',
};
export const devCopyPasteGuardNames = ['code', 'decideThenCode'];
function countNoun(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}
export function devSavedCountsLine(counts, rounds) {
    return [
        'Saved you',
        countNoun(counts.interruptions, 'interruption'),
        'and',
        countNoun(counts.copyPastes, 'copy-paste'),
        'across',
        countNoun(rounds, 'round'),
        'of planning.',
    ].join(' ');
}
export const devSummaryPolicy = {
    stateCountLabels: devStateCountLabels,
    copyPasteGuardNames: devCopyPasteGuardNames,
    savedCountsLine: devSavedCountsLine,
};
export function validateDevOptions(optionSlice) {
    if (optionSlice === undefined)
        return Object.freeze({});
    if (optionSlice === null ||
        typeof optionSlice !== 'object' ||
        Array.isArray(optionSlice)) {
        throw new Error('captain.options.playbooks.dev.options must be an object');
    }
    const keys = Object.keys(optionSlice);
    if (keys.length > 0) {
        throw new Error(`Unknown config field captain.options.playbooks.dev.options.${keys[0]}`);
    }
    return Object.freeze({});
}
export const devPlaybookRegistryEntry = {
    id: 'dev',
    command: 'dev',
    intent: 'analyze a development request that needs planning before choosing direct implementation or a durable decision first',
    artifactSchema: 3,
    runtimeProfile: Object.freeze({
        kind: 'shared-factory',
        compat: createPlaybookRuntime.compat,
    }),
    requiredRoleIds: ['analyst'],
    concurrentRoleSets: [],
    summaryPolicy: devSummaryPolicy,
    validateOptions: validateDevOptions,
    createRuntime(options, hostCapabilities) {
        return createPlaybookRuntime({
            configuredOptions: options,
            hostCapabilities,
        });
    },
};
export default devPlaybookRegistryEntry;
