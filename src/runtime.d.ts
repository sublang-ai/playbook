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
export type PlaybookRuntimeFactory<Options = unknown> = (options: Options) => PlaybookRuntime;
