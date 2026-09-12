import { type XStatePlaybookRuntimeFactory, type XStatePlaybookRuntimeConstruction } from '@sublang/playbook/xstate-runtime';
import { type PlayerInput, type PrInput } from './pr.fsm.js';
import type { PlaybookHostConstructionCapabilities } from '../code.playbook/playbook-captain.js';
import type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlayerResult, PlayerSessionStore } from '@sublang/playbook/runtime';
export type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlayerResult, PlayerSessionStore, };
/**
 * PR's per-run options. The machine reads no input of its own; the one
 * linker-owned option is the working directory its five script states run
 * in (slc/link.md §Script execution). Absent, the process working directory.
 */
export type PrPlaybookOptions = PrInput & {
    readonly cwd?: string;
};
export type PrPlaybookHostCapabilities = PlaybookHostConstructionCapabilities & XStatePlaybookRuntimeConstruction<PrPlaybookOptions, object>['hostCapabilities'];
/**
 * Preserve the authored Markdown quote marker around every line of the
 * relayed caller input. The generic composer preserves the marker itself;
 * PR's override additionally keeps a multiline value inside that quote.
 */
declare function composePlayerPrompt(input: PlayerInput, resuming?: boolean): string;
export declare const _internal: {
    composePlayerPrompt: typeof composePlayerPrompt;
    VERBATIM_PAYLOAD_FIELDS: ReadonlySet<string>;
    UNFINISHED_FINAL_STATE_IDS: ReadonlySet<string>;
};
declare const createPlaybookRuntime: XStatePlaybookRuntimeFactory<XStatePlaybookRuntimeConstruction<PrPlaybookOptions, PrPlaybookHostCapabilities>, 3>;
export default createPlaybookRuntime;
