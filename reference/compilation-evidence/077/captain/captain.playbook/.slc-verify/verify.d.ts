/** A GEARS spec item with its acting prompt and optional source-owned results. */
export interface GearsItem {
    id: string;
    /** Source-spelled delegated participant; schema 3 canonicalizes it as a role. */
    player: string;
    prompt: string;
    /**
     * Direct Captain work, delegated player work, or an optimizer-introduced
     * script item (`Captain shall run:`); absent for playbook calls.
     */
    actor?: 'captain' | 'player' | 'script';
    /** Target id when this item invokes another playbook rather than a player. */
    playbookId?: string;
    /** Context field selecting a dynamic nested-playbook target. */
    playbookIdContext?: string;
    /** Context field supplying a dynamic nested-playbook input. */
    textContext?: string;
    /** Source-declared parallel group, when this item is a concurrent member. */
    parallelGroup?: string;
    /** Ordered source-owned domain guard contract, when explicitly declared. */
    result?: Record<string, string>;
    /** Malformed result-metadata details retained for fail-closed reporting. */
    resultFindings?: string[];
}
/** A Captain/player-invoking state's introspected `gears2fsm` binding. */
export interface CaptainState {
    stateId: string;
    sourceItem: string;
    /**
     * Semantic actor kind after preserving legacy `captain` + player bindings.
     * `script` appears only in coverage-driving views built from script states,
     * never in captain-binding enumeration or pins.
     */
    actor: 'captain' | 'player' | 'script';
    /** Immutable schema-1 delegated-player binding. */
    player: string;
    /** Canonical schema-3 local-role binding. */
    role?: string;
    prompt: string;
    /** The state's per-state guard contract: result key to description. */
    result: Record<string, string>;
    /** Dot-separated config path, present only for a nested state node. */
    statePath?: string;
    /** Malformed binding details retained for fail-closed conformance reporting. */
    bindingFindings?: string[];
}
/** A script-actor invocation recovered from an FSM state (DR-013). */
export interface ScriptInvocationState {
    stateId: string;
    sourceItem: string;
    /** The item's blockquoted shell script, verbatim. */
    command: string;
    /** The two declared exit-status guards, zero-exit first. */
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
/**
 * A Playbook engine's raw compatibility self-report — `RUNTIME_ABI` and
 * `SUPPORTED_ARTIFACT_SCHEMAS` on its `@sublang/playbook/xstate-runtime`
 * surface — read from the installed package owning a link target
 * (verification-21, phase-execution-30; DR-028). The reader lives in
 * `runtime-contract.ts`; the predicates stay here so the artifact-local
 * verifier copy (verification-12) carries the schema decision whole.
 */
export interface PlaybookRuntimeDeclaration {
    /** `@sublang/playbook@<version>` of the owning installed package. */
    provenance: string;
    /** Lexical root of the owning package. */
    packageRoot: string;
    /** The exported `RUNTIME_ABI`, or `undefined` when the engine exports none. */
    runtimeAbi: unknown;
    /** The exported `SUPPORTED_ARTIFACT_SCHEMAS`, or `undefined` when absent. */
    supportedArtifactSchemas: unknown;
}
/**
 * True when the declaration admits the roleless schema-3 `composed-v3`
 * generation: `RUNTIME_ABI` is exactly `1` and `SUPPORTED_ARTIFACT_SCHEMAS`
 * contains `3` (DR-028).
 */
export declare function declaresComposedV3(declaration: PlaybookRuntimeDeclaration): boolean;
/** Names a declaration for fail-closed diagnostics. */
export declare function describeRuntimeDeclaration(declaration: PlaybookRuntimeDeclaration): string;
/**
 * Artifact schema recorded for an exact reviewed Playbook provenance: the
 * historical map kept as recorded (DR-028). A later release supplies its
 * schema through the installed engine's declaration instead
 * ({@link resolveArtifactSchemaForVerification}).
 */
export declare function artifactSchemaForPlaybookProvenance(provenance: unknown): 1 | 3 | undefined;
/**
 * Returns the Playbook package provenance that owns an invocation's concrete
 * link target. The first package manifest above the target owns the file; a
 * parent workspace manifest must not lend its identity to a nested local file.
 */
export declare function playbookProvenanceForLinkTarget(linkTarget: string): Promise<string | undefined>;
/** The minimal XState machine-config shape the introspector walks (`machine.config`). */
export interface MachineConfigLike {
    initial?: string | {
        target: string;
        actions?: unknown;
    };
    meta?: unknown;
    tags?: string | readonly string[];
    states?: Record<string, StateLike>;
    on?: Record<string, unknown>;
    /** The machine's initial context: a literal record or an input-taking factory. */
    context?: unknown;
}
type InputMapper = (arg: {
    context: Record<string, unknown>;
}) => unknown;
interface InvokeLike {
    src?: unknown;
    input?: InputMapper | Record<string, unknown>;
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
    initial?: MachineConfigLike['initial'];
    type?: string;
    meta?: unknown;
    tags?: string | readonly string[];
    states?: Record<string, StateLike>;
    invoke?: InvokeLike | InvokeArrayLike;
    on?: Record<string, unknown>;
    onDone?: unknown;
    onError?: unknown;
}
/** Both XState initial-transition forms select one immediate child key. */
export declare function initialStateTarget(initial: MachineConfigLike['initial']): string | undefined;
/**
 * Parses the GEARS items from a `gears` artifact: each `### <ID>` item's player,
 * blockquoted acting prompt, and optional ordered `Results:` metadata.
 */
export declare function parseGearsItems(gears: string): GearsItem[];
/** Existing GEARS result-parser findings, without requiring a consumer FSM. */
export declare function checkGearsResultContract(gears: string): string[];
/** GEARS actor-clause findings, without changing parser classification. */
export declare function checkGearsActorContract(gears: string): string[];
/** The source generation and canonical role/cohort declaration of one GEARS artifact. */
export interface GearsRoleContract {
    generation: 'schema-1' | 'schema-3' | 'unspecified';
    names: string[];
    roleIds: string[];
    concurrentRoleSets: string[][];
    findings: string[];
}
/** Canonical lowercase local-role id used by schema-3 artifacts. */
export declare function canonicalRoleId(name: string): string;
/** Parses Roles/Players plus source-derived concurrent role sets without host bindings. */
export declare function inspectGearsRoleContract(gears: string): GearsRoleContract;
/**
 * Enumerates a machine's direct-Captain and delegated-player states, reading
 * `invoke.input` under a stub context to recover the static source binding.
 */
export declare function enumerateCaptainStates(config: MachineConfigLike): CaptainState[];
/** Enumerates typed `playbook` actor calls across the complete state tree. */
export declare function enumeratePlaybookStates(config: MachineConfigLike): PlaybookInvocationState[];
/**
 * Enumerates typed `script` actor calls across the complete state tree
 * (gears2fsm.md "Setup"; DR-013). A script state carries `stateId`,
 * `sourceItem`, the verbatim `command`, and exactly two exit-status guards; it
 * is not agent-invoking, so `needsBossReply` in its result map is malformed.
 */
export declare function enumerateScriptStates(config: MachineConfigLike): ScriptInvocationState[];
/** Module-level schema-3 declarations needed beside the machine config. */
export interface GearsFsmConformanceOptions {
    concurrentRoleSets?: unknown;
    /** Reviewed artifact schema for roleless non-controller machines. */
    artifactSchema?: 1 | 3;
}
/** Exact action guards of Playbook 10's controller decision result. */
export declare const CONTROLLER_ACTION_GUARDS: readonly ['respond', 'resume', 'start', 'switch', 'dismiss', 'deliver', 'runtime'];
/** Exact legacy or recovery-capable controller domain. */
export declare function isControllerDecisionResult(result: unknown): boolean;
/** A single missing or extra key against the matching controller domain. */
export declare function controllerDecisionNearMiss(result: unknown): {
    missing: string[];
    extra: string[];
    domain: readonly string[];
} | undefined;
/** Whether a machine contains Playbook 10's grounded controller decision state. */
export declare function isControllerMachine(config: MachineConfigLike): boolean;
/** Whether an explicit direct-Captain result is one key from the controller domain. */
export declare function hasControllerDecisionNearMiss(config: MachineConfigLike): boolean;
/** Reject tags that prevent the public runtime returning a pending child. */
export declare function checkFsmChildSuspension(config: MachineConfigLike): string[];
/**
 * Checks GEARS↔FSM conformance and returns human-readable findings (empty when
 * conformant): every GEARS item maps to one state with the same player and the
 * prompt verbatim, every captain state references a known item, and every
 * captain state's `result` map declares the Boss-reply suspension key with its
 * adjudicator contract (verification-1, verification-3; DR-009).
 */
export declare function checkGearsFsmConformance(gears: string, config: MachineConfigLike, options?: GearsFsmConformanceOptions): string[];
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
/** The structural facts {@link pinIntrospection} pins for a machine (verification-4). */
export interface IntrospectionPins {
    initial: string | null;
    /** Captain-invoking states, in declaration order. */
    captain: {
        state: string;
        path?: string;
        actor?: 'captain' | 'player';
        sourceItem: string;
        player: string;
        /** Canonical schema-3 role; absent for historical schema-1 pins. */
        role?: string;
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
 * test pins (verification-4): captain bindings with result keys and every transition
 * arm, the quiescent states' event surfaces, the root event surface, and the
 * `BOSS_INTERRUPT` jumpable set.
 */
export declare function pinIntrospection(config: MachineConfigLike): IntrospectionPins;
/** The historical full continuation format, retained for schema-1 and old composers. */
export declare const CONTINUATION_PREAMBLE = "You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.";
export declare const BOSS_QUESTION_LABEL = "Boss question:";
export declare const BOSS_REPLY_LABEL = "Boss reply:";
/** One captain state's derived prompt contract (verification-5). */
export interface PromptContractRow {
    state: string;
    sourceItem: string;
    player: string;
    /** Canonical schema-3 role; absent for historical schema-1 rows. */
    role?: string;
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
}) => unknown, 
/** The machine's initial context, so a typed field does not truncate the trace. */
initial?: Record<string, unknown>): string[];
/**
 * Derives every captain state's prompt contract from the machine config
 * (verification-5): traced context reads, sentinel-traced input wiring, and the
 * prompt body's placeholder tokens.
 */
export declare function capturePromptContract(config: MachineConfigLike): PromptContractRow[];
/**
 * Derives, per captain state, which of its prompt's placeholder tokens the
 * linked composer substitutes when the wired context is present — pinned into
 * the emitted test so a token that later leaks unsubstituted fails it
 * (verification-5).
 */
export declare function deriveSubstitutions(config: MachineConfigLike, compose: PromptComposer, actor?: CaptainState['actor']): Record<string, string[]>;
/** Known-schema FSM input checks, without requiring a linked composer. */
export declare function checkFsmContinuationInputs(config: MachineConfigLike, artifactSchema: 1 | 3): string[];
/**
 * Checks the linked composer against the link contract for every captain state
 * (verification-5), returning findings (empty when conformant): the prompt body is
 * preserved modulo substituted placeholders, the adjudicator-facing Boss-reply
 * contract never leaks into a player prompt, no continuation appears on an
 * ordinary turn, and a Boss-reply continuation turn opens with a supported exact
 * prefix. Only an explicitly resumed schema-3 player may omit the question.
 */
export declare function checkPromptComposition(opts: {
    config: MachineConfigLike;
    compose: PromptComposer;
    /** Restricts the check to the states served by the matching composer. */
    actor?: CaptainState['actor'];
    /** Grounded linked-artifact schema for otherwise ambiguous direct Captain states. */
    artifactSchema?: 1 | 3;
    /** Collects observations that degrade the probe without failing the contract. */
    diagnostics?: string[];
}): string[];
type PromptIdentity = (roleId: string) => string;
type PromptComposer = (input: unknown, promptIdentity: PromptIdentity, resuming?: boolean) => string;
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
/** Reads the schema-3 cohort declaration from an imported FSM module. */
export declare function findConcurrentRoleSets(fsmModule: unknown): unknown;
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
    /** Reviewed schema baked into roleless artifact checks when available. */
    artifactSchema?: 1 | 3;
    /** Emission-time schema evidence that must remain empty for a valid artifact. */
    schemaFindings?: readonly string[];
}): string;
/**
 * Emits the GEARS↔FSM conformance test as `slc` output beside a compiled
 * `playbook` artifact: writes `<basename>.gears-fsm.test.ts` into the artifact
 * directory (`<basename>.playbook/`), wiring the artifact's `gears` file and its
 * `fsm` module's machine to the checker, and returns the written path (verification-2;
 * [DR-009](../decisions/009-slc-playbook-pipeline-compilation.md)).
 */
