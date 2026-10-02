// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
/**
 * FSM transition-coverage verification for a compiled `playbook` artifact
 * (verification-6; DR-009).
 *
 * {@link checkFsmCoverage} drives the artifact's machine with scripted Captain
 * and nested-playbook actors and returns findings when a declared transition
 * is not reachable: every ordinary Captain result key must fire a transition
 * out (with `needsBossReply` suspending in the Boss-reply wait state and
 * resuming on `BOSS_REPLY`), every controller action must return to its session
 * hub or shutdown final without a wait, nested calls must transition on success
 * and failure, every `onError` arm must land on its target, every
 * `BOSS_INTERRUPT` target must be enterable, and guard-free root entry events
 * must transition.
 * Context-dependent `onDone` arms that a jumped-in actor cannot satisfy are
 * covered by deterministic guard-satisfiability probing — candidate values
 * mined from the guard's own source — so an unsatisfiable arm is still flagged.
 * The checker needs only the artifact and `xstate`; the emitted per-artifact
 * test runs it beside the artifacts. See specs/packages/verification.md.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createActor, fromPromise } from 'xstate';
import { AWAIT_BOSS_REPLY_STATE, BOSS_REPLY_EVENT, INTERRUPT_EVENT, NEEDS_BOSS_REPLY, VERIFY_MODULE, controllerDecisionNearMiss, enumerateCaptainStates, enumerateScriptStates, initialStateTarget, isControllerDecisionResult, isControllerMachine, loadFsmModule, normalizeArms, } from './verify.js';
/** The `gears2fsm`-mandated captain actor name a machine declares. */
export const CAPTAIN_ACTOR = 'captain';
// Each check owns its resources, including concurrent checks and async actor
// callbacks. No current-run variable is shared between invocations.
const coverageRuns = new AsyncLocalStorage();
/** Incomplete coverage is not an unsatisfiable transition or Source question. */
export class FsmCoverageDeadlineError extends Error {
    constructor() {
        super('FSM transition coverage incomplete: cooperative deadline exceeded');
        this.name = 'FsmCoverageDeadlineError';
    }
}
function coverageCheckpoint() {
    const run = coverageRuns.getStore();
    run?.signal?.throwIfAborted();
    if (run !== undefined && performance.now() >= run.deadline)
        throw new FsmCoverageDeadlineError();
}
/** Deliver pending cancellation between bounded blocks of synchronous work. */
async function coverageYield(force = false) {
    coverageCheckpoint();
    const run = coverageRuns.getStore();
    if (run !== undefined && (force || performance.now() - run.lastYield >= 8)) {
        try {
            await delay(0, undefined, { signal: run.signal });
        }
        finally {
            coverageCheckpoint();
        }
        run.lastYield = performance.now();
    }
}
function trackCoverageActor(actor) {
    const run = coverageRuns.getStore();
    if (run !== undefined) {
        run.actors.add(actor);
        const stop = actor.stop.bind(actor);
        actor.stop = () => {
            try {
                return stop();
            }
            finally {
                run.actors.delete(actor);
            }
        };
    }
    return actor;
}
/** Release every actor without replacing an already propagating failure. */
function stopCoverageActors(actors, preserveFailure) {
    let failed = false;
    let firstError;
    for (const actor of actors) {
        try {
            actor.stop();
        }
        catch (error) {
            if (!failed)
                firstError = error;
            failed = true;
        }
    }
    if (failed && !preserveFailure)
        throw firstError;
}
function stateRefKey(ref) {
    return ref.path.join('\u0000');
}
function sameStateRef(left, right) {
    return (left !== undefined &&
        right !== undefined &&
        stateRefKey(left) === stateRefKey(right));
}
function captainPublicStateId(captain) {
    return captain.binding.stateId || captain.ref.stableId;
}
/** The public interrupt id that enters a leaf's complete structured region. */
function interruptTargetForRef(ref, fallback) {
    let ancestor = ref.parent;
    while (ancestor !== undefined) {
        if (ancestor.state.type === 'parallel')
            return ancestor.stableId;
        ancestor = ancestor.parent;
    }
    return fallback;
}
function captainInterruptTarget(captain) {
    return interruptTargetForRef(captain.ref, captainPublicStateId(captain));
}
function invokeGuard(guard, args, ...params) {
    coverageCheckpoint();
    try {
        return guard(args, ...params);
    }
    finally {
        coverageCheckpoint();
    }
}
/** Scalar values carried by a parameterized XState guard descriptor. */
function descriptorValues(value, seen = new Set()) {
    if (typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean') {
        return [value];
    }
    if (typeof value !== 'object' || value === null || seen.has(value))
        return [];
    seen.add(value);
    return Object.values(value).flatMap((item) => descriptorValues(item, seen));
}
/** Resolves inline, named, and parameterized named XState guards. */
function resolveGuard(machine, guard) {
    if (typeof guard === 'function') {
        const implementation = guard;
        return {
            run: (args) => invokeGuard(implementation, args),
            probeValues: minedLiterals(implementation),
        };
    }
    const descriptor = typeof guard === 'string'
        ? { type: guard, params: undefined }
        : typeof guard === 'object' && guard !== null && 'type' in guard
            ? guard
            : undefined;
    if (typeof descriptor?.type !== 'string')
        return undefined;
    const candidate = machine.implementations?.guards?.[descriptor.type];
    if (typeof candidate !== 'function')
        return undefined;
    const implementation = candidate;
    const params = descriptor.params;
    return {
        run: (args) => invokeGuard(implementation, args, typeof params === 'function'
            ? params(args)
            : params),
        probeValues: [
            ...minedLiterals(implementation),
            ...(typeof params === 'function' ? minedLiterals(params) : []),
            ...descriptorValues(params),
        ],
    };
}
function guardLabel(guard) {
    if (typeof guard === 'string')
        return guard;
    try {
        return JSON.stringify(guard) ?? String(guard);
    }
    catch {
        coverageCheckpoint();
        return String(guard);
    }
}
/**
 * Finds the XState machine an `fsm` module exports — the export carrying a
 * `.config.states` and a `.provide` — so the coverage driver can supply the
 * scripted captain.
 *
 * @throws when the module exports no such machine.
 */
export function findMachine(fsmModule) {
    if (typeof fsmModule === 'object' && fsmModule !== null) {
        for (const value of Object.values(fsmModule)) {
            if (typeof value === 'object' &&
                value !== null &&
                'config' in value &&
                'provide' in value &&
                typeof value.provide === 'function') {
                const config = value.config;
                if (typeof config === 'object' &&
                    config !== null &&
                    'states' in config) {
                    return value;
                }
            }
        }
    }
    throw new Error('fsm module exports no providable XState machine with a `.config.states`');
}
/** How long a driven actor may take to settle; transitions resolve in microtasks. */
const SETTLE_MS = 1_000;
/** Bounded structured-machine probes use these shorter settle windows. */
const PARALLEL_SETTLE_MS = 250;
const PARALLEL_QUESTION_SETTLE_MS = 500;
const MAX_PARALLEL_COMBINATIONS = 64;
const MAX_COVERAGE_PATH_STEPS = 8;
const MAX_COVERAGE_PATH_ATTEMPTS = 64;
/** Stable values shared by machine input, result output, and guard probing. */
const COVERAGE_PLAYBOOK_ID = 'coverage-child-playbook';
const COVERAGE_PLAYBOOK_INPUT = 'coverage: complete the child request';
const COVERAGE_FINAL_RESPONSE = 'coverage: completed response';
const COVERAGE_ENABLED_PLAYBOOKS = [
    {
        id: COVERAGE_PLAYBOOK_ID,
        command: '/coverage-child',
        intent: 'Exercise a nested playbook transition.',
    },
];
/**
 * Supplies the required Captain-session catalog without assuming that every
 * artifact consumes these input fields. XState ignores unused machine input.
 */
const COVERAGE_MACHINE_INPUT = {
    stateId: 'coverage-root-playbook',
    selfPlaybookId: 'coverage-root-playbook',
    bossIntent: 'Exercise the compiled playbook transitions.',
    enabledPlaybooks: COVERAGE_ENABLED_PLAYBOOKS,
};
/**
 * A valid Captain context for direct guard evaluation. Dynamic call fields use
 * the same id as the catalog entry, preserving exact catalog-membership guards.
 */
