import { type CaptainInput, type EnabledPlaybook } from './captain.fsm.js';
import type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlayerResult, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent } from '../../../src/runtime.js';
export type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlayerCallOptions, PlayerResult, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, };
export interface PlaybookRuntimeOptions {
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
}
export declare function composeCaptainPrompt(input: CaptainInput): string;
export declare function composePlayerPrompt(input: Pick<CaptainInput, 'prompt' | 'pendingBossQuestion' | 'bossReply'>): string;
export declare function recoverJsonObject(text: string): Record<string, unknown> | undefined;
export declare function createPlaybookRuntime(options: PlaybookRuntimeOptions): PlaybookRuntime;
declare const factory: PlaybookRuntimeFactory<PlaybookRuntimeOptions>;
export default factory;
export declare const _internal: Readonly<{
    composePlayerPrompt: typeof composePlayerPrompt;
    composeCaptainPrompt: typeof composeCaptainPrompt;
    recoverJsonObject: typeof recoverJsonObject;
}>;
