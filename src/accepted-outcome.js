// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
export const ACCEPTED_OUTCOME_ACTION_TYPE = 'playbook.acceptedOutcome';
function exactMarkerParams(value) {
    if (value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype &&
            Object.getPrototypeOf(value) !== null)) {
        throw new TypeError(`${ACCEPTED_OUTCOME_ACTION_TYPE} params must be a plain object`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const expected = ['acceptedOutcome', 'source', 'target'];
    if (keys.length !== expected.length ||
        keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
        throw new TypeError(`${ACCEPTED_OUTCOME_ACTION_TYPE} params must contain exactly source, target, and acceptedOutcome`);
    }
    const stringValue = (key) => {
        const descriptor = descriptors[key];
        if (descriptor === undefined ||
            !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
            descriptor.enumerable !== true ||
            typeof descriptor.value !== 'string' ||
            descriptor.value.trim().length === 0) {
            throw new TypeError(`${ACCEPTED_OUTCOME_ACTION_TYPE} params.${key} must be a nonempty enumerable string data property`);
        }
        return descriptor.value;
    };
    return Object.freeze({
        source: stringValue('source'),
        target: stringValue('target'),
        acceptedOutcome: stringValue('acceptedOutcome'),
    });
}
export function createAcceptedOutcomeConsumer(artifactSchema, isDeclared) {
    let pending = [];
    let invalidBatch = false;
    return Object.freeze({
        capture(action) {
            if (artifactSchema !== 3 ||
                action.type !== ACCEPTED_OUTCOME_ACTION_TYPE) {
                return;
            }
            if (invalidBatch)
                return;
            try {
                const marker = exactMarkerParams(action.params);
                if (!isDeclared(marker.source, marker.acceptedOutcome)) {
                    throw new TypeError(`${ACCEPTED_OUTCOME_ACTION_TYPE} names undeclared outcome ` +
                        `${marker.source}.${marker.acceptedOutcome}`);
                }
                pending.push(marker);
            }
            catch (error) {
                pending = [];
                invalidBatch = true;
                throw error;
            }
        },
        confirm(previousState, state) {
            if (invalidBatch) {
                pending = [];
                invalidBatch = false;
                return Object.freeze([]);
            }
            if (pending.length === 0)
                return Object.freeze([]);
            const captured = pending;
            pending = [];
            if (previousState === undefined) {
                throw new TypeError(`${ACCEPTED_OUTCOME_ACTION_TYPE} marker has no prior public root snapshot`);
            }
            const seen = new Set();
            for (const marker of captured) {
                const identity = marker.source;
                if (seen.has(identity)) {
                    throw new TypeError(`${ACCEPTED_OUTCOME_ACTION_TYPE} source ${marker.source} was instrumented more than once in one action batch`);
                }
                seen.add(identity);
                if (!previousState.activeStateIds.includes(marker.source)) {
                    throw new TypeError(`${ACCEPTED_OUTCOME_ACTION_TYPE} source ${marker.source} was not confirmed by the prior public root snapshot`);
                }
                if (!state.activeStateIds.includes(marker.target)) {
                    throw new TypeError(`${ACCEPTED_OUTCOME_ACTION_TYPE} target ${marker.target} was not confirmed by the public root snapshot`);
                }
            }
            return Object.freeze(captured);
        },
        reset() {
            pending = [];
            invalidBatch = false;
        },
    });
}
