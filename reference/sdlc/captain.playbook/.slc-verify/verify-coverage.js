// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
/**
 * FSM transition-coverage verification for a compiled `playbook` artifact
 * (VERIFY-6; DR-009).
 *
 * {@link checkFsmCoverage} drives the artifact's machine with scripted Captain
 * and nested-playbook actors and returns findings when a declared transition
 * is not reachable: every Captain result key must fire a transition out (with
 * `needsBossReply` suspending in the Boss-reply wait state and resuming on
 * `BOSS_REPLY`), nested calls must transition on success and failure, every
 * `onError` arm must land on its target, every `BOSS_INTERRUPT` target must be
 * enterable, and guard-free root entry events must transition.
 * Context-dependent `onDone` arms that a jumped-in actor cannot satisfy are
 * covered by deterministic guard-satisfiability probing — candidate values
 * mined from the guard's own source — so an unsatisfiable arm is still flagged.
 * The checker needs only the artifact and `xstate`; the emitted per-artifact
 * test runs it beside the artifacts. See specs/dev/verification.md.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createActor, fromPromise } from 'xstate';
import { AWAIT_BOSS_REPLY_STATE, BOSS_REPLY_EVENT, INTERRUPT_EVENT, NEEDS_BOSS_REPLY, VERIFY_MODULE, enumerateCaptainStates, loadFsmModule, normalizeArms, } from './verify.js';
/** The `gears2fsm`-mandated captain actor name a machine declares. */
export const CAPTAIN_ACTOR = 'captain';
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
            run: (args) => implementation(args),
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
        run: (args) => implementation(args, typeof params === 'function'
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
    try {
        const actor = createActor(machine, { input: COVERAGE_MACHINE_INPUT });
        const context = actor.getSnapshot().context;
        actor.stop();
        return context;
    }
    catch {
        return {};
    }
}
/** Real initialized fields plus deterministic values needed by guard probes. */
function initializedCoverageContext(machine, dynamic) {
    return {
        ...initializedMachineContext(machine),
        ...coverageGuardContext(dynamic),
    };
}
/** Payload fields a result description requires, per the adjudicator convention. */
const REQUIRED_FIELD = /Output shall include `([A-Za-z_][A-Za-z0-9_]*):/g;
/** Structured fields named by the generic Captain result contracts. */
const STRUCTURED_RESULT_FIELD = /\b(response|question|remainingPlan|nextPlaybookId|nextPlaybookInput)\b/g;
function requiredFields(description) {
    return [
        ...new Set([
            ...[...description.matchAll(REQUIRED_FIELD)].map((match) => match[1]),
            ...[...description.matchAll(STRUCTURED_RESULT_FIELD)].map((match) => match[1]),
        ]),
    ];
}
function synthesizedFieldValue(field) {
    switch (field) {
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
    const output = { guard: key };
    for (const field of requiredFields(state.result[key] ?? '')) {
        output[field] = synthesizedFieldValue(field);
    }
    return output;
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
/** Captain bindings paired with the nested state node that owns the invoke. */
function captainRefs(config) {
    const out = [];
    const refs = stateRefs(config);
    const used = new Set();
    for (const binding of enumerateCaptainStates(config)) {
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
function coverageErrorMessage(error) {
    try {
        return error instanceof Error ? error.message : String(error);
    }
    catch {
        return 'unknown error';
    }
}
/** Replays a nested input against the context observed after a failed start. */
function playbookInputFailure(playbook, context) {
    if (typeof playbook.invocation.input !== 'function')
        return undefined;
    try {
        playbook.invocation.input({ context });
        return undefined;
    }
    catch (error) {
        return coverageErrorMessage(error);
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
    const seed = createActor(provided, { input: COVERAGE_MACHINE_INPUT });
    try {
        return {
            ...seed.getPersistedSnapshot(),
            context: { ...context },
            children: {},
        };
    }
    finally {
        seed.stop();
    }
}
function makeActor(machine, script, playbookScript = () => null, restoredContext) {
    const coverageErrors = [];
    const workActor = fromPromise(async ({ input }) => {
        const output = script(input ?? {});
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
            // A child script is opt-in. All unrelated child invocations hang until
            // the driven actor is stopped, preserving Captain and parallel probes.
            playbook: fromPromise(async ({ input, self, }) => {
                const output = playbookScript(input ?? {}, self.id);
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
    const actor = createActor(provided, {
        input: COVERAGE_MACHINE_INPUT,
        ...(restoredSnapshot === undefined ? {} : { snapshot: restoredSnapshot }),
        inspect: (inspection) => {
            if (typeof inspection !== 'object' ||
                inspection === null ||
                !('event' in inspection)) {
                return;
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
    });
    Object.defineProperty(actor, 'coverageErrors', {
        value: coverageErrors,
    });
    actor.subscribe({ error: () => { } });
    actor.start();
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
    return new Promise((resolveSettled) => {
        let subscription = undefined;
        const finish = (outcome) => {
            clearTimeout(timer);
            subscription?.unsubscribe();
            resolveSettled(outcome);
        };
        const timer = setTimeout(() => finish(predicate(actor.getSnapshot())), ms);
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
        if (predicate(actor.getSnapshot()))
            finish(true);
    });
}
/** Lets XState process an event whose correct outcome is no transition. */
async function settleNoTransition() {
    await new Promise((resolveSettled) => setTimeout(resolveSettled, 10));
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
            return undefined;
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
    const base = { type: INTERRUPT_EVENT, targetId };
    const arms = transitionArms((machine.config.on ?? {})[INTERRUPT_EVENT]);
    const armIndex = selectedArmIndex ??
        arms.findIndex((arm) => {
            const rawTarget = rawArmTarget(arm);
            if (rawTarget === undefined)
                return false;
            const resolvedTarget = stateRefForTarget(refs, rawTarget);
            return (sameStateRef(resolvedTarget, target) ||
                resolvedTarget?.stableId === targetId);
        });
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
const PROBES_PER_TIMEOUT_MILLISECOND = 50;
const COVERAGE_TIMEOUT_MARGIN_MS = 5_000;
const MIN_COVERAGE_TEST_TIMEOUT_MS = 10_000;
function minedLiterals(fn) {
    let source;
    try {
        source = String(fn);
    }
    catch {
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
    // Guard-source literals first: the likeliest matches are tried earliest.
    const values = [
        ...new Set([...minedLiterals(guard), ...extraValues, ...GENERIC_VALUES]),
    ];
    let probes = 0;
    const eventFor = (assignment) => {
        let event = { ...fixedEvent };
        for (const payload of payloads) {
            if (payload.eventField === undefined) {
                event = overlaidObject(event, assignment.payloads[payload.tag] ?? {});
            }
            else {
                event[payload.eventField] = overlaidObject(payload.base, assignment.payloads[payload.tag] ?? {});
            }
        }
        return event;
    };
    const passes = (assignment) => {
        probes++;
        try {
            return Boolean(guard({ context: assignment.context, event: eventFor(assignment) }));
        }
        catch {
            return false;
        }
    };
    // Records the unassigned fields the guard reads under the given assignment.
    const readsUnder = (assignment) => {
        const reads = new Set();
        const recording = (base, assigned, tag, varyExisting = false) => new Proxy(overlaidObject(base, assigned), {
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
                    event = recording(event, assignment.payloads[payload.tag] ?? {}, payload.tag);
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
            // Reads observed before the throw still guide the search.
        }
        return [...reads];
    };
    const search = (assignment, depth) => {
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
function doneGuardSatisfiable(guard, event, output, extraValues) {
    return probeGuardSatisfiable(guard.run, event, [{ eventField: 'output', tag: 'o:', base: output }], [...guard.probeValues, ...extraValues]);
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
        const candidates = captains.filter((captain) => isDescendantOf(captain.ref, region));
        const initial = region.state.initial;
        const captain = (initial === undefined
            ? undefined
            : candidates.find((candidate) => candidate.ref.path[region.path.length] === initial)) ?? candidates[0];
        if (captain !== undefined)
            selected.push(captain);
    }
    return selected;
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
function playbookCoverageInput(machine, playbook, dynamic) {
    if (typeof playbook.invocation.input !== 'function')
        return undefined;
    try {
        const input = playbook.invocation.input({
            context: initializedCoverageContext(machine, dynamic),
        });
        return typeof input === 'object' && input !== null && !Array.isArray(input)
            ? input
            : undefined;
    }
    catch {
        return undefined;
    }
}
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
                !sameStateRef(stateRefForTarget(refs, rawTarget, captain.ref), playbook.ref)) {
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
                !sameStateRef(stateRefForTarget(refs, rawTarget, playbook.ref), target.ref)) {
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
function captainProbeActor(machine, captain, result, gate, refs, captains, playbooks, interruptValues) {
    const predecessor = captainPredecessorPlan(machine, captain, playbooks, refs, captains);
    if (predecessor === undefined) {
        const drive = interruptDriveForRef(machine, refs, captain.ref, captainInterruptTarget(captain), interruptValues);
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
    const actorId = invocationActorId(machine, playbook);
    const dynamic = dynamicPlaybookFields(playbook);
    const entry = dynamic === undefined
        ? undefined
        : playbookEntryPlan(machine, playbook, refs, captains, dynamic);
    if (dynamic !== undefined && entry === undefined) {
        return [
            `state ${playbook.ref.stableId}: dynamic nested playbook has no reachable Captain entry transition`,
        ];
    }
    const entryRef = entry?.captain.ref ?? playbook.ref;
    const entryId = entry === undefined
        ? interruptTargetForRef(playbook.ref, playbook.ref.stableId)
        : captainInterruptTarget(entry.captain);
    const drive = interruptDriveForRef(machine, refs, entryRef, entryId, interruptValues);
    const input = playbookCoverageInput(machine, playbook, dynamic);
    const expectedPlaybookId = typeof input?.playbookId === 'string'
        ? input.playbookId
        : COVERAGE_PLAYBOOK_ID;
    const fixedEvent = {
        type: `xstate.${outcome === 'onDone' ? 'done' : 'error'}.actor.${actorId}`,
        actorId,
    };
    const context = initializedCoverageContext(machine, dynamic);
    const candidateValues = refs.flatMap((ref) => [
        ref.key,
        ref.stableId,
        ...(ref.configId === undefined ? [] : [ref.configId]),
    ]);
    const findings = [];
    for (const [armIndex, arm] of rawArms.entries()) {
        const rawGuard = armGuard(arm);
        if (rawGuard !== undefined &&
            resolveGuard(machine, rawGuard) === undefined) {
            findings.push(`state ${playbook.ref.stableId}: nested playbook ${outcome} arm ${armIndex} names an unresolvable guard "${guardLabel(rawGuard)}"`);
            continue;
        }
        const guard = orderedArmPredicate(machine, rawArms, armIndex);
        if (guard === undefined)
            continue;
        let scriptedResult;
        if (outcome === 'onDone') {
            const outputs = [
                nestedSuccessOutput(),
                // A resolved promise may still return a value rejected by the linked
                // runtime's output validator; fallback arms must be independently
                // selectable and driven as well.
                { invalidCoverageOutput: undefined },
            ];
            for (const base of outputs) {
                const assignment = probeGuardAssignment(guard.run, fixedEvent, [{ eventField: 'output', tag: 'o:', base }], [...guard.probeValues, ...candidateValues], { initialContext: context, assignContext: false });
                if (assignment !== undefined) {
                    scriptedResult = assignedPayload(base, assignment, 'o:');
                    break;
                }
            }
        }
        else {
            const errors = [
                nestedFailure(expectedPlaybookId),
                new Error('coverage: generic nested playbook failure'),
            ];
            for (const base of errors) {
                const assignment = probeGuardAssignment(guard.run, fixedEvent, [{ eventField: 'error', tag: 'r:', base, varyExisting: true }], [...guard.probeValues, ...candidateValues], { initialContext: context, assignContext: false });
                if (assignment !== undefined) {
                    scriptedResult = assignedPayload(base, assignment, 'r:');
                    break;
                }
            }
        }
        if (scriptedResult === undefined) {
            findings.push(`state ${playbook.ref.stableId}: nested playbook ${outcome} arm ${armIndex} is unsatisfiable under probing`);
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
        const gate = { armed: false };
        let calls = 0;
        const actor = makeActor(machine, entry === undefined
            ? () => null
            : onceScript(entry.captain.binding.sourceItem, entry.output, gate), (actorInput, invokedActorId) => {
            if (!gate.armed ||
                calls > 0 ||
                invokedActorId !== actorId ||
                actorInput.stateId !== playbook.ref.stableId ||
                (dynamic !== undefined &&
                    (actorInput.playbookId !== COVERAGE_PLAYBOOK_ID ||
                        actorInput.text !== COVERAGE_PLAYBOOK_INPUT))) {
                return null;
            }
            calls++;
            return scriptedResult;
        }, drive.context);
        gate.armed = true;
        actor.send(drive.event);
        let enteredCall = false;
        const settled = await settle(actor, (snapshot) => {
            if (atState(playbook.ref)(snapshot))
                enteredCall = true;
            return ((calls === 1 && atState(target)(snapshot)) ||
                (calls === 0 && actor.coverageErrors.length > 0) ||
                (enteredCall && calls === 0 && leftState(playbook.ref)(snapshot)));
        });
        const finalSnapshot = actor.getSnapshot();
        const observedStartFailure = actor.coverageErrors.find(({ eventType }) => eventType === `xstate.error.actor.${actorId}` || calls === 0);
        const inputFailure = calls === 0
            ? observedStartFailure === undefined
                ? finalSnapshot.status === 'error'
                    ? coverageErrorMessage(finalSnapshot.error)
                    : playbookInputFailure(playbook, finalSnapshot.context)
                : coverageErrorMessage(observedStartFailure.error)
            : undefined;
        actor.stop();
        if (inputFailure !== undefined) {
            findings.push(`state ${playbook.ref.stableId}: nested playbook actor failed to start during ${outcome} coverage: ${inputFailure}`);
            continue;
        }
        if (!settled || calls !== 1 || !atState(target)(finalSnapshot)) {
            findings.push(`state ${playbook.ref.stableId}: nested playbook ${outcome} arm ${armIndex} did not reach ${target.stableId}`);
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
    const states = (config.states ?? {});
    const refs = stateRefs(config);
    const captains = captainRefs(config);
    const playbooks = playbookRefs(config);
    const parallels = refs.filter((ref) => ref.state.type === 'parallel');
    const rootInterruptProbes = transitionArms((config.on ?? {})[INTERRUPT_EVENT]).length;
    const rootSettles = rootInterruptProbes * SETTLE_MS;
    const initial = typeof config.initial === 'string' ? config.initial : undefined;
    const entryEvents = new Set([
        ...Object.keys(initial === undefined ? {} : (states[initial]?.on ?? {})),
        ...Object.keys(config.on ?? {}),
    ]);
    entryEvents.delete(INTERRUPT_EVENT);
    const entrySettles = entryEvents.size * SETTLE_MS;
    let captainSettles = 0;
    let guardProbeCalls = rootInterruptProbes;
    for (const captain of captains) {
        const resultKeys = Object.keys(captain.binding.result);
        captainSettles +=
            resultKeys.reduce((total, key) => total + (key === NEEDS_BOSS_REPLY ? 4 : 1), 0) * SETTLE_MS;
        // One directly selectable onError arm is driven.
        captainSettles += SETTLE_MS;
        const guardedDoneArms = transitionArms(captain.invocation.onDone).filter((arm) => armGuard(arm) !== undefined).length;
        const errorArms = transitionArms(captain.invocation.onError).length;
        // Result acceptance probes each guarded arm once, then the arm audit probes
        // every result's structured and bare output forms.
        guardProbeCalls += resultKeys.length * guardedDoneArms * 3 + errorArms;
        // Every result, the blank Boss-reply check, and onError enter through an
        // independently context-probed interrupt plan.
        guardProbeCalls +=
            resultKeys.length + (resultKeys.includes(NEEDS_BOSS_REPLY) ? 1 : 0) + 1;
    }
    guardProbeCalls += playbooks.reduce((total, playbook) => total +
        transitionArms(playbook.invocation.onDone).length +
        transitionArms(playbook.invocation.onError).length, 0);
    // Nested success/error and parallel question/join helpers each reuse one
    // context-probed entry plan per state and outcome.
    guardProbeCalls += 2 * playbooks.length + 2 * parallels.length;
    const playbookSettles = playbooks.reduce((total, playbook) => total +
        (transitionArms(playbook.invocation.onDone).length +
            transitionArms(playbook.invocation.onError).length) *
            SETTLE_MS, 0);
    const parallelSettles = parallels.reduce((total, parallel) => total +
        2 * PARALLEL_QUESTION_SETTLE_MS +
        transitionArms(parallel.state.onDone).length *
            MAX_PARALLEL_COMBINATIONS *
            PARALLEL_SETTLE_MS, 0);
    const guardAllowance = guardProbeCalls * Math.ceil(MAX_PROBES / PROBES_PER_TIMEOUT_MILLISECOND);
    return Math.max(MIN_COVERAGE_TEST_TIMEOUT_MS, rootSettles +
        entrySettles +
        captainSettles +
        playbookSettles +
        parallelSettles +
        guardAllowance +
        COVERAGE_TIMEOUT_MARGIN_MS);
}
/**
 * Checks transition coverage over a compiled `playbook` artifact's machine
 * (VERIFY-6) and returns findings (empty when every declared transition is
 * reachable). Requires the machine to declare the `gears2fsm` surfaces it
 * drives through: the `BOSS_INTERRUPT` root event and the Boss-reply wait
 * state.
 */
export async function checkFsmCoverage(fsmModule, opts = {}) {
    const findings = [];
    const machine = findMachine(fsmModule);
    const config = machine.config;
    const states = (config.states ?? {});
    const refs = stateRefs(config);
    const captains = captainRefs(config);
    const playbooks = playbookRefs(config);
    const captainByRef = new Map(captains.map((captain) => [stateRefKey(captain.ref), captain]));
    const sourceCandidates = identifierLiterals(opts.sourceText ?? '');
    const parallelRefs = refs.filter((ref) => ref.state.type === 'parallel');
    for (const ref of parallelRefs) {
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
    const rootArms = normalizeArms((config.on ?? {})[INTERRUPT_EVENT]);
    const canJump = rootArms.length > 0;
    if (!canJump) {
        findings.push(`machine declares no root ${INTERRUPT_EVENT} event`);
    }
    if (canJump) {
        for (const playbook of playbooks) {
            findings.push(...(await probePlaybookInvocation(machine, playbook, refs, captains, sourceCandidates)));
        }
        for (const parallel of parallelRefs) {
            findings.push(...(await probeParallelQuestions(machine, parallel, refs, captains, sourceCandidates)), ...(await probeParallelJoins(machine, parallel, refs, captains, sourceCandidates)));
        }
    }
    const waitStates = refs.filter((ref) => ref.stableId === AWAIT_BOSS_REPLY_STATE ||
        (tagsOf(ref.state).includes('playbook.parked') &&
            ref.state.on?.[BOSS_REPLY_EVENT] !== undefined));
    if (waitStates.length === 0) {
        findings.push(`machine declares no ${AWAIT_BOSS_REPLY_STATE} state or branch-local Boss-reply wait state`);
    }
    // Every BOSS_INTERRUPT target is enterable (the captain hangs, so entering a
    // captain state parks in it).
    if (canJump) {
        for (const [armIndex, arm] of rootArms.entries()) {
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
    const initial = typeof config.initial === 'string' ? config.initial : null;
    const initialRef = initial === null
        ? undefined
        : refs.find((ref) => ref.path.length === 1 && ref.key === initial);
    const entryArms = {
        ...(initial !== null ? (states[initial]?.on ?? {}) : {}),
        ...(config.on ?? {}),
    };
    for (const [event, raw] of Object.entries(entryArms)) {
        if (event === INTERRUPT_EVENT)
            continue;
        const arms = normalizeArms(raw);
        const free = arms.find((arm) => !arm.guarded && arm.target !== null && arm.target !== initial);
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
    for (const captain of captains) {
        if (!canJump)
            break;
        const state = captain.binding;
        const stateKey = state.stateId;
        const stateId = captainPublicStateId(captain);
        const candidates = [...stateCandidates, ...sourceCandidates];
        const doneEvent = invocationEvent(machine, captain, 'done');
        const errorEvent = invocationEvent(machine, captain, 'error');
        const rawDoneArms = transitionArms(captain.invocation.onDone);
        const onDoneArms = normalizeArms(captain.invocation.onDone);
        // Every declared result needs an arm that explicitly accepts its complete
        // valid output. A sole unguarded arm accepts the whole local result
        // contract; an array's unguarded arm is a fallback and cannot make an
        // otherwise orphaned key look covered.
        for (const key of Object.keys(state.result)) {
            const output = synthOutput(state, key);
            const accepting = new Set();
            for (const [index, arm] of rawDoneArms.entries()) {
                const target = onDoneArms[index]?.target ?? null;
                const rawGuard = armGuard(arm);
                if (rawGuard === undefined) {
                    if (rawDoneArms.length === 1 && target !== null)
                        accepting.add(index);
                    continue;
                }
                if (target === null || resolveGuard(machine, rawGuard) === undefined) {
                    continue;
                }
                const guard = orderedArmPredicate(machine, rawDoneArms, index);
                if (guard !== undefined &&
                    doneGuardSatisfiable(guard, doneEvent, output, candidates)) {
                    accepting.add(index);
                }
            }
            if (accepting.size === 0) {
                findings.push(`state ${stateKey}: result "${key}" has no reachable accepting transition`);
                continue;
            }
            // Drive only when the first arm XState would inspect under the real
            // initial context is a known accepting arm. Encountering an unresolved
            // guard first makes driving unsafe: XState reports that error
            // asynchronously, so the arm audit below owns the finding (c887fc4).
            let directArm;
            let safeToDrive = true;
            for (const [index, arm] of rawDoneArms.entries()) {
                const rawGuard = armGuard(arm);
                if (rawGuard === undefined) {
                    directArm = index;
                    break;
                }
                const guard = resolveGuard(machine, rawGuard);
                if (guard === undefined) {
                    safeToDrive = false;
                    break;
                }
                try {
                    if (guard.run({
                        context: initializedCoverageContext(machine),
                        event: { ...doneEvent, output },
                    })) {
                        directArm = index;
                        break;
                    }
                }
                catch {
                    safeToDrive = false;
                    break;
                }
            }
            if (!safeToDrive ||
                directArm === undefined ||
                !accepting.has(directArm)) {
                continue;
            }
            const gate = { armed: false };
            const probe = captainProbeActor(machine, captain, output, gate, refs, captains, playbooks, sourceCandidates);
            const actor = probe.actor;
            gate.armed = true;
            actor.send(probe.event);
            const left = await settle(actor, leftState(captain.ref));
            if (!left) {
                findings.push(`state ${stateKey}: result "${key}" fired no transition`);
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
                const blankProbe = captainProbeActor(machine, captain, synthOutput(state, NEEDS_BOSS_REPLY), blankGate, refs, captains, playbooks, sourceCandidates);
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
        // Try each key's full output and bare malformed form; neither probe may
        // invent a different event type or actor id.
        for (const [index, arm] of rawDoneArms.entries()) {
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
            const anyOutput = Object.keys(state.result).some((key) => doneGuardSatisfiable(guard, doneEvent, synthOutput(state, key), candidates) ||
                doneGuardSatisfiable(guard, doneEvent, { guard: key }, candidates));
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
                    context: initializedCoverageContext(machine),
                    event: { ...errorEvent, error: forcedError },
                })) {
                    directErrorArm = index;
                    break;
                }
            }
            catch {
                errorDriveSafe = false;
                break;
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
        const probe = captainProbeActor(machine, captain, forcedError, gate, refs, captains, playbooks, sourceCandidates);
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
 * beside the artifacts (VERIFY-6).
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
 * (VERIFY-6): validates the produced `fsm` drives cleanly, then writes
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
