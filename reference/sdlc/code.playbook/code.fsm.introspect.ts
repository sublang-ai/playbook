// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// FSM introspection helpers — IR-005 Task 2.
// Static walkers over `codingMachine.config` consumed by the
// conformance, coverage, and prompt-contract tests landing in
// Tasks 3–5. Reaching into `machine.config` is internal but stable
// in xstate v5: it preserves the literal `createMachine` argument,
// so `invoke.input` is still the original `({ context }) =>
// CaptainInput` function and `invoke.onDone` is still the per-arm
// array with `guard` / `target` / `actions` keys.

import type {
  CaptainInput,
  CodingContext,
  codingMachine,
} from './code.fsm.js';

export interface CaptainStateInfo {
  readonly stateId: string;
  readonly sourceItem: string;
  readonly getInput: (context: Partial<CodingContext>) => CaptainInput;
  readonly transitions: ReadonlyArray<CaptainTransition>;
}

export interface CaptainTransition {
  // Position in the state's `invoke.onDone` array. Stable per FSM
  // source — the coverage test's fixture table keys
  // `(stateId, index)` to address each arm uniquely, since
  // `(stateId, target)` collides for arms that share a target
  // (e.g., `commitReviewerCleared` and `commitJoint` each route
  // both `committed && afterReview === 'done'` and
  // `noRelevantChanges` to `done`).
  readonly index: number;
  readonly target: string;
  readonly guard: TransitionGuard;
  readonly actions: unknown;
}

export interface AwaitBossReplyInfo {
  readonly stateId: string;
  readonly bossReplyTransitions: ReadonlyArray<BossReplyTransition>;
  readonly transitions: ReadonlyArray<AwaitBossReplyTransition>;
}

export interface BossReplyTransition {
  readonly index: number;
  readonly target: string;
  readonly guard: TransitionGuard;
  readonly actions: unknown;
}

export interface AwaitBossReplyTransition {
  readonly eventType: string;
  readonly index: number;
  readonly target: string;
  readonly guard: TransitionGuard;
  readonly actions: unknown;
}

export type TransitionGuard = (args: {
  context: CodingContext;
  event: unknown;
}) => boolean;

export interface RootEventTable {
  readonly startCoding: { readonly target: string };
  readonly continueIr: { readonly target: string };
  readonly summarizeIr: { readonly target: string };
  readonly bossInterruptTargets: ReadonlyArray<string>;
  readonly bossInterruptTargetDescriptions: ReadonlyArray<{
    readonly stateId: string;
    readonly description: string;
  }>;
}

type RawInvoke = {
  src?: unknown;
  input?: (args: { context: Partial<CodingContext> }) => CaptainInput;
  onDone?: unknown;
};

type RawStateDef = {
  description?: unknown;
  invoke?: RawInvoke;
  on?: Record<string, unknown>;
};

type RawArm = { target?: unknown; guard?: TransitionGuard };
type RawArmWithActions = RawArm & { actions?: unknown };

type RawConfig = {
  states?: Record<string, RawStateDef>;
  on?: Record<string, unknown>;
};

export function enumerateCaptainStates(
  machine: typeof codingMachine,
): readonly CaptainStateInfo[] {
  const states = getRawConfig(machine).states ?? {};
  const out: CaptainStateInfo[] = [];
  for (const [stateId, def] of Object.entries(states)) {
    const invoke = def.invoke;
    if (!invoke || invoke.src !== 'captain' || typeof invoke.input !== 'function') {
      continue;
    }
    const inputFn = invoke.input;
    const getInput = (context: Partial<CodingContext>): CaptainInput =>
      inputFn({ context });
    const probe = getInput({});
    const transitions = toArmArray(invoke.onDone).map(
      (arm, index): CaptainTransition => ({
        index,
        target: stripIdPrefix(String(arm.target ?? '')),
        guard: arm.guard ?? alwaysTrue,
        actions: arm.actions,
      }),
    );
    out.push({
      stateId,
      sourceItem: probe.sourceItem,
      getInput,
      transitions,
    });
  }
  return out;
}

export function enumerateRootEvents(
  machine: typeof codingMachine,
): RootEventTable {
  const cfg = getRawConfig(machine);
  const readyOn = (cfg.states?.ready?.on ?? {}) as Record<
    string,
    { target?: string }
  >;
  const rootOn = (cfg.on ?? {}) as Record<string, unknown>;
  const bossInterruptTargets = toArmArray(rootOn.BOSS_INTERRUPT).map((arm) =>
    stripIdPrefix(String(arm.target ?? '')),
  );
  return {
    startCoding: { target: stripIdPrefix(String(readyOn.START_CODING?.target ?? '')) },
    continueIr: { target: stripIdPrefix(String(readyOn.CONTINUE_IR?.target ?? '')) },
    summarizeIr: { target: stripIdPrefix(String(readyOn.SUMMARIZE_IR?.target ?? '')) },
    bossInterruptTargets,
    bossInterruptTargetDescriptions: bossInterruptTargets.map((stateId) => {
      const description = cfg.states?.[stateId]?.description;
      return {
        stateId,
        description: typeof description === 'string' ? description : '',
      };
    }),
  };
}

export function enumerateAwaitBossReply(
  machine: typeof codingMachine,
): AwaitBossReplyInfo {
  const stateId = 'awaitBossReply';
  const awaitOn = getRawConfig(machine).states?.[stateId]?.on ?? {};
  const transitions = Object.entries(awaitOn).flatMap(([eventType, value]) =>
    toArmArray(value).map(
      (arm, index): AwaitBossReplyTransition => ({
        eventType,
        index,
        target: stripIdPrefix(String(arm.target ?? '')),
        guard: arm.guard ?? alwaysTrue,
        actions: arm.actions,
      }),
    ),
  );
  const bossReplyTransitions = toArmArray(awaitOn.BOSS_REPLY).map(
    (arm, index): BossReplyTransition => ({
      index,
      target: stripIdPrefix(String(arm.target ?? '')),
      guard: arm.guard ?? alwaysTrue,
      actions: arm.actions,
    }),
  );
  return { stateId, bossReplyTransitions, transitions };
}

function getRawConfig(machine: typeof codingMachine): RawConfig {
  return (machine as unknown as { config: RawConfig }).config;
}

function toArmArray(value: unknown): RawArmWithActions[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as RawArmWithActions[];
}

function stripIdPrefix(target: string): string {
  return target.startsWith('#') ? target.slice(1) : target;
}

const alwaysTrue: TransitionGuard = () => true;
