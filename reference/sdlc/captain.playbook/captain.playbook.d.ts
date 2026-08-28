import { normalizeError, type ScheduledStatus } from '../../../src/xstate-runtime.js';
import { type CaptainInput, type DecisionAction, type EnabledPlaybook, type ParsedActingDecision, type SettlementEvidence, type SettlementReceiptEvidence } from './captain.fsm.js';
import type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookRunResult, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlaybookPorts, PlaybookRuntime, PlaybookRuntimeFactory, PlayerResult } from '@sublang/playbook/runtime';
export type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookControlReceipt, PlaybookControlView, PlaybookPendingCall, PlaybookRunResult, PlayerResult, PlaybookPorts, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, };
export type { DecisionAction, EnabledPlaybook, ParsedActingDecision, SettlementEvidence, SettlementReceiptEvidence, };
/** One nonempty complete standalone request selected for `start` or `switch`. */
export type CaptainControllerInput = string;
/** One validated controller selection submitted through the port (DR-029, DR-038). */
export type CaptainControllerSelection = {
    readonly action: 'respond';
    readonly text: string;
} | {
    readonly action: 'resume';
    readonly playbookId: string;
} | {
    readonly action: 'start' | 'switch';
    readonly playbookId: string;
    /** Complete standalone request synthesized from the remembered Boss conversation. */
    readonly input: CaptainControllerInput;
} | {
    readonly action: 'dismiss';
} | {
    readonly action: 'deliver';
} | {
    readonly action: 'runtime';
    readonly actionId: string;
};
/**
 * The host's deterministic per-turn resolution (CAPTAIN-7 parse table):
 * `undefined` sends the turn to the hidden decision call; `respond` routes
 * the dedicated prose item; `action` injects the parse-resolved decision
 * object; `shutdown` is the host teardown entry to the machine's one final
 * state.
 */
export type CaptainParsedResolution = {
    readonly kind: 'respond';
} | {
    readonly kind: 'action';
    readonly decision: ParsedActingDecision;
} | {
    readonly kind: 'shutdown';
};
/**
 * The host-supplied controller port (CAPPLAY-9, DR-029): one validated
 * selection per Boss turn in, its settlement back as the only evidence of
 * effects. The optional `resolveParsedTurn` member supplies the host's
 * deterministic command-parse resolution for the entry mapping.
 */
export interface CaptainControllerPort {
    submit(selection: CaptainControllerSelection, signal: AbortSignal): Promise<SettlementEvidence>;
    resolveParsedTurn?(text: string): CaptainParsedResolution | undefined;
}
export interface PlaybookRuntimeOptions {
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
    /**
     * The host-supplied controller port. Every Boss turn settles through it
     * (CAPPLAY-9), so it is declared required. It was optional here only until
     * the IR-036 task-4 shell rework landed; that rework has landed and the
     * shell now supplies the port on every construction, so a declaration that
     * still admitted its absence typechecked a runtime that cannot settle a
     * single turn.
     */
    readonly controller: CaptainControllerPort;
}
/**
 * The validated option record the engine carries. It differs from the public
 * declaration in exactly one place: `controller` is optional here, because a
 * construction from untyped JavaScript can still omit it and the shape has to
 * describe what validation actually accepts. Where that ends is
 * `requireControllerPort` — the first Boss turn, with a named error rather
 * than a silent one.
 */
type ValidatedCaptainOptions = Omit<PlaybookRuntimeOptions, 'controller'> & {
    readonly controller?: CaptainControllerPort;
};
declare function validateParsedActingDecision(value: unknown): ParsedActingDecision;
declare function classifyControllerTurn(text: string, _ports: PlaybookPorts, _signal: AbortSignal, _snapshotOrState: unknown, _boundary?: unknown, options?: ValidatedCaptainOptions): Promise<Record<string, unknown> | undefined>;
declare function correctiveDecisionPrompt(prompt: string, reason: string): string;
type DecisionReplyReading = {
    readonly selection: CaptainControllerSelection;
    readonly reason?: undefined;
} | {
    readonly selection?: undefined;
    readonly reason: string;
};
declare function readDecisionReply(reply: string, options: ValidatedCaptainOptions, selfPlaybookId: string, declaredActions: ReadonlySet<string>): DecisionReplyReading;
declare function validateSettlement(value: unknown): SettlementEvidence;
declare function statusesForState(state: PlaybookState, context: Record<string, unknown>): ScheduledStatus[];
export declare const _internal: {
    composeCaptainPrompt: (input: CaptainInput) => string;
    classifyControllerTurn: typeof classifyControllerTurn;
    readDecisionReply: typeof readDecisionReply;
    correctiveDecisionPrompt: typeof correctiveDecisionPrompt;
    validateSettlement: typeof validateSettlement;
    validateParsedActingDecision: typeof validateParsedActingDecision;
    statusesForState: typeof statusesForState;
    normalizeError: typeof normalizeError;
    UNFINISHED_FINAL_STATE_IDS: ReadonlySet<string>;
};
export declare function createPlaybookRuntime(options: PlaybookRuntimeOptions): PlaybookRuntime;
declare const factory: PlaybookRuntimeFactory<PlaybookRuntimeOptions>;
export default factory;
