import { type PlayerInput, type PlayerOutput, type CodingEvent, type CodingInput } from './code.fsm.js';
import type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookPendingCall, PlaybookRunResult, PlaybookRuntimeSnapshot, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlaybookPorts, PlaybookRuntime, PlaybookRuntimeFactory, PlayerResult } from '@sublang/playbook/runtime';
export type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookPendingCall, PlaybookRunResult, PlayerResult, PlaybookPorts, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlaybookTraceType, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookRuntimeSnapshot, };
export type CodePlaybookOptions = CodingInput;
declare function normalizeErrorCompact(err: unknown): {
    name: string;
    message: string;
} | undefined;
declare function normalizeErrorFull(err: unknown): {
    name: string;
    message: string;
    stack?: string;
} | undefined;
declare function normalizeEventForTelemetry(event: unknown): unknown;
declare function composePlayerPrompt(input: PlayerInput): string;
declare function resolvePlayerId(input: PlayerInput): string;
type JudgePurpose = 'boss-input-classification' | 'player-output-adjudication';
interface RuntimeBoundaryCalls {
    callPlayer(input: PlayerInput, playerId: string, prompt: string, signal: AbortSignal): Promise<PlayerResult>;
    callJudge(purpose: JudgePurpose, stateId: string | undefined, prompt: string, signal: AbortSignal): Promise<string>;
}
declare function adjudicate(input: PlayerInput, finalText: string, ports: PlaybookPorts, signal: AbortSignal, boundary?: RuntimeBoundaryCalls): Promise<PlayerOutput>;
declare function classifyBossText(text: string, ports: PlaybookPorts, signal: AbortSignal, snapshotOrState?: unknown, boundary?: RuntimeBoundaryCalls): Promise<CodingEvent | undefined>;
declare function captainBridge(ports: PlaybookPorts, getActiveSignal?: () => AbortSignal | undefined, boundary?: RuntimeBoundaryCalls, onControlPlaneError?: (error: unknown) => void): import("xstate").PromiseActorLogic<import("./code.fsm.js").CaptainOutput, PlayerInput, import("xstate").EventObject>;
interface StateMetadata {
    player: PlayerInput['player'];
    sourceItem: string;
    label: string;
}
type BossReplyQuestionId = NonNullable<Extract<CodingEvent, {
    type: 'BOSS_REPLY';
}>['questionId']>;
interface PendingBossQuestionForStatus {
    questionId: BossReplyQuestionId;
    resumeStateId: string;
    sourceItem: string;
    player: string;
    question: string;
}
declare function pendingBossQuestionFromContext(context: Record<string, unknown>): PendingBossQuestionForStatus | undefined;
declare function formatAwaitBossReplyQuestion(context: Record<string, unknown>): string;
declare function formatAwaitBossReplyMarker(context: Record<string, unknown>): string;
declare function formatStateEntry(stateId: string): string | undefined;
declare function formatTransition(event: unknown): string | undefined;
declare function formatClassification(eventType: string): string;
declare function stateTelemetryPayload(from: unknown, to: string, event: unknown, context: Record<string, unknown>): Record<string, unknown>;
export declare const _internal: {
    composePlayerPrompt: typeof composePlayerPrompt;
    resolvePlayerId: typeof resolvePlayerId;
    adjudicate: typeof adjudicate;
    classifyBossText: typeof classifyBossText;
    captainBridge: typeof captainBridge;
    STATE_LABELS: Readonly<Record<string, string>>;
    stateMetadata: ReadonlyMap<string, StateMetadata>;
    pendingBossQuestionFromContext: typeof pendingBossQuestionFromContext;
    formatAwaitBossReplyQuestion: typeof formatAwaitBossReplyQuestion;
    formatAwaitBossReplyMarker: typeof formatAwaitBossReplyMarker;
    formatStateEntry: typeof formatStateEntry;
    formatTransition: typeof formatTransition;
    formatClassification: typeof formatClassification;
    stateTelemetryPayload: typeof stateTelemetryPayload;
    normalizeErrorCompact: typeof normalizeErrorCompact;
    normalizeErrorFull: typeof normalizeErrorFull;
    normalizeEventForTelemetry: typeof normalizeEventForTelemetry;
    VERBATIM_PAYLOAD_FIELDS: ReadonlySet<string>;
};
export default function createPlaybookRuntime(options: CodePlaybookOptions): PlaybookRuntime;
