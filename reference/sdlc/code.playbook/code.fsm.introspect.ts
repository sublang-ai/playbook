// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type {
  CodingContext,
  PlaybookInput,
  PlayerInput,
  codingMachine,
} from './code.fsm.js';

export type TransitionGuard = (args: {
  context: CodingContext;
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
  readonly getInput: (context: CodingContext) => PlayerInput;
  readonly transitions: readonly InvokingTransition[];
}

export interface NestedPlaybookStateInfo {
  readonly stateId: string;
  readonly sourceItem: string;
  readonly getInput: (context: CodingContext) => PlaybookInput;
  readonly transitions: readonly InvokingTransition[];
}

export interface AwaitBossReplyInfo {
  readonly stateId: 'awaitBossReply';
  readonly bossReplyTransitions: readonly InvokingTransition[];
}

type RawInvoke = {
  src?: unknown;
  input?: (args: { context: CodingContext }) => PlayerInput | PlaybookInput;
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

function rawConfig(machine: typeof codingMachine): RawConfig {
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

export function enumeratePlayerStates(
  machine: typeof codingMachine,
): readonly PlayerStateInfo[] {
  const states = rawConfig(machine).states ?? {};
  return Object.entries(states).flatMap(([stateId, state]) => {
    const invoke = state.invoke;
    if (invoke?.src !== 'player' || invoke.input === undefined) return [];
    const getInput = (context: CodingContext): PlayerInput =>
      invoke.input?.({ context }) as PlayerInput;
    const input = getInput({ coderPlayer: 'Coder', runResults: '' });
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

// Backward-compatible internal name retained for repository conformance tools.
export const enumerateCaptainStates = enumeratePlayerStates;

export function enumerateNestedPlaybookStates(
  machine: typeof codingMachine,
): readonly NestedPlaybookStateInfo[] {
  const states = rawConfig(machine).states ?? {};
  return Object.entries(states).flatMap(([stateId, state]) => {
    const invoke = state.invoke;
    if (invoke?.src !== 'playbook' || invoke.input === undefined) return [];
    const getInput = (context: CodingContext): PlaybookInput =>
      invoke.input?.({ context }) as PlaybookInput;
    const input = getInput({ coderPlayer: 'Coder', runResults: '' });
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
  machine: typeof codingMachine,
): AwaitBossReplyInfo {
  const on = rawConfig(machine).states?.awaitBossReply?.on ?? {};
  return {
    stateId: 'awaitBossReply',
    bossReplyTransitions: transitions(on.BOSS_REPLY),
  };
}

export function enumerateRootEvents(machine: typeof codingMachine): {
  readonly startCode: { readonly target: string };
} {
  const on = rawConfig(machine).states?.ready?.on ?? {};
  const start = arms(on.START_CODE)[0];
  return { startCode: { target: targetName(start?.target) } };
}
