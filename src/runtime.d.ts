export interface PlayerResult {
    status: 'ok' | 'aborted' | 'error';
    resumeToken?: string;
    finalText?: string;
    error?: string;
}
export interface PlayerCallOptions {
    resume: string | false;
}
export interface CaptainCallOptions {
    visibility: 'visible' | 'hidden';
}
export interface CaptainResult {
    status: 'ok' | 'aborted' | 'error';
    finalText?: string;
    error?: string;
}
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export interface NormalizedError {
    name: string;
    message: string;
    stack?: string;
}
export type PlaybookStateValue = string | {
    readonly [key: string]: PlaybookStateValue;
};
export interface PlaybookState {
    value: PlaybookStateValue;
    activeStateIds: readonly string[];
    tags: readonly string[];
    status: 'active' | 'done' | 'error' | 'stopped';
    quiescent: boolean;
    stateId?: string;
}
export interface PlaybookPendingCall {
    callId: string;
    playbookId: string;
    childSessionId: string;
}
export interface PlaybookCallRequest {
    callId: string;
    playbookId: string;
    text: string;
}
export type PlaybookCallResult = {
    status: 'ok';
    playbookId: string;
    childSessionId: string;
    state?: PlaybookState;
    output?: JsonValue;
} | {
    status: 'aborted';
    playbookId: string;
    childSessionId?: string;
    state?: PlaybookState;
    error?: NormalizedError;
} | {
    status: 'error';
    playbookId: string;
    childSessionId?: string;
    state?: PlaybookState;
    error: NormalizedError;
};
export type PlaybookCallStart = {
    state: 'settled';
    result: PlaybookCallResult;
} | {
    state: 'suspended';
    childSessionId: string;
};
export type PlaybookRunResult = {
    outcome: 'quiescent' | 'no-action';
    state: PlaybookState;
} | {
    outcome: 'failed' | 'aborted';
    state: PlaybookState;
    error?: NormalizedError;
} | {
    outcome: 'terminal';
    state: PlaybookState;
    output?: JsonValue;
} | {
    outcome: 'suspended';
    state: PlaybookState;
    pendingCall: PlaybookPendingCall;
};
export interface PlaybookPorts {
    callPlayer(playerId: string, prompt: string, signal: AbortSignal, options: PlayerCallOptions): Promise<PlayerResult>;
    callCaptain(prompt: string, signal: AbortSignal, options: CaptainCallOptions): Promise<CaptainResult>;
    callJudge(prompt: string, signal: AbortSignal): Promise<string>;
    callPlaybook(request: PlaybookCallRequest, signal: AbortSignal): Promise<PlaybookCallStart>;
    emitStatus(message: string, data?: unknown): Promise<void>;
    emitTelemetry(event: {
        topic: string;
        payload: unknown;
    }): Promise<void>;
}
export interface PlaybookSession {
    sessionId: string;
    playbookId: string;
    rootSessionId: string;
    parentSessionId?: string;
    parentCallId?: string;
    depth: number;
    ports: PlaybookPorts;
}
export type PlaybookTraceType = 'session.started' | 'boss.input.received' | 'judge.call.started' | 'judge.call.finished' | 'player.call.started' | 'player.call.finished' | 'captain.call.started' | 'captain.call.finished' | 'playbook.call.started' | 'playbook.call.finished' | 'fsm.transition' | 'status.emitted' | 'boss.input.settled' | 'session.disposed';
export interface PlaybookTraceEvent {
    schemaVersion: 2;
    sessionId: string;
    playbookId: string;
    rootSessionId: string;
    parentSessionId?: string;
    parentCallId?: string;
    depth: number;
    sequence: number;
    timestamp: number;
    type: PlaybookTraceType;
    turnId?: number;
    callId?: string;
    payload: JsonValue;
}
export interface PlaybookRuntime {
    init(session: PlaybookSession): Promise<void>;
    handleBossInput(turn: {
        text: string;
        signal: AbortSignal;
    }): Promise<PlaybookRunResult>;
    resumePlaybookCall(input: {
        callId: string;
        result: PlaybookCallResult;
        signal: AbortSignal;
    }): Promise<PlaybookRunResult>;
    dispose(): Promise<void>;
}
export type PlaybookRuntimeFactory<Options = unknown> = (options: Options) => PlaybookRuntime;
