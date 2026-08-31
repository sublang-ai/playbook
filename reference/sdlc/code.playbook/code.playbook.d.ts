import { type XStatePlaybookRuntimeFactory, type XStatePlaybookRuntimeConstruction, type XStatePromptIdentity } from '@sublang/playbook/xstate-runtime';
import { type CodingInput, type PlayerInput } from './code.fsm.js';
import type { PlaybookHostConstructionCapabilities } from './playbook-captain.js';
import type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlayerResult, PlayerSessionStore } from '@sublang/playbook/runtime';
export type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlayerResult, PlayerSessionStore, };
export type CodePlaybookOptions = CodingInput;
export type CodePlaybookHostCapabilities = PlaybookHostConstructionCapabilities & XStatePlaybookRuntimeConstruction<CodePlaybookOptions, object>['hostCapabilities'];
/**
 * Preserve authored Markdown quote markers around every line of relayed
 * runtime text. The generic composer preserves the marker itself; CODE's
 * override additionally keeps a multiline value inside that quote.
 */
declare function composePlayerPrompt(input: PlayerInput, promptIdentity: XStatePromptIdentity): string;
export declare const _internal: {
    composePlayerPrompt: typeof composePlayerPrompt;
    VERBATIM_PAYLOAD_FIELDS: ReadonlySet<string>;
    UNFINISHED_FINAL_STATE_IDS: ReadonlySet<string>;
};
declare const createPlaybookRuntime: XStatePlaybookRuntimeFactory<XStatePlaybookRuntimeConstruction<CodePlaybookOptions, CodePlaybookHostCapabilities>, 3>;
export default createPlaybookRuntime;
