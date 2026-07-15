import { type CaptainInput, type EnabledPlaybook } from './captain.fsm.js';
import type { PlaybookRuntime, PlaybookRuntimeFactory } from '../../../src/runtime.js';
export type { CaptainCallOptions, CaptainResult, JsonValue, NormalizedError, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlayerCallOptions, PlayerResult, } from '../../../src/runtime.js';
export interface PlaybookRuntimeOptions {
    readonly enabledPlaybooks: readonly EnabledPlaybook[];
}
export declare function composeCaptainPrompt(input: CaptainInput): string;
export declare function composePlayerPrompt(input: {
    readonly prompt: string;
    readonly pendingBossQuestion?: {
        readonly question: string;
    };
    readonly bossReply?: string;
}): string;
declare function parseJsonObjectLoose(text: string): Record<string, unknown> | undefined;
export declare const _internal: {
    composeCaptainPrompt: typeof composeCaptainPrompt;
    composePlayerPrompt: typeof composePlayerPrompt;
    parseJsonObjectLoose: typeof parseJsonObjectLoose;
};
export declare function createPlaybookRuntime(options: PlaybookRuntimeOptions): PlaybookRuntime;
declare const factory: PlaybookRuntimeFactory<PlaybookRuntimeOptions>;
export default factory;
