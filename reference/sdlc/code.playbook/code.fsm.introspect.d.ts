import type { CaptainInput, CodingContext, codingMachine } from './code.fsm.js';
export interface CaptainStateInfo {
    readonly stateId: string;
    readonly sourceItem: string;
    readonly getInput: (context: Partial<CodingContext>) => CaptainInput;
    readonly transitions: ReadonlyArray<CaptainTransition>;
}
export interface CaptainTransition {
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
    readonly startCoding: {
        readonly target: string;
    };
    readonly continueIr: {
        readonly target: string;
    };
    readonly summarizeIr: {
        readonly target: string;
    };
    readonly bossInterruptTargets: ReadonlyArray<string>;
}
export declare function enumerateCaptainStates(machine: typeof codingMachine): readonly CaptainStateInfo[];
export declare function enumerateRootEvents(machine: typeof codingMachine): RootEventTable;
export declare function enumerateAwaitBossReply(machine: typeof codingMachine): AwaitBossReplyInfo;
