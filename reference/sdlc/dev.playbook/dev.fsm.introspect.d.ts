import type { DevContext, PlaybookInput, PlayerInput, devMachine } from './dev.fsm.js';
export type TransitionGuard = (args: {
    context: DevContext;
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
    readonly getInput: (context: DevContext) => PlayerInput;
    readonly transitions: readonly InvokingTransition[];
}
export interface NestedPlaybookStateInfo {
    readonly stateId: string;
    readonly sourceItem: string;
    readonly getInput: (context: DevContext) => PlaybookInput;
    readonly transitions: readonly InvokingTransition[];
}
export interface AwaitBossReplyInfo {
    readonly stateId: 'awaitBossReply';
    readonly bossReplyTransitions: readonly InvokingTransition[];
}
export declare function enumeratePlayerStates(machine: typeof devMachine): readonly PlayerStateInfo[];
export declare function enumerateNestedPlaybookStates(machine: typeof devMachine): readonly NestedPlaybookStateInfo[];
export declare function enumerateAwaitBossReply(machine: typeof devMachine): AwaitBossReplyInfo;
export declare function enumerateRootEvents(machine: typeof devMachine): {
    readonly startDev: {
        readonly target: string;
    };
};
