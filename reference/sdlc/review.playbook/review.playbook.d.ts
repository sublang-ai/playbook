import { type XStatePromptIdentity } from '@sublang/playbook/xstate-runtime';
import { type PlayerInput, type ReviewInput } from './review.fsm.js';
import type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlayerResult, PlayerSessionStore } from '@sublang/playbook/runtime';
export type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlayerResult, PlayerSessionStore, };
export type ReviewPlaybookOptions = ReviewInput;
/** Keep every line of a relayed runtime value inside its authored quote. */
declare function composePlayerPrompt(input: PlayerInput, promptIdentity: XStatePromptIdentity): string;
export declare const _internal: {
    composePlayerPrompt: typeof composePlayerPrompt;
    VERBATIM_PAYLOAD_FIELDS: ReadonlySet<string>;
    UNFINISHED_FINAL_STATE_IDS: ReadonlySet<string>;
};
declare const createPlaybookRuntime: PlaybookRuntimeFactory<ReviewPlaybookOptions>;
export default createPlaybookRuntime;
