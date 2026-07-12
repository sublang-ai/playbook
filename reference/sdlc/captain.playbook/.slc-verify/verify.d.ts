/** A GEARS spec item: its id, the player it prompts, and its verbatim prompt body. */
export interface GearsItem {
    id: string;
    player: string;
    prompt: string;
    /** Direct Captain work or delegated player work; absent for playbook calls. */
    actor?: 'captain' | 'player';
    /** Target id when this item invokes another playbook rather than a player. */
    playbookId?: string;
    /** Context field selecting a dynamic nested-playbook target. */
    playbookIdContext?: string;
    /** Context field supplying a dynamic nested-playbook input. */
    textContext?: string;
}
/** A Captain/player-invoking state's introspected `gears2fsm` binding. */
export interface CaptainState {
    stateId: string;
    sourceItem: string;
    /** Semantic actor kind after preserving legacy `captain` + player bindings. */
    actor: 'captain' | 'player';
    player: string;
    prompt: string;
    /** The state's per-state guard contract: result key to description. */
    result: Record<string, string>;
    /** Dot-separated config path, present only for a nested state node. */
    statePath?: string;
    /** Malformed binding details retained for fail-closed conformance reporting. */
    bindingFindings?: string[];
}
/** A playbook-actor invocation recovered from an FSM state. */
export interface PlaybookInvocationState {
    stateId: string;
    /** Literal values are empty during static introspection of a dynamic call. */
    playbookId: string;
    text: string;
    /** Explicit dynamic-call metadata naming the runtime context fields. */
    playbookIdContext?: string;
    textContext?: string;
    /** Optional source item emitted by linkers that retain the GEARS identity. */
    sourceItem?: string;
    /** Dot-separated config path, present only for a nested state node. */
    statePath?: string;
    /** Malformed binding details retained for fail-closed conformance reporting. */
    bindingFindings?: string[];
}
/**
 * The Boss-reply result key `gears2fsm` adds to every captain-invoking state's
 * `result` map, and the load-bearing substring its adjudicator-facing
 * description must carry so the runtime's judge requires a `question` payload
 * (gears2fsm.md "Boss-reply suspension"; DR-009).
 */
export declare const NEEDS_BOSS_REPLY = "needsBossReply";
export declare const BOSS_QUESTION_MARKER = "Output shall include `question:";
/** The minimal XState machine-config shape the introspector walks (`machine.config`). */
export interface MachineConfigLike {
    initial?: string;
    states?: Record<string, StateLike>;
    on?: Record<string, unknown>;
}
interface InvokeLike {
    src?: unknown;
    input?: (arg: {
        context: Record<string, unknown>;
    }) => unknown;
    onDone?: unknown;
    onError?: unknown;
}
interface InvokeArrayLike extends ReadonlyArray<InvokeLike> {
    src?: unknown;
    input?: (arg: {
        context: Record<string, unknown>;
    }) => unknown;
    onDone?: unknown;
    onError?: unknown;
}
interface StateLike {
    id?: string;
    initial?: string;
    type?: string;
    meta?: unknown;
    tags?: string | readonly string[];
    states?: Record<string, StateLike>;
    invoke?: InvokeLike | InvokeArrayLike;
    on?: Record<string, unknown>;
    onDone?: unknown;
    onError?: unknown;
}
/**
 * Parses the GEARS items from a `gears` artifact: each `### <ID>` item's player
 * and its blockquoted prompt body, in document order.
 */
export declare function parseGearsItems(gears: string): GearsItem[];
/**
 * Enumerates a machine's direct-Captain and delegated-player states, reading
 * `invoke.input` under a stub context to recover the static source binding.
 */
export declare function enumerateCaptainStates(config: MachineConfigLike): CaptainState[];
/** Enumerates typed `playbook` actor calls across the complete state tree. */
export declare function enumeratePlaybookStates(config: MachineConfigLike): PlaybookInvocationState[];
/**
 * Checks GEARS↔FSM conformance and returns human-readable findings (empty when
 * conformant): every GEARS item maps to one state with the same player and the
 * prompt verbatim, every captain state references a known item, and every
 * captain state's `result` map declares the Boss-reply suspension key with its
 * adjudicator contract (VERIFY-1, VERIFY-3; DR-009).
 */
