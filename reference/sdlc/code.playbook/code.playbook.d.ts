import { type CaptainInput, type CaptainOutput, type CodingEvent, type CodingInput } from './code.fsm.js';
import type { PlaybookSession, PlaybookPorts, PlaybookRuntime, PlayerResult } from '@sublang/playbook/runtime';
export type { PlayerResult, PlaybookPorts, PlaybookSession, PlaybookRuntime, };
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
declare function composePlayerPrompt(input: CaptainInput): string;
declare function resolvePlayerId(input: CaptainInput): string;
type JudgePurpose = 'boss-input-classification' | 'player-output-adjudication';
interface RuntimeBoundaryCalls {
    callPlayer(input: CaptainInput, playerId: string, prompt: string, signal: AbortSignal): Promise<PlayerResult>;
    callJudge(purpose: JudgePurpose, stateId: string | undefined, prompt: string, signal: AbortSignal): Promise<string>;
}
declare function adjudicate(input: CaptainInput, finalText: string, ports: PlaybookPorts, signal: AbortSignal, boundary?: RuntimeBoundaryCalls): Promise<CaptainOutput>;
declare function classifyBossText(text: string, ports: PlaybookPorts, signal: AbortSignal, snapshotOrState?: unknown, boundary?: RuntimeBoundaryCalls): Promise<CodingEvent | undefined>;
declare function captainBridge(ports: PlaybookPorts, getActiveSignal?: () => AbortSignal | undefined, boundary?: RuntimeBoundaryCalls): import("xstate").PromiseActorLogic<CaptainOutput, CaptainInput, import("xstate").EventObject>;
interface StateMetadata {
    player: CaptainInput['player'];
    sourceItem: string;
    label: string;
}
interface PendingBossQuestionForStatus {
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
