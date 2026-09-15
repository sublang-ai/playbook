import { type PlaybookPlayerInput, type XStatePlaybookRuntimeFactory, type XStatePlaybookRuntimeConstruction } from '@sublang/playbook/xstate-runtime';
import { type DevInput } from './dev.fsm.js';
import type { PlaybookHostConstructionCapabilities } from '../code.playbook/playbook-captain.js';
import type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlayerResult, PlayerSessionStore } from '@sublang/playbook/runtime';
export type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlayerResult, PlayerSessionStore, };
export type DevPlaybookOptions = DevInput;
export type DevPlaybookHostCapabilities = PlaybookHostConstructionCapabilities & XStatePlaybookRuntimeConstruction<DevPlaybookOptions, object>['hostCapabilities'];
export declare const _internal: {
    composePlayerPrompt: (input: PlaybookPlayerInput, _identity: import("@sublang/playbook/xstate-runtime").XStatePromptIdentity, resuming?: boolean) => string;
    VERBATIM_PAYLOAD_FIELDS: ReadonlySet<string>;
    UNFINISHED_FINAL_STATE_IDS: ReadonlySet<string>;
};
declare const createPlaybookRuntime: XStatePlaybookRuntimeFactory<XStatePlaybookRuntimeConstruction<DevPlaybookOptions, DevPlaybookHostCapabilities>, 3>;
export default createPlaybookRuntime;
