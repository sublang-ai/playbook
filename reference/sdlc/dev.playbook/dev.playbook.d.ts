import { type XStatePlaybookRuntimeFactory, type XStatePlaybookRuntimeConstruction } from '@sublang/playbook/xstate-runtime';
import { type DevInput, type PlayerInput } from './dev.fsm.js';
import type { PlaybookHostConstructionCapabilities } from '../code.playbook/playbook-captain.js';
import type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlayerResult, PlayerSessionStore } from '@sublang/playbook/runtime';
export type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlayerResult, PlayerSessionStore, };
export type DevPlaybookOptions = DevInput;
export type DevPlaybookHostCapabilities = PlaybookHostConstructionCapabilities & XStatePlaybookRuntimeConstruction<DevPlaybookOptions, object>['hostCapabilities'];
/**
 * Preserve authored Markdown quote markers around every line of relayed
 * runtime text. The generic composer preserves the marker itself; DEV's
 * override additionally keeps a multiline value inside that quote and drops
 * the optional relays that have no value yet.
 */
declare function composePlayerPrompt(input: PlayerInput): string;
export declare const _internal: {
    composePlayerPrompt: typeof composePlayerPrompt;
    VERBATIM_PAYLOAD_FIELDS: ReadonlySet<string>;
    UNFINISHED_FINAL_STATE_IDS: ReadonlySet<string>;
};
declare const createPlaybookRuntime: XStatePlaybookRuntimeFactory<XStatePlaybookRuntimeConstruction<DevPlaybookOptions, DevPlaybookHostCapabilities>, 3>;
export default createPlaybookRuntime;
