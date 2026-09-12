// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type {
  BranchContext,
  PlayerInput,
  branchMachine,
} from './branch.fsm.js';

export type TransitionGuard = (args: {
  context: BranchContext;
  event: unknown;
}) => boolean;

export interface InvokingTransition {
  readonly index: number;
  readonly target: string;
  readonly guard?: TransitionGuard;
  readonly actions: unknown;
}

export interface PlayerStateInfo {
  readonly stateId: string;
  readonly sourceItem: string;
  readonly getInput: (context: BranchContext) => PlayerInput;
  readonly transitions: readonly InvokingTransition[];
}

export interface AwaitBossReplyInfo {
  readonly stateId: 'awaitBossReply';
  readonly bossReplyTransitions: readonly InvokingTransition[];
}

type RawInvoke = {
  src?: unknown;
  input?: (args: { context: BranchContext }) => PlayerInput;
  onDone?: unknown;
};

type RawState = {
  invoke?: RawInvoke;
  on?: Readonly<Record<string, unknown>>;
};

type RawArm = {
  target?: unknown;
  guard?: TransitionGuard;
  actions?: unknown;
};

type RawConfig = {
  states?: Readonly<Record<string, RawState>>;
};

function rawConfig(machine: typeof branchMachine): RawConfig {
  return (machine as unknown as { config: RawConfig }).config;
}

function arms(value: unknown): readonly RawArm[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as readonly RawArm[];
}

function targetName(target: unknown): string {
  const value = String(target ?? '');
  return value.startsWith('#') ? value.slice(1) : value;
}

function transitions(value: unknown): readonly InvokingTransition[] {
  return arms(value).map((arm, index) => ({
    index,
    target: targetName(arm.target),
    ...(arm.guard === undefined ? {} : { guard: arm.guard }),
    actions: arm.actions,
  }));
}

const EMPTY_CONTEXT: BranchContext = {};

export function enumeratePlayerStates(
  machine: typeof branchMachine,
): readonly PlayerStateInfo[] {
  const states = rawConfig(machine).states ?? {};
  return Object.entries(states).flatMap(([stateId, state]) => {
    const invoke = state.invoke;
    if (invoke?.src !== 'player' || invoke.input === undefined) return [];
    const getInput = (context: BranchContext): PlayerInput =>
      invoke.input?.({ context }) as PlayerInput;
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

export function enumerateAwaitBossReply(
  machine: typeof branchMachine,
): AwaitBossReplyInfo {
  const on = rawConfig(machine).states?.awaitBossReply?.on ?? {};
  return {
    stateId: 'awaitBossReply',
    bossReplyTransitions: transitions(on.BOSS_REPLY),
  };
}

export function enumerateRootEvents(machine: typeof branchMachine): {
  readonly startBranch: { readonly target: string };
} {
  const on = rawConfig(machine).states?.ready?.on ?? {};
  const start = arms(on.START_BRANCH)[0];
  return { startBranch: { target: targetName(start?.target) } };
}
