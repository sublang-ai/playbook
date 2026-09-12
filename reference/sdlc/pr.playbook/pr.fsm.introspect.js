// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
function rawConfig(machine) {
    return machine.config;
}
function arms(value) {
    if (value === undefined || value === null)
        return [];
    return (Array.isArray(value) ? value : [value]);
}
function targetName(target) {
    const value = String(target ?? '');
    return value.startsWith('#') ? value.slice(1) : value;
}
function transitions(value) {
    return arms(value).map((arm, index) => ({
        index,
        target: targetName(arm.target),
        ...(arm.guard === undefined ? {} : { guard: arm.guard }),
        actions: arm.actions,
    }));
}
const EMPTY_CONTEXT = {};
function enumerateInvokingStates(machine, src) {
    const states = rawConfig(machine).states ?? {};
    return Object.entries(states).flatMap(([stateId, state]) => {
        const invoke = state.invoke;
        if (invoke?.src !== src || invoke.input === undefined)
            return [];
        const getInput = (context) => invoke.input?.({ context });
        const input = getInput(EMPTY_CONTEXT);
        return [
            {
                stateId,
                sourceItem: input.sourceItem,
                getInput,
                transitions: transitions(invoke.onDone),
            },
        ];
    });
}
export function enumeratePlayerStates(machine) {
    return enumerateInvokingStates(machine, 'player');
}
export function enumerateNestedPlaybookStates(machine) {
    return enumerateInvokingStates(machine, 'playbook');
}
export function enumerateScriptStates(machine) {
    return enumerateInvokingStates(machine, 'script');
}
export function enumerateAwaitBossReply(machine) {
    const on = rawConfig(machine).states?.awaitBossReply?.on ?? {};
    return {
        stateId: 'awaitBossReply',
        bossReplyTransitions: transitions(on.BOSS_REPLY),
    };
}
export function enumerateRootEvents(machine) {
    const on = rawConfig(machine).states?.ready?.on ?? {};
    const start = arms(on.START_PR)[0];
    return { startPr: { target: targetName(start?.target) } };
}
