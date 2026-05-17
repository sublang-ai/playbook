// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
export function enumerateCaptainStates(machine) {
    const states = getRawConfig(machine).states ?? {};
    const out = [];
    for (const [stateId, def] of Object.entries(states)) {
        const invoke = def.invoke;
        if (!invoke || invoke.src !== 'captain' || typeof invoke.input !== 'function') {
            continue;
        }
        const inputFn = invoke.input;
        const getInput = (context) => inputFn({ context });
        const probe = getInput({});
        const transitions = toArmArray(invoke.onDone).map((arm, index) => ({
            index,
            target: stripIdPrefix(String(arm.target ?? '')),
            guard: arm.guard ?? alwaysTrue,
        }));
        out.push({
            stateId,
            sourceItem: probe.sourceItem,
            getInput,
            transitions,
        });
    }
    return out;
}
export function enumerateRootEvents(machine) {
    const cfg = getRawConfig(machine);
    const readyOn = (cfg.states?.ready?.on ?? {});
    const rootOn = (cfg.on ?? {});
    return {
        startCoding: { target: stripIdPrefix(String(readyOn.START_CODING?.target ?? '')) },
        continueIr: { target: stripIdPrefix(String(readyOn.CONTINUE_IR?.target ?? '')) },
        summarizeIr: { target: stripIdPrefix(String(readyOn.SUMMARIZE_IR?.target ?? '')) },
        bossInterruptTargets: toArmArray(rootOn.BOSS_INTERRUPT).map((arm) => stripIdPrefix(String(arm.target ?? ''))),
    };
}
function getRawConfig(machine) {
    return machine.config;
}
function toArmArray(value) {
    if (value === undefined || value === null)
        return [];
    return (Array.isArray(value) ? value : [value]);
}
function stripIdPrefix(target) {
    return target.startsWith('#') ? target.slice(1) : target;
}
const alwaysTrue = () => true;