export declare function checkGearsFsmConformance(gears: string, config: MachineConfigLike): string[];
/** The `gears2fsm`-mandated root pre-emption event name. */
export declare const INTERRUPT_EVENT = "BOSS_INTERRUPT";
/** The `gears2fsm`-mandated Boss-reply event and wait-state names. */
export declare const BOSS_REPLY_EVENT = "BOSS_REPLY";
export declare const AWAIT_BOSS_REPLY_STATE = "awaitBossReply";
/** One normalized transition arm of an `onDone`/`onError`/`on` declaration. */
export interface TransitionArm {
    index: number;
    /** Target state key/id with any leading `#` stripped; null for a target-less arm. */
    target: string | null;
    guarded: boolean;
}
/** Event name to its normalized transition arms. */
export type EventArms = Record<string, TransitionArm[]>;
/** One state node in the optional recursive topology for compound machines. */
export interface StructuredStatePin {
    path: string;
    parent: string | null;
    id: string | null;
    publicStateId: string | null;
    type: string | null;
    initial: string | null;
    tags: string[];
    children: string[];
    invokes: string[];
    onDone: TransitionArm[];
    onError: TransitionArm[];
    on: EventArms;
}
/** The structural facts {@link pinIntrospection} pins for a machine (VERIFY-4). */
export interface IntrospectionPins {
    initial: string | null;
    /** Captain-invoking states, in declaration order. */
    captain: {
        state: string;
        path?: string;
        actor?: 'captain' | 'player';
        sourceItem: string;
        player: string;
        resultKeys: string[];
        onDone: TransitionArm[];
        onError: TransitionArm[];
        on: EventArms;
    }[];
    /** Non-captain states: finality and event surface. */
    quiescent: {
        state: string;
        final: boolean;
        on: EventArms;
    }[];
    /** Root-level event surface. */
    rootOn: EventArms;
    /** Root `BOSS_INTERRUPT` targets in arm order — the jumpable set. */
    interruptTargets: string[];
    /** Playbook-actor bindings, omitted when a machine declares none. */
    playbook?: {
        state: string;
        path?: string;
        playbookId?: string;
        playbookIdContext?: string;
        textContext?: string;
        sourceItem?: string;
        onDone: TransitionArm[];
        onError: TransitionArm[];
        on: EventArms;
    }[];
    /** Recursive topology, omitted to preserve flat-machine pin bytes. */
    structured?: {
        states: StructuredStatePin[];
    };
}
/**
 * Normalizes an XState transition declaration — a string target, a
 * target/guard/actions object, or an array of either — into ordered
 * {@link TransitionArm}s.
 */
export declare function normalizeArms(raw: unknown): TransitionArm[];
/**
 * Reduces a machine config to the structural facts the emitted introspection
 * test pins (VERIFY-4): captain bindings with result keys and every transition
 * arm, the quiescent states' event surfaces, the root event surface, and the
 * `BOSS_INTERRUPT` jumpable set.
 */
export declare function pinIntrospection(config: MachineConfigLike): IntrospectionPins;
/** The exact continuation preamble the link contract mandates (link.md). */
export declare const CONTINUATION_PREAMBLE = "You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.";
export declare const BOSS_QUESTION_LABEL = "Boss question:";
export declare const BOSS_REPLY_LABEL = "Boss reply:";
/** One captain state's derived prompt contract (VERIFY-5). */
export interface PromptContractRow {
    state: string;
    sourceItem: string;
    player: string;
    /** Context fields the state's input thunk reads. */
    reads: string[];
    /** Input fields carrying a read context field's value, by sentinel tracing. */
    wires: Record<string, string[]>;
    /** `<...>` placeholder tokens in the prompt body, first-appearance order. */
    placeholders: string[];
}
/** Lists the distinct `<...>` placeholder tokens in a prompt body, in order. */
export declare function placeholdersIn(prompt: string): string[];
/**
 * Traces which context fields an `invoke.input` thunk reads, via a recording
 * proxy context; reads collected up to a throw are kept.
 */
export declare function probeContextReads(inputFn: (arg: {
    context: Record<string, unknown>;
}) => unknown): string[];
/**
 * Derives every captain state's prompt contract from the machine config
 * (VERIFY-5): traced context reads, sentinel-traced input wiring, and the
 * prompt body's placeholder tokens.
 */
export declare function capturePromptContract(config: MachineConfigLike): PromptContractRow[];
/**
 * Derives, per captain state, which of its prompt's placeholder tokens the
 * linked composer substitutes when the wired context is present — pinned into
 * the emitted test so a token that later leaks unsubstituted fails it
 * (VERIFY-5).
 */
export declare function deriveSubstitutions(config: MachineConfigLike, compose: (input: unknown) => string, actor?: CaptainState['actor']): Record<string, string[]>;
/**
 * Checks the linked composer against the link contract for every captain state
 * (VERIFY-5), returning findings (empty when conformant): the prompt body is
 * preserved modulo substituted placeholders, the adjudicator-facing Boss-reply
 * contract never leaks into a player prompt, no continuation appears on an
 * ordinary turn, and a Boss-reply continuation turn opens with the exact
 * preamble and labelled Q&A blocks before the body.
 */
export declare function checkPromptComposition(opts: {
    config: MachineConfigLike;
    compose: (input: unknown) => string;
    /** Restricts the check to the states served by the matching composer. */
    actor?: CaptainState['actor'];
}): string[];
/**
 * Package-export default for direct emitter callers. Full reserved-pipeline
 * runs override it with the artifact-local verifier support module.
 */
