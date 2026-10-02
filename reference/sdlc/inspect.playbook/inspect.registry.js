// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import createPlaybookRuntime, { validateOptions, } from './inspect.playbook.js';
// INSPECT counts its delegated evidence-gathering calls as inspection rounds.
export const inspectStateCountLabels = {
    inspecting: 'inspection round',
};
export const inspectCopyPasteGuardNames = ['completed'];
function countNoun(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}
export function inspectSavedCountsLine(counts, rounds) {
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
export const inspectSummaryPolicy = {
    stateCountLabels: inspectStateCountLabels,
    copyPasteGuardNames: inspectCopyPasteGuardNames,
    savedCountsLine: inspectSavedCountsLine,
};
export function validateInspectOptions(optionSlice) {
    return validateOptions(optionSlice);
}
export const inspectPlaybookRegistryEntry = {
    id: 'inspect',
    command: 'inspect',
    intent: 'inspect supplied material or a running web interface and explain observed evidence without changing the repository',
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
