// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type {
  PlaybookInput,
  PlayerInput,
  PrContext,
  ScriptInput,
  prMachine,
} from './pr.fsm.js';

export type TransitionGuard = (args: {
  context: PrContext;
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
  readonly getInput: (context: PrContext) => PlayerInput;
  readonly transitions: readonly InvokingTransition[];
}

export interface NestedPlaybookStateInfo {
  readonly stateId: string;
  readonly sourceItem: string;
  readonly getInput: (context: PrContext) => PlaybookInput;
  readonly transitions: readonly InvokingTransition[];
}

/** A DR-016 script state: no agent, no prompt, no role — one static command. */
export interface ScriptStateInfo {
  readonly stateId: string;
  readonly sourceItem: string;
  readonly getInput: (context: PrContext) => ScriptInput;
  readonly transitions: readonly InvokingTransition[];
}

export interface AwaitBossReplyInfo {
  readonly stateId: 'awaitBossReply';
  readonly bossReplyTransitions: readonly InvokingTransition[];
}

type ActorInput = PlayerInput | PlaybookInput | ScriptInput;

type RawInvoke = {
  src?: unknown;
  input?: (args: { context: PrContext }) => ActorInput;
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

function rawConfig(machine: typeof prMachine): RawConfig {
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

const EMPTY_CONTEXT: PrContext = {};

interface InvokingStateInfo<Input extends ActorInput> {
  readonly stateId: string;
  readonly sourceItem: string;
  readonly getInput: (context: PrContext) => Input;
  readonly transitions: readonly InvokingTransition[];
}

function enumerateInvokingStates<Input extends ActorInput>(
  machine: typeof prMachine,
  src: 'player' | 'playbook' | 'script',
): readonly InvokingStateInfo<Input>[] {
  const states = rawConfig(machine).states ?? {};
  return Object.entries(states).flatMap(([stateId, state]) => {
    const invoke = state.invoke;
    if (invoke?.src !== src || invoke.input === undefined) return [];
    const getInput = (context: PrContext): Input =>
      invoke.input?.({ context }) as Input;
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

export function enumeratePlayerStates(
  machine: typeof prMachine,
): readonly PlayerStateInfo[] {
  return enumerateInvokingStates<PlayerInput>(machine, 'player');
}

export function enumerateNestedPlaybookStates(
  machine: typeof prMachine,
): readonly NestedPlaybookStateInfo[] {
  return enumerateInvokingStates<PlaybookInput>(machine, 'playbook');
}

export function enumerateScriptStates(
  machine: typeof prMachine,
): readonly ScriptStateInfo[] {
  return enumerateInvokingStates<ScriptInput>(machine, 'script');
}

export function enumerateAwaitBossReply(
  machine: typeof prMachine,
): AwaitBossReplyInfo {
  const on = rawConfig(machine).states?.awaitBossReply?.on ?? {};
  return {
    stateId: 'awaitBossReply',
    bossReplyTransitions: transitions(on.BOSS_REPLY),
  };
}

export function enumerateRootEvents(machine: typeof prMachine): {
  readonly startPr: { readonly target: string };
} {
  const on = rawConfig(machine).states?.ready?.on ?? {};
  const start = arms(on.START_PR)[0];
  return { startPr: { target: targetName(start?.target) } };
}
