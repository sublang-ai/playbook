import type { PlaybookInput, PlayerInput, PrContext, ScriptInput, prMachine } from './pr.fsm.js';
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
export declare function enumeratePlayerStates(machine: typeof prMachine): readonly PlayerStateInfo[];
export declare function enumerateNestedPlaybookStates(machine: typeof prMachine): readonly NestedPlaybookStateInfo[];
export declare function enumerateScriptStates(machine: typeof prMachine): readonly ScriptStateInfo[];
export declare function enumerateAwaitBossReply(machine: typeof prMachine): AwaitBossReplyInfo;
export declare function enumerateRootEvents(machine: typeof prMachine): {
    readonly startPr: {
        readonly target: string;
    };
};
