import { type CaptainInput, type CaptainOutput, type CodingEvent, type CodingInput } from './code.fsm.js';
export interface PlayerResult {
    status: 'ok' | 'aborted' | 'error';
    finalText?: string;
    error?: string;
}
export interface PlaybookPorts {
    callPlayer(playerId: string, prompt: string, signal: AbortSignal): Promise<PlayerResult>;
    callJudge(prompt: string, signal: AbortSignal): Promise<string>;
    emitStatus(message: string, data?: unknown): Promise<void>;
    emitTelemetry(event: {
        topic: string;
        payload: unknown;
    }): Promise<void>;
}
export interface PlaybookRuntime {
    init(ports: PlaybookPorts): Promise<void>;
    handleBossInput(turn: {
        text: string;
        signal: AbortSignal;
    }): Promise<void>;
    dispose(): Promise<void>;
}
export type CodePlaybookOptions = CodingInput;
declare function composePlayerPrompt(input: CaptainInput): string;
declare function resolvePlayerId(input: CaptainInput): string;
declare function adjudicate(input: CaptainInput, finalText: string, ports: PlaybookPorts, signal: AbortSignal): Promise<CaptainOutput>;
declare function classifyBossText(text: string, ports: PlaybookPorts, signal: AbortSignal, snapshotOrState?: unknown): Promise<CodingEvent | undefined>;
declare function captainBridge(ports: PlaybookPorts, getActiveSignal?: () => AbortSignal | undefined): import("xstate").PromiseActorLogic<CaptainOutput, CaptainInput, import("xstate").EventObject>;
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
declare function formatAwaitBossReplyEntry(context: Record<string, unknown>): string;
declare function formatStateEntry(stateId: string, context?: Record<string, unknown>): string | undefined;
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
    formatAwaitBossReplyEntry: typeof formatAwaitBossReplyEntry;
    formatStateEntry: typeof formatStateEntry;
    formatTransition: typeof formatTransition;
    formatClassification: typeof formatClassification;
    stateTelemetryPayload: typeof stateTelemetryPayload;
};
export default function createPlaybookRuntime(options: CodePlaybookOptions): PlaybookRuntime;
export {};