function coverageGuardContext(dynamic) {
    return {
        ...COVERAGE_MACHINE_INPUT,
        remainingPlan: [],
        completedCallResults: [
            {
                playbookId: COVERAGE_PLAYBOOK_ID,
                status: 'ok',
                output: { response: 'coverage: prior child result' },
            },
        ],
        completedCallSignatures: [],
        nextPlaybookId: COVERAGE_PLAYBOOK_ID,
        nextPlaybookInput: COVERAGE_PLAYBOOK_INPUT,
        finalResponse: COVERAGE_FINAL_RESPONSE,
        ...(dynamic === undefined
            ? {}
            : {
                [dynamic.playbookIdContext]: COVERAGE_PLAYBOOK_ID,
                [dynamic.textContext]: COVERAGE_PLAYBOOK_INPUT,
            }),
    };
}
/** Context produced by the machine's real initializer for the coverage input. */
function initializedMachineContext(machine) {
    let actor;
    let failed = false;
    try {
        actor = trackCoverageActor(createActor(machine, { input: COVERAGE_MACHINE_INPUT }));
        return actor.getSnapshot().context;
    }
    catch {
        failed = true;
        coverageCheckpoint();
        return {};
    }
    finally {
        stopCoverageActors(actor === undefined ? [] : [actor], failed);
    }
}
/** Real initialized fields plus deterministic values needed by guard probes. */
function initializedCoverageContext(machine, dynamic) {
    return {
        ...initializedMachineContext(machine),
        ...coverageGuardContext(dynamic),
    };
}
/** The `Output shall include` clause a result description declares. */
const OUTPUT_CLAUSE = /Output shall include\s+(.+)$/;
/** Every backticked `field:` property named inside that clause. */
const REQUIRED_FIELD = /`([A-Za-z_$][A-Za-z0-9_$]*):/g;
/** Structured fields named by the generic Captain result contracts. */
const STRUCTURED_RESULT_FIELD = /\b(response|question|remainingPlan|nextPlaybookId|nextPlaybookInput)\b/g;
function requiredFields(description) {
    const clause = OUTPUT_CLAUSE.exec(description)?.[1] ?? '';
    return [
        ...new Set([
            ...[...clause.matchAll(REQUIRED_FIELD)].map((match) => match[1]),
            ...[...description.matchAll(STRUCTURED_RESULT_FIELD)].map((match) => match[1]),
        ]),
    ];
}
function synthesizedFieldValue(field) {
    switch (field) {
        case 'text':
            return COVERAGE_FINAL_RESPONSE;
        case 'playbookId':
            return COVERAGE_PLAYBOOK_ID;
        case 'input':
            return COVERAGE_PLAYBOOK_INPUT;
        case 'actionId':
            return 'coverage-runtime-action';
        case 'question':
            return 'What should happen next?';
        case 'remainingPlan':
            return [];
        case 'nextPlaybookId':
            return COVERAGE_PLAYBOOK_ID;
        case 'nextPlaybookInput':
            return COVERAGE_PLAYBOOK_INPUT;
        case 'response':
            return COVERAGE_FINAL_RESPONSE;
        default:
            return `coverage:${field}`;
    }
}
/** Synthesizes a captain output that selects `key` under the state's contract. */
function synthOutput(state, key) {
    if (state.actor === 'script') {
        return {
            guard: key,
            exitStatus: Object.keys(state.result)[0] === key ? 0 : 1,
        };
    }
    const output = { guard: key };
    for (const field of requiredFields(state.result[key] ?? '')) {
        output[field] = synthesizedFieldValue(field);
    }
    return output;
}
/** One bounded runtime-valid candidate set for acceptance and arm auditing. */
function resultOutputCandidates(state, key, candidates) {
    const output = synthOutput(state, key);
    if (state.actor !== 'script' || output.exitStatus === 0)
        return [output];
    return [...new Set([1, ...candidates])]
        .filter((value) => typeof value === 'number' && Number.isInteger(value) && value > 0)
        .slice(0, MAX_SCRIPT_EXIT_STATUSES)
        .map((exitStatus) => ({ guard: key, exitStatus }));
}
function invocations(state) {
    if (Array.isArray(state.invoke))
        return state.invoke;
    return state.invoke === undefined ? [] : [state.invoke];
}
function invocationSource(src) {
    if (typeof src === 'string')
        return src;
    if (typeof src === 'object' &&
        src !== null &&
        'type' in src &&
        typeof src.type === 'string') {
        return src.type;
    }
    return undefined;
}
/** Walks every state node in declaration order while retaining its ancestry. */
function stateRefs(config) {
    const out = [];
    const visit = (states, parent) => {
        for (const [key, state] of Object.entries(states)) {
            const path = [...(parent?.path ?? []), key];
            const ref = {
                key,
                path,
                ...(typeof state.id === 'string' ? { configId: state.id } : {}),
                stableId: typeof state.meta?.playbook?.stateId === 'string'
                    ? state.meta.playbook.stateId
                    : typeof state.id === 'string'
                        ? state.id
                        : path.join('.'),
                state,
                ...(parent === undefined ? {} : { parent }),
            };
            out.push(ref);
            if (state.states !== undefined)
                visit(state.states, ref);
        }
    };
    visit((config.states ?? {}));
    return out;
}
/** States entered by default, including every active parallel region. */
function enteredStateRefs(state, refs, parent) {
    const active = [];
    const initial = initialStateTarget(state.initial);
    const keys = state.type === 'parallel'
        ? Object.keys(state.states ?? {})
        : initial !== undefined
            ? [initial]
            : [];
    for (const key of keys) {
        const path = [...(parent?.path ?? []), key];
        const ref = refs.find((candidate) => candidate.path.join('\u0000') === path.join('\u0000'));
        if (ref === undefined)
            continue;
        active.push(ref, ...enteredStateRefs(ref.state, refs, ref));
    }
    return active;
}
function initialActiveRefs(config, refs) {
    return enteredStateRefs(config, refs);
}
/** A target enters itself and only its default active descendants. */
function targetEntersRef(refs, target, invocation) {
    return (target !== undefined &&
        (sameStateRef(target, invocation) ||
            enteredStateRefs(target.state, refs, target).some((ref) => sameStateRef(ref, invocation))));
}
/** Captain bindings paired with the nested state node that owns the invoke. */
function captainRefs(config) {
    const out = [];
    const refs = stateRefs(config);
    const used = new Set();
    // Script states drive like other work states: the scripted actor resolves
    // one of the two declared exit-status guards (DR-013).
    const workBindings = [
        ...enumerateCaptainStates(config),
        ...enumerateScriptStates(config).map((state) => ({
            stateId: state.stateId,
            sourceItem: state.sourceItem,
            actor: 'script',
            player: '',
            prompt: state.command,
            result: state.result,
            ...(state.statePath === undefined ? {} : { statePath: state.statePath }),
        })),
    ];
    for (const binding of workBindings) {
        const statePath = binding.statePath;
        const ref = (statePath === undefined
            ? undefined
            : refs.find((candidate) => candidate.path.join('.') === statePath)) ??
            refs.find((candidate) => candidate.stableId === binding.stateId ||
                (candidate.path.length === 1 && candidate.key === binding.stateId));
        if (ref === undefined)
            continue;
        const choices = invocations(ref.state);
        const invocationIndex = choices.findIndex((invocation) => {
            if (used.has(invocation))
                return false;
            const source = invocationSource(invocation.src);
            const matchingActor = source === binding.actor ||
                // Playbook 0.9 represented delegated work as a `captain` invoke with
                // an input.player field. Retain that immutable bundle until the atomic
                // Playbook 1.0 refresh while driving new `player` invokes distinctly.
                (binding.actor === 'player' && source === 'captain');
            if ((!matchingActor && source !== undefined) ||
                typeof invocation.input !== 'function') {
                return matchingActor && binding.sourceItem === '';
            }
            try {
                const input = invocation.input({ context: coverageGuardContext() });
                if (typeof input !== 'object' ||
                    input === null ||
                    Array.isArray(input)) {
                    return matchingActor && binding.sourceItem === '';
                }
                const sourceItem = input.sourceItem;
                if (binding.sourceItem !== '')
                    return sourceItem === binding.sourceItem;
                return matchingActor;
            }
            catch {
                coverageCheckpoint();
                return matchingActor && binding.sourceItem === '';
            }
        });
        // A malformed explicit work invoke can lack a distinguishable input;
        // retain declaration order rather than silently dropping coverage.
        const selected = invocationIndex >= 0
            ? invocationIndex
            : choices.findIndex((invocation) => !used.has(invocation) &&
                (invocationSource(invocation.src) === binding.actor ||
                    (binding.actor === 'player' &&
                        invocationSource(invocation.src) === 'captain')));
        if (selected < 0)
            continue;
        used.add(choices[selected]);
        out.push({
            binding,
            invocation: choices[selected],
            invocationIndex: selected,
            ref,
        });
    }
    return out;
}
function playbookRefs(config) {
    return stateRefs(config).flatMap((ref) => invocations(ref.state).flatMap((invocation, invocationIndex) => invocationSource(invocation.src) === 'playbook'
        ? [{ invocation, invocationIndex, ref }]
        : []));
}
// Local copy: this module is copied verbatim beside the artifact (verification-12),
// so it may not import a sibling module.
function coverageErrorMessage(error) {
    try {
        return error instanceof Error ? error.message : String(error);
    }
    catch {
        coverageCheckpoint();
        return 'unknown error';
    }
}
/** Dynamic target/text context names declared by a nested playbook input. */
function dynamicPlaybookFields(playbook) {
    if (typeof playbook.invocation.input !== 'function')
        return undefined;
    let input;
    try {
        input = playbook.invocation.input({ context: coverageGuardContext() });
    }
    catch {
        coverageCheckpoint();
        return undefined;
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return undefined;
    }
    const playbookIdContext = input
        .playbookIdContext;
    const textContext = input.textContext;
    return typeof playbookIdContext === 'string' &&
        typeof textContext === 'string'
        ? { playbookIdContext, textContext }
        : undefined;
}
function tagsOf(state) {
    if (typeof state.tags === 'string')
        return [state.tags];
    return Array.isArray(state.tags) ? state.tags : [];
}
/** XState's built-in actions that send the machine an event by themselves. */
const EVENT_RAISING_ACTION_TYPES = new Set([
    'xstate.raise',
    'xstate.sendTo',
    'xstate.enqueueActions',
]);
/**
 * Whether an `entry` or `exit` action list can move the machine without an
 * external event: a built-in raise, send, or enqueue, written inline or behind
 * a `setup()`-registered name. An action that only assigns keeps a parked leaf
 * inert (DR-053).
 */
function raisesEvent(machine, actions) {
    const typeOf = (action) => {
        if (typeof action === 'string')
            return action;
        if ((typeof action === 'object' && action !== null) ||
            typeof action === 'function') {
            const type = action.type;
            return typeof type === 'string' ? type : undefined;
        }
        return undefined;
    };
    const list = actions === undefined ? [] : Array.isArray(actions) ? actions : [actions];
    return list.some((action) => {
        const type = typeOf(action);
        if (type === undefined)
            return false;
        if (EVENT_RAISING_ACTION_TYPES.has(type))
            return true;
        const named = typeOf(machine.implementations?.actions?.[type]);
        return named !== undefined && EVENT_RAISING_ACTION_TYPES.has(named);
    });
}
function stateRefForTarget(refs, target, source) {
    const absolute = target.startsWith('#');
    const normalized = absolute
        ? target.slice(1)
        : target.startsWith('.')
            ? target.slice(1)
            : target;
    if (!absolute && source?.parent !== undefined) {
        const siblingPath = [...source.parent.path, normalized].join('.');
        const sibling = refs.find((ref) => ref.path.join('.') === siblingPath);
        if (sibling !== undefined)
            return sibling;
    }
    const byStableId = refs.find((ref) => ref.stableId === normalized || ref.configId === normalized);
    if (byStableId !== undefined)
        return byStableId;
    const byPath = refs.find((ref) => ref.path.join('.') === normalized);
    if (byPath !== undefined)
        return byPath;
    const byKey = refs.filter((ref) => ref.key === normalized);
    return byKey.length === 1 ? byKey[0] : undefined;
}
function resolvedStateNode(machine, ref) {
    let node = machine.root;
    for (const key of ref.path) {
        node = node?.states?.[key];
        if (node === undefined)
            return undefined;
    }
    return node;
}
function persistedSnapshotWithContext(provided, context) {
    const seed = trackCoverageActor(createActor(provided, { input: COVERAGE_MACHINE_INPUT }));
    let completed = false;
    try {
        const snapshot = {
            ...seed.getPersistedSnapshot(),
            context: { ...context },
            children: {},
        };
        completed = true;
        return snapshot;
    }
    finally {
        stopCoverageActors([seed], !completed);
    }
}
function makeActor(machine, script, playbookScript = () => null, restoredContext, observeTransition) {
    coverageCheckpoint();
    const coverageErrors = [];
    const workActor = fromPromise(async ({ input, self, }) => {
        const output = await script(input ?? {}, self.id);
        if (output === null)
            return new Promise(() => { });
        if (output instanceof Error)
            throw output;
        return output;
    });
    const provided = machine.provide({
        actors: {
            [CAPTAIN_ACTOR]: workActor,
            player: workActor,
            script: workActor,
            // A child script is opt-in. All unrelated child invocations hang until
            // the driven actor is stopped, preserving Captain and parallel probes.
            playbook: fromPromise(async ({ input, self, }) => {
                const output = await playbookScript(input ?? {}, self.id);
                if (output === null)
                    return new Promise(() => { });
                if (output instanceof Error)
                    throw output;
                return output;
            }),
        },
    });
    const restoredSnapshot = restoredContext === undefined
        ? undefined
        : persistedSnapshotWithContext(provided, restoredContext);
    const actor = trackCoverageActor(createActor(provided, {
        input: COVERAGE_MACHINE_INPUT,
        ...(restoredSnapshot === undefined
            ? {}
            : { snapshot: restoredSnapshot }),
        inspect: (inspection) => {
            if (typeof inspection !== 'object' ||
                inspection === null ||
                !('event' in inspection)) {
                return;
            }
            const inspectedTransitions = inspection._transitions;
            if (inspection.type === '@xstate.microstep' &&
                Array.isArray(inspectedTransitions)) {
                for (const transition of inspectedTransitions) {
                    if (typeof transition !== 'object' || transition === null) {
                        continue;
                    }
                    const source = transition.source;
                    const target = transition.target;
                    observeTransition?.({
                        ...(typeof source === 'object' &&
                            source !== null &&
                            typeof source.id === 'string'
                            ? { sourceId: source.id }
                            : {}),
                        targetIds: Array.isArray(target)
                            ? target.flatMap((candidate) => typeof candidate === 'object' &&
                                candidate !== null &&
                                typeof candidate.id === 'string'
                                ? [candidate.id]
                                : [])
                            : [],
                    });
                }
            }
            const event = inspection.event;
            if (typeof event !== 'object' || event === null)
                return;
            const eventType = event.type;
            if (typeof eventType === 'string' &&
                eventType.startsWith('xstate.error.actor.')) {
                coverageErrors.push({
                    eventType,
                    error: event.error,
                });
            }
        },
    }));
    Object.defineProperty(actor, 'coverageErrors', {
        value: coverageErrors,
    });
    actor.subscribe({ error: () => { } });
    actor.start();
    coverageCheckpoint();
    return actor;
}
/** A script that rejects the captain invocation for the given source item. */
function throwingScript(sourceItem, gate) {
    return (input) => {
        if (!gate.armed || input.sourceItem !== sourceItem)
            return null;
        return new Error('coverage: forced captain failure');
    };
}
/** A script that resolves `output` once for the given source item, then hangs. */
function onceScript(sourceItem, output, gate) {
    let used = false;
    return (input) => {
        if (!gate.armed || used || input.sourceItem !== sourceItem)
            return null;
        used = true;
        return output;
    };
}
/** Waits until the actor's snapshot satisfies `predicate`, or times out. */
function settle(actor, predicate, ms = SETTLE_MS) {
    coverageCheckpoint();
    const run = coverageRuns.getStore();
    return new Promise((resolveSettled, reject) => {
        let subscription = undefined;
        let settled = false;
        const finish = (outcome) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            subscription?.unsubscribe();
            run?.signal?.removeEventListener('abort', aborted);
            try {
                coverageCheckpoint();
                resolveSettled(outcome);
            }
            catch (error) {
                reject(error);
            }
        };
        const aborted = () => finish(false);
        const remaining = run === undefined ? ms : Math.max(0, run.deadline - performance.now());
        const timer = setTimeout(() => finish(predicate(actor.getSnapshot())), Math.min(ms, Math.ceil(remaining)));
        run?.signal?.addEventListener('abort', aborted, { once: true });
        subscription = actor.subscribe({
            next: (snapshot) => {
                if (predicate(snapshot))
                    finish(true);
            },
            // XState reports an actor failure as unhandled when any observer lacks
            // an error listener. A failed transition is a false settle result; its
            // owning probe records the actionable coverage finding.
            error: () => finish(false),
        });
        if (settled)
            subscription.unsubscribe();
        if (predicate(actor.getSnapshot()))
            finish(true);
        if (run?.signal?.aborted)
            aborted();
    });
}
/** Lets XState process an event whose correct outcome is no transition. */
async function settleNoTransition() {
    coverageCheckpoint();
    const run = coverageRuns.getStore();
    try {
        await delay(Math.min(10, run === undefined
            ? 10
            : Math.max(0, Math.ceil(run.deadline - performance.now()))), undefined, { signal: run?.signal });
    }
    finally {
        coverageCheckpoint();
    }
}
function activeStateIds(snapshot) {
    const ids = new Set();
    if (typeof snapshot.getMeta === 'function') {
        for (const [nodeId, raw] of Object.entries(snapshot.getMeta())) {
            if (typeof raw !== 'object' || raw === null)
                continue;
            const playbook = raw.playbook;
            if (typeof playbook !== 'object' || playbook === null)
                continue;
            const stateId = playbook.stateId;
            if (typeof stateId === 'string')
                ids.add(stateId);
            // XState's metadata map keys are public state-node ids. Retain them as
            // an additional compatibility surface for authored metadata that omits
            // playbook.stateId.
            ids.add(nodeId.startsWith('#') ? nodeId.slice(1) : nodeId);
        }
    }
    const walkValue = (value, prefix = []) => {
        if (typeof value === 'string') {
            ids.add(value);
            ids.add([...prefix, value].join('.'));
            return;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return;
        }
        for (const [key, nested] of Object.entries(value)) {
            ids.add([...prefix, key].join('.'));
            walkValue(nested, [...prefix, key]);
        }
    };
    walkValue(snapshot.value);
    return ids;
}
const atState = (ref) => (snapshot) => {
    const active = activeStateIds(snapshot);
    return (active.has(ref.stableId) ||
        active.has(ref.path.join('.')) ||
        (ref.path.length === 1 && active.has(ref.key)));
};
const leftState = (ref) => (snapshot) => !atState(ref)(snapshot);
/** The actor id XState actually uses for a declared invocation. */
function invocationActorId(machine, invocation) {
    const resolved = resolvedStateNode(machine, invocation.ref)?.invoke?.[invocation.invocationIndex]?.id;
    if (typeof resolved === 'string')
        return resolved;
    const declared = invocation.invocation.id;
    if (typeof declared === 'string')
        return declared;
    if (typeof invocation.ref.state.id === 'string') {
        return `0.${invocation.ref.state.id}`;
    }
    return `0.${typeof machine.config.id === 'string' ? machine.config.id : '(machine)'}.${invocation.ref.path.join('.')}`;
}
function invocationEvent(machine, captain, kind) {
    const actorId = invocationActorId(machine, captain);
    return { type: `xstate.${kind}.actor.${actorId}`, actorId };
}
function transitionArms(raw) {
    return Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
}
function rawArmTarget(arm) {
    if (typeof arm === 'string')
        return arm;
    if (typeof arm !== 'object' || arm === null)
        return undefined;
    const target = arm.target;
    return typeof target === 'string' ? target : undefined;
}
function armGuard(arm) {
    return typeof arm === 'object' && arm !== null
        ? arm.guard
        : undefined;
}
/** The first transition arm XState selects for one concrete actor event. */
function directlySelectedEventArm(machine, arms, event, context = coverageGuardContext()) {
    for (const [index, arm] of arms.entries()) {
        const rawGuard = armGuard(arm);
        if (rawGuard === undefined)
            return index;
        const guard = resolveGuard(machine, rawGuard);
        if (guard === undefined)
            return undefined;
        try {
            if (guard.run({ context, event }))
                return index;
        }
        catch {
            coverageCheckpoint();
            return undefined;
        }
        finally {
            coverageCheckpoint();
        }
    }
    return undefined;
}
/**
 * Builds the predicate that selects one ordered XState transition arm: every
 * preceding guarded arm must reject and the selected arm must accept (or be
 * the unguarded fallback). An earlier unguarded arm shadows all later arms.
 */
function orderedArmPredicate(machine, arms, selected) {
    const prior = [];
    for (let index = 0; index <= selected; index++) {
        const rawGuard = armGuard(arms[index]);
        if (rawGuard === undefined) {
            if (index < selected) {
                return { run: () => false, probeValues: [] };
            }
            return {
                run: (args) => prior.every((guard) => !guard.run(args)),
                probeValues: prior.flatMap((guard) => guard.probeValues),
            };
        }
        const guard = resolveGuard(machine, rawGuard);
        if (guard === undefined)
            return undefined;
        if (index === selected) {
            return {
                run: (args) => prior.every((candidate) => !candidate.run(args)) && guard.run(args),
                probeValues: [
                    ...prior.flatMap((candidate) => candidate.probeValues),
                    ...guard.probeValues,
                ],
            };
        }
        prior.push(guard);
    }
    return undefined;
}
/** A bounded satisfying context/event pair for one authored interrupt arm. */
function interruptDriveForRef(machine, refs, target, targetId, extraValues = [], selectedArmIndex) {
    const arms = transitionArms((machine.config.on ?? {})[INTERRUPT_EVENT]);
    const armIndex = selectedArmIndex ??
        arms.findIndex((arm) => {
            const rawTarget = rawArmTarget(arm);
            if (rawTarget === undefined)
                return false;
            const resolvedTarget = stateRefForTarget(refs, rawTarget);
            return (targetEntersRef(refs, resolvedTarget, target) ||
                resolvedTarget?.stableId === targetId);
        });
    const rawTarget = rawArmTarget(arms[armIndex]);
    const entryTarget = rawTarget === undefined ? undefined : stateRefForTarget(refs, rawTarget);
    const base = {
        type: INTERRUPT_EVENT,
        targetId: entryTarget !== undefined && !sameStateRef(entryTarget, target)
            ? entryTarget.stableId
            : targetId,
    };
    const targetPlaybook = playbookRefs(machine.config).find((playbook) => sameStateRef(playbook.ref, target));
    const initialContext = initializedCoverageContext(machine, targetPlaybook === undefined
        ? undefined
        : dynamicPlaybookFields(targetPlaybook));
    if (armIndex < 0 || armIndex >= arms.length) {
        return { event: base, context: initialContext, satisfiable: false };
    }
    const guard = orderedArmPredicate(machine, arms, armIndex);
    if (guard === undefined) {
        return { event: base, context: initialContext, satisfiable: false };
    }
    const assignment = probeGuardAssignment(guard.run, {}, [{ tag: 'e:', base }], [
        ...guard.probeValues,
        ...refs.flatMap((ref) => [
            ref.key,
            ref.stableId,
            ...(ref.configId === undefined ? [] : [ref.configId]),
        ]),
        ...extraValues,
    ], {
        initialContext,
        varyExistingContext: true,
    });
    return assignment === undefined
        ? { event: base, context: initialContext, satisfiable: false }
        : {
            event: assignedPayload(base, assignment, 'e:'),
            context: assignment.context,
            satisfiable: true,
        };
}
/** A bounded satisfying initial/root event that enters one Captain state. */
function entryDriveForRef(machine, refs, target, extraValues = [], initialContext = initializedCoverageContext(machine)) {
    const initialPath = initialActiveRefs(machine.config, refs);
    const surfaces = [
        ...initialPath
            .slice()
            .reverse()
            .map((source) => ({ source, events: source.state.on ?? {} })),
        { source: undefined, events: machine.config.on ?? {} },
    ];
    for (const { source, events } of surfaces) {
        for (const [eventType, raw] of Object.entries(events)) {
            if (eventType === INTERRUPT_EVENT)
                continue;
            const arms = transitionArms(raw);
            for (const [armIndex, arm] of arms.entries()) {
                const rawTarget = rawArmTarget(arm);
                if (rawTarget === undefined ||
                    !targetEntersRef(refs, stateRefForTarget(refs, rawTarget, source), target)) {
                    continue;
                }
                const guard = orderedArmPredicate(machine, arms, armIndex);
                if (guard === undefined)
                    continue;
                const base = { type: eventType };
                const assignment = probeGuardAssignment(guard.run, {}, [{ tag: 'e:', base }], [
                    ...guard.probeValues,
                    ...refs.flatMap((ref) => [
                        ref.key,
                        ref.stableId,
                        ...(ref.configId === undefined ? [] : [ref.configId]),
                    ]),
                    ...extraValues,
                ], {
                    initialContext,
                    varyExistingContext: true,
                });
                if (assignment !== undefined) {
                    return {
                        event: assignedPayload(base, assignment, 'e:'),
                        context: assignment.context,
                        satisfiable: true,
                    };
                }
            }
        }
    }
    return undefined;
}
/** The arm XState selects for one concrete invocation output and context. */
function directlySelectedArm(machine, captain, output, context = coverageGuardContext()) {
    const event = {
        ...invocationEvent(machine, captain, 'done'),
        output,
    };
    return directlySelectedEventArm(machine, transitionArms(captain.invocation.onDone), event, context);
}
function directTargetRef(machine, refs, captain, output, context = coverageGuardContext()) {
    const arms = transitionArms(captain.invocation.onDone);
    const selected = directlySelectedArm(machine, captain, output, context);
    if (selected === undefined)
        return undefined;
    const target = rawArmTarget(arms[selected]);
    return target === undefined
        ? undefined
        : stateRefForTarget(refs, target, captain.ref);
}
/*
 * Guard-satisfiability probing: a jumped-in actor carries the initial context,
 * so an arm guarded on accumulated state (e.g. a routing field set by an
 * earlier transition) cannot fire in the driven run. Such arms are checked
 * deterministically instead: candidate context/event values are mined from the
 * guard function's own source literals, and the arm is flagged only when no
 * bounded assignment satisfies it.
 */
const GENERIC_VALUES = [
    'coverage',
    true,
    1,
    ['coverage'],
    COVERAGE_ENABLED_PLAYBOOKS,
];
const MAX_PROBES = 30_000;
const MAX_SCRIPT_EXIT_STATUSES = 8;
const PROBES_PER_TIMEOUT_MILLISECOND = 50;
const COVERAGE_TIMEOUT_MARGIN_MS = 5_000;
const MIN_COVERAGE_TEST_TIMEOUT_MS = 10_000;
const MAX_COVERAGE_TEST_TIMEOUT_MS = 300_000;
function minedLiterals(fn) {
    let source;
    try {
        source = String(fn);
    }
    catch {
        coverageCheckpoint();
        return [];
    }
    const literals = source.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g) ?? [];
    return [...new Set(literals.map((literal) => literal.slice(1, -1)))];
}
// Routing-field values (e.g. a change origin or review subject) are bound at
// helper call sites, invisible in the guard closures themselves; the module's
// identifier-like string literals recover them without dragging prompt prose
// into the candidate pool.
const IDENTIFIER_LITERAL = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
// Bound comparisons (cycle limits, retry counters, exit statuses) route on
// integers that neither the string miner nor the generic value pool supplies:
// GENERIC_VALUES carries only 1, and minedLiterals matches quoted text alone. A
// machine gating on `>= 2` or `=== 0` is therefore reported unsatisfiable purely
// for want of a candidate. Mining the artifact's own integers recovers exactly
// the bounds it routes on.
function numericLiterals(sourceText) {
    return [
        ...new Set((sourceText.match(/(?<![\w.$])\d+(?![\w.$])/g) ?? []).map(Number)),
    ];
}
/** Mines identifier-like string literals from an artifact's source text. */
export function identifierLiterals(sourceText) {
    const literals = sourceText.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g) ?? [];
    return [
        ...new Set(literals
            .map((literal) => literal.slice(1, -1))
            .filter((literal) => IDENTIFIER_LITERAL.test(literal))),
    ];
}
/**
 * Reports whether a bounded search finds a context/output assignment under
 * which the guard passes, seeding candidate values from the guard's source and
 * the caller's extra candidates (typically the machine's state keys and the
 * artifact's identifier literals, since typed routing fields hold values that
 * guards compare against helper-bound constants).
 *
 * A conjunctive guard short-circuits, so each probe pass reveals at most one
 * new field read; the search deepens iteratively — assign a discovered field
 * each candidate value, re-probe for the next read — within a global probe
 * budget, and an exhausted budget reports unsatisfiable ("under probing").
 */
export function guardSatisfiable(guard, baseOutput, extraValues = []) {
    return (probeGuardAssignment(guard, {}, [{ eventField: 'output', tag: 'o:', base: baseOutput }], extraValues) !== undefined);
}
function probeGuardAssignment(guard, fixedEvent, payloads, extraValues, options = {}) {
    const baseContext = { ...(options.initialContext ?? {}) };
    // Guards are predicates over fixed seed objects. Snapshot their descriptors
    // once within this probe, while keeping every candidate independently mutable
    // and retaining accessors, prototypes and non-enumerable Error properties.
    const bases = new WeakMap();
    const overlay = (base, assigned) => {
        let shape = bases.get(base);
        if (shape === undefined) {
            shape = {
                prototype: Object.getPrototypeOf(base),
                descriptors: Object.getOwnPropertyDescriptors(base),
            };
            bases.set(base, shape);
        }
        const copy = Object.create(shape.prototype, shape.descriptors);
        return Object.assign(copy, assigned);
    };
    // Guard-source literals first: the likeliest matches are tried earliest.
    const values = [
        ...new Set([...minedLiterals(guard), ...extraValues, ...GENERIC_VALUES]),
    ];
    let probes = 0;
    const eventFor = (assignment) => {
        let event = { ...fixedEvent };
        for (const payload of payloads) {
            if (payload.eventField === undefined) {
                event = overlay(overlay(payload.base, event), assignment.payloads[payload.tag] ?? {});
            }
            else {
                event[payload.eventField] = overlay(payload.base, assignment.payloads[payload.tag] ?? {});
            }
        }
        return event;
    };
    const passes = (assignment) => {
        coverageCheckpoint();
        probes++;
        try {
            return Boolean(guard({ context: assignment.context, event: eventFor(assignment) }));
        }
        catch {
            coverageCheckpoint();
            return false;
        }
        finally {
            coverageCheckpoint();
        }
    };
    // Records the unassigned fields the guard reads under the given assignment.
    const readsUnder = (assignment) => {
        coverageCheckpoint();
        const reads = new Set();
        const recording = (base, assigned, tag, varyExisting = false) => new Proxy(overlay(base, assigned), {
            get(target, prop) {
                if (typeof prop !== 'string')
                    return undefined;
                if (prop in target) {
                    const payload = payloads.find((item) => item.tag === tag);
                    if ((varyExisting || payload?.varyExisting === true) &&
                        !(prop in assigned)) {
                        reads.add(`${tag}${prop}`);
                    }
                    return target[prop];
                }
                reads.add(`${tag}${prop}`);
                return undefined;
            },
            has(target, prop) {
                if (typeof prop === 'string' && !(prop in target)) {
                    reads.add(`${tag}${prop}`);
                }
                return prop in target;
            },
        });
        try {
            let event = { ...fixedEvent };
            for (const payload of payloads) {
                if (payload.eventField === undefined) {
                    event = recording(overlay(payload.base, event), assignment.payloads[payload.tag] ?? {}, payload.tag);
                }
                else {
                    event[payload.eventField] = recording(payload.base, assignment.payloads[payload.tag] ?? {}, payload.tag);
                }
            }
            guard({
                context: recording(baseContext, assignment.contextOverrides, 'c:', options.varyExistingContext === true),
                event,
            });
        }
        catch {
            coverageCheckpoint();
            // Reads observed before the throw still guide the search.
        }
        finally {
            coverageCheckpoint();
        }
        return [...reads];
    };
    const search = (assignment, depth) => {
        coverageCheckpoint();
        if (probes > MAX_PROBES)
            return undefined;
        if (passes(assignment))
            return assignment;
        if (depth >= 4)
            return undefined;
        for (const key of readsUnder(assignment)) {
            const tag = key.slice(0, 2);
            const field = key.slice(2);
            if (tag === 'c:' && options.assignContext === false)
                continue;
            const assigned = tag === 'c:'
                ? assignment.contextOverrides
                : (assignment.payloads[tag] ?? {});
            const payload = payloads.find((item) => item.tag === tag);
            const base = tag === 'c:' ? baseContext : payload?.base;
            const hasBaseline = base !== undefined && Object.prototype.hasOwnProperty.call(base, field);
            const baseline = hasBaseline
                ? base[field]
                : undefined;
            const candidates = [
                ...(hasBaseline ? [baseline] : []),
                ...values.filter((value) => !hasBaseline || value !== baseline),
            ];
            for (const value of candidates) {
                coverageCheckpoint();
                if (probes > MAX_PROBES)
                    return undefined;
                const nextDepth = depth + (hasBaseline && value === baseline ? 0 : 1);
                const next = tag === 'c:'
                    ? {
                        ...assignment,
                        context: { ...assignment.context, [field]: value },
                        contextOverrides: { ...assigned, [field]: value },
                    }
                    : {
                        ...assignment,
                        payloads: {
                            ...assignment.payloads,
                            [tag]: {
                                ...(assignment.payloads[tag] ?? {}),
                                [field]: value,
                            },
                        },
                    };
                const found = search(next, nextDepth);
                if (found !== undefined)
                    return found;
            }
        }
        return undefined;
    };
    return search({
        context: baseContext,
        contextOverrides: {},
        payloads: {},
    }, 0);
}
function probeGuardSatisfiable(guard, fixedEvent, payloads, extraValues) {
    return (probeGuardAssignment(guard, fixedEvent, payloads, extraValues) !== undefined);
}
function overlaidObject(base, assigned) {
    const copy = Object.create(Object.getPrototypeOf(base));
    Object.defineProperties(copy, Object.getOwnPropertyDescriptors(base));
    Object.assign(copy, assigned);
    return copy;
}
/**
 * Bounded guard probing with a fixed, real event surface. Only context and the
 * named nested payloads are assignable; event-level fields such as `type` and
 * `actorId` remain the values XState actually supplies.
 */
function doneGuardSatisfiable(guard, event, output, extraValues, fixedOutput = false) {
    return probeGuardSatisfiable(guard.run, fixedOutput ? { ...event, output } : event, fixedOutput ? [] : [{ eventField: 'output', tag: 'o:', base: output }], [...guard.probeValues, ...extraValues]);
}
/** A concrete initialized-context/output assignment selecting one done arm. */
function controllerDoneGuardAssignment(guard, event, output, extraValues, initialContext) {
    return probeGuardAssignment(guard.run, event, [{ eventField: 'output', tag: 'o:', base: output }], [...guard.probeValues, ...extraValues], { initialContext, varyExistingContext: true });
}
function errorGuardSatisfiable(guard, event, error, extraValues) {
    return probeGuardSatisfiable(guard.run, event, [{ eventField: 'error', tag: 'r:', base: error, varyExisting: true }], [...guard.probeValues, ...extraValues]);
}
function isDescendantOf(ref, ancestor) {
    return (ref.path.length > ancestor.path.length &&
        ancestor.path.every((part, index) => ref.path[index] === part));
}
/** Picks the initially active Captain leaf from each immediate parallel region. */
function parallelBranchCaptains(parallel, refs, captains) {
    const regions = refs.filter((ref) => ref.parent === parallel);
    const selected = [];
    for (const region of regions) {
        const captain = captains.find((candidate) => targetEntersRef(refs, region, candidate.ref));
        if (captain !== undefined)
            selected.push(captain);
    }
    return selected;
}
function repeatedParallelRoleFindings(refs, captains) {
    const findings = [];
    for (const parallel of refs.filter((ref) => ref.state.type === 'parallel')) {
        const regions = refs.filter((ref) => ref.parent === parallel);
        const priorRoles = new Set();
        for (const region of regions) {
            // Sequential appearances inside one region are never concurrent. Fold
            // the complete descendant region to a set, then compare across siblings;
            // nested parallel descendants are therefore visible to their ancestors
            // and are also checked independently at their own parallel boundary.
            const regionRoles = new Set(captains.flatMap((captain) => {
                if (captain.binding.actor !== 'player' ||
                    (!sameStateRef(captain.ref, region) &&
                        !isDescendantOf(captain.ref, region))) {
                    return [];
                }
                const role = captain.binding.role?.trim().toLowerCase();
                return role === undefined || role === '' ? [] : [role];
            }));
            for (const role of regionRoles) {
                if (priorRoles.has(role)) {
                    findings.push(`parallel state ${parallel.stableId} repeats canonical role ${role}`);
                }
            }
            for (const role of regionRoles)
                priorRoles.add(role);
        }
    }
    return [...new Set(findings)];
}
function scriptedOutputs(entries) {
    const calls = new Map();
    const byState = new Map(entries.map(({ captain, output }) => [
        captainPublicStateId(captain),
        output,
    ]));
    const bySource = new Map(entries.map(({ captain, output }) => [captain.binding.sourceItem, output]));
    return {
        calls,
        script: (input) => {
            const stateId = typeof input.stateId === 'string' ? input.stateId : undefined;
            const sourceItem = typeof input.sourceItem === 'string' ? input.sourceItem : undefined;
            const key = stateId ?? sourceItem;
            const output = (stateId === undefined ? undefined : byState.get(stateId)) ??
                (sourceItem === undefined ? undefined : bySource.get(sourceItem));
            if (key === undefined || output === undefined)
                return null;
            const count = (calls.get(key) ?? 0) + 1;
            calls.set(key, count);
            return count === 1 ? output : null;
        },
    };
}
function callCount(calls, captain) {
    return (calls.get(captainPublicStateId(captain)) ??
        calls.get(captain.binding.sourceItem) ??
        0);
}
/** One public drive or the actual initialized state, never a private jump. */
function childCoverageDrive(machine, refs, ref, targetId, candidates) {
    const interrupt = interruptDriveForRef(machine, refs, ref, targetId, candidates);
    if (interrupt.satisfiable)
        return { drive: interrupt };
    const entry = entryDriveForRef(machine, refs, ref, candidates);
    if (entry !== undefined)
        return { drive: entry };
    return initialActiveRefs(machine.config, refs).some((active) => sameStateRef(active, ref))
        ? {}
        : undefined;
}
function coverageNodeKey(node) {
    return `${stateRefKey(node.value.ref)}:${node.value.invocationIndex}`;
}
function coverageNodes(captains, playbooks) {
    return [
        ...captains.map((value) => ({ kind: 'acting', value })),
        ...playbooks.map((value) => ({ kind: 'child', value })),
    ];
}
/** The exact ordered output candidates used both for entry and target arms. */
function coverageArmResults(machine, node, outcome, armIndex, context, input, candidates, dynamicTarget, requiredResult, includeBare = false, firstOnly = false) {
    const arms = transitionArms(node.value.invocation[outcome]);
    const guard = orderedArmPredicate(machine, arms, armIndex);
    if (guard === undefined)
        return [];
    const actorId = invocationActorId(machine, node.value);
    const event = {
        type: `xstate.${outcome === 'onDone' ? 'done' : 'error'}.actor.${actorId}`,
        actorId,
    };
    const bases = outcome === 'onError'
        ? node.kind === 'child'
            ? [
                nestedFailure(typeof input.playbookId === 'string'
                    ? input.playbookId
                    : COVERAGE_PLAYBOOK_ID),
                nestedFailureTerminal(typeof input.playbookId === 'string'
                    ? input.playbookId
                    : COVERAGE_PLAYBOOK_ID),
                new Error('coverage: generic nested playbook failure'),
            ]
            : [new Error('coverage: forced captain failure')]
        : node.kind === 'child'
            ? [{}, nestedSuccessOutput(), { invalidCoverageOutput: undefined }]
            : (requiredResult === undefined
                ? Object.keys(node.value.binding.result)
                : [requiredResult]).flatMap((key) => resultOutputCandidates(node.value.binding, key, [
                ...guard.probeValues,
                ...candidates,
            ]).map((output) => ({
                ...output,
                ...(dynamicTarget === undefined
                    ? {}
                    : {
                        [dynamicTarget.playbookIdContext]: COVERAGE_PLAYBOOK_ID,
                        [dynamicTarget.textContext]: COVERAGE_PLAYBOOK_INPUT,
                    }),
            })));
    if (includeBare &&
        node.kind === 'acting' &&
        node.value.binding.actor !== 'script' &&
        outcome === 'onDone') {
        bases.push(...Object.keys(node.value.binding.result).map((guard) => ({ guard })));
    }
    const results = [];
    for (const base of bases) {
        coverageCheckpoint();
        if (node.kind === 'acting' &&
            node.value.binding.actor === 'script' &&
            outcome === 'onDone') {
            if (directlySelectedEventArm(machine, arms, { ...event, output: base }, context) === armIndex) {
                results.push(base);
                if (firstOnly)
                    return results;
            }
            continue;
        }
        const assignment = probeGuardAssignment(guard.run, event, [
            {
                eventField: outcome === 'onDone' ? 'output' : 'error',
                tag: outcome === 'onDone' ? 'o:' : 'r:',
                base,
                ...(outcome === 'onError' ? { varyExisting: true } : {}),
            },
        ], [...guard.probeValues, ...GENERIC_VALUES, ...candidates], { initialContext: context, assignContext: false });
        if (assignment !== undefined) {
            results.push(assignedPayload(base, assignment, outcome === 'onDone' ? 'o:' : 'r:'));
            if (firstOnly)
                return results;
        }
    }
    return results;
}
/** Replay every prefix transition; no persisted private-state restoration. */
async function replayCoveragePath(machine, nodes, path) {
    const gate = { armed: path.drive === undefined };
    let expected = path.root;
    let pending;
    const script = (input, actorId) => {
        const node = nodes.find((candidate) => invocationActorId(machine, candidate.value) === actorId);
        if (!gate.armed ||
            node === undefined ||
            coverageNodeKey(node) !== coverageNodeKey(expected))
            return null;
        const stateId = node.kind === 'acting'
            ? captainPublicStateId(node.value)
            : node.value.ref.stableId;
        if (input.stateId !== stateId)
            return null;
        return new Promise((complete) => {
            pending = { node, input, complete };
        });
    };
    const actor = makeActor(machine, script, script, path.drive?.context);
    gate.armed = true;
    if (path.drive !== undefined)
        actor.send(path.drive.event);
    const wait = () => settle(actor, (snapshot) => (pending !== undefined && atState(expected.value.ref)(snapshot)) ||
        snapshot.status === 'done' ||
        snapshot.status === 'error', PARALLEL_SETTLE_MS);
    let completedPrefix = true;
    for (const step of path.steps) {
        await coverageYield();
        await wait();
        const current = pending;
        if (current === undefined ||
            coverageNodeKey(current.node) !== coverageNodeKey(step.node)) {
            completedPrefix = false;
            break;
        }
        pending = undefined;
        expected = step.next;
        current.complete(step.result);
        if (step.questionWait !== undefined) {
            if (!(await settle(actor, atState(step.questionWait), PARALLEL_SETTLE_MS))) {
                completedPrefix = false;
                break;
            }
            actor.send({
                type: BOSS_REPLY_EVENT,
                questionId: captainPublicStateId(step.node.value),
                answer: 'Proceed as planned.',
            });
        }
    }
    await wait();
    const snapshot = actor.getSnapshot();
    const failure = actor.coverageErrors.find(({ eventType }) => eventType ===
        `xstate.error.actor.${invocationActorId(machine, expected.value)}`);
    return {
        actor,
        ...(!completedPrefix ||
            pending === undefined ||
            !atState(expected.value.ref)(snapshot)
            ? {}
            : { pending }),
        ...(failure !== undefined
            ? { inputFailure: coverageErrorMessage(failure.error) }
            : snapshot.status === 'error'
                ? { inputFailure: coverageErrorMessage(snapshot.error) }
                : {}),
    };
}
/** Finite path replay, with one canonical question/reply revisit at most. */
async function searchCoverageEntry(machine, target, refs, captains, playbooks, candidates, check) {
    const nodes = coverageNodes(captains, playbooks);
    const nodesForTarget = (raw, source) => {
        const targetName = rawArmTarget(raw);
        const targetRef = targetName === undefined
            ? undefined
            : stateRefForTarget(refs, targetName, source);
        return nodes.filter((node) => targetEntersRef(refs, targetRef, node.value.ref));
    };
    const reachable = new Set([coverageNodeKey(target)]);
    for (let pass = 0; pass < nodes.length; pass++) {
        for (const node of nodes) {
            if (['onDone', 'onError'].some((outcome) => transitionArms(node.value.invocation[outcome]).some((arm) => {
                return nodesForTarget(arm, node.value.ref).some((next) => reachable.has(coverageNodeKey(next)));
            })))
                reachable.add(coverageNodeKey(node));
        }
    }
    const queue = [];
    for (const node of [
        target,
        ...nodes.filter((node) => coverageNodeKey(node) !== coverageNodeKey(target)),
    ]) {
        if (!reachable.has(coverageNodeKey(node)))
            continue;
        const entry = childCoverageDrive(machine, refs, node.value.ref, node.kind === 'acting'
            ? captainInterruptTarget(node.value)
            : interruptTargetForRef(node.value.ref, node.value.ref.stableId), candidates);
        if (entry !== undefined)
            queue.push({ root: node, ...entry, steps: [] });
    }
    let attempts = 0;
    let entered = false;
    let limitation;
    let inputFailure;
    while (queue.length > 0 && attempts < MAX_COVERAGE_PATH_ATTEMPTS) {
        await coverageYield();
        const path = queue.shift();
        attempts++;
        let replay = await replayCoveragePath(machine, nodes, path);
        try {
            if (replay.inputFailure !== undefined)
                inputFailure = replay.inputFailure;
            if (replay.pending !== undefined &&
                coverageNodeKey(replay.pending.node) === coverageNodeKey(target)) {
                entered = true;
                if (await check(replay.actor, replay.pending))
                    return { covered: true, entered };
                // A target check may have completed its actor. Re-enter the same
                // authored prefix before considering successors, charging that replay
                // against the same attempt limit.
                replay.actor.stop();
                if (attempts >= MAX_COVERAGE_PATH_ATTEMPTS) {
                    limitation = `exhausted ${MAX_COVERAGE_PATH_ATTEMPTS}-attempt path budget`;
                    break;
                }
                attempts++;
                replay = await replayCoveragePath(machine, nodes, path);
            }
            const pending = replay.pending;
            if (pending === undefined)
                continue;
            const node = pending.node;
            const context = replay.actor.getSnapshot().context;
            const nextSteps = [];
            for (const outcome of ['onDone', 'onError']) {
                for (const [index, arm] of transitionArms(node.value.invocation[outcome]).entries()) {
                    for (const next of nodesForTarget(arm, node.value.ref)) {
                        if (!reachable.has(coverageNodeKey(next)))
                            continue;
                        const dynamic = next.kind === 'child'
                            ? dynamicPlaybookFields(next.value)
                            : undefined;
                        for (const result of coverageArmResults(machine, node, outcome, index, context, pending.input, candidates, dynamic)) {
                            nextSteps.push({ node, result, next });
                        }
                    }
                }
            }
            if (node.kind === 'acting' &&
                Object.hasOwn(node.value.binding.result, NEEDS_BOSS_REPLY) &&
                !path.steps.some((step) => step.questionWait !== undefined)) {
                for (const [index, arm] of transitionArms(node.value.invocation.onDone).entries()) {
                    const rawTarget = rawArmTarget(arm);
                    const waitRef = rawTarget === undefined
                        ? undefined
                        : stateRefForTarget(refs, rawTarget, node.value.ref);
                    if (waitRef === undefined ||
                        (waitRef.stableId !== AWAIT_BOSS_REPLY_STATE &&
                            !tagsOf(waitRef.state).includes('playbook.parked')))
                        continue;
                    for (const result of coverageArmResults(machine, node, 'onDone', index, context, pending.input, candidates, undefined, NEEDS_BOSS_REPLY)) {
                        nextSteps.push({ node, result, next: node, questionWait: waitRef });
                    }
                }
            }
            for (const step of nextSteps) {
                if (path.steps.length + 1 >= MAX_COVERAGE_PATH_STEPS) {
                    limitation = `exhausted ${MAX_COVERAGE_PATH_STEPS}-invocation path depth`;
                    continue;
                }
                const visited = [path.root, ...path.steps.map((step) => step.next)].map(coverageNodeKey);
                if (step.questionWait === undefined &&
                    visited.includes(coverageNodeKey(step.next))) {
                    limitation ??= 'unsupported repeated-invocation path';
                    continue;
                }
                queue.push({ ...path, steps: [...path.steps, step] });
            }
        }
        finally {
            replay.actor.stop();
        }
    }
    if (queue.length > 0)
        limitation = `exhausted ${MAX_COVERAGE_PATH_ATTEMPTS}-attempt path budget`;
    return {
        covered: false,
        entered,
        ...(limitation === undefined ? {} : { limitation }),
        ...(inputFailure === undefined ? {} : { inputFailure }),
    };
}
/**
 * The value the bridge resolves a completed child with: a child that reached
 * a success terminal, or an older child that published no terminal kind,
 * resolves with its own output and reaches `onDone`.
 */
function nestedSuccessOutput() {
    return {
        outcome: 'terminal',
        state: { value: 'done', context: {} },
        output: { response: 'coverage: nested playbook completed' },
        response: 'coverage: nested playbook completed',
    };
}
function nestedFailure(playbookId) {
    const error = new Error('coverage: forced nested playbook failure');
    Object.defineProperty(error, 'result', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: {
            status: 'error',
            playbookId,
            error: {
                name: 'Error',
                message: 'coverage: forced nested playbook failure',
            },
        },
    });
    return error;
}
/**
 * A child that completed at its own authored failure terminal. The bridge
 * rejects the call with that exact `ok` result, so a recovering first
 * `onError` arm written for it is satisfiable under probing.
 */
function nestedFailureTerminal(playbookId) {
    const terminal = {
        stateId: 'coverageFailureTerminal',
        kind: 'failure',
        description: 'coverage: the child reported its own failure terminal',
    };
    const error = new Error(`Child playbook ${playbookId} reached failure terminal ${terminal.stateId}`);
    error.name = 'NestedPlaybookCallError';
    Object.defineProperty(error, 'result', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: {
            status: 'ok',
            playbookId,
            childSessionId: 'coverage-child-session',
            output: { response: 'coverage: nested playbook failure terminal' },
            terminal,
        },
    });
    return error;
}
function assignedPayload(base, assignment, tag) {
    return overlaidObject(base, assignment.payloads[tag] ?? {});
}
/**
 * Finds a valid Captain result that populates a dynamic call's target and text
 * before entering it. This exercises the authored assignment and exact catalog
 * guard instead of jumping into the call with impossible empty context.
 */
function playbookEntryPlan(machine, playbook, refs, captains, dynamic) {
    const context = initializedCoverageContext(machine, dynamic);
    for (const captain of captains) {
        const arms = transitionArms(captain.invocation.onDone);
        for (const [armIndex, arm] of arms.entries()) {
            const rawTarget = rawArmTarget(arm);
            if (rawTarget === undefined ||
                !targetEntersRef(refs, stateRefForTarget(refs, rawTarget, captain.ref), playbook.ref)) {
                continue;
            }
            for (const key of Object.keys(captain.binding.result)) {
                const output = {
                    ...synthOutput(captain.binding, key),
                    [dynamic.playbookIdContext]: COVERAGE_PLAYBOOK_ID,
                    [dynamic.textContext]: COVERAGE_PLAYBOOK_INPUT,
                };
                if (directlySelectedArm(machine, captain, output, context) === armIndex) {
                    return { captain, output };
                }
            }
        }
    }
    return undefined;
}
/**
 * Finds a child-success path into a Captain state whose public interrupt has
 * valid accumulated-context preconditions (for example Captain reassessment
 * after one child call). The checker then drives the authored predecessor
 * instead of manufacturing context or treating the guarded jump as dead.
 */
function captainPredecessorPlan(machine, target, playbooks, refs, captains) {
    const candidateValues = refs.flatMap((ref) => [
        ref.key,
        ref.stableId,
        ...(ref.configId === undefined ? [] : [ref.configId]),
    ]);
    for (const playbook of playbooks) {
        const dynamic = dynamicPlaybookFields(playbook);
        const entry = dynamic === undefined
            ? undefined
            : playbookEntryPlan(machine, playbook, refs, captains, dynamic);
        if (dynamic !== undefined && entry === undefined)
            continue;
        if (entry !== undefined && sameStateRef(entry.captain.ref, target.ref)) {
            continue;
        }
        const actorId = invocationActorId(machine, playbook);
        const fixedEvent = {
            type: `xstate.done.actor.${actorId}`,
            actorId,
        };
        const arms = transitionArms(playbook.invocation.onDone);
        for (const [armIndex, arm] of arms.entries()) {
            const rawTarget = rawArmTarget(arm);
            if (rawTarget === undefined ||
                !targetEntersRef(refs, stateRefForTarget(refs, rawTarget, playbook.ref), target.ref)) {
                continue;
            }
            const guard = orderedArmPredicate(machine, arms, armIndex);
            if (guard === undefined)
                continue;
            for (const base of [
                nestedSuccessOutput(),
                { invalidCoverageOutput: undefined },
            ]) {
                const assignment = probeGuardAssignment(guard.run, fixedEvent, [{ eventField: 'output', tag: 'o:', base }], [...guard.probeValues, ...candidateValues], {
                    initialContext: initializedCoverageContext(machine, dynamic),
                    assignContext: false,
                });
                if (assignment !== undefined) {
                    return {
                        playbook,
                        ...(entry === undefined ? {} : { entry }),
                        childOutput: assignedPayload(base, assignment, 'o:'),
                    };
                }
            }
        }
    }
    return undefined;
}
/**
 * Finds a controller path from a hub event to an acting state. Controller-only
 * intermediate states are entered through earlier Captain results rather than
 * through the ordinary workflow interrupt surface.
 */
function controllerCaptainEntryPlan(machine, target, refs, captains, candidates, initialContext) {
    const queue = [];
    for (const captain of captains) {
        const drive = entryDriveForRef(machine, refs, captain.ref, candidates, initialContext);
        if (drive?.satisfiable === true) {
            queue.push({ captain, drive, preceding: [] });
        }
    }
    const visited = new Set();
    while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined)
            break;
        const key = stateRefKey(current.captain.ref);
        if (visited.has(key))
            continue;
        visited.add(key);
        if (sameStateRef(current.captain.ref, target.ref)) {
            return { drive: current.drive, preceding: current.preceding };
        }
        for (const resultKey of Object.keys(current.captain.binding.result)) {
            const output = synthOutput(current.captain.binding, resultKey);
            const nextRef = directTargetRef(machine, refs, current.captain, output, initialContext);
            const nextCaptain = captains.find((candidate) => targetEntersRef(refs, nextRef, candidate.ref));
            if (nextCaptain !== undefined &&
                !visited.has(stateRefKey(nextCaptain.ref))) {
                queue.push({
                    captain: nextCaptain,
                    drive: current.drive,
                    preceding: [
                        ...current.preceding,
                        { captain: current.captain, output },
                    ],
                });
            }
        }
    }
    return undefined;
}
function controllerCaptainExitPlan(machine, captain, output, refs, captains, hub, initialContext) {
    const firstTarget = directTargetRef(machine, refs, captain, output, initialContext);
    if (firstTarget === undefined)
        return { following: [], outcome: 'dead' };
    if (sameStateRef(firstTarget, hub) || firstTarget.state.type === 'final') {
        return { following: [], outcome: 'planned' };
    }
    const firstCaptain = captains.find((candidate) => targetEntersRef(refs, firstTarget, candidate.ref));
    if (firstCaptain === undefined) {
        return { following: [], outcome: 'runtime' };
    }
    const queue = [{ captain: firstCaptain, following: [] }];
    const visited = new Set();
    while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined)
            break;
        const currentKey = stateRefKey(current.captain.ref);
        if (visited.has(currentKey))
            continue;
        visited.add(currentKey);
        for (const resultKey of Object.keys(current.captain.binding.result)) {
            const nextOutput = synthOutput(current.captain.binding, resultKey);
            const following = [
                ...current.following,
                { captain: current.captain, output: nextOutput },
            ];
            const nextRef = directTargetRef(machine, refs, current.captain, nextOutput, initialContext);
            if (nextRef === undefined)
                continue;
            if (sameStateRef(nextRef, hub) || nextRef.state.type === 'final') {
                return { following, outcome: 'planned' };
            }
            const nextCaptain = captains.find((candidate) => targetEntersRef(refs, nextRef, candidate.ref));
            if (nextCaptain !== undefined &&
                !visited.has(stateRefKey(nextCaptain.ref))) {
                queue.push({ captain: nextCaptain, following });
            }
        }
    }
    return { following: [], outcome: 'dead' };
}
function controllerCaptainProbeActor(machine, captain, result, gate, refs, captains, candidates, initialContext) {
    const entry = controllerCaptainEntryPlan(machine, captain, refs, captains, candidates, initialContext);
    if (entry === undefined)
        return undefined;
    const hub = initialActiveRefs(machine.config, refs).at(-1);
    const outcomes = [...entry.preceding, { captain, output: result }];
    let controllerExitPlanned;
    if (!(result instanceof Error)) {
        const exit = controllerCaptainExitPlan(machine, captain, result, refs, captains, hub, initialContext);
        controllerExitPlanned =
            exit.outcome === 'runtime' ? undefined : exit.outcome === 'planned';
        outcomes.push(...exit.following);
    }
    const probedOccurrence = entry.preceding.length;
    let controllerResultConsumed = false;
    let controllerDirectTransitionTargets;
    let occurrence = 0;
    const actor = makeActor(machine, (input) => {
        if (!gate.armed)
            return null;
        const planned = outcomes[occurrence];
        if (planned === undefined)
            return null;
        const stateId = typeof input.stateId === 'string' ? input.stateId : undefined;
        const sourceItem = typeof input.sourceItem === 'string' ? input.sourceItem : undefined;
        const matchesState = stateId === undefined ||
            stateId === captainPublicStateId(planned.captain);
        const matchesSource = sourceItem === undefined ||
            sourceItem === planned.captain.binding.sourceItem;
        if ((stateId === undefined && sourceItem === undefined) ||
            !matchesState ||
            !matchesSource) {
            return null;
        }
        if (occurrence === probedOccurrence) {
            controllerResultConsumed = true;
        }
        occurrence += 1;
        return planned.output;
    }, () => null, entry.drive.context, (transition) => {
        if (controllerResultConsumed &&
            controllerDirectTransitionTargets === undefined &&
            transition.sourceId === resolvedStateNode(machine, captain.ref)?.id) {
            controllerDirectTransitionTargets = transition.targetIds;
        }
    });
    return {
        actor,
        event: entry.drive.event,
        controllerDirectTransitionTargets: () => controllerDirectTransitionTargets,
        ...(controllerExitPlanned === undefined ? {} : { controllerExitPlanned }),
    };
}
function captainProbeActor(machine, captain, result, gate, refs, captains, playbooks, interruptValues, controllerContext) {
    if (controllerContext !== undefined) {
        return controllerCaptainProbeActor(machine, captain, result, gate, refs, captains, interruptValues, controllerContext);
    }
    const predecessor = captainPredecessorPlan(machine, captain, playbooks, refs, captains);
    if (predecessor === undefined) {
        // A root BOSS_INTERRUPT makes the interrupt route PREFERRED, not exclusive.
        // A state legitimately outside the interrupt target set - every script
        // state, since a script state is not agent-invoking and so cannot receive a
        // Boss turn - is still entered by its own typed entry event. Falling back to
        // the entry drive keeps such a state auditable instead of reporting it
        // unreachable.
        const interruptDrive = transitionArms((machine.config.on ?? {})[INTERRUPT_EVENT]).length > 0
            ? interruptDriveForRef(machine, refs, captain.ref, captainInterruptTarget(captain), interruptValues)
            : undefined;
        const drive = interruptDrive?.satisfiable === true
            ? interruptDrive
            : entryDriveForRef(machine, refs, captain.ref, interruptValues);
        if (drive === undefined || !drive.satisfiable)
            return undefined;
        return {
            actor: makeActor(machine, result instanceof Error
                ? throwingScript(captain.binding.sourceItem, gate)
                : onceScript(captain.binding.sourceItem, result, gate), () => null, drive.context),
            event: drive.event,
        };
    }
    let entryUsed = false;
    let targetUsed = false;
    let childUsed = false;
    const actorId = invocationActorId(machine, predecessor.playbook);
    const dynamic = dynamicPlaybookFields(predecessor.playbook);
    const entryRef = predecessor.entry?.captain.ref ?? predecessor.playbook.ref;
    const entryId = predecessor.entry === undefined
        ? interruptTargetForRef(predecessor.playbook.ref, predecessor.playbook.ref.stableId)
        : captainInterruptTarget(predecessor.entry.captain);
    const drive = interruptDriveForRef(machine, refs, entryRef, entryId, interruptValues);
    if (!drive.satisfiable)
        return undefined;
    const actor = makeActor(machine, (input) => {
        if (!gate.armed)
            return null;
        if (predecessor.entry !== undefined &&
            !entryUsed &&
            input.sourceItem === predecessor.entry.captain.binding.sourceItem) {
            entryUsed = true;
            return predecessor.entry.output;
        }
        if (!targetUsed && input.sourceItem === captain.binding.sourceItem) {
            targetUsed = true;
            return result;
        }
        return null;
    }, (input, invokedActorId) => {
        if (!gate.armed ||
            childUsed ||
            invokedActorId !== actorId ||
            input.stateId !== predecessor.playbook.ref.stableId ||
            (dynamic !== undefined &&
                (input.playbookId !== COVERAGE_PLAYBOOK_ID ||
                    input.text !== COVERAGE_PLAYBOOK_INPUT))) {
            return null;
        }
        childUsed = true;
        return predecessor.childOutput;
    }, drive.context);
    return {
        actor,
        event: drive.event,
    };
}
/**
 * Drives one nested invocation outcome. Literal calls enter through their
 * public id; dynamic calls first take a valid Captain transition that writes
 * the target/text context. The one-shot child is selected by both its resolved
 * XState actor id and its `PlaybookInput.stateId`; every other child remains
 * parked until actor stop.
 */
async function probePlaybookOutcome(machine, playbook, refs, captains, outcome, interruptValues) {
    const rawArms = transitionArms(outcome === 'onDone'
        ? playbook.invocation.onDone
        : playbook.invocation.onError);
    if (rawArms.length === 0) {
        return [
            `state ${playbook.ref.stableId} declares no nested playbook ${outcome} transition`,
        ];
    }
    const node = { kind: 'child', value: playbook };
    const candidateValues = [
        ...interruptValues,
        ...refs.flatMap((ref) => [
            ref.key,
            ref.stableId,
            ...(ref.configId === undefined ? [] : [ref.configId]),
        ]),
    ];
    const findings = [];
    for (const [armIndex, arm] of rawArms.entries()) {
        await coverageYield();
        const rawGuard = armGuard(arm);
        if (rawGuard !== undefined &&
            resolveGuard(machine, rawGuard) === undefined) {
            findings.push(`state ${playbook.ref.stableId}: nested playbook ${outcome} arm ${armIndex} names an unresolvable guard "${guardLabel(rawGuard)}"`);
            continue;
        }
        const rawTarget = rawArmTarget(arm);
        const target = rawTarget === undefined
            ? undefined
            : stateRefForTarget(refs, rawTarget, playbook.ref);
        if (rawTarget === undefined || target === undefined) {
            findings.push(`state ${playbook.ref.stableId}: nested playbook ${outcome} arm ${armIndex} has no observable target`);
            continue;
        }
        if (sameStateRef(target, playbook.ref)) {
            findings.push(`state ${playbook.ref.stableId}: nested playbook ${outcome} arm ${armIndex} does not leave the call state`);
            continue;
        }
        let satisfiable = false;
        const result = await searchCoverageEntry(machine, node, refs, captains, playbookRefs(machine.config), candidateValues, async (actor, pending) => {
            const outputs = coverageArmResults(machine, node, outcome, armIndex, actor.getSnapshot().context, pending.input, candidateValues, undefined, undefined, false, true);
            if (outputs.length === 0)
                return false;
            satisfiable = true;
            pending.complete(outputs[0]);
            return await settle(actor, atState(target), PARALLEL_SETTLE_MS);
        });
        if (result.covered)
            continue;
        const label = `state ${playbook.ref.stableId}: nested playbook ${outcome} arm ${armIndex}`;
        if (result.limitation !== undefined)
            findings.push(`${label}: ${result.limitation}`);
        else if (result.inputFailure !== undefined && !result.entered)
            findings.push(`state ${playbook.ref.stableId}: nested playbook actor failed to start during ${outcome} coverage: ${result.inputFailure}`);
        else if (!result.entered)
            findings.push(`${label} has no reachable entry under probing (dead or unsupported entry path)`);
        else if (!satisfiable)
            findings.push(`${label} is unsatisfiable under probing`);
        else
            findings.push(`${label} did not reach ${target.stableId}`);
    }
    return findings;
}
/** No preemption is needed to audit ordinary acting outcomes and one reply. */
async function probeNonPreemptiveActor(machine, captain, refs, captains, playbooks, candidates) {
    const node = { kind: 'acting', value: captain };
    const findings = [];
    const stateId = captainPublicStateId(captain);
    const label = `state ${stateId}`;
    const search = (check) => searchCoverageEntry(machine, node, refs, captains, playbooks, candidates, check);
    const detail = (result) => result.limitation ??
        (result.inputFailure !== undefined
            ? `actor failed to start: ${result.inputFailure}`
            : result.entered
                ? 'no candidate completed at the declared target under reached-context probing'
                : 'no reachable entry under probing (dead or unsupported entry path)');
    for (const key of Object.keys(captain.binding.result)) {
        await coverageYield();
        const check = (blankReply) => search(async (actor, pending) => {
            for (const [index, arm] of transitionArms(captain.invocation.onDone).entries()) {
                const outputs = coverageArmResults(machine, node, 'onDone', index, actor.getSnapshot().context, pending.input, candidates, undefined, key, false, true);
                if (outputs.length === 0)
                    continue;
                const targetName = rawArmTarget(arm);
                const target = targetName === undefined
                    ? undefined
                    : stateRefForTarget(refs, targetName, captain.ref);
                if (target === undefined || sameStateRef(target, captain.ref))
                    return false;
                pending.complete(outputs[0]);
                if (!(await settle(actor, atState(target), PARALLEL_SETTLE_MS)))
                    return false;
                if (key !== NEEDS_BOSS_REPLY)
                    return true;
                if (target.stableId !== AWAIT_BOSS_REPLY_STATE &&
                    !tagsOf(target.state).includes('playbook.parked'))
                    return false;
                if (!blankReply && target.stableId !== AWAIT_BOSS_REPLY_STATE) {
                    actor.send({
                        type: BOSS_REPLY_EVENT,
                        questionId: 'coverage-unknown-question',
                        answer: 'This answer belongs to no pending branch.',
                    });
                    await settleNoTransition();
                    if (!atState(target)(actor.getSnapshot()))
                        return false;
                }
                actor.send({
                    type: BOSS_REPLY_EVENT,
                    questionId: stateId,
                    answer: blankReply ? '   ' : 'Proceed as planned.',
                });
                if (blankReply) {
                    await settleNoTransition();
                    return !atState(captain.ref)(actor.getSnapshot());
                }
                return await settle(actor, atState(captain.ref), PARALLEL_SETTLE_MS);
            }
            return false;
        });
        const result = await check(false);
        if (!result.covered)
            findings.push(`${label}: result "${key}" remains unproved: ${detail(result)}`);
        if (key === NEEDS_BOSS_REPLY && result.covered) {
            const blank = await check(true);
            if (!blank.covered)
                findings.push(`${label}: a blank ${BOSS_REPLY_EVENT} answer must not resume the state (${detail(blank)})`);
        }
    }
    for (const outcome of ['onDone', 'onError']) {
        await coverageYield();
        const arms = transitionArms(captain.invocation[outcome]);
        if (outcome === 'onError' && arms.length === 0)
            findings.push(`${label} declares no onError transition`);
        for (const [index, arm] of arms.entries()) {
            await coverageYield();
            const rawGuard = armGuard(arm);
            if (outcome === 'onDone' && rawGuard === undefined)
                continue;
            if (rawGuard !== undefined &&
                resolveGuard(machine, rawGuard) === undefined) {
                findings.push(`${label}: ${outcome} arm ${index} names an unresolvable guard "${guardLabel(rawGuard)}"`);
                continue;
            }
            const targetName = rawArmTarget(arm);
            const target = targetName === undefined
                ? undefined
                : stateRefForTarget(refs, targetName, captain.ref);
            if (target === undefined || sameStateRef(target, captain.ref)) {
                findings.push(`${label}: ${outcome} arm ${index} has no distinct observable target`);
                continue;
            }
            const result = await search(async (actor, pending) => {
                const outputs = coverageArmResults(machine, node, outcome, index, actor.getSnapshot().context, pending.input, candidates, undefined, undefined, true, true);
                if (outputs.length === 0)
                    return false;
                pending.complete(outputs[0]);
                return await settle(actor, atState(target), PARALLEL_SETTLE_MS);
            });
            if (!result.covered)
                findings.push(`${label}: ${outcome} arm ${index} remains unproved: ${detail(result)}`);
        }
    }
    return findings;
}
async function probePlaybookInvocation(machine, playbook, refs, captains, interruptValues) {
    return [
        ...(await probePlaybookOutcome(machine, playbook, refs, captains, 'onDone', interruptValues)),
        ...(await probePlaybookOutcome(machine, playbook, refs, captains, 'onError', interruptValues)),
    ];
}
async function probeParallelQuestions(machine, parallel, refs, captains, interruptValues) {
    const branches = parallelBranchCaptains(parallel, refs, captains);
    const plans = branches.flatMap((captain) => {
        if (captain.binding.result[NEEDS_BOSS_REPLY] === undefined)
            return [];
        const output = synthOutput(captain.binding, NEEDS_BOSS_REPLY);
        const wait = directTargetRef(machine, refs, captain, output);
        if (wait === undefined ||
            (wait.stableId !== AWAIT_BOSS_REPLY_STATE &&
                !tagsOf(wait.state).includes('playbook.parked'))) {
            return [];
        }
        return [{ captain, output, wait }];
    });
    if (plans.length < 2)
        return [];
    const drive = interruptDriveForRef(machine, refs, parallel, parallel.stableId, interruptValues);
    const { script, calls } = scriptedOutputs(plans);
    const actor = makeActor(machine, script, () => null, drive.context);
    actor.send(drive.event);
    const parked = await settle(actor, (snapshot) => plans.every(({ wait }) => atState(wait)(snapshot)), PARALLEL_QUESTION_SETTLE_MS);
    if (!parked) {
        actor.stop();
        return [
            `parallel state ${parallel.stableId}: branch questions did not become simultaneously pending`,
        ];
    }
    const [selected, ...others] = plans;
    actor.send({
        type: BOSS_REPLY_EVENT,
        questionId: captainPublicStateId(selected.captain),
        answer: 'Continue only this branch.',
    });
    const isolated = await settle(actor, (snapshot) => callCount(calls, selected.captain) >= 2 &&
        atState(selected.captain.ref)(snapshot) &&
        others.every(({ wait }) => atState(wait)(snapshot)), PARALLEL_QUESTION_SETTLE_MS);
    actor.stop();
    return isolated
        ? []
        : [
            `parallel state ${parallel.stableId}: a keyed Boss reply did not resume exactly one pending branch`,
        ];
}
function combinations(lists, limit = MAX_PARALLEL_COMBINATIONS) {
    let out = [[]];
    for (const list of lists) {
        out = out.flatMap((prefix) => list.map((item) => [...prefix, item]));
        if (out.length > limit)
            return out.slice(0, limit);
    }
    return out;
}
async function probeParallelJoins(machine, parallel, refs, captains, interruptValues) {
    const arms = transitionArms(parallel.state.onDone);
    if (arms.length === 0)
        return [];
    const branches = parallelBranchCaptains(parallel, refs, captains);
    if (branches.length < 2) {
        return [
            `parallel state ${parallel.stableId}: onDone join coverage is unsupported without one Captain leaf per branch`,
        ];
    }
    const branchOutputs = branches.map((captain) => Object.keys(captain.binding.result).flatMap((key) => {
        if (key === NEEDS_BOSS_REPLY)
            return [];
        const output = synthOutput(captain.binding, key);
        const target = directTargetRef(machine, refs, captain, output);
        return target?.state.type === 'final' ? [output] : [];
    }));
    if (branchOutputs.some((outputs) => outputs.length === 0)) {
        return [
            `parallel state ${parallel.stableId}: onDone join coverage is unsupported without a final-reaching branch result`,
        ];
    }
    const outputs = combinations(branchOutputs);
    const drive = interruptDriveForRef(machine, refs, parallel, parallel.stableId, interruptValues);
    const normalizedTargets = arms.map((arm) => rawArmTarget(arm) ?? null);
    const findings = [];
    for (const [armIndex, rawTarget] of normalizedTargets.entries()) {
        await coverageYield();
        if (rawTarget === null) {
            findings.push(`parallel state ${parallel.stableId}: onDone join arm ${armIndex} coverage is unsupported for a target-less arm`);
            continue;
        }
        const duplicateTarget = normalizedTargets.some((candidate, index) => index !== armIndex && candidate === rawTarget);
        const target = stateRefForTarget(refs, rawTarget, parallel);
        if (duplicateTarget || target === undefined) {
            findings.push(`parallel state ${parallel.stableId}: onDone join arm ${armIndex} coverage is unsupported because its target is not uniquely observable`);
            continue;
        }
        let exercised = false;
        for (const combination of outputs) {
            await coverageYield();
            const entries = branches.map((captain, index) => ({
                captain,
                output: combination[index],
            }));
            const { script, calls } = scriptedOutputs(entries);
            const actor = makeActor(machine, script, () => null, drive.context);
            actor.send(drive.event);
            exercised = await settle(actor, (snapshot) => sameStateRef(target, parallel)
                ? branches.every((captain) => callCount(calls, captain) >= 2) &&
                    branches.every((captain) => atState(captain.ref)(snapshot))
                : atState(target)(snapshot), PARALLEL_SETTLE_MS);
            actor.stop();
            if (exercised)
                break;
        }
        if (!exercised) {
            findings.push(`parallel state ${parallel.stableId}: onDone join arm ${armIndex} could not be exercised under bounded branch-result probing`);
        }
    }
    return findings;
}
/**
 * Derives a conservative Vitest timeout from the same bounded work performed
 * by {@link checkFsmCoverage}. It includes every possible async settle window,
 * the bounded parallel-combination surface, an allowance for each worst-case
 * guard search, and a final scheduling margin. Generated tests use this instead
 * of Vitest's five-second default.
 */
export function fsmCoverageTestTimeout(fsmModule) {
    const machine = findMachine(fsmModule);
    const config = machine.config;
    const refs = stateRefs(config);
    const captains = captainRefs(config);
    const playbooks = playbookRefs(config);
    const parallels = refs.filter((ref) => ref.state.type === 'parallel');
    const controller = isControllerMachine(config);
    const rootInterruptProbes = transitionArms((config.on ?? {})[INTERRUPT_EVENT]).length;
    const rootSettles = rootInterruptProbes * SETTLE_MS;
    const entryEvents = new Set([
        ...initialActiveRefs(config, refs).flatMap((ref) => Object.keys(ref.state.on ?? {})),
        ...Object.keys(config.on ?? {}),
    ]);
    entryEvents.delete(INTERRUPT_EVENT);
    const entrySettles = entryEvents.size * SETTLE_MS;
    let captainSettles = 0;
    let guardProbeCalls = rootInterruptProbes;
    let pathSearches = controller
        ? 0
        : playbooks.reduce((total, playbook) => total +
            transitionArms(playbook.invocation.onDone).length +
            transitionArms(playbook.invocation.onError).length, 0);
    for (const captain of captains) {
        const resultKeys = Object.keys(captain.binding.result);
        const guardedDoneArms = transitionArms(captain.invocation.onDone).filter((arm) => armGuard(arm) !== undefined).length;
        const errorArms = transitionArms(captain.invocation.onError).length;
        if (!controller && rootInterruptProbes === 0) {
            pathSearches +=
                resultKeys.length +
                    (resultKeys.includes(NEEDS_BOSS_REPLY) ? 1 : 0) +
                    guardedDoneArms +
                    errorArms;
            continue;
        }
        captainSettles +=
            resultKeys.reduce((total, key) => total + (key === NEEDS_BOSS_REPLY ? 4 : controller ? 2 : 1), 0) * SETTLE_MS;
        // One directly selectable onError arm is driven.
        captainSettles += SETTLE_MS;
        // Acceptance includes ordered fallbacks. Script arm probes have one zero
        // status and a capped set of nonzero statuses; ordinary actors also probe
        // malformed bare outputs for defensive arms.
        const resultCandidates = captain.binding.actor === 'script'
            ? 1 + MAX_SCRIPT_EXIT_STATUSES
            : resultKeys.length;
        guardProbeCalls +=
            resultCandidates * transitionArms(captain.invocation.onDone).length +
                guardedDoneArms *
                    (captain.binding.actor === 'script'
                        ? resultCandidates
                        : resultKeys.length * 2) +
                errorArms;
        // Every result, the blank Boss-reply check, and onError enter through an
        // independently context-probed interrupt plan.
        guardProbeCalls +=
            resultKeys.length + (resultKeys.includes(NEEDS_BOSS_REPLY) ? 1 : 0) + 1;
    }
    const nodes = coverageNodes(captains, playbooks);
    const entryArmCount = [
        config.on ?? {},
        ...initialActiveRefs(config, refs).map((ref) => ref.state.on ?? {}),
    ].reduce((total, events) => total +
        Object.values(events).reduce((count, arms) => count + transitionArms(arms).length, 0), 0);
    const maxNodeCandidates = Math.max(0, ...nodes.map((node) => {
        const done = transitionArms(node.value.invocation.onDone).length;
        const error = transitionArms(node.value.invocation.onError).length;
        if (node.kind === 'child')
            return 3 * (done + error);
        const keys = Object.keys(node.value.binding.result);
        const candidates = node.value.binding.actor === 'script'
            ? keys.length * MAX_SCRIPT_EXIT_STATUSES
            : 2 * keys.length;
        // Target malformed-output probes and predecessor question revisits both
        // fit this allowance; real searches stop early on a satisfying target.
        return (done * (candidates + (keys.includes(NEEDS_BOSS_REPLY) ? 1 : 0)) + error);
    }));
    guardProbeCalls +=
        pathSearches *
            (nodes.length * (1 + entryArmCount) +
                MAX_COVERAGE_PATH_ATTEMPTS * 2 * maxNodeCandidates);
    // Parallel question/join helpers retain their independent entry probes.
    guardProbeCalls += 2 * parallels.length;
    // Each charged replay contains at most eight invocation waits, one parked
    // question wait and two target/reply settles, plus no-transition checks.
    const pathSettles = pathSearches *
        MAX_COVERAGE_PATH_ATTEMPTS *
        ((MAX_COVERAGE_PATH_STEPS + 3) * PARALLEL_SETTLE_MS + 2 * 10);
    const parallelSettles = parallels.reduce((total, parallel) => total +
        2 * PARALLEL_QUESTION_SETTLE_MS +
        transitionArms(parallel.state.onDone).length *
            MAX_PARALLEL_COMBINATIONS *
            PARALLEL_SETTLE_MS, 0);
    const guardAllowance = guardProbeCalls * Math.ceil(MAX_PROBES / PROBES_PER_TIMEOUT_MILLISECOND);
    return Math.min(MAX_COVERAGE_TEST_TIMEOUT_MS, Math.max(MIN_COVERAGE_TEST_TIMEOUT_MS, rootSettles +
        entrySettles +
        captainSettles +
        pathSettles +
        parallelSettles +
        guardAllowance +
        COVERAGE_TIMEOUT_MARGIN_MS));
}
/**
 * Checks transition coverage over a compiled `playbook` artifact's machine
 * (verification-6) and returns findings (empty when every declared transition is
 * reachable). Drives the machine through the `gears2fsm` surfaces it
 * declares; a workflow without pre-emption may omit the `BOSS_INTERRUPT`
 * surface entirely, in which case interrupt coverage is skipped.
 */
export async function checkFsmCoverage(fsmModule, opts = {}) {
    opts.signal?.throwIfAborted();
    if (opts.timeoutMs !== undefined &&
        (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0))
        throw new RangeError('FSM coverage timeout must be a positive finite number');
    const started = performance.now();
    const run = {
        signal: opts.signal,
        deadline: started +
            Math.min(opts.timeoutMs ?? Infinity, MAX_COVERAGE_TEST_TIMEOUT_MS),
        lastYield: started,
        actors: new Set(),
    };
    return coverageRuns.run(run, async () => {
        let completed = false;
        try {
            run.deadline = Math.min(run.deadline, started + fsmCoverageTestTimeout(fsmModule));
            await coverageYield(true);
            const findings = await runFsmCoverage(fsmModule, opts.sourceText ?? '');
            await coverageYield(true);
            completed = true;
            return findings;
        }
        finally {
            stopCoverageActors(run.actors, !completed);
        }
    });
}
async function runFsmCoverage(fsmModule, sourceText) {
    const findings = [];
    const machine = findMachine(fsmModule);
    const config = machine.config;
    const states = (config.states ?? {});
    const refs = stateRefs(config);
    const captains = captainRefs(config);
    const playbooks = playbookRefs(config);
    const captainByRef = new Map(captains.map((captain) => [stateRefKey(captain.ref), captain]));
    const sourceCandidates = [
        ...identifierLiterals(sourceText),
        ...numericLiterals(sourceText),
    ];
    const isController = isControllerMachine(config);
    const controllerNearMisses = captains.flatMap((captain) => {
        if (captain.binding.actor !== 'captain' ||
            captain.binding.result[NEEDS_BOSS_REPLY] !== undefined) {
            return [];
        }
        const nearMiss = controllerDecisionNearMiss(captain.binding.result);
        return nearMiss === undefined ? [] : [{ captain, nearMiss }];
    });
    const controllerContractCandidate = isController || controllerNearMisses.length > 0;
    const initialCoverageContext = initializedCoverageContext(machine);
    const controllerContext = isController ? initialCoverageContext : undefined;
    const parallelRefs = refs.filter((ref) => ref.state.type === 'parallel');
    findings.push(...repeatedParallelRoleFindings(refs, captains));
    for (const { captain, nearMiss } of controllerNearMisses) {
        await coverageYield();
        const detail = nearMiss.missing.length > 0
            ? `missing ${JSON.stringify(nearMiss.missing[0])}`
            : `extra ${JSON.stringify(nearMiss.extra[0])}`;
        findings.push(`state ${captain.binding.stateId}: controller decision contract near-miss (${detail}); the controller domain requires exactly ${nearMiss.domain.join(', ')}`);
    }
    for (const ref of parallelRefs) {
        await coverageYield();
        if (!normalizeArms(ref.state.onDone).some((arm) => arm.target !== null)) {
            findings.push(`parallel state ${ref.stableId} declares no onDone join`);
        }
    }
    for (const ref of refs.filter((candidate) => candidate.key === 'failed' ||
        candidate.configId === 'failed' ||
        candidate.stableId === 'failed')) {
        if (ref.state.meta?.playbook !== undefined &&
            !tagsOf(ref.state).includes('playbook.parked')) {
            findings.push(`recoverable failure state ${ref.stableId} lacks playbook.parked tag`);
        }
    }
    const finalStates = Object.entries(states).filter(([, state]) => state.type === 'final');
    if (finalStates.length === 0) {
        findings.push('machine declares no final state');
    }
    const controllerHasPlayer = isController &&
        captains.some((captain) => captain.binding.actor === 'player');
    const controllerHasPlaybook = isController && playbooks.length > 0;
    const controllerHasParallel = isController && parallelRefs.length > 0;
    if (controllerHasPlayer) {
        findings.push('controller machine declares delegated-player invocation');
    }
    if (controllerHasPlaybook) {
        findings.push('controller machine declares nested-playbook invocation');
    }
    if (controllerHasParallel) {
        findings.push('controller machine declares parallel state');
    }
    const unsupportedController = controllerHasPlayer || controllerHasPlaybook || controllerHasParallel;
    const rootArms = normalizeArms((config.on ?? {})[INTERRUPT_EVENT]);
    const canJump = rootArms.length > 0;
    // A workflow without pre-emption declares no interrupt surface at all
    // (gears2fsm.md "Boss entry events vs. BOSS_INTERRUPT"); only a machine
    // that handles the event somewhere but not at the root is malformed.
    // Prompt text merely mentioning the event name does not count.
    const handlesInterruptSomewhere = refs.some((ref) => Object.hasOwn(ref.state.on ?? {}, INTERRUPT_EVENT));
    if (!canJump && handlesInterruptSomewhere && !controllerContractCandidate) {
        findings.push(`machine declares no root ${INTERRUPT_EVENT} event`);
    }
    if (!isController) {
        for (const playbook of playbooks) {
            await coverageYield();
            findings.push(...(await probePlaybookInvocation(machine, playbook, refs, captains, sourceCandidates)));
        }
        for (const parallel of canJump ? parallelRefs : []) {
            await coverageYield();
            findings.push(...(await probeParallelQuestions(machine, parallel, refs, captains, sourceCandidates)), ...(await probeParallelJoins(machine, parallel, refs, captains, sourceCandidates)));
        }
    }
    const waitStates = refs.filter((ref) => ref.stableId === AWAIT_BOSS_REPLY_STATE ||
        (tagsOf(ref.state).includes('playbook.parked') &&
            ref.state.on?.[BOSS_REPLY_EVENT] !== undefined));
    if (isController && waitStates.length > 0) {
        findings.push('controller machine declares a Boss-reply wait state');
    }
    else if (!controllerContractCandidate && waitStates.length === 0) {
        findings.push(`machine declares no ${AWAIT_BOSS_REPLY_STATE} state or branch-local Boss-reply wait state`);
    }
    // Every BOSS_INTERRUPT target is enterable (the captain hangs, so entering a
    // captain state parks in it).
    if (canJump) {
        for (const [armIndex, arm] of rootArms.entries()) {
            await coverageYield();
            if (arm.target === null)
                continue;
            const target = stateRefForTarget(refs, arm.target);
            const targetPlaybook = playbooks.find((playbook) => target !== undefined && sameStateRef(playbook.ref, target));
            const targetCaptain = target === undefined
                ? undefined
                : captainByRef.get(stateRefKey(target));
            const targetId = targetCaptain === undefined
                ? (target?.stableId ?? arm.target)
                : captainPublicStateId(targetCaptain);
            if (target === undefined) {
                findings.push(`${INTERRUPT_EVENT} target ${arm.target} is not enterable`);
                continue;
            }
            const drive = interruptDriveForRef(machine, refs, target, targetId, sourceCandidates, armIndex);
            if (!drive.satisfiable) {
                findings.push(`${INTERRUPT_EVENT} target ${arm.target} is unsatisfiable under context/event probing`);
                continue;
            }
            const actor = makeActor(machine, () => null, () => null, drive.context);
            actor.send(drive.event);
            const entered = await settle(actor, atState(target));
            if (!entered &&
                !(targetPlaybook !== undefined && actor.coverageErrors.length > 0)) {
                findings.push(`${INTERRUPT_EVENT} target ${arm.target} is not enterable`);
            }
            actor.stop();
        }
    }
    // Guard-free root entry events transition from the initial state.
    const initialPath = initialActiveRefs(config, refs);
    const initialRef = initialPath.at(-1);
    const entryArms = Object.assign({}, config.on ?? {}, ...initialPath.map((ref) => ref.state.on ?? {}));
    for (const [event, raw] of Object.entries(entryArms)) {
        await coverageYield();
        if (event === INTERRUPT_EVENT)
            continue;
        const arms = normalizeArms(raw);
        const free = arms.find((arm) => !arm.guarded &&
            arm.target !== null &&
            arm.target !== initialRef?.key &&
            arm.target !== initialRef?.stableId);
        if (free === undefined)
            continue;
        const actor = makeActor(machine, () => null);
        actor.send({ type: event });
        if (initialRef === undefined ||
            !(await settle(actor, leftState(initialRef)))) {
            findings.push(`root event ${event} fired no transition`);
        }
        actor.stop();
    }
    const stateCandidates = refs.flatMap((ref) => [
        ref.key,
        ref.stableId,
        ...(ref.configId === undefined ? [] : [ref.configId]),
    ]);
    // Playbook 10 controllers are host decision loops. Player delegation,
    // nested playbook invocation, and parallel regions are invalid controller
    // surfaces, so their explicit findings above own the result; do not mask
    // them by trying the ordinary workflow drivers against an unsupported shape.
    if (unsupportedController)
        return findings;
    for (const captain of captains) {
        await coverageYield();
        if (!canJump && !isController) {
            findings.push(...(await probeNonPreemptiveActor(machine, captain, refs, captains, playbooks, [...stateCandidates, ...sourceCandidates])));
            continue;
        }
        const state = captain.binding;
        const stateKey = state.stateId;
        const stateId = captainPublicStateId(captain);
        const candidates = [...stateCandidates, ...sourceCandidates];
        const doneEvent = invocationEvent(machine, captain, 'done');
        const errorEvent = invocationEvent(machine, captain, 'error');
        const rawDoneArms = transitionArms(captain.invocation.onDone);
        const onDoneArms = normalizeArms(captain.invocation.onDone);
        const controllerResultByArm = new Map();
        // Every declared result needs an ordered arm accepting its valid output.
        // A fallback is reachable exactly when all preceding guards reject it.
        // Result names alone cannot distinguish authored failure from an orphan.
        for (const key of Object.keys(state.result)) {
            await coverageYield();
            const output = synthOutput(state, key);
            const accepting = new Map();
            const acceptedOutputs = new Map();
            for (const [index, arm] of rawDoneArms.entries()) {
                await coverageYield();
                const target = onDoneArms[index]?.target ?? null;
                const rawGuard = armGuard(arm);
                if (target === null ||
                    (rawGuard !== undefined &&
                        resolveGuard(machine, rawGuard) === undefined)) {
                    continue;
                }
                // A controller's final defensive fallback rejects malformed actor
                // output. It is not a second business action for a valid result,
                // provided the parked leaf it enters cannot leave by itself.
                const targetRef = stateRefForTarget(refs, target, captain.ref);
                if (isControllerDecisionResult(state.result) &&
                    rawGuard === undefined &&
                    index === rawDoneArms.length - 1 &&
                    targetRef !== undefined &&
                    tagsOf(targetRef.state).includes('playbook.parked') &&
                    targetRef.state.invoke === undefined &&
                    targetRef.state.states === undefined &&
                    !Object.hasOwn(targetRef.state, 'always') &&
                    !Object.hasOwn(targetRef.state, 'after') &&
                    !raisesEvent(machine, targetRef.state.entry) &&
                    !raisesEvent(machine, targetRef.state.exit) &&
                    !rawDoneArms
                        .slice(0, index)
                        .some((otherArm) => stateRefForTarget(refs, rawArmTarget(otherArm) ?? '', captain.ref) === targetRef) &&
                    transitionArms(captain.invocation.onError).some((errorArm, errorIndex, errorArms) => errorIndex === errorArms.length - 1 &&
                        armGuard(errorArm) === undefined &&
                        stateRefForTarget(refs, rawArmTarget(errorArm) ?? '', captain.ref) === targetRef)) {
                    continue;
                }
                const guard = orderedArmPredicate(machine, rawDoneArms, index);
                if (guard === undefined)
                    continue;
                if (isController) {
                    const assignment = controllerDoneGuardAssignment(guard, doneEvent, output, candidates, initialCoverageContext);
                    if (assignment !== undefined)
                        accepting.set(index, assignment);
                }
                else {
                    const outputs = resultOutputCandidates(state, key, [
                        ...(resolveGuard(machine, rawGuard)?.probeValues ?? []),
                        ...candidates,
                    ]);
                    for (const candidate of outputs) {
                        await coverageYield();
                        if (doneGuardSatisfiable(guard, doneEvent, candidate, candidates, state.actor === 'script')) {
                            accepting.set(index, undefined);
                            acceptedOutputs.set(JSON.stringify(candidate), candidate);
                        }
                    }
                }
            }
            if (accepting.size === 0) {
                findings.push(`state ${stateKey}: result "${key}" has no reachable accepting transition`);
                continue;
            }
            let directArm;
            let drivenOutput = output;
            let drivenControllerContext = controllerContext;
            if (isController) {
                if (isControllerDecisionResult(state.result) && accepting.size !== 1) {
                    findings.push(`state ${stateKey}: controller result "${key}" selects ${accepting.size} accepting action arms`);
                    continue;
                }
                const selected = accepting.entries().next().value;
                directArm = selected?.[0];
                const assignment = selected?.[1];
                if (assignment !== undefined) {
                    drivenOutput = assignedPayload(output, assignment, 'o:');
                    drivenControllerContext = assignment.context;
                }
            }
            else {
                // Drive only when the first arm XState would inspect under the real
                // initial context is a known accepting arm. Encountering an unresolved
                // guard first makes driving unsafe: XState reports that error
                // asynchronously, so the arm audit below owns the finding (c887fc4).
                for (const candidate of acceptedOutputs.values()) {
                    await coverageYield();
                    const selected = directlySelectedArm(machine, captain, candidate, initialCoverageContext);
                    if (selected !== undefined && accepting.has(selected)) {
                        directArm = selected;
                        drivenOutput = candidate;
                        break;
                    }
                }
            }
            if (directArm === undefined) {
                continue;
            }
            let controllerDirectTarget;
            let controllerDirectTargetNodeId;
            if (isController) {
                if (isControllerDecisionResult(state.result)) {
                    const priorResult = controllerResultByArm.get(directArm);
                    if (priorResult !== undefined) {
                        findings.push(`state ${stateKey}: controller result "${key}" selects direct arm ${directArm}, already selected by result "${priorResult}"`);
                        continue;
                    }
                    controllerResultByArm.set(directArm, key);
                }
                const directTarget = rawArmTarget(rawDoneArms[directArm]);
                controllerDirectTarget =
                    directTarget === undefined
                        ? undefined
                        : stateRefForTarget(refs, directTarget, captain.ref);
                controllerDirectTargetNodeId =
                    controllerDirectTarget === undefined
                        ? undefined
                        : resolvedStateNode(machine, controllerDirectTarget)?.id;
                if (directTarget === undefined ||
                    controllerDirectTarget === undefined ||
                    controllerDirectTargetNodeId === undefined) {
                    findings.push(`state ${stateKey}: controller result "${key}" declares no resolvable direct action target`);
                    continue;
                }
            }
            const gate = { armed: false };
            const probe = captainProbeActor(machine, captain, drivenOutput, gate, refs, captains, playbooks, sourceCandidates, drivenControllerContext);
            if (probe === undefined) {
                const finding = `state ${stateKey} has no reachable entry transition`;
                if (!findings.includes(finding))
                    findings.push(finding);
                continue;
            }
            const actor = probe.actor;
            gate.armed = true;
            actor.send(probe.event);
            if (controllerDirectTarget !== undefined &&
                controllerDirectTargetNodeId !== undefined &&
                !(await settle(actor, () => probe
                    .controllerDirectTransitionTargets?.()
                    ?.includes(controllerDirectTargetNodeId) === true))) {
                findings.push(`state ${stateKey}: controller result "${key}" did not reach its declared direct action target ${controllerDirectTarget.stableId}`);
                actor.stop();
                continue;
            }
            const transitioned = isController && probe.controllerExitPlanned === false
                ? false
                : await settle(actor, isController
                    ? (snapshot) => snapshot.status === 'done' ||
                        (initialRef !== undefined && atState(initialRef)(snapshot))
                    : leftState(captain.ref));
            if (!transitioned) {
                findings.push(isController
                    ? `state ${stateKey}: controller result "${key}" reached neither the session hub nor a shutdown final`
                    : `state ${stateKey}: result "${key}" fired no transition`);
            }
            else if (key === NEEDS_BOSS_REPLY) {
                const waitTarget = rawArmTarget(rawDoneArms[directArm]) ?? onDoneArms[directArm]?.target;
                const waitRef = waitTarget === null || waitTarget === undefined
                    ? undefined
                    : stateRefForTarget(refs, waitTarget, captain.ref);
                if (waitRef === undefined ||
                    (waitRef.stableId !== AWAIT_BOSS_REPLY_STATE &&
                        !tagsOf(waitRef.state).includes('playbook.parked')) ||
                    !(await settle(actor, atState(waitRef)))) {
                    findings.push(`state ${stateKey}: ${NEEDS_BOSS_REPLY} did not suspend in ${AWAIT_BOSS_REPLY_STATE} or a branch-local Boss-reply wait state`);
                    actor.stop();
                    continue;
                }
                if (waitRef.stableId !== AWAIT_BOSS_REPLY_STATE) {
                    actor.send({
                        type: BOSS_REPLY_EVENT,
                        questionId: 'coverage-unknown-question',
                        answer: 'This answer belongs to no pending branch.',
                    });
                    await settleNoTransition();
                    if (!atState(waitRef)(actor.getSnapshot())) {
                        findings.push(`state ${stateKey}: an unknown ${BOSS_REPLY_EVENT} questionId moved the branch`);
                        actor.stop();
                        continue;
                    }
                }
                // Boss-reply resume: BOSS_REPLY returns to the suspended state, and a
                // blank answer must not resume it.
                actor.send({
                    type: BOSS_REPLY_EVENT,
                    questionId: stateId,
                    answer: 'Proceed as planned.',
                });
                if (!(await settle(actor, atState(captain.ref)))) {
                    findings.push(`state ${stateKey}: ${BOSS_REPLY_EVENT} did not resume the suspended state`);
                }
                actor.stop();
                const blankGate = { armed: false };
                const blankProbe = captainProbeActor(machine, captain, synthOutput(state, NEEDS_BOSS_REPLY), blankGate, refs, captains, playbooks, sourceCandidates, controllerContext);
                if (blankProbe === undefined) {
                    const finding = `state ${stateKey} has no reachable entry transition`;
                    if (!findings.includes(finding))
                        findings.push(finding);
                    continue;
                }
                const blank = blankProbe.actor;
                blankGate.armed = true;
                blank.send(blankProbe.event);
                if (await settle(blank, atState(waitRef))) {
                    blank.send({
                        type: BOSS_REPLY_EVENT,
                        questionId: stateId,
                        answer: '   ',
                    });
                    await settleNoTransition();
                    if (atState(captain.ref)(blank.getSnapshot())) {
                        findings.push(`state ${stateKey}: a blank ${BOSS_REPLY_EVENT} answer must not resume the state`);
                    }
                }
                blank.stop();
                continue;
            }
            actor.stop();
        }
        // Every onDone arm is satisfiable under the actual done-event identity.
        // Ordinary actors also probe bare malformed forms for authored defensive
        // arms. Scripts resolve only their exact runtime guard/exit-status pair;
        // invented payload fields or impossible statuses cannot cover an arm.
        for (const [index, arm] of rawDoneArms.entries()) {
            await coverageYield();
            const rawGuard = armGuard(arm);
            if (rawGuard === undefined)
                continue;
            const declaredGuard = resolveGuard(machine, rawGuard);
            if (declaredGuard === undefined) {
                findings.push(`state ${stateKey}: onDone arm ${index} names an unresolvable guard "${guardLabel(rawGuard)}"`);
                continue;
            }
            const guard = orderedArmPredicate(machine, rawDoneArms, index);
            // A prior unresolvable arm already owns the actionable finding, and makes
            // ordered reachability of later arms unsafe to evaluate.
            if (guard === undefined)
                continue;
            const anyOutput = Object.keys(state.result).some((key) => {
                const outputs = resultOutputCandidates(state, key, [
                    ...declaredGuard.probeValues,
                    ...candidates,
                ]);
                return (outputs.some((candidate) => doneGuardSatisfiable(guard, doneEvent, candidate, candidates, state.actor === 'script')) ||
                    (state.actor !== 'script' &&
                        doneGuardSatisfiable(guard, doneEvent, { guard: key }, candidates)));
            });
            if (!anyOutput) {
                findings.push(`state ${stateKey}: onDone arm ${index} (target ${onDoneArms[index]?.target ?? 'none'}) is unsatisfiable under probing`);
            }
        }
        // Audit every onError arm under the real error-event identity. Guarded arms
        // are probed deterministically; one directly selected arm is also driven to
        // confirm XState lands on its declared target.
        const rawErrorArms = transitionArms(captain.invocation.onError);
        const onErrorArms = normalizeArms(captain.invocation.onError);
        if (onErrorArms.length === 0) {
            findings.push(`state ${stateKey} declares no onError transition`);
            continue;
        }
        const forcedError = new Error('coverage: forced captain failure');
        let hasUnresolvableErrorGuard = false;
        for (const [index, arm] of rawErrorArms.entries()) {
            await coverageYield();
            const rawGuard = armGuard(arm);
            if (rawGuard !== undefined) {
                const declaredGuard = resolveGuard(machine, rawGuard);
                if (declaredGuard === undefined) {
                    hasUnresolvableErrorGuard = true;
                    findings.push(`state ${stateKey}: onError arm ${index} names an unresolvable guard "${guardLabel(rawGuard)}"`);
                    continue;
                }
            }
            const guard = orderedArmPredicate(machine, rawErrorArms, index);
            if (guard === undefined)
                continue;
            if (!errorGuardSatisfiable(guard, errorEvent, forcedError, candidates)) {
                findings.push(`state ${stateKey}: onError arm ${index} (target ${onErrorArms[index]?.target ?? 'none'}) is unsatisfiable under probing`);
            }
        }
        if (hasUnresolvableErrorGuard)
            continue;
        let directErrorArm;
        let errorDriveSafe = true;
        for (const [index, arm] of rawErrorArms.entries()) {
            await coverageYield();
            const rawGuard = armGuard(arm);
            if (rawGuard === undefined) {
                directErrorArm = index;
                break;
            }
            const guard = resolveGuard(machine, rawGuard);
            if (guard === undefined) {
                errorDriveSafe = false;
                break;
            }
            try {
                if (guard.run({
                    context: initialCoverageContext,
                    event: { ...errorEvent, error: forcedError },
                })) {
                    directErrorArm = index;
                    break;
                }
            }
            catch {
                coverageCheckpoint();
                errorDriveSafe = false;
                break;
            }
            finally {
                coverageCheckpoint();
            }
        }
        if (!errorDriveSafe || directErrorArm === undefined)
            continue;
        const target = onErrorArms[directErrorArm]?.target ?? null;
        const rawTarget = rawArmTarget(rawErrorArms[directErrorArm]) ?? target;
        const targetRef = rawTarget === null
            ? undefined
            : stateRefForTarget(refs, rawTarget, captain.ref);
        const gate = { armed: false };
        const probe = captainProbeActor(machine, captain, forcedError, gate, refs, captains, playbooks, sourceCandidates, controllerContext);
        if (probe === undefined) {
            const finding = `state ${stateKey} has no reachable entry transition`;
            if (!findings.includes(finding))
                findings.push(finding);
            continue;
        }
        const actor = probe.actor;
        gate.armed = true;
        actor.send(probe.event);
        const landed = await settle(actor, target !== null && targetRef !== undefined
            ? atState(targetRef)
            : leftState(captain.ref));
        if (!landed || (target !== null && targetRef === undefined)) {
            findings.push(`state ${stateKey}: onError arm ${directErrorArm} did not reach ${target ?? 'a quiescent state'}`);
        }
        actor.stop();
    }
    return findings;
}
/**
 * Builds a per-artifact vitest module running the transition-coverage check
 * beside the artifacts (verification-6).
 */
export function generateFsmCoverageTest(opts) {
    const commentBasename = JSON.stringify(opts.basename)
        .replaceAll('\u2028', '\\u2028')
        .replaceAll('\u2029', '\\u2029');
    const fsmModule = JSON.stringify(opts.fsmModule);
    const fsmSourceFile = JSON.stringify(opts.fsmSourceFile);
    const verifyModule = JSON.stringify(opts.verifyModule);
    const suiteName = JSON.stringify(`${opts.basename}: FSM coverage`);
    return `// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Generated by slc (DR-009): FSM transition coverage for ${commentBasename}.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { checkFsmCoverage, fsmCoverageTestTimeout } from ${verifyModule};
