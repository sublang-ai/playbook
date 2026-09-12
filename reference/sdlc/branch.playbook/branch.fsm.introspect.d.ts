import type { BranchContext, PlayerInput, branchMachine } from './branch.fsm.js';
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
export declare function enumeratePlayerStates(machine: typeof branchMachine): readonly PlayerStateInfo[];
export declare function enumerateAwaitBossReply(machine: typeof branchMachine): AwaitBossReplyInfo;
export declare function enumerateRootEvents(machine: typeof branchMachine): {
    readonly startBranch: {
        readonly target: string;
    };
};
