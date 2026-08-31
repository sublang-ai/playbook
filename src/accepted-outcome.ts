// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { PlaybookState } from './runtime.js';

export const ACCEPTED_OUTCOME_ACTION_TYPE = 'playbook.acceptedOutcome';

export interface AcceptedOutcomeReceipt {
  readonly source: string;
  readonly target: string;
  readonly acceptedOutcome: string;
}

interface InspectedAction {
  readonly type: string;
  readonly params: unknown;
}

export interface AcceptedOutcomeConsumer {
  capture(action: InspectedAction): void;
  confirm(
    previousState: PlaybookState | undefined,
    state: PlaybookState,
  ): readonly AcceptedOutcomeReceipt[];
  reset(): void;
}

function exactMarkerParams(value: unknown): AcceptedOutcomeReceipt {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(
      `${ACCEPTED_OUTCOME_ACTION_TYPE} params must be a plain object`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const expected = ['acceptedOutcome', 'source', 'target'];
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    throw new TypeError(
      `${ACCEPTED_OUTCOME_ACTION_TYPE} params must contain exactly source, target, and acceptedOutcome`,
    );
  }
  const stringValue = (key: string): string => {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.trim().length === 0
    ) {
      throw new TypeError(
        `${ACCEPTED_OUTCOME_ACTION_TYPE} params.${key} must be a nonempty enumerable string data property`,
      );
    }
    return descriptor.value;
  };
  return Object.freeze({
    source: stringValue('source'),
    target: stringValue('target'),
    acceptedOutcome: stringValue('acceptedOutcome'),
  });
}

export function createAcceptedOutcomeConsumer(
  isDeclared: (source: string, acceptedOutcome: string) => boolean,
): AcceptedOutcomeConsumer {
  let pending: AcceptedOutcomeReceipt[] = [];
  let invalidBatch = false;
  return Object.freeze({
    capture(action: InspectedAction) {
      if (action.type !== ACCEPTED_OUTCOME_ACTION_TYPE) {
        return;
      }
      if (invalidBatch) return;
      try {
        const marker = exactMarkerParams(action.params);
        if (!isDeclared(marker.source, marker.acceptedOutcome)) {
          throw new TypeError(
            `${ACCEPTED_OUTCOME_ACTION_TYPE} names undeclared outcome ` +
              `${marker.source}.${marker.acceptedOutcome}`,
          );
        }
        pending.push(marker);
      } catch (error) {
        pending = [];
        invalidBatch = true;
        throw error;
      }
    },
    confirm(previousState: PlaybookState | undefined, state: PlaybookState) {
      if (invalidBatch) {
        pending = [];
        invalidBatch = false;
        return Object.freeze([]);
      }
      if (pending.length === 0) return Object.freeze([]);
      const captured = pending;
      pending = [];
      if (previousState === undefined) {
        throw new TypeError(
          `${ACCEPTED_OUTCOME_ACTION_TYPE} marker has no prior public root snapshot`,
        );
      }
      const seen = new Set<string>();
      for (const marker of captured) {
        const identity = marker.source;
        if (seen.has(identity)) {
          throw new TypeError(
            `${ACCEPTED_OUTCOME_ACTION_TYPE} source ${marker.source} was instrumented more than once in one action batch`,
          );
        }
        seen.add(identity);
        if (!previousState.activeStateIds.includes(marker.source)) {
          throw new TypeError(
            `${ACCEPTED_OUTCOME_ACTION_TYPE} source ${marker.source} was not confirmed by the prior public root snapshot`,
          );
        }
        if (!state.activeStateIds.includes(marker.target)) {
          throw new TypeError(
            `${ACCEPTED_OUTCOME_ACTION_TYPE} target ${marker.target} was not confirmed by the public root snapshot`,
          );
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
