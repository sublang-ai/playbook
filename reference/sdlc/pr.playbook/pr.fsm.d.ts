export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export type PrStateId = 'openPullRequest' | 'waitForChecks' | 'fixChecks' | 'publishFix' | 'waitForChecksAfterFix' | 'mergePullRequest' | 'updateLocalDefault';
export type PrSourceItem = 'PR-1' | 'PR-2' | 'PR-3' | 'PR-4' | 'PR-5' | 'PR-6' | 'PR-7';
export type PrScriptStateId = 'waitForChecks' | 'publishFix' | 'waitForChecksAfterFix' | 'mergePullRequest' | 'updateLocalDefault';
export type PrScriptSourceItem = 'PR-2' | 'PR-4' | 'PR-5' | 'PR-6' | 'PR-7';
export type PrChildPlaybookId = 'code';
export type PendingBossQuestion = {
    readonly questionId: 'openPullRequest';
    readonly resumeStateId: 'openPullRequest';
    readonly sourceItem: 'PR-1';
    readonly asker: {
        readonly kind: 'role';
        readonly roleId: 'coder';
    };
    readonly question: string;
};
export type PlayerInput = {
    readonly stateId: 'openPullRequest';
    readonly role: 'coder';
    readonly sourceItem: 'PR-1';
    readonly prompt: string;
    readonly result: Readonly<Record<string, string>>;
    readonly callerInput: string;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
};
export type PlayerOutput = {
    readonly guard: 'opened';
    readonly pullRequest: string;
    readonly pullRequestUrl: string;
} | {
    readonly guard: 'notPublished';
    readonly coderOutput: string;
} | {
    readonly guard: 'needsBossReply';
    readonly question: string;
};
export type PlaybookInput = {
    readonly stateId: 'fixChecks';
    readonly sourceItem: 'PR-3';
    readonly playbookId: PrChildPlaybookId;
    readonly text: string;
};
export type ScriptInput = {
    readonly stateId: PrScriptStateId;
    readonly sourceItem: PrScriptSourceItem;
    readonly command: string;
    readonly result: Readonly<Record<string, string>>;
};
export type ScriptOutput = {
    readonly guard: 'checksPassed';
    readonly exitStatus: number;
} | {
    readonly guard: 'checksFailed';
    readonly exitStatus: number;
} | {
    readonly guard: 'fixPublished';
    readonly exitStatus: number;
} | {
    readonly guard: 'fixNotPublished';
    readonly exitStatus: number;
} | {
    readonly guard: 'checksStillFailing';
    readonly exitStatus: number;
} | {
    readonly guard: 'merged';
    readonly exitStatus: number;
} | {
    readonly guard: 'mergeRefused';
    readonly exitStatus: number;
} | {
    readonly guard: 'localDefaultUpdated';
    readonly exitStatus: number;
} | {
    readonly guard: 'localDefaultNotUpdated';
    readonly exitStatus: number;
};
export type CompactError = {
    readonly name: string;
    readonly message: string;
};
/** Sanitized canonical child result relayed as PR's own failure outcome. */
export type CompletedChildResult = {
    readonly playbookId: PrChildPlaybookId;
    readonly status: 'ok';
    readonly output?: JsonValue;
} | {
    readonly playbookId: PrChildPlaybookId;
    readonly status: 'aborted' | 'error';
    readonly error: CompactError;
};
export type PrPlaybookOutput = {
    readonly status: 'merged';
    /** The pull request number, exactly as Coder reported it. */
    readonly pullRequest: string;
    /** The pull request URL, exactly as Coder reported it. */
    readonly pullRequestUrl: string;
    /** Whether the local default branch was fast-forwarded to the merged head. */
    readonly localDefaultUpdated: boolean;
} | {
    readonly status: 'not-merged';
    readonly reason: 'not-published';
    /** Coder's complete result carrying the reason. */
    readonly coderOutput: string;
} | {
    readonly status: 'not-merged';
    readonly reason: 'fix-failed';
    readonly pullRequest: string;
    readonly pullRequestUrl: string;
    /** The relayed canonical `code` result that ended the one fix attempt. */
    readonly childResult: CompletedChildResult;
} | {
    readonly status: 'not-merged';
    readonly reason: 'fix-not-published' | 'checks-failed' | 'merge-refused';
    readonly pullRequest: string;
    readonly pullRequestUrl: string;
};
export type PrCompletion = 'merged' | 'not-published' | 'fix-failed' | 'fix-not-published' | 'checks-failed' | 'merge-refused';
/** The machine reads no input: the caller input arrives on `START_PR`. */
export type PrInput = Readonly<Record<never, never>>;
export type PrContext = {
    readonly callerInput?: string;
    readonly pullRequest?: string;
    readonly pullRequestUrl?: string;
    readonly completion?: PrCompletion;
    readonly localDefaultUpdated?: boolean;
    readonly coderOutput?: string;
    readonly childFailure?: CompletedChildResult;
    readonly lastError?: unknown;
    readonly pendingBossQuestion?: PendingBossQuestion;
    readonly bossReply?: string;
};
export type PrEvent = {
    readonly type: 'START_PR';
    readonly callerInput: string;
} | {
    readonly type: 'BOSS_REPLY';
    readonly answer: string;
    readonly questionId?: 'openPullRequest';
};
/** PR-3's composed child input: the caller input, the pull request, and the static coding request. */
export declare function fixChecksCallText(context: PrContext): string;
export declare const prMachine: import("xstate").StateMachine<PrContext, {
    readonly type: "START_PR";
    readonly callerInput: string;
} | {
    readonly type: "BOSS_REPLY";
    readonly answer: string;
    readonly questionId?: "openPullRequest";
}, {
    [x: string]: import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<JsonValue | undefined, PlaybookInput, import("xstate").EventObject>> | import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<PlayerOutput, PlayerInput, import("xstate").EventObject>> | import("xstate").ActorRefFromLogic<import("xstate").PromiseActorLogic<ScriptOutput, ScriptInput, import("xstate").EventObject>> | undefined;
}, {
    src: "playbook";
    logic: import("xstate").PromiseActorLogic<JsonValue | undefined, PlaybookInput, import("xstate").EventObject>;
    id: string | undefined;
} | {
    src: "player";
    logic: import("xstate").PromiseActorLogic<PlayerOutput, PlayerInput, import("xstate").EventObject>;
    id: string | undefined;
} | {
    src: "script";
    logic: import("xstate").PromiseActorLogic<ScriptOutput, ScriptInput, import("xstate").EventObject>;
    id: string | undefined;
}, {
    type: "playbook.acceptedOutcome";
    params: {
        readonly source: string;
        readonly target: string;
        readonly acceptedOutcome: string;
    };
} | {
    type: "rememberActorError";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberPendingQuestion";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberBossReply";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberEmptyBossReplyError";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberMalformedPlayerOutput";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeWithInsufficientCodeResult";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeWithCodeFailure";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "startPr";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberPullRequest";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeNotPublished";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeFixNotPublished";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeChecksStillFailing";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeMergeRefused";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeMerged";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "completeMergedLocalBehind";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "rememberMalformedScriptOutput";
    params: {
        readonly sourceItem: PrScriptSourceItem;
    };
}, {
    type: "needsBossReply";
    params: unknown;
} | {
    type: "emptyBossReply";
    params: unknown;
} | {
    type: "authoredCodeFailure";
    params: unknown;
} | {
    type: "checksPassed";
    params: unknown;
} | {
    type: "checksFailed";
    params: unknown;
} | {
    type: "fixPublished";
    params: unknown;
} | {
    type: "fixNotPublished";
    params: unknown;
} | {
    type: "checksStillFailing";
    params: unknown;
} | {
    type: "merged";
    params: unknown;
} | {
    type: "mergeRefused";
    params: unknown;
} | {
    type: "localDefaultUpdated";
    params: unknown;
} | {
    type: "localDefaultNotUpdated";
    params: unknown;
} | {
    type: "isOpened";
    params: unknown;
} | {
    type: "isNotPublished";
    params: unknown;
} | {
    type: "isCodeSuccess";
    params: unknown;
} | {
    type: "resumesOpenPullRequest";
    params: unknown;
}, never, "failed" | "awaitBossReply" | "ready" | "openPullRequest" | "waitForChecks" | "fixChecks" | "publishFix" | "waitForChecksAfterFix" | "mergePullRequest" | "updateLocalDefault" | "notPublished" | "fixNotPublished" | "checksStillFailing" | "merged" | "mergeRefused" | "mergedLocalBehind" | "fixFailed", string, Readonly<Record<never, never>>, {
    readonly status: "merged";
    /** The pull request number, exactly as Coder reported it. */
    readonly pullRequest: string;
    /** The pull request URL, exactly as Coder reported it. */
    readonly pullRequestUrl: string;
    /** Whether the local default branch was fast-forwarded to the merged head. */
    readonly localDefaultUpdated: boolean;
} | {
    readonly status: "not-merged";
    readonly reason: "not-published";
    /** Coder's complete result carrying the reason. */
    readonly coderOutput: string;
} | {
    readonly status: "not-merged";
    readonly reason: "fix-failed";
    readonly pullRequest: string;
    readonly pullRequestUrl: string;
    /** The relayed canonical `code` result that ended the one fix attempt. */
    readonly childResult: CompletedChildResult;
} | {
    readonly status: "not-merged";
    readonly reason: "fix-not-published" | "checks-failed" | "merge-refused";
    readonly pullRequest: string;
    readonly pullRequestUrl: string;
}, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "pr";
    states: {
        readonly ready: {
            id: "ready";
        };
        readonly openPullRequest: {
            id: "openPullRequest";
        };
        readonly waitForChecks: {
            id: "waitForChecks";
        };
        readonly fixChecks: {
            id: "fixChecks";
        };
        readonly publishFix: {
            id: "publishFix";
        };
        readonly waitForChecksAfterFix: {
            id: "waitForChecksAfterFix";
        };
        readonly mergePullRequest: {
            id: "mergePullRequest";
        };
        readonly updateLocalDefault: {
            id: "updateLocalDefault";
        };
        readonly awaitBossReply: {
            id: "awaitBossReply";
        };
        readonly failed: {
            id: "failed";
        };
        readonly merged: {
            id: "merged";
        };
        readonly mergedLocalBehind: {
            id: "mergedLocalBehind";
        };
        readonly notPublished: {
            id: "notPublished";
        };
        readonly fixFailed: {
            id: "fixFailed";
        };
        readonly fixNotPublished: {
            id: "fixNotPublished";
        };
        readonly checksStillFailing: {
            id: "checksStillFailing";
        };
        readonly mergeRefused: {
            id: "mergeRefused";
        };
    };
}>;
export default prMachine;