export declare function emitGearsFsmConformanceTest(opts: {
    /** The artifact directory (`<basename>.playbook/`) to emit the test into. */
    artifactDir: string;
    /** Basename shared by the artifacts (e.g. `code`). */
    basename: string;
    /** Checker import specifier; defaults to {@link VERIFY_MODULE}. */
    verifyModule?: string;
    /** Reviewed schema baked into roleless artifact checks when available. */
    artifactSchema?: 1 | 3;
    /** Emission-time schema evidence that must remain empty for a valid artifact. */
    schemaFindings?: readonly string[];
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
 * Imports generated linked TypeScript for emission-time, standalone, or
 * equivalence review before its sibling FSM has been built to JavaScript.
 * NodeNext source correctly names the runtime-safe `./<basename>.fsm.js` edge,
 * but review may run while only `./<basename>.fsm.ts` exists. Stage a
 * same-directory copy whose one generated module specifier points at the
 * hashed TypeScript artifact, import that copy, and remove it without changing
 * the linked source or its production import.
 */
export declare function loadLinkedModuleForVerification(opts: {
    linkedPath: string;
    fsmPath: string;
}): Promise<unknown>;
/**
 * Builds a per-artifact vitest module that fails when the machine's structure
 * drifts from the topology pinned at build time (verification-4).
 */
export declare function generateFsmIntrospectionTest(opts: {
    basename: string;
    fsmModule: string;
    verifyModule: string;
    pins: IntrospectionPins;
}): string;
/**
 * Builds a per-artifact vitest module pinning the prompt contract derived from
 * the artifacts at build time (verification-5): the per-state context reads, input
 * wiring, and placeholders always; and, when the linked module exposes its
 * matching Captain/player composers, the composition checks and pinned
 * substitution maps.
 */
export declare function generatePromptContractTest(opts: {
    basename: string;
    fsmModule: string;
    verifyModule: string;
    rows: PromptContractRow[];
    /** Grounded artifact schema baked into continuation probes when available. */
    artifactSchema?: 1 | 3;
    /** Emission-time schema evidence that must remain empty for a valid artifact. */
    schemaFindings?: readonly string[];
    /** Present when the linked module beside the artifacts exposes its composer. */
    composer?: {
        playbookModule: string;
        captain?: Record<string, string[]>;
        player?: Record<string, string[]>;
    };
}): string;
/**
 * Schema decision shared by generated and standalone artifact verification
 * (verification-21). Reviewed provenance is evidence through its exact
 * historical map; any other provenance is evidence only through the engine
 * declaration read from the link target's installed package — `RUNTIME_ABI`
 * `1` with artifact schema `3` — and is otherwise reported unsupported
 * (DR-028).
 */
export declare function resolveArtifactSchemaForVerification(opts: {
    /** Conformance before linking has no continuation composer to classify. */
    requireContinuationSchema?: boolean;
    artifactSchema?: 1 | 3;
    provenance?: unknown;
    /** The link target's installed engine declaration, when the caller read it. */
    runtimeDeclaration?: PlaybookRuntimeDeclaration;
    config?: MachineConfigLike;
    linked?: {
        default?: unknown;
    };
}): {
    artifactSchema?: 1 | 3;
    findings: string[];
};
/**
 * The deterministic link-fidelity checks over one live linked `playbook` module
 * beside its FSM (verification-27): exactly the checks the emitted
 * prompt-contract suite asserts, decided from those two paths alone and
 * returning one finding per violation.
 *
 * The gate that runs this before any Reviewer call must never throw into the
 * executor it guards (DR-030, phase-execution-53), so a module that cannot be
 * imported yields its import diagnostic as a finding. An absent module or FSM
 * yields none: an artifact the performing call has not written is the generic
 * target check's business (phase-execution-4). An FSM that cannot be imported
 * yields none either — the suite's checks derive from that machine, so they
 * degrade exactly as emission degrades its prompt-contract test to a
 * diagnostic (verification-5).
 */
export declare function checkLinkedModuleContract(opts: {
    linkedPath: string;
    fsmPath: string;
}): Promise<string[]>;
/**
 * Emits the prompt-contract test beside a compiled `playbook` artifact
 * (verification-5): derives and pins the per-state contract from the physical
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
    /** Reviewed schema when the FSM shape alone cannot distinguish generations. */
    artifactSchema?: 1 | 3;
    /** Actual reviewed full-link target provenance, when the caller has it. */
    provenance?: unknown;
    /** The full-link target's installed engine declaration, when read (DR-028). */
    runtimeDeclaration?: PlaybookRuntimeDeclaration;
}): Promise<{
    path: string;
    diagnostics: string[];
}>;
/**
 * Emits the introspection test beside a compiled `playbook` artifact
 * (verification-4): derives topology pins from the physical `<basename>.fsm.ts`,
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
