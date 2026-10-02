import { type XStatePromptIdentity, type PlaybookPlayerInput, type XStatePlaybookRuntimeConstruction, type XStatePlaybookRuntimeFactory } from '@sublang/playbook/xstate-runtime';
export type { PlayerResult, PlayerCallOptions, PlayerSessionStore, CaptainResult, CaptainCallOptions, JsonValue, NormalizedError, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookStateValue, PlaybookState, PlaybookPendingCall, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookPorts, PlaybookTraceEvent, PlaybookTraceType, PlaybookControlReceipt, PlaybookControlView, } from '@sublang/playbook/runtime';
export interface PlaybookRuntimeOptions {
    readonly "discussionContext"?: string;
}
export type PlaybookHostCapabilities = XStatePlaybookRuntimeConstruction<PlaybookRuntimeOptions, {
    readonly authority: object;
}>['hostCapabilities'];
export declare function validateOptions(value: unknown): PlaybookRuntimeOptions;
export declare const _internal: {
    composePlayerPrompt: (input: PlaybookPlayerInput, promptIdentity: XStatePromptIdentity, resuming?: boolean) => string;
    RESUMABLE_STATE_IDS: ReadonlySet<string>;
    UNFINISHED_FINAL_STATE_IDS: ReadonlySet<string>;
    VERBATIM_PAYLOAD_FIELDS: ReadonlySet<string>;
};
declare const createPlaybookRuntime: XStatePlaybookRuntimeFactory<XStatePlaybookRuntimeConstruction<PlaybookRuntimeOptions, PlaybookHostCapabilities>, 3>;
export default createPlaybookRuntime;
