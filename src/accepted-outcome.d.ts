import type { PlaybookState } from './runtime.js';
export declare const ACCEPTED_OUTCOME_ACTION_TYPE = "playbook.acceptedOutcome";
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
    confirm(previousState: PlaybookState | undefined, state: PlaybookState): readonly AcceptedOutcomeReceipt[];
    reset(): void;
}
export declare function createAcceptedOutcomeConsumer(isDeclared: (source: string, acceptedOutcome: string) => boolean): AcceptedOutcomeConsumer;
export {};
