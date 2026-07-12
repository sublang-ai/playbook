import { type CaptainInput, type EnabledPlaybook } from './captain.fsm.js';
import type { PlaybookRuntime, PlaybookRuntimeFactory } from '../../../src/runtime.js';
export type { CaptainCallOptions, CaptainResult, PlaybookCallRequest, PlaybookCallResult, PlaybookCallStart, PlaybookPorts, PlaybookRunResult, PlaybookRuntime, PlaybookRuntimeFactory, PlaybookSession, PlaybookState, PlaybookStateValue, PlaybookTraceEvent, PlayerCallOptions, PlayerResult, } from '../../../src/runtime.js';
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
export declare function createPlaybookRuntime(options: PlaybookRuntimeOptions): PlaybookRuntime;
export declare const _internal: Readonly<{
    composePlayerPrompt: typeof composePlayerPrompt;
    composeCaptainPrompt: typeof composeCaptainPrompt;
}>;
declare const factory: PlaybookRuntimeFactory<PlaybookRuntimeOptions>;
export default factory;
