import { type XStatePlaybookRuntimeFactory, type XStatePlaybookRuntimeConstruction } from '@sublang/playbook/xstate-runtime';
import { type BranchInput, type PlayerInput } from './branch.fsm.js';
import type { PlaybookHostConstructionCapabilities } from '../code.playbook/playbook-captain.js';
import type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlayerResult, PlayerSessionStore } from '@sublang/playbook/runtime';
export type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlayerResult, PlayerSessionStore, };
export type BranchPlaybookOptions = BranchInput;
export type BranchPlaybookHostCapabilities = PlaybookHostConstructionCapabilities & XStatePlaybookRuntimeConstruction<BranchPlaybookOptions, object>['hostCapabilities'];
/**
 * Preserve authored Markdown quote markers around every line of relayed
 * runtime text. The generic composer preserves the marker itself; BRANCH's
 * override additionally keeps a multiline caller input inside that quote.
 */
declare function composePlayerPrompt(input: PlayerInput, resuming?: boolean): string;
export declare const _internal: {
    composePlayerPrompt: typeof composePlayerPrompt;
    VERBATIM_PAYLOAD_FIELDS: ReadonlySet<string>;
    UNFINISHED_FINAL_STATE_IDS: ReadonlySet<string>;
};
declare const createPlaybookRuntime: XStatePlaybookRuntimeFactory<XStatePlaybookRuntimeConstruction<BranchPlaybookOptions, BranchPlaybookHostCapabilities>, 3>;
export default createPlaybookRuntime;
