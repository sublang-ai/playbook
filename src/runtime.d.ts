export interface PlayerResult {
    status: 'ok' | 'aborted' | 'error';
    resumeToken?: string;
    finalText?: string;
    error?: string;
}
export interface PlayerCallOptions {
    resume: string | false;
}
export interface PlaybookPorts {
    callPlayer(playerId: string, prompt: string, signal: AbortSignal, options: PlayerCallOptions): Promise<PlayerResult>;
    callJudge(prompt: string, signal: AbortSignal): Promise<string>;
    emitStatus(message: string, data?: unknown): Promise<void>;
    emitTelemetry(event: {
        topic: string;
        payload: unknown;
    }): Promise<void>;
}
export interface PlaybookSession {
    sessionId: string;
    playbookId: string;
    ports: PlaybookPorts;
}
export type PlaybookTraceType = 'session.started' | 'boss.input.received' | 'judge.call.started' | 'judge.call.finished' | 'player.call.started' | 'player.call.finished' | 'fsm.transition' | 'status.emitted' | 'boss.input.settled' | 'session.disposed';
export interface PlaybookTraceEvent {
    schemaVersion: 1;
    sessionId: string;
    playbookId: string;
    sequence: number;
    timestamp: number;
    type: PlaybookTraceType;
    turnId?: number;
    callId?: string;
    payload: unknown;
}
export interface PlaybookRuntime {
    init(session: PlaybookSession): Promise<void>;
    handleBossInput(turn: {
        text: string;
        signal: AbortSignal;
    }): Promise<void>;
    dispose(): Promise<void>;
}
export type PlaybookRuntimeFactory<Options = unknown> = (options: Options) => PlaybookRuntime;