import * as fsm from ${fsmModule};

describe(${suiteName}, () => {
  it('reaches every declared transition', async () => {
    const sourceText = readFileSync(
      fileURLToPath(new URL(${fsmSourceFile}, import.meta.url)),
      'utf8',
    );
    expect(await checkFsmCoverage(fsm, { sourceText })).toEqual([]);
  }, fsmCoverageTestTimeout(fsm));
});
`;
}
/**
 * Emits the transition-coverage test beside a compiled `playbook` artifact
 * (verification-6): validates the produced `fsm` drives cleanly, then writes
 * `<basename>.fsm.coverage.test.ts` and returns its path with any coverage
 * findings as diagnostics.
 *
 * @throws when the `fsm` artifact cannot be imported or exports no machine.
 */
export async function emitFsmCoverageTest(opts) {
    const fsmPath = join(opts.artifactDir, `${opts.basename}.fsm.ts`);
    const module = await loadFsmModule(fsmPath);
    const findings = await checkFsmCoverage(module, {
        sourceText: await readFile(fsmPath, 'utf8'),
    });
    const content = generateFsmCoverageTest({
        basename: opts.basename,
        fsmModule: `./${opts.basename}.fsm.js`,
        fsmSourceFile: `./${opts.basename}.fsm.ts`,
        verifyModule: opts.verifyModule ?? VERIFY_MODULE,
    });
    await mkdir(opts.artifactDir, { recursive: true });
    const path = join(opts.artifactDir, `${opts.basename}.fsm.coverage.test.ts`);
    await writeFile(path, content);
    return {
        path,
        diagnostics: findings.map((finding) => `fsm coverage: ${finding}`),
    };
}
