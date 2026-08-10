import type { CodingContext, PlaybookInput, PlayerInput, codingMachine } from './code.fsm.js';
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
export declare function enumeratePlayerStates(machine: typeof codingMachine): readonly PlayerStateInfo[];
export declare const enumerateCaptainStates: typeof enumeratePlayerStates;
export declare function enumerateNestedPlaybookStates(machine: typeof codingMachine): readonly NestedPlaybookStateInfo[];
export declare function enumerateAwaitBossReply(machine: typeof codingMachine): AwaitBossReplyInfo;
export declare function enumerateRootEvents(machine: typeof codingMachine): {
    readonly startCode: {
        readonly target: string;
    };
};
