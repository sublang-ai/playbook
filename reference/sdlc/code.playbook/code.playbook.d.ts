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
declare function adjudicate(_input: CaptainInput, _finalText: string, _ports: PlaybookPorts, _signal: AbortSignal): Promise<CaptainOutput>;
declare function classifyBossText(_text: string, _ports: PlaybookPorts, _signal: AbortSignal): Promise<CodingEvent | undefined>;
declare function captainBridge(_ports: PlaybookPorts): import("xstate").PromiseActorLogic<never, import("xstate").NonReducibleUnknown, import("xstate").EventObject>;
export declare const _internal: {
    composePlayerPrompt: typeof composePlayerPrompt;
    resolvePlayerId: typeof resolvePlayerId;
    adjudicate: typeof adjudicate;
    classifyBossText: typeof classifyBossText;
    captainBridge: typeof captainBridge;
};
export default function createPlaybookRuntime(options: CodePlaybookOptions): PlaybookRuntime;
export {};