export declare const VERIFY_MODULE = "@sublang/slc/verify";
/**
 * Finds the XState machine an `fsm` module exports — the export whose value has a
 * `.config.states` — so callers need not know its export name, and returns that
 * machine's config for {@link checkGearsFsmConformance}.
 *
 * @throws when the module exports no such machine.
 */
export declare function findMachineConfig(fsmModule: unknown): MachineConfigLike;
/**
 * Builds a per-artifact vitest module that fails when the compiled FSM drifts
 * from its GEARS source: it reads the artifact's `gears` file and the machine its
 * `fsm` module exports (via {@link findMachineConfig}, so no export name is
 * needed), then asserts {@link checkGearsFsmConformance} finds nothing.
 */
export declare function generateGearsFsmConformanceTest(opts: {
    /** Basename shared by the artifacts (e.g. `code`). */
    basename: string;
    /** Import specifier for the compiled `fsm` module, relative to the test. */
    fsmModule: string;
    /** Path to the `gears` artifact, relative to the test. */
    gearsFile: string;
    /** Import specifier for this checker, relative to the test. */
    verifyModule: string;
}): string;
/**
 * Emits the GEARS↔FSM conformance test as `slc` output beside a compiled
 * `playbook` artifact: writes `<basename>.gears-fsm.test.ts` into the artifact
 * directory (`<basename>.playbook/`), wiring the artifact's `gears` file and its
 * `fsm` module's machine to the checker, and returns the written path (VERIFY-2;
 * [DR-009](../decisions/009-slc-playbook-pipeline-compilation.md)).
 */
export declare function emitGearsFsmConformanceTest(opts: {
    /** The artifact directory (`<basename>.playbook/`) to emit the test into. */
    artifactDir: string;
    /** Basename shared by the artifacts (e.g. `code`). */
    basename: string;
    /** Checker import specifier; defaults to {@link VERIFY_MODULE}. */
    verifyModule?: string;
}): Promise<string>;
/**
 * Imports a produced `fsm` artifact module for emission-time derivation. The
 * artifact is TypeScript; under Node's type stripping (erasable-syntax-only)
 * the direct import works, and a failure is reported to the caller so emission
 * degrades to a diagnostic rather than failing the run. The URL carries the
 * content hash so a rebuilt artifact at the same path is never served from the
 * module cache.
 */
export declare function loadFsmModule(fsmPath: string): Promise<unknown>;
/**
 * Builds a per-artifact vitest module that fails when the machine's structure
 * drifts from the topology pinned at build time (VERIFY-4).
 */
export declare function generateFsmIntrospectionTest(opts: {
    basename: string;
    fsmModule: string;
    verifyModule: string;
    pins: IntrospectionPins;
}): string;
/**
 * Builds a per-artifact vitest module pinning the prompt contract derived from
 * the artifacts at build time (VERIFY-5): the per-state context reads, input
 * wiring, and placeholders always; and, when the linked module exposes its
 * matching Captain/player composers, the composition checks and pinned
 * substitution maps.
 */
export declare function generatePromptContractTest(opts: {
    basename: string;
    fsmModule: string;
    verifyModule: string;
    rows: PromptContractRow[];
    /** Present when the linked module beside the artifacts exposes its composer. */
    composer?: {
        playbookModule: string;
        captain?: Record<string, string[]>;
        player?: Record<string, string[]>;
    };
}): string;
/**
 * Emits the prompt-contract test beside a compiled `playbook` artifact
 * (VERIFY-5): derives and pins the per-state contract from the physical
 * `<basename>.fsm.ts` artifact, then emits NodeNext `.js` imports for that FSM
 * and any linked `<basename>.playbook.ts` module. When the linked module
 * exposes the `_internal` composer matching each state actor —
 * `composeCaptainPrompt` for direct Captain work and `composePlayerPrompt` for
 * delegated work — the test pins substitution maps and composition checks.
 * Returns the written path and any diagnostics (a linked module that cannot be
 * imported or exposes no matching composer degrades independently to the
 * artifact-only checks).
 *
 * @throws when the `fsm` artifact cannot be imported or exports no machine.
 */
export declare function emitPromptContractTest(opts: {
    artifactDir: string;
    basename: string;
    verifyModule?: string;
}): Promise<{
    path: string;
    diagnostics: string[];
}>;
/**
 * Emits the introspection test beside a compiled `playbook` artifact
 * (VERIFY-4): derives topology pins from the physical `<basename>.fsm.ts`,
 * emits a NodeNext `.js` import for that sibling source, and writes
 * `<basename>.fsm.introspect.test.ts` into the artifact directory.
 *
 * @throws when the `fsm` artifact cannot be imported or exports no machine.
 */
export declare function emitFsmIntrospectionTest(opts: {
    artifactDir: string;
    basename: string;
    verifyModule?: string;
}): Promise<string>;
export * from './verify-coverage.js';
