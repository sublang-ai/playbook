// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Generic linked-playbook runtime factory (DR-019). The FSM-interpreter
// machinery that slc/link.md previously regenerated inside every linked
// `<name>.playbook.ts` artifact — actor wiring, boundary tracing, judge
// classification/adjudication, script execution, nested-playbook bridging,
// Boss-reply suspension, snapshot/restore, and disposal — lives here once.
// A linked artifact supplies only its per-workflow `spec` (options
// validation and any strategy overrides) and its own FSM; the factory
// interprets the FSM data the artifact already carries.
//
// The machinery is hoisted from the reference CODE artifact
// (reference/sdlc/code.playbook/code.playbook.ts) verbatim where possible;
// its behavior tests are the equivalence proof. Do not change observable
// behavior here without consulting those suites.
import { spawn } from 'node:child_process';
import PQueue from 'p-queue';
import { createActor, fromPromise } from 'xstate';
import { assertPlaybookRuntimeSnapshot, combineAbortSignals, createNestedPlaybookBridge, detachPersistedMachineSnapshot, normalizeError, normalizePlaybookSnapshot, snapshotJsonValue, snapshotPlaybookSession, validateCaptainResult, validatePlayerResult, waitForPlaybookQuiescence, } from './xstate-runtime.js';
export const BOSS_REPLY_ERRORS = {
    missingQuestion: "needsBossReply outcome missing 'question' field",
    unregisteredState: (stateId) => `state ${stateId} declared needsBossReply but is not registered as resumable`,
};
// ---------------------------------------------------------------------------
// A host agent result that is not `ok` (or is `ok` with no final text) is a
// recoverable FSM failure, not a control-plane error: it travels the invoked
// actor's XState error path to the failure state and the public boundary
// resolves `failed` (PBRT-47, matching the player boundary's PBRT-9). The
// direct-Captain boundary has to emit its paired finish trace before
// rethrowing, so it needs to tell that failure apart from the control-plane
// errors it does latch — a thrown port, a malformed result, a rejecting sink.
// ---------------------------------------------------------------------------
const fsmResultFailures = new WeakSet();
function markFsmResultFailure(error) {
    fsmResultFailures.add(error);
    return error;
}
function isFsmResultFailure(error) {
    return (typeof error === 'object' &&
        error !== null &&
        fsmResultFailures.has(error));
}
// ---------------------------------------------------------------------------
// Tolerant judge-JSON recovery (slc/link.md §Boss-event mapping).
// ---------------------------------------------------------------------------
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Strip a single Markdown code fence that wraps the whole string. */
export function stripCodeFence(text) {
    const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
    return fence ? fence[1].trim() : text;
}
function dropTrailingComma(out) {
    return out.replace(/,(\s*)$/, '$1');
}
// Scan from `start` (a `{`/`[` index), tracking string and bracket-nesting
// state, and emit the balanced JSON value rooted there. With `repair` false
// the span is returned only if it actually closes; with `repair` true a
// trailing comma, an unterminated string, and unclosed brackets are fixed.
export function extractJsonValue(text, start, repair) {
    const stack = [];
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (escaped)
                escaped = false;
            else if (ch === '\\')
                escaped = true;
            else if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === '{' || ch === '[') {
            stack.push(ch === '{' ? '}' : ']');
            out += ch;
            continue;
        }
        if (ch === '}' || ch === ']') {
            if (repair)
                out = dropTrailingComma(out);
            out += ch;
            stack.pop();
            if (stack.length === 0)
                return out; // top-level value complete
            continue;
        }
        out += ch;
    }
    // End of input before the top-level value closed.
    if (!repair)
        return undefined; // strict pass: no balanced span here
    if (inString)
        out += '"';
    out = dropTrailingComma(out);
    while (stack.length > 0)
        out += stack.pop();
    return out;
}
// Tolerant recovery shared by the classifier and adjudicator: prefer a strict
// balanced span at the earliest opening brace, then its repair, before
// advancing to a later candidate. The first plain object wins; the first
// value of any shape is remembered so a legitimately array/scalar reply still
// surfaces to the caller's own object check.
export function parseJudgeJson(raw) {
    const fenced = stripCodeFence(raw.trim());
    // Fast path: a well-formed (optionally fenced) JSON body.
    try {
        return JSON.parse(fenced);
    }
    catch {
        // Fall through to lenient extraction + repair.
    }
    const starts = [];
    for (let i = 0; i < fenced.length; i++) {
        const ch = fenced[i];
        if (ch === '{' || ch === '[')
            starts.push(i);
    }
    let firstValue;
    for (const start of starts) {
        let parsedHere;
        for (const repair of [false, true]) {
            const candidate = extractJsonValue(fenced, start, repair);
            if (candidate === undefined)
                continue;
            try {
                parsedHere = { value: JSON.parse(candidate) };
            }
            catch {
                continue; // not parseable this way — try repair, then next start
            }
            break; // prefer the strict span at this start over its repair
        }
        if (parsedHere === undefined)
            continue;
        if (isPlainObject(parsedHere.value))
            return parsedHere.value;
        if (firstValue === undefined)
            firstValue = parsedHere;
    }
    if (firstValue !== undefined)
        return firstValue.value;
    throw new Error('adjudicate: judge response is not valid JSON');
}
// ---------------------------------------------------------------------------
// Shared error/context helpers.
// ---------------------------------------------------------------------------
export function normalizeErrorCompact(err) {
    if (err === undefined || err === null)
        return undefined;
    const normalized = normalizeError(err);
    return { name: normalized.name, message: normalized.message };
}
export function normalizeErrorFull(err) {
    if (err === undefined || err === null)
        return undefined;
    return normalizeError(err);
}
function isAbortFailure(error, signal) {
    return (signal.aborted &&
        (error === signal.reason || normalizeError(error).name === 'AbortError'));
}
/** Read the FSM context's single pending Boss question, when well-formed. */
export function pendingBossQuestionFromContext(context) {
    const pending = context.pendingBossQuestion;
    if (pending === undefined ||
        pending === null ||
        typeof pending !== 'object') {
        return undefined;
    }
    const candidate = pending;
    if (typeof candidate.questionId !== 'string' ||
        typeof candidate.resumeStateId !== 'string' ||
        typeof candidate.sourceItem !== 'string' ||
        typeof candidate.player !== 'string' ||
        typeof candidate.question !== 'string') {
        return undefined;
    }
    return {
        questionId: candidate.questionId,
        resumeStateId: candidate.resumeStateId,
        sourceItem: candidate.sourceItem,
        player: candidate.player,
        question: candidate.question,
    };
}
// ---------------------------------------------------------------------------
// Generic strategy defaults.
// ---------------------------------------------------------------------------
const CONTINUATION_PREAMBLE = 'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.';
function continuationBlocks(input) {
    if (input.pendingBossQuestion === undefined || input.bossReply === undefined) {
        return [];
    }
    return [
        CONTINUATION_PREAMBLE,
        `Boss question:\n${input.pendingBossQuestion.question}`,
        `Boss reply:\n${input.bossReply}`,
    ];
}
const PLACEHOLDER_PATTERN = /<(#|[A-Za-z_$][A-Za-z0-9_$-]*)>/g;
function placeholderFieldName(token, fields) {
    const explicit = fields[token];
    if (explicit !== undefined)
        return explicit;
    if (token === '#')
        return 'irNumber';
    return token.replace(/-([A-Za-z0-9])/g, (_match, next) => next.toUpperCase());
}
/**
 * Default player-prompt composer (slc/link.md §Player prompt composition).
 * One callback-based pass substitutes each `<fieldName>` placeholder whose
 * typed input field is a string; replacement text is literal, and
 * placeholder-looking text inside a value is never re-substituted. The
 * continuation preamble and Q/A blocks precede the domain body on resume.
 */
export function defaultComposePlayerPrompt(input, placeholderFields = {}) {
    const blocks = continuationBlocks(input);
    const fields = input;
    const body = input.prompt.replace(PLACEHOLDER_PATTERN, (match, token) => {
        const value = fields[placeholderFieldName(token, placeholderFields)];
        return typeof value === 'string' ? value : match;
    });
    blocks.push(body);
    return blocks.join('\n\n');
}
function sortJson(value) {
    if (Array.isArray(value))
        return value.map((entry) => sortJson(entry));
    if (value !== null && typeof value === 'object') {
        const record = value;
        const sorted = {};
        for (const key of Object.keys(record).sort()) {
            sorted[key] = sortJson(record[key]);
        }
        return sorted;
    }
    return value;
}
function stableJson(value, path) {
    return JSON.stringify(sortJson(snapshotJsonValue(value, path)));
}
/**
 * Default direct-Captain prompt composer (slc/link.md §Captain prompt
 * composition). Placeholder substitution is presence-based: string fields
 * substitute verbatim; JSON-safe arrays/objects render as deterministic JSON
 * with lexicographically sorted keys at every depth.
 */
export function defaultComposeCaptainPrompt(input, placeholderFields = {}) {
    const blocks = continuationBlocks(input);
    const fields = input;
    const body = input.prompt.replace(PLACEHOLDER_PATTERN, (match, token) => {
        const field = placeholderFieldName(token, placeholderFields);
        const value = fields[field];
        if (typeof value === 'string')
            return value;
        if (value !== null && typeof value === 'object') {
            return stableJson(value, `CaptainInput.${field}`);
        }
        return match;
    });
    blocks.push(body);
    return blocks.join('\n\n');
}
/** Default player binding: each player to its lowercased name. */
export function defaultResolvePlayerId(input) {
    return input.player.toLowerCase();
}
/**
 * Default required-field extraction (slc/link.md §Captain adjudication).
 * Limited to the description's `Output shall include` / `输出应包含` clause;
 * recognizes both the bare backticked name and the annotated `name: <...>`
 * form.
 */
export function defaultExtractRequiredFields(description) {
    const markers = ['Output shall include', '输出应包含'];
    let clauseStart = -1;
    for (const marker of markers) {
        const idx = description.indexOf(marker);
        if (idx !== -1) {
            clauseStart = idx + marker.length;
            break;
        }
    }
    if (clauseStart === -1)
        return [];
    const clause = description.slice(clauseStart);
    const fields = [];
    const re = /`([A-Za-z_$][A-Za-z0-9_$]*)(?::[^`]*)?`/g;
    for (const m of clause.matchAll(re))
        fields.push(m[1]);
    return fields;
}
/** Default delegated-player adjudicator prompt. */
export function defaultBuildJudgePrompt(input, finalText) {
    const lines = [];
    lines.push(`The ${input.player} just produced this output:`);
    lines.push('');
    lines.push('```');
    lines.push(finalText);
    lines.push('```');
    lines.push('');
    lines.push('Pick exactly one outcome by `guard` and return JSON ' +
        '`{ guard, …payloadFields }`. Required payload fields are named in the ' +
        'outcome description after "Output shall include" / "输出应包含".');
    lines.push('');
    for (const [key, description] of Object.entries(input.result)) {
        lines.push(`- \`${key}\` — ${description}`);
    }
    return lines.join('\n');
}
const NO_VERBATIM_FIELDS = new Set();
/**
 * LLM-judge adjudicator for delegated players. Coerces the player's
 * finalText into one of the state's declared guards, extracts every required
 * payload field from the judge reply, and fails loudly (throws) on a missing
 * JSON object, an undeclared guard, or a missing required field. Fields in
 * `verbatimPayloadFields` carry `finalText.trim()` rather than round-tripping
 * long-form prose through judge JSON.
 */
export async function adjudicatePlayerOutput(spec, input, finalText, ports, signal, boundary) {
    const buildPrompt = spec.buildJudgePrompt ?? defaultBuildJudgePrompt;
    const extractFields = spec.extractRequiredFields ?? defaultExtractRequiredFields;
    const verbatimFields = spec.verbatimPayloadFields ?? NO_VERBATIM_FIELDS;
    const prompt = buildPrompt(input, finalText);
    const raw = boundary
        ? await boundary.callJudge('player-output-adjudication', input.stateId, prompt, signal)
        : await ports.callJudge(prompt, signal);
    const parsed = parseJudgeJson(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('adjudicate: judge response is not a JSON object');
    }
    const obj = parsed;
    const guard = obj.guard;
    if (typeof guard !== 'string') {
        throw new Error('adjudicate: judge response missing string "guard" field');
    }
    if (!Object.prototype.hasOwnProperty.call(input.result, guard)) {
        throw new Error(`adjudicate: unknown guard "${guard}" — declared guards: ${Object.keys(input.result).join(', ')}`);
    }
    const verbatim = finalText.trim();
    for (const field of extractFields(input.result[guard])) {
        if (verbatimFields.has(field)) {
            obj[field] = verbatim;
            continue;
        }
        if (typeof obj[field] !== 'string') {
            if (guard === 'needsBossReply' && field === 'question') {
                throw new Error(BOSS_REPLY_ERRORS.missingQuestion);
            }
            throw new Error(`adjudicate: judge response missing required field "${field}" for guard "${guard}"`);
        }
    }
    return obj;
}
function validateBossReplyOutput(input, output, resumableStateIds) {
    if (output.guard !== 'needsBossReply')
        return;
    if (typeof output.question !== 'string') {
        throw new Error(BOSS_REPLY_ERRORS.missingQuestion);
    }
    if (!resumableStateIds.has(input.stateId)) {
        throw new Error(BOSS_REPLY_ERRORS.unregisteredState(input.stateId));
    }
}
export function createPlayerBridge(spec, ports, getActiveSignal, boundary, onControlPlaneError) {
    return fromPromise(async ({ input, signal }) => {
        const activeSignal = combineAbortSignals(signal, getActiveSignal?.());
        const playerId = spec.resolvePlayerId(input);
        const prompt = spec.composePlayerPrompt(input);
        const result = boundary
            ? await boundary.callPlayer(input, playerId, prompt, activeSignal)
            : await ports.callPlayer(playerId, prompt, activeSignal, {
                resume: false,
            });
        if (result.status !== 'ok') {
            throw new Error(result.error ?? `captainBridge: callPlayer status "${result.status}"`);
        }
        if (result.finalText === undefined) {
            throw new Error('captainBridge: callPlayer returned status=ok with no finalText');
        }
        try {
            const output = await adjudicatePlayerOutput(spec.adjudication, input, result.finalText, ports, activeSignal, boundary);
            validateBossReplyOutput(input, output, spec.resumableStateIds);
            return output;
        }
        catch (error) {
            onControlPlaneError?.(error);
            throw error;
        }
    });
}
// ---------------------------------------------------------------------------
// Direct-Captain adjudication (slc/link.md §Captain adjudication). The judge
// selects the guard and supplies only other structural fields; the runtime
// injects the exact visible finalText as the selected output's `question` or
// `response` and rejects a judge reply that supplies either presentation
// field as an undeclared extra key.
// ---------------------------------------------------------------------------
function buildCaptainJudgePrompt(input, finalText) {
    const lines = [];
    lines.push('Adjudicate the direct Captain output for this FSM state.');
    lines.push(`State id: ${input.stateId}`);
    lines.push(`Source item: ${input.sourceItem}`);
    lines.push('');
    lines.push('Visible Captain output:');
    lines.push('```');
    lines.push(finalText);
    lines.push('```');
    lines.push('');
    lines.push('Result keys and descriptions:');
    for (const [key, description] of Object.entries(input.result)) {
        lines.push(`- \`${key}\` — ${description}`);
    }
    lines.push('');
    lines.push('Pick exactly one outcome by `guard` and return JSON ' +
        '`{ guard, …structuralPayloadFields }`. Do not include `question` or ' +
        '`response`; the runtime injects the visible text.');
    return lines.join('\n');
}
function adjudicateCaptainOutput(extractFields, input, finalText, judgeText) {
    const parsed = parseJudgeJson(judgeText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('adjudicate: judge response is not a JSON object');
    }
    const obj = parsed;
    const guard = obj.guard;
    if (typeof guard !== 'string') {
        throw new Error('adjudicate: judge response missing string "guard" field');
    }
    if (!Object.prototype.hasOwnProperty.call(input.result, guard)) {
        throw new Error(`adjudicate: unknown guard "${guard}" — declared guards: ${Object.keys(input.result).join(', ')}`);
    }
    const required = extractFields(input.result[guard]);
    const allowed = new Set(['guard']);
    for (const field of required) {
        if (field !== 'question' && field !== 'response')
            allowed.add(field);
    }
    for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
            throw new Error(`adjudicate: judge response supplied undeclared field "${key}" for guard "${guard}"`);
        }
    }
    for (const field of required) {
        if (field === 'question' || field === 'response')
            continue;
        if (obj[field] === undefined || obj[field] === null) {
            throw new Error(`adjudicate: judge response missing required field "${field}" for guard "${guard}"`);
        }
    }
    const output = { ...obj, guard };
    if (required.includes('question'))
        output.question = finalText;
    if (required.includes('response'))
        output.response = finalText;
    return output;
}
// ---------------------------------------------------------------------------
// FSM-artifact introspection over `machine.config` — internal but stable in
// XState v5: it preserves the literal `createMachine` argument.
// ---------------------------------------------------------------------------
function stripIdPrefix(target) {
    return target.startsWith('#') ? target.slice(1) : target;
}
function collectInvokeSources(machine) {
    const sources = new Set();
    const visit = (stateDef) => {
        if (!isPlainObject(stateDef))
            return;
        const invoke = stateDef.invoke;
        const invokes = Array.isArray(invoke) ? invoke : invoke ? [invoke] : [];
        for (const entry of invokes) {
            if (isPlainObject(entry) && typeof entry.src === 'string') {
                sources.add(entry.src);
            }
        }
        if (isPlainObject(stateDef.states)) {
            for (const child of Object.values(stateDef.states))
                visit(child);
        }
    };
    visit(machine.config);
    return sources;
}
function transitionTargets(transition) {
    const arms = Array.isArray(transition) ? transition : [transition];
    const targets = [];
    for (const arm of arms) {
        if (typeof arm === 'string') {
            targets.push(stripIdPrefix(arm));
        }
        else if (isPlainObject(arm) && typeof arm.target === 'string') {
            targets.push(stripIdPrefix(arm.target));
        }
    }
    return targets;
}
/** Targets of the FSM's `awaitBossReply` BOSS_REPLY transitions. */
export function resumableStateIdsFromMachine(machine) {
    const config = machine.config;
    if (!isPlainObject(config) || !isPlainObject(config.states)) {
        return new Set();
    }
    const awaitState = config.states.awaitBossReply;
    if (!isPlainObject(awaitState) || !isPlainObject(awaitState.on)) {
        return new Set();
    }
    const bossReply = awaitState.on.BOSS_REPLY;
    if (bossReply === undefined)
        return new Set();
    return new Set(transitionTargets(bossReply));
}
// ---------------------------------------------------------------------------
// Default transition/status derivation.
// ---------------------------------------------------------------------------
const SUPPRESSED_ENTRY_STATES = new Set(['ready', 'done']);
function makeDefaultNormalizeTransitionEvent(transitionEventFields) {
    return (event) => {
        if (event === null || typeof event !== 'object') {
            return snapshotJsonValue(event ?? null, 'FSM event');
        }
        const e = event;
        const out = {};
        if (typeof e.type === 'string')
            out.type = e.type;
        for (const field of transitionEventFields) {
            if (typeof e[field] === 'string')
                out[field] = e[field];
        }
        if (e.output !== undefined) {
            out.output = snapshotJsonValue(e.output, 'FSM event output');
        }
        if (e.error !== undefined) {
            out.error = snapshotJsonValue(normalizeError(e.error), 'FSM event error');
        }
        return snapshotJsonValue(out, 'FSM event');
    };
}
function defaultStatusesForState(state, context) {
    const stateId = state.stateId;
    if (stateId === undefined || SUPPRESSED_ENTRY_STATES.has(stateId))
        return [];
    if (stateId === 'awaitBossReply') {
        const pending = pendingBossQuestionFromContext(context);
        const message = pending === undefined
            ? 'Awaiting Boss reply.'
            : `${pending.player} asks: ${pending.question}`;
        return [{ message }];
    }
    if (stateId === 'failed') {
        const lastError = normalizeErrorFull(context.lastError);
        return [
            {
                message: 'Workflow failed; awaiting Boss recovery.',
                ...(lastError === undefined
                    ? {}
                    : { data: snapshotJsonValue({ lastError }, 'failed status data') }),
            },
        ];
    }
    return [{ message: `Entered ${stateId}.` }];
}
function classifierState(snapshotOrState) {
    if (snapshotOrState !== null &&
        typeof snapshotOrState === 'object' &&
        'value' in snapshotOrState) {
        const candidate = snapshotOrState;
        return {
            value: candidate.value,
            context: candidate.context !== null &&
                typeof candidate.context === 'object' &&
                !Array.isArray(candidate.context)
                ? candidate.context
                : {},
        };
    }
    return { value: snapshotOrState, context: {} };
}
function configuredEventTypesForState(machine, stateId) {
    const configured = new Set();
    const config = machine.config;
    if (!isPlainObject(config))
        return configured;
    if (isPlainObject(config.on)) {
        for (const type of Object.keys(config.on))
            configured.add(type);
    }
    if (stateId !== undefined && isPlainObject(config.states)) {
        const state = config.states[stateId];
        if (isPlainObject(state) && isPlainObject(state.on)) {
            for (const type of Object.keys(state.on))
                configured.add(type);
        }
    }
    return configured;
}
// Derived contracts merge into whatever the machine already yielded for the
// same type, so a deterministic entry event that shares a type with another
// derived contract keeps its exact-text ownership instead of being replaced.
function mergeDerivedContract(contracts, contract) {
    const existing = contracts.get(contract.type);
    contracts.set(contract.type, {
        type: contract.type,
        fields: { ...(existing?.fields ?? {}), ...(contract.fields ?? {}) },
    });
}
function defaultBossEventSpecs(machine, entryEvent, supplied) {
    const contracts = new Map();
    if (entryEvent !== undefined) {
        mergeDerivedContract(contracts, {
            type: entryEvent.type,
            fields: { [entryEvent.textField]: { source: 'text', required: true } },
        });
    }
    const config = machine.config;
    const rootInterrupt = isPlainObject(config) && isPlainObject(config.on)
        ? config.on.BOSS_INTERRUPT
        : undefined;
    const interruptTargets = rootInterrupt === undefined ? [] : transitionTargets(rootInterrupt);
    if (interruptTargets.length > 0) {
        mergeDerivedContract(contracts, {
            type: 'BOSS_INTERRUPT',
            fields: {
                targetId: {
                    source: 'judge',
                    required: true,
                    values: [...new Set(interruptTargets)],
                },
                // slc/link.md §Boss-event mapping: for BOSS_INTENT and
                // BOSS_INTERRUPT the runtime, never the judge, attaches the exact
                // original Boss text as `bossIntent`.
                bossIntent: { source: 'text', required: true },
            },
        });
    }
    for (const contract of supplied) {
        if (typeof contract.type !== 'string' ||
            contract.type.trim().length === 0) {
            throw new TypeError('Boss event contract type must be a non-empty string');
        }
        if (contract.type === 'NO_ACTION' || contract.type === 'BOSS_REPLY') {
            throw new TypeError(`Boss event contract ${contract.type} is runtime-owned`);
        }
        const existing = contracts.get(contract.type);
        const fields = {
            ...(existing?.fields ?? {}),
        };
        for (const [field, fieldSpec] of Object.entries(contract.fields ?? {})) {
            if (field.length === 0 || field === 'type') {
                throw new TypeError(`Boss event contract ${contract.type} has invalid field ${JSON.stringify(field)}`);
            }
            if (fieldSpec.source !== 'judge' && fieldSpec.source !== 'text') {
                throw new TypeError(`Boss event contract ${contract.type}.${field} has invalid source`);
            }
            if (fieldSpec.values !== undefined) {
                if (fieldSpec.source !== 'judge' ||
                    fieldSpec.values.length === 0 ||
                    fieldSpec.values.some((value) => typeof value !== 'string' || value.length === 0)) {
                    throw new TypeError(`Boss event contract ${contract.type}.${field} has invalid values`);
                }
            }
            const normalized = {
                source: fieldSpec.source,
                ...(fieldSpec.required === true ? { required: true } : {}),
                ...(fieldSpec.values === undefined
                    ? {}
                    : { values: [...new Set(fieldSpec.values)] }),
            };
            const derived = fields[field];
            if (derived !== undefined) {
                const derivedValues = derived.values === undefined
                    ? undefined
                    : new Set(derived.values);
                const normalizedValues = normalized.values === undefined
                    ? undefined
                    : new Set(normalized.values);
                const sameValues = derivedValues === undefined || normalizedValues === undefined
                    ? derivedValues === normalizedValues
                    : derivedValues.size === normalizedValues.size &&
                        [...derivedValues].every((value) => normalizedValues.has(value));
                if (derived.source !== normalized.source ||
                    (derived.required === true) !== (normalized.required === true) ||
                    !sameValues) {
                    throw new TypeError(`Boss event contract ${contract.type}.${field} conflicts with the runtime-derived contract`);
                }
                continue;
            }
            fields[field] = normalized;
        }
        contracts.set(contract.type, { type: contract.type, fields });
    }
    contracts.set('BOSS_REPLY', {
        type: 'BOSS_REPLY',
        fields: {
            questionId: { source: 'judge' },
            answer: { source: 'text', required: true },
        },
    });
    return contracts;
}
function eventContractPrompt(contract) {
    const fields = Object.entries(contract.fields ?? {}).filter(([, field]) => field.source === 'judge');
    const members = [
        `"type": ${JSON.stringify(contract.type)}`,
        ...fields.map(([name, field]) => `${JSON.stringify(name)}: ${JSON.stringify(field.values?.[0] ?? '<string>')}`),
    ];
    const notes = fields.flatMap(([name, field]) => [
        ...(field.required === true ? [] : [`${name} optional`]),
        ...(field.values === undefined
            ? []
            : [
                `${name} one of ${field.values
                    .map((value) => JSON.stringify(value))
                    .join(', ')}`,
            ]),
    ]);
    return `{ ${members.join(', ')} }${notes.length === 0 ? '' : ` (${notes.join('; ')})`}`;
}
function makeDefaultClassifyBossText(machine, entryEvent, bossEvents) {
    const contracts = defaultBossEventSpecs(machine, entryEvent, bossEvents);
    return async (text, ports, signal, snapshotOrState, boundary) => {
        const trimmed = text.trim();
        if (trimmed === '')
            return undefined;
        const state = classifierState(snapshotOrState);
        const stateId = typeof state.value === 'string' ? state.value : undefined;
        const currentState = stateId ?? JSON.stringify(state.value ?? null);
        const pending = pendingBossQuestionFromContext(state.context);
        const configuredTypes = configuredEventTypesForState(machine, stateId);
        const applicable = [...contracts.values()].filter((contract) => configuredTypes.has(contract.type) &&
            (contract.type !== 'BOSS_REPLY' || pending !== undefined));
        const lines = [
            'Classify the following Boss message into exactly one event.',
            'Respond with one exact flat JSON object. Do not add fields that are not shown.',
            'The runtime, not the judge, attaches the exact Boss text to textual event fields.',
            '',
            `Current state: ${currentState}`,
        ];
        if (pending !== undefined) {
            lines.push(`Pending question id: ${pending.questionId}`, `Pending asking player: ${pending.player}`, `Pending Boss question: ${pending.question}`);
        }
        lines.push('', 'Allowed JSON objects:', '- { "type": "NO_ACTION" }');
        for (const contract of applicable) {
            lines.push(`- ${eventContractPrompt(contract)}`);
        }
        lines.push('', 'Boss message:', '```', text, '```');
        const prompt = lines.join('\n');
        const raw = boundary
            ? await boundary.callJudge('boss-input-classification', stateId, prompt, signal)
            : await ports.callJudge(prompt, signal);
        let parsed;
        try {
            parsed = parseJudgeJson(raw);
        }
        catch {
            await ports.emitStatus('Classifier reply was not recoverable JSON');
            return undefined;
        }
        if (typeof parsed !== 'object' ||
            parsed === null ||
            Array.isArray(parsed)) {
            await ports.emitStatus('Classifier returned a non-object JSON response');
            return undefined;
        }
        const obj = parsed;
        const eventType = obj.type;
        if (typeof eventType !== 'string') {
            await ports.emitStatus('Classifier did not name an event type');
            return undefined;
        }
        if (eventType === 'NO_ACTION') {
            if (Object.keys(obj).length !== 1) {
                await ports.emitStatus('Classifier supplied extra fields for NO_ACTION');
                return undefined;
            }
            return undefined;
        }
        const contract = applicable.find((candidate) => candidate.type === eventType);
        if (contract === undefined) {
            await ports.emitStatus(`Classifier returned unknown or inapplicable event type: ${eventType}`);
            return undefined;
        }
        const fields = contract.fields ?? {};
        const judgeFields = new Set(Object.entries(fields)
            .filter(([, field]) => field.source === 'judge')
            .map(([field]) => field));
        const extras = Object.keys(obj).filter((field) => field !== 'type' && !judgeFields.has(field));
        if (extras.length > 0) {
            await ports.emitStatus(`Classifier supplied undeclared field for ${eventType}: ${extras[0]}`);
            return undefined;
        }
        const event = { type: eventType };
        for (const [field, fieldSpec] of Object.entries(fields)) {
            if (fieldSpec.source === 'text') {
                event[field] = text;
                continue;
            }
            const value = obj[field];
            if (value === undefined && fieldSpec.required !== true)
                continue;
            if (typeof value !== 'string' || value.length === 0) {
                await ports.emitStatus(`Classifier omitted or invalidated ${field} for ${eventType}`);
                return undefined;
            }
            if (fieldSpec.values !== undefined && !fieldSpec.values.includes(value)) {
                await ports.emitStatus(`Classifier supplied unknown ${field} for ${eventType}: ${value}`);
                return undefined;
            }
            event[field] = value;
        }
        if (eventType === 'BOSS_REPLY') {
            if (pending === undefined) {
                await ports.emitStatus('Classifier returned BOSS_REPLY without a pending question');
                return undefined;
            }
            const questionId = event.questionId;
            if (questionId !== undefined && questionId !== pending.questionId) {
                await ports.emitStatus(`Classifier supplied unknown questionId for BOSS_REPLY: ${String(questionId)}`);
                return undefined;
            }
            event.questionId = pending.questionId;
        }
        const can = snapshotOrState?.can;
        if (typeof can === 'function' &&
            !can.call(snapshotOrState, event)) {
            await ports.emitStatus(`Classifier selected ${eventType}, but its state guards rejected the event`);
            return undefined;
        }
        return event;
    };
}
/**
 * Build a `PlaybookRuntimeFactory` that interprets the given FSM artifact
 * under the slc/link.md contract. The factory provides every actor kind the
 * machine declares — `player`, `script`, `captain`, and nested `playbook`
 * (literal and dynamic) — and implements the full runtime lifecycle including
 * the optional parked-session snapshot capability (DR-014).
 *
 * Scope: single-region root machines (each snapshot exposes exactly one
 * playbook state id). Parallel-region FSMs keep their own linked runtimes.
 */
export function createXStatePlaybookRuntime(machine, spec) {
    const label = spec.label ?? 'playbook';
    const declaredActors = collectInvokeSources(machine);
    const resumableStateIds = spec.resumableStateIds ?? resumableStateIdsFromMachine(machine);
    const resolvePlayerIdSpec = spec.resolvePlayerId;
    const composePlayerPrompt = spec.composePlayerPrompt ??
        ((input) => defaultComposePlayerPrompt(input, spec.placeholderFields));
    const composeCaptainPrompt = spec.composeCaptainPrompt ??
        ((input) => defaultComposeCaptainPrompt(input, spec.placeholderFields));
    const adjudication = {
        ...(spec.buildJudgePrompt !== undefined
            ? { buildJudgePrompt: spec.buildJudgePrompt }
            : {}),
        ...(spec.extractRequiredFields !== undefined
            ? { extractRequiredFields: spec.extractRequiredFields }
            : {}),
        ...(spec.verbatimPayloadFields !== undefined
            ? { verbatimPayloadFields: spec.verbatimPayloadFields }
            : {}),
    };
    const extractFields = spec.extractRequiredFields ?? defaultExtractRequiredFields;
    // Build the derived classifier unconditionally: it is the sole validator of
    // supplied `bossEvents`, and DR-019 §2 requires a conflicting duplicate to
    // fail factory construction whether or not this spec overrides the
    // classifier that would have consumed the contracts.
    const derivedClassifyBossText = makeDefaultClassifyBossText(machine, spec.entryEvent, spec.bossEvents ?? []);
    const classifyBossText = spec.classifyBossText ?? derivedClassifyBossText;
    const normalizeTransitionEvent = spec.normalizeTransitionEvent ??
        makeDefaultNormalizeTransitionEvent(spec.transitionEventFields ?? []);
    const statusesForState = spec.statusesForState ?? defaultStatusesForState;
    const machineInput = spec.machineInput ?? ((options) => options);
    const scriptCwd = spec.scriptCwd ??
        ((options) => {
            const cwd = options?.cwd;
            return typeof cwd === 'string' ? cwd : undefined;
        });
    return function createPlaybookRuntime(options) {
        const boundOptions = spec.snapshotOptions(options);
        const boundScriptCwd = scriptCwd(boundOptions);
        let actor;
        let session;
        let initialized = false;
        let initInFlight;
        let disposalPromise;
        let disposed = false;
        let savedPorts;
        let runtimePorts;
        // The Boss's per-turn AbortSignal, surfaced to the provided actors so
        // ports.callPlayer / callCaptain / callJudge see the right cancellation
        // source. undefined between turns; set by the public boundaries.
        let activeSignal;
        let activeTurnId;
        let controlPlaneError;
        // Previous root-machine state for the inspect-driven telemetry /
        // status emitter. undefined before the first inspect firing.
        let priorState;
        let suppressInspectionEmissions = false;
        let traceSequence = 0;
        let turnSequence = 0;
        let judgeCallSequence = 0;
        let playerCallSequence = 0;
        let playbookCallSequence = 0;
        let captainCallSequence = 0;
        const playerResumeTokens = new Map();
        const activePlayerIds = new Set();
        const playbookCallTurnIds = new Map();
        // Captain and judge work share one serialized lane (slc/link.md
        // §Session lifecycle).
        const judgeQueue = new PQueue({ concurrency: 1 });
        const emissionQueue = new PQueue({ concurrency: 1 });
        const activeEmissionCalls = new Set();
        // All trace, state-telemetry, and status work shares this one queue.
        // Inspection callbacks enqueue a complete ordered batch synchronously;
        // imperative boundaries await their queued work directly.
        let emissionFailure;
        function enqueueEmission(fn) {
            const queued = emissionQueue.add(fn).then(() => undefined);
            activeEmissionCalls.add(queued);
            void queued.then(() => activeEmissionCalls.delete(queued), (error) => {
                activeEmissionCalls.delete(queued);
                emissionFailure ??= error;
            });
            return queued;
        }
        async function drainEmissions() {
            while (true) {
                const active = [...activeEmissionCalls];
                if (active.length > 0)
                    await Promise.allSettled(active);
                await emissionQueue.onIdle();
                if (activeEmissionCalls.size === 0 &&
                    emissionQueue.size === 0 &&
                    emissionQueue.pending === 0) {
                    break;
                }
            }
            if (emissionFailure !== undefined) {
                const error = emissionFailure;
                emissionFailure = undefined;
                throw error;
            }
        }
        function requireSession() {
            if (!session) {
                throw new Error('createPlaybookRuntime: init must be called first');
            }
            return session;
        }
        function requireHostPorts() {
            if (!savedPorts) {
                throw new Error('createPlaybookRuntime: init must be called first');
            }
            return savedPorts;
        }
        function createTraceEvent(type, payload, position = {}) {
            const currentSession = requireSession();
            const safePayload = snapshotJsonValue(payload, `trace ${type} payload`);
            return {
                schemaVersion: 2,
                sessionId: currentSession.sessionId,
                playbookId: currentSession.playbookId,
                rootSessionId: currentSession.rootSessionId,
                ...(currentSession.parentSessionId !== undefined
                    ? { parentSessionId: currentSession.parentSessionId }
                    : {}),
                ...(currentSession.parentCallId !== undefined
                    ? { parentCallId: currentSession.parentCallId }
                    : {}),
                depth: currentSession.depth,
                sequence: ++traceSequence,
                timestamp: Date.now(),
                type,
                ...(position.turnId !== undefined ? { turnId: position.turnId } : {}),
                ...(position.callId !== undefined ? { callId: position.callId } : {}),
                payload: safePayload,
            };
        }
        function emitTrace(type, payload, position = {}) {
            const currentSession = requireSession();
            const event = createTraceEvent(type, payload, position);
            return enqueueEmission(() => currentSession.ports.emitTelemetry({
                topic: 'playbook.trace',
                payload: event,
            }));
        }
        function stateIdentity(stateId) {
            return stateId === undefined ? {} : { stateId };
        }
        function currentState() {
            if (!actor) {
                throw new Error('createPlaybookRuntime: actor is not initialized');
            }
            return normalizePlaybookSnapshot(actor.getSnapshot(), {
                pendingCall: nestedBridge.getPendingCall(),
            });
        }
        function stateTracePayload(state = currentState()) {
            return {
                state,
                ...stateIdentity(state.stateId),
            };
        }
        function createRuntimePorts(hostPorts) {
            return {
                callPlayer: (playerId, prompt, signal, callOptions) => hostPorts.callPlayer(playerId, prompt, signal, callOptions),
                callCaptain: (prompt, signal, callOptions) => hostPorts.callCaptain(prompt, signal, callOptions),
                callJudge: (prompt, signal) => hostPorts.callJudge(prompt, signal),
                callPlaybook: (request, signal) => hostPorts.callPlaybook(request, signal),
                emitStatus: (message, data) => {
                    const descriptor = actor ? currentState() : undefined;
                    const safeData = data === undefined
                        ? undefined
                        : snapshotJsonValue(data, 'status data');
                    const trace = createTraceEvent('status.emitted', {
                        message,
                        ...(safeData !== undefined ? { data: safeData } : {}),
                        ...(descriptor !== undefined
                            ? {
                                state: descriptor,
                                ...stateIdentity(descriptor.stateId),
                            }
                            : {}),
                    }, activeTurnId !== undefined ? { turnId: activeTurnId } : {});
                    return enqueueEmission(async () => {
                        await hostPorts.emitTelemetry({
                            topic: 'playbook.trace',
                            payload: trace,
                        });
                        await hostPorts.emitStatus(message, safeData);
                    });
                },
                emitTelemetry: (event) => {
                    if (typeof event.topic !== 'string' || event.topic.length === 0) {
                        throw new TypeError('telemetry topic must be a non-empty string');
                    }
                    const payload = snapshotJsonValue(event.payload, 'telemetry payload');
                    return enqueueEmission(() => hostPorts.emitTelemetry({ topic: event.topic, payload }));
                },
            };
        }
        async function emitCallStarted(startedType, finishedType, identity, position) {
            try {
                await emitTrace(startedType, identity, position);
            }
            catch (error) {
                controlPlaneError ??= error;
                try {
                    await emitTrace(finishedType, { ...identity, status: 'error', error: normalizeError(error) }, position);
                }
                catch {
                    // Preserve the start failure after one best-effort finish attempt.
                }
                throw error;
            }
        }
        const boundary = {
            async callPlayer(input, playerId, prompt, signal) {
                // State-entry telemetry/status must precede the call they describe.
                await drainEmissions();
                const turnId = activeTurnId;
                const callId = `player-${++playerCallSequence}`;
                const stateId = input.stateId;
                const resume = playerResumeTokens.get(playerId) ?? false;
                const identity = {
                    purpose: 'captain',
                    ...stateIdentity(stateId),
                    sourceItem: input.sourceItem,
                    playerId,
                    resume,
                };
                const position = {
                    ...(turnId !== undefined ? { turnId } : {}),
                    callId,
                };
                if (activePlayerIds.has(playerId)) {
                    const error = new Error(`simultaneous calls to resolved player ${playerId} are not allowed`);
                    await emitCallStarted('player.call.started', 'player.call.finished', { ...identity, prompt }, position);
                    await emitTrace('player.call.finished', { ...identity, status: 'error', error: normalizeError(error) }, position);
                    throw error;
                }
                activePlayerIds.add(playerId);
                try {
                    await emitTrace('player.call.started', { ...identity, prompt }, position);
                    let rawResult;
                    try {
                        rawResult = await requireHostPorts().callPlayer(playerId, prompt, signal, { resume });
                        // A host promise is not required to honor cancellation. Do not let
                        // a late result mutate continuity or publish a successful finish.
                        signal.throwIfAborted();
                    }
                    catch (error) {
                        if (!signal.aborted)
                            controlPlaneError ??= error;
                        try {
                            await emitTrace('player.call.finished', {
                                ...identity,
                                status: signal.aborted ? 'aborted' : 'error',
                                error: normalizeError(error),
                            }, position);
                        }
                        catch {
                            // The original non-abort port rejection remains authoritative.
                        }
                        // A thrown port call carries no authoritative result, so the
                        // prior token remains available for a later explicit resume.
                        throw error;
                    }
                    let result;
                    try {
                        result = validatePlayerResult(rawResult);
                    }
                    catch (error) {
                        if (!signal.aborted)
                            controlPlaneError ??= error;
                        try {
                            await emitTrace('player.call.finished', { ...identity, status: 'error', error: normalizeError(error) }, position);
                        }
                        catch {
                            // The malformed host result remains authoritative.
                        }
                        throw error;
                    }
                    if (typeof result.resumeToken === 'string' &&
                        result.resumeToken.trim().length > 0) {
                        playerResumeTokens.set(playerId, result.resumeToken);
                    }
                    else {
                        playerResumeTokens.delete(playerId);
                    }
                    await emitTrace('player.call.finished', {
                        ...identity,
                        status: result.status,
                        ...(result.finalText !== undefined
                            ? { finalText: result.finalText }
                            : {}),
                        ...(result.error !== undefined
                            ? { error: normalizeError(result.error) }
                            : {}),
                        ...(result.resumeToken !== undefined
                            ? { resumeToken: result.resumeToken }
                            : {}),
                    }, position);
                    return result;
                }
                finally {
                    activePlayerIds.delete(playerId);
                }
            },
            async callJudge(purpose, stateId, prompt, signal) {
                return judgeQueue.add(async () => {
                    signal.throwIfAborted();
                    // A transition/status queued synchronously by XState must reach
                    // the host before the judge call that follows it.
                    await drainEmissions();
                    signal.throwIfAborted();
                    const turnId = activeTurnId;
                    const callId = `judge-${++judgeCallSequence}`;
                    const identity = { purpose, ...stateIdentity(stateId) };
                    const position = {
                        ...(turnId !== undefined ? { turnId } : {}),
                        callId,
                    };
                    await emitCallStarted('judge.call.started', 'judge.call.finished', { ...identity, prompt }, position);
                    let reply;
                    try {
                        reply = await requireHostPorts().callJudge(prompt, signal);
                        signal.throwIfAborted();
                    }
                    catch (error) {
                        if (!isAbortFailure(error, signal)) {
                            controlPlaneError ??= error;
                        }
                        await emitTrace('judge.call.finished', {
                            ...identity,
                            status: signal.aborted ? 'aborted' : 'error',
                            error: normalizeError(error),
                        }, position);
                        throw error;
                    }
                    if (typeof reply !== 'string') {
                        const error = new TypeError('judge reply must be a string');
                        controlPlaneError ??= error;
                        await emitTrace('judge.call.finished', { ...identity, status: 'error', error: normalizeError(error) }, position);
                        throw error;
                    }
                    // Keep the success finish outside the port-call catch. If a
                    // telemetry sink records this boundary and then rejects, that sink
                    // failure must not synthesize a second, contradictory finish.
                    await emitTrace('judge.call.finished', { ...identity, status: 'ok', reply }, position);
                    // The finish sink is part of the classifier boundary. A signal may
                    // abort while that ordered emission drains; never let the already
                    // classified event mutate the machine afterward.
                    signal.throwIfAborted();
                    return reply;
                });
            },
            async callCaptain(input, prompt, signal) {
                return judgeQueue.add(async () => {
                    signal.throwIfAborted();
                    await drainEmissions();
                    signal.throwIfAborted();
                    const turnId = activeTurnId;
                    const callId = `captain-${++captainCallSequence}`;
                    const identity = {
                        ...stateIdentity(input.stateId),
                        sourceItem: input.sourceItem,
                        visibility: 'visible',
                        resume: false,
                        ...(input.allowedTools === undefined
                            ? {}
                            : { allowedTools: [...input.allowedTools] }),
                    };
                    const position = {
                        ...(turnId !== undefined ? { turnId } : {}),
                        callId,
                    };
                    await emitCallStarted('captain.call.started', 'captain.call.finished', { ...identity, prompt }, position);
                    let rawResult;
                    try {
                        rawResult = await requireHostPorts().callCaptain(prompt, signal, {
                            visibility: 'visible',
                            resume: false,
                            ...(input.allowedTools !== undefined
                                ? { allowedTools: input.allowedTools }
                                : {}),
                        });
                        signal.throwIfAborted();
                    }
                    catch (error) {
                        if (!isAbortFailure(error, signal))
                            controlPlaneError ??= error;
                        await emitTrace('captain.call.finished', {
                            ...identity,
                            status: signal.aborted ? 'aborted' : 'error',
                            error: normalizeError(error),
                        }, position);
                        throw error;
                    }
                    let result;
                    try {
                        result = validateCaptainResult(rawResult);
                    }
                    catch (error) {
                        controlPlaneError ??= error;
                        await emitTrace('captain.call.finished', { ...identity, status: 'error', error: normalizeError(error) }, position);
                        throw error;
                    }
                    // A non-`ok` host result is a recoverable FSM failure (PBRT-47), so
                    // it is never latched as a control-plane error; it is still
                    // authoritative for the actor's error path even when the required
                    // finish emission fails or a coincident boundary abort lands.
                    let resultFailure;
                    if (result.status !== 'ok') {
                        resultFailure = markFsmResultFailure(new Error(result.error ??
                            `captainActor: callCaptain status "${result.status}"`));
                    }
                    else if (result.finalText === undefined || result.finalText === '') {
                        resultFailure = markFsmResultFailure(new Error('captainActor: callCaptain returned status=ok with no finalText'));
                    }
                    try {
                        await emitTrace('captain.call.finished', {
                            ...identity,
                            status: result.status,
                            ...(result.finalText !== undefined
                                ? { finalText: result.finalText }
                                : {}),
                            ...(result.error !== undefined
                                ? { error: normalizeError(result.error) }
                                : resultFailure !== undefined
                                    ? { error: normalizeError(resultFailure) }
                                    : {}),
                        }, position);
                    }
                    catch (error) {
                        // Keep the finish-sink failure in the emission queue for public
                        // cleanup evidence, but do not replace an authoritative result
                        // failure on the invoked actor's XState onError path.
                        if (resultFailure !== undefined)
                            throw resultFailure;
                        throw error;
                    }
                    if (resultFailure !== undefined) {
                        throw resultFailure;
                    }
                    return result;
                });
            },
        };
        function resolvePlayerId(input) {
            return resolvePlayerIdSpec
                ? resolvePlayerIdSpec(input, boundOptions)
                : defaultResolvePlayerId(input);
        }
        function playerActor(ports) {
            return createPlayerBridge({
                resolvePlayerId,
                composePlayerPrompt,
                adjudication,
                resumableStateIds,
            }, ports, () => activeSignal, boundary, (error) => {
                if (!activeSignal?.aborted)
                    controlPlaneError ??= error;
            });
        }
        // Direct-Captain actor (slc/link.md §Captain prompt composition,
        // §Captain adjudication): one visible callCaptain, then hidden judge
        // adjudication that injects the exact visible finalText as the selected
        // output's question/response.
        function captainActor() {
            return fromPromise(async ({ input, signal }) => {
                const active = combineAbortSignals(signal, activeSignal);
                try {
                    await drainEmissions();
                    const prompt = composeCaptainPrompt(input);
                    const result = await boundary.callCaptain(input, prompt, active);
                    // The boundary owns result validation (PBRT-47) and throws the
                    // authoritative failure itself, so a returned result is always
                    // `ok` with visible text. Assert that invariant rather than
                    // restating the failure semantics, which would drift.
                    if (result.status !== 'ok' || !result.finalText) {
                        throw new Error('captainActor: boundary returned an unvalidated Captain result');
                    }
                    const judgePrompt = buildCaptainJudgePrompt(input, result.finalText);
                    const raw = await boundary.callJudge('captain-output-adjudication', input.stateId, judgePrompt, active);
                    const output = adjudicateCaptainOutput(extractFields, input, result.finalText, raw);
                    validateBossReplyOutput(input, output, resumableStateIds);
                    return output;
                }
                catch (error) {
                    // A host-reported Captain result failure routes to the FSM's
                    // failure state (PBRT-47); everything else here — a drained
                    // emission failure, prompt composition, the port itself,
                    // adjudication — is control plane.
                    if (!active.aborted && !isFsmResultFailure(error)) {
                        controlPlaneError ??= error;
                    }
                    throw error;
                }
            });
        }
        // Deterministic script actor (slc/link.md §Script execution). Runs
        // `input.command` through `sh -c`, resolves the declared guard
        // mechanically from the exit status, and emits one status + one
        // `playbook.script` telemetry event. No agent call, no adjudication,
        // no `*.call.*` trace.
        function scriptActor() {
            return fromPromise(async ({ input, signal }) => {
                await drainEmissions();
                const active = combineAbortSignals(signal, activeSignal);
                const guards = Object.keys(input.result);
                const okGuard = guards[0];
                const failedGuard = guards[1] ?? guards[0];
                const cwd = boundScriptCwd ?? process.cwd();
                const ports = runtimePorts ?? requireHostPorts();
                const exitStatus = await new Promise((resolve, reject) => {
                    let child;
                    try {
                        child = spawn('sh', ['-c', input.command], {
                            cwd,
                            stdio: 'ignore',
                        });
                    }
                    catch (error) {
                        reject(error);
                        return;
                    }
                    const onAbort = () => {
                        child.kill('SIGTERM');
                        reject(active.reason ?? new Error('script aborted'));
                    };
                    if (active.aborted) {
                        onAbort();
                        return;
                    }
                    active.addEventListener('abort', onAbort, { once: true });
                    child.on('error', (error) => {
                        active.removeEventListener('abort', onAbort);
                        reject(error);
                    });
                    child.on('close', (code) => {
                        active.removeEventListener('abort', onAbort);
                        resolve(typeof code === 'number' ? code : 1);
                    });
                });
                await ports.emitStatus(`Executed script for ${input.stateId} (exit ${exitStatus}).`);
                await ports.emitTelemetry({
                    topic: 'playbook.script',
                    payload: {
                        stateId: input.stateId,
                        sourceItem: input.sourceItem,
                        exitStatus,
                    },
                });
                if (exitStatus === 0) {
                    return { guard: okGuard, exitStatus: 0 };
                }
                return { guard: failedGuard, exitStatus };
            });
        }
        const nestedBridge = createNestedPlaybookBridge({
            nextCallId: () => `playbook-${++playbookCallSequence}`,
            getBoundarySignal: () => activeSignal,
            callPlaybook: (request, signal) => requireHostPorts().callPlaybook(request, signal),
            emitStarted: async (event) => {
                playbookCallTurnIds.set(event.callId, activeTurnId);
                await emitTrace('playbook.call.started', {
                    stateId: event.stateId,
                    playbookId: event.playbookId,
                    text: event.text,
                }, {
                    ...(activeTurnId !== undefined ? { turnId: activeTurnId } : {}),
                    callId: event.callId,
                });
            },
            emitFinished: async (event) => {
                const turnId = playbookCallTurnIds.get(event.callId);
                try {
                    await emitTrace('playbook.call.finished', {
                        stateId: event.stateId,
                        playbookId: event.playbookId,
                        text: event.text,
                        result: event.result,
                    }, {
                        ...(turnId !== undefined ? { turnId } : {}),
                        callId: event.callId,
                    });
                }
                finally {
                    playbookCallTurnIds.delete(event.callId);
                }
            },
            drain: drainEmissions,
            bindResumeSignal: (signal) => {
                activeSignal = signal;
            },
            onControlPlaneError: (error) => {
                if (!activeSignal?.aborted)
                    controlPlaneError ??= error;
            },
            onBackgroundError: (error) => {
                emissionFailure ??= error;
            },
        });
        function tracePositionForActiveTurn() {
            return activeTurnId === undefined ? {} : { turnId: activeTurnId };
        }
        function structuredStateTelemetryPayload(previousState, state, event, context) {
            const payload = {
                from: previousState?.value ?? null,
                to: state.value,
                event: normalizeTransitionEvent(event) ?? null,
                previousState: previousState ?? null,
                state,
            };
            if (state.stateId === 'awaitBossReply') {
                const pendingBossQuestion = pendingBossQuestionFromContext(context);
                if (pendingBossQuestion !== undefined) {
                    payload.pendingBossQuestion = pendingBossQuestion;
                }
            }
            if (state.stateId === 'failed') {
                const lastError = normalizeErrorFull(context.lastError);
                if (lastError !== undefined)
                    payload.lastError = lastError;
            }
            return snapshotJsonValue(payload, 'FSM telemetry payload');
        }
        function enqueueTransitionEmission(payload, state, statuses, position) {
            const currentSession = requireSession();
            const transitionTrace = createTraceEvent('fsm.transition', payload, position);
            const statusEmissions = statuses.map(({ message, data }) => ({
                message,
                data,
                trace: createTraceEvent('status.emitted', {
                    message,
                    ...(data === undefined ? {} : { data }),
                    state,
                    ...stateIdentity(state.stateId),
                }, position),
            }));
            void enqueueEmission(async () => {
                await currentSession.ports.emitTelemetry({
                    topic: 'playbook.trace',
                    payload: transitionTrace,
                });
                await currentSession.ports.emitTelemetry({
                    topic: 'playbook.fsm.state',
                    payload,
                });
                for (const status of statusEmissions) {
                    await currentSession.ports.emitTelemetry({
                        topic: 'playbook.trace',
                        payload: status.trace,
                    });
                    await currentSession.ports.emitStatus(status.message, status.data);
                }
            }).catch(() => undefined);
        }
        function latchInspectionError(error) {
            if (activeSignal !== undefined)
                controlPlaneError ??= error;
            else
                emissionFailure ??= error;
        }
        function buildActor(ports, machineSnapshot) {
            priorState = undefined;
            const actors = {};
            if (declaredActors.has('player'))
                actors.player = playerActor(ports);
            if (declaredActors.has('captain'))
                actors.captain = captainActor();
            if (declaredActors.has('script'))
                actors.script = scriptActor();
            if (declaredActors.has('playbook')) {
                actors.playbook = nestedBridge.actorLogic;
            }
            const provided = machine.provide({
                actors: actors,
            });
            let builtActor;
            builtActor = createActor(provided, {
                input: machineInput(boundOptions, requireSession()),
                // DR-014 §1: a restore rehydrates the persisted machine snapshot;
                // XState derives context/value from it and ignores `input` then.
                ...(machineSnapshot === undefined
                    ? {}
                    : { snapshot: machineSnapshot }),
                inspect: (inspectionEvent) => {
                    if (inspectionEvent.type !== '@xstate.snapshot')
                        return;
                    if (inspectionEvent.actorRef !== builtActor)
                        return;
                    if (suppressInspectionEmissions)
                        return;
                    try {
                        const snap = inspectionEvent.snapshot;
                        const state = normalizePlaybookSnapshot(snap);
                        if (state.stateId === undefined) {
                            throw new Error(`${label} root snapshot must expose exactly one playbook state id`);
                        }
                        const previousState = priorState;
                        const context = (snap.context ??
                            {});
                        const payload = structuredStateTelemetryPayload(previousState, state, inspectionEvent.event, context);
                        const statuses = statusesForState(state, context, inspectionEvent.event);
                        enqueueTransitionEmission(payload, state, statuses, tracePositionForActiveTurn());
                        priorState = state;
                    }
                    catch (error) {
                        latchInspectionError(error);
                    }
                },
            });
            return builtActor;
        }
        function runResultFor(outcome, error) {
            const state = currentState();
            if (outcome === 'quiescent' || outcome === 'no-action') {
                return { outcome, state };
            }
            if (outcome === 'suspended') {
                const pendingCall = nestedBridge.getPendingCall();
                if (!pendingCall) {
                    throw new Error('suspended runtime has no pending playbook call');
                }
                return { outcome, state, pendingCall };
            }
            if (outcome === 'terminal') {
                const output = actor?.getSnapshot()?.output;
                if (output !== undefined) {
                    return {
                        outcome,
                        state,
                        output: snapshotJsonValue(output, 'terminal playbook output'),
                    };
                }
                return { outcome, state };
            }
            const failure = error ??
                (outcome === 'failed'
                    ? actor?.getSnapshot()
                        ?.context?.lastError
                    : outcome === 'aborted'
                        ? activeSignal?.reason
                        : undefined);
            return {
                outcome,
                state,
                ...(failure !== undefined ? { error: normalizeError(failure) } : {}),
            };
        }
        function settledOutcome(signal) {
            if (nestedBridge.getPendingCall())
                return 'suspended';
            if (signal.aborted)
                return 'aborted';
            const state = currentState();
            if (state.status === 'error') {
                const actorError = actor?.getSnapshot()?.error;
                throw actorError ?? new Error(`${label} actor entered error status`);
            }
            if (state.status === 'done')
                return 'terminal';
            if (state.stateId === 'failed')
                return 'failed';
            return 'quiescent';
        }
        function settlementTracePayload(result) {
            return {
                ...result,
                ...stateIdentity(result.state.stateId),
            };
        }
        // Shared failed-start cleanup for init and restore: stop the actor,
        // abort/drain nested and host work, optionally emit one best-effort
        // session.disposed boundary, and unbind every closure field so dispose
        // stays callable. The caller rethrows its original failure. A restore
        // failure skips the disposal trace — the parked session was never
        // re-bound in this process, so its persisted snapshot stays
        // authoritative (DR-014 §2).
        async function cleanupFailedStart(cause, options) {
            let finalState;
            if (options.emitDisposal && actor) {
                try {
                    finalState = currentState();
                }
                catch {
                    // A state that cannot even normalize has no disposal descriptor.
                }
            }
            suppressInspectionEmissions = true;
            try {
                actor?.stop();
            }
            catch {
                // Preserve the original startup failure.
            }
            try {
                await nestedBridge.abortPending(cause);
            }
            catch {
                // Preserve the original startup failure.
            }
            try {
                await judgeQueue.onIdle();
                await drainEmissions();
            }
            catch {
                // Preserve the original startup failure.
            }
            if (options.emitDisposal) {
                try {
                    await emitTrace('session.disposed', finalState === undefined
                        ? {}
                        : {
                            state: finalState,
                            ...stateIdentity(finalState.stateId),
                        });
                    await drainEmissions();
                }
                catch {
                    // The session-start error remains authoritative.
                }
            }
            playerResumeTokens.clear();
            activePlayerIds.clear();
            playbookCallTurnIds.clear();
            activeEmissionCalls.clear();
            emissionQueue.clear();
            judgeQueue.clear();
            actor = undefined;
            session = undefined;
            savedPorts = undefined;
            runtimePorts = undefined;
            activeSignal = undefined;
            activeTurnId = undefined;
            controlPlaneError = undefined;
            emissionFailure = undefined;
            priorState = undefined;
            suppressInspectionEmissions = false;
            initialized = false;
            traceSequence = 0;
            turnSequence = 0;
            judgeCallSequence = 0;
            playerCallSequence = 0;
            playbookCallSequence = 0;
            captainCallSequence = 0;
        }
        const runtime = {
            async init(nextSession) {
                if (initialized || disposed || disposalPromise !== undefined) {
                    throw new Error('createPlaybookRuntime.init: already initialized');
                }
                const boundSession = snapshotPlaybookSession(nextSession);
                initialized = true;
                let finishInitialization;
                const initialization = new Promise((resolve) => {
                    finishInitialization = resolve;
                });
                initInFlight = initialization;
                const initTask = (async () => {
                    session = boundSession;
                    savedPorts = boundSession.ports;
                    runtimePorts = createRuntimePorts(boundSession.ports);
                    suppressInspectionEmissions = false;
                    actor = buildActor(runtimePorts);
                    await emitTrace('session.started', stateTracePayload());
                    actor.start();
                    await drainEmissions();
                })();
                try {
                    await initTask;
                }
                catch (error) {
                    await cleanupFailedStart(error, { emitDisposal: true });
                    throw error;
                }
                finally {
                    finishInitialization();
                    if (initInFlight === initialization)
                        initInFlight = undefined;
                }
            },
            // DR-014 §1 / PBRT-45: JSON-safe capture of a parked session.
            // Defined only at a safe capture point — initialized, not disposing
            // or disposed, no active public boundary, no pending nested call,
            // and the actor quiescent with status `active`.
            exportSnapshot() {
                if (!actor || !session || disposed || disposalPromise !== undefined) {
                    return undefined;
                }
                if (activeSignal !== undefined)
                    return undefined;
                if (nestedBridge.getPendingCall())
                    return undefined;
                const state = currentState();
                if (state.status !== 'active' || !state.quiescent)
                    return undefined;
                const machineSnapshot = detachPersistedMachineSnapshot(actor.getPersistedSnapshot());
                const context = actor.getSnapshot()
                    .context;
                const pending = pendingBossQuestionFromContext(context ?? {});
                return {
                    schemaVersion: 1,
                    playbookId: session.playbookId,
                    machine: machineSnapshot,
                    playerResumeTokens: Object.fromEntries(playerResumeTokens),
                    sequences: {
                        trace: traceSequence,
                        turn: turnSequence,
                        judgeCall: judgeCallSequence,
                        playerCall: playerCallSequence,
                        playbookCall: playbookCallSequence,
                        ...(declaredActors.has('captain')
                            ? { captainCall: captainCallSequence }
                            : {}),
                    },
                    state,
                    pendingBossQuestions: pending === undefined
                        ? []
                        : [
                            {
                                questionId: pending.questionId,
                                player: pending.player,
                                question: pending.question,
                                sourceItem: pending.sourceItem,
                            },
                        ],
                };
            },
            // DR-014 §1 / PBRT-45: alternative to `init` that rehydrates an
            // exported snapshot under the same immutable session identity.
            // Emits no `session.started`, transition trace, or human status —
            // the session already started; the next public boundary continues
            // the contiguous trace sequence.
            async restore(nextSession, snapshot) {
                if (initialized || disposed || disposalPromise !== undefined) {
                    throw new Error('createPlaybookRuntime.restore: already initialized');
                }
                const boundSession = snapshotPlaybookSession(nextSession);
                const boundSnapshot = assertPlaybookRuntimeSnapshot(snapshot, boundSession.playbookId);
                initialized = true;
                let finishInitialization;
                const initialization = new Promise((resolve) => {
                    finishInitialization = resolve;
                });
                initInFlight = initialization;
                const initTask = (async () => {
                    session = boundSession;
                    savedPorts = boundSession.ports;
                    runtimePorts = createRuntimePorts(boundSession.ports);
                    traceSequence = boundSnapshot.sequences.trace;
                    turnSequence = boundSnapshot.sequences.turn;
                    judgeCallSequence = boundSnapshot.sequences.judgeCall;
                    playerCallSequence = boundSnapshot.sequences.playerCall;
                    playbookCallSequence = boundSnapshot.sequences.playbookCall;
                    captainCallSequence =
                        boundSnapshot.sequences.captainCall ??
                            // Legacy schema-v1 snapshots predate this dedicated counter.
                            // Every Captain call already consumed at least one trace number,
                            // so the global trace counter is a collision-safe id floor.
                            boundSnapshot.sequences.trace;
                    playerResumeTokens.clear();
                    for (const [playerId, token] of Object.entries(boundSnapshot.playerResumeTokens)) {
                        playerResumeTokens.set(playerId, token);
                    }
                    suppressInspectionEmissions = true;
                    actor = buildActor(runtimePorts, boundSnapshot.machine);
                    actor.start();
                    const restoredState = currentState();
                    if (restoredState.status !== 'active') {
                        throw new Error(`createPlaybookRuntime.restore: restored actor status is ${restoredState.status}, expected active`);
                    }
                    suppressInspectionEmissions = false;
                    priorState = restoredState;
                    await drainEmissions();
                })();
                try {
                    await initTask;
                }
                catch (error) {
                    await cleanupFailedStart(error, { emitDisposal: false });
                    throw error;
                }
                finally {
                    finishInitialization();
                    if (initInFlight === initialization)
                        initInFlight = undefined;
                }
            },
            async handleBossInput({ text, signal, }) {
                if (!actor || !savedPorts) {
                    throw new Error('createPlaybookRuntime.handleBossInput: init must be called first');
                }
                if (disposed || disposalPromise !== undefined) {
                    throw new Error('createPlaybookRuntime.handleBossInput: runtime is disposing or disposed');
                }
                if (activeSignal !== undefined) {
                    throw new Error('createPlaybookRuntime.handleBossInput: another runtime turn is active');
                }
                const turnId = ++turnSequence;
                activeTurnId = turnId;
                activeSignal = signal;
                controlPlaneError = undefined;
                let result;
                let operationError;
                try {
                    await emitTrace('boss.input.received', { text }, { turnId });
                    // 1. Map the Boss text to an FSM event: deterministic exact entry
                    //    where applicable (slc/link.md §Boss-event mapping), judge
                    //    classification otherwise.
                    let event;
                    const trimmed = text.trim();
                    if (trimmed !== '') {
                        const snapshot = actor.getSnapshot();
                        const terminal = snapshot.status === 'done';
                        const stateId = normalizePlaybookSnapshot(snapshot).stateId;
                        if (spec.entryEvent !== undefined &&
                            (stateId === 'ready' || terminal)) {
                            event = {
                                type: spec.entryEvent.type,
                                [spec.entryEvent.textField]: text,
                            };
                        }
                        else {
                            event = await classifyBossText(text, runtimePorts, signal, snapshot, boundary);
                        }
                        signal.throwIfAborted();
                    }
                    // Empty input, no-action classifier output, or invalid classifier
                    // output — nothing to send.
                    if (event === undefined) {
                        result = runResultFor('no-action');
                    }
                    else {
                        // 2. Optional Captain-pane classification line: the bare FSM
                        //    event type, emitted before the FSM advances.
                        const statusLine = spec.classificationStatus?.(event);
                        if (statusLine !== undefined) {
                            await runtimePorts.emitStatus(statusLine);
                        }
                        signal.throwIfAborted();
                        // 3. A final actor cannot accept new events; reconstruct only
                        //    after classification produced a real event.
                        if (actor.getSnapshot().status === 'done') {
                            actor.stop();
                            actor = buildActor(runtimePorts);
                            actor.start();
                        }
                        actor.send(event);
                        await waitForPlaybookQuiescence(actor, {
                            pendingCalls: nestedBridge,
                        });
                        if (controlPlaneError !== undefined)
                            throw controlPlaneError;
                        result = runResultFor(settledOutcome(signal));
                    }
                }
                catch (error) {
                    operationError = error;
                }
                let drainError;
                try {
                    await drainEmissions();
                }
                catch (error) {
                    drainError = error;
                }
                const latchedControlError = controlPlaneError;
                const primaryError = latchedControlError ?? drainError ?? operationError;
                const abortError = latchedControlError === undefined &&
                    drainError === undefined &&
                    operationError !== undefined &&
                    isAbortFailure(operationError, signal);
                const settlementResult = primaryError === undefined
                    ? (result ?? runResultFor('no-action'))
                    : runResultFor(abortError ? 'aborted' : 'failed', primaryError);
                let settlementEmissionError;
                try {
                    await emitTrace('boss.input.settled', settlementTracePayload(settlementResult), { turnId });
                }
                catch (error) {
                    settlementEmissionError = error;
                }
                try {
                    await drainEmissions();
                }
                catch (error) {
                    settlementEmissionError ??= error;
                }
                const failure = controlPlaneError ??
                    latchedControlError ??
                    drainError ??
                    (abortError
                        ? (settlementEmissionError ?? operationError)
                        : (operationError ?? settlementEmissionError));
                activeSignal = undefined;
                activeTurnId = undefined;
                controlPlaneError = undefined;
                if (failure !== undefined &&
                    !(abortError && settlementEmissionError === undefined)) {
                    throw failure;
                }
                return settlementResult;
            },
            async resumePlaybookCall(input) {
                if (!actor || !savedPorts) {
                    throw new Error('createPlaybookRuntime.resumePlaybookCall: init must be called first');
                }
                if (disposed || disposalPromise !== undefined) {
                    throw new Error('createPlaybookRuntime.resumePlaybookCall: runtime is disposing or disposed');
                }
                if (activeSignal !== undefined) {
                    throw new Error('createPlaybookRuntime.resumePlaybookCall: another runtime turn is active');
                }
                activeTurnId = playbookCallTurnIds.get(input.callId);
                activeSignal = input.signal;
                controlPlaneError = undefined;
                let result;
                let operationError;
                try {
                    await nestedBridge.resume(input);
                }
                catch (error) {
                    operationError = error;
                }
                try {
                    await waitForPlaybookQuiescence(actor, {
                        pendingCalls: nestedBridge,
                    });
                    result = runResultFor(settledOutcome(input.signal));
                }
                catch (error) {
                    operationError ??= error;
                }
                let drainError;
                try {
                    await drainEmissions();
                }
                catch (error) {
                    drainError = error;
                }
                const failure = controlPlaneError ?? drainError ?? operationError;
                activeSignal = undefined;
                activeTurnId = undefined;
                controlPlaneError = undefined;
                if (failure !== undefined)
                    throw failure;
                if (result === undefined) {
                    throw new Error('playbook resume produced no runtime result');
                }
                return result;
            },
            dispose() {
                if (disposalPromise !== undefined)
                    return disposalPromise;
                if (disposed)
                    return Promise.resolve();
                if (activeSignal !== undefined) {
                    return Promise.reject(new Error('createPlaybookRuntime.dispose: cannot dispose during an active runtime boundary'));
                }
                const task = (async () => {
                    const failures = [];
                    try {
                        if (initInFlight !== undefined) {
                            try {
                                await initInFlight;
                            }
                            catch {
                                // Dispose still releases whatever an unsuccessful init bound.
                            }
                        }
                        const finalState = actor ? currentState() : undefined;
                        // Stop the root before settling a suspended child. Its rejection
                        // must not re-enter the FSM and start fresh work during disposal.
                        if (actor)
                            actor.stop();
                        try {
                            await nestedBridge.dispose();
                        }
                        catch (error) {
                            failures.push(error);
                        }
                        try {
                            await drainEmissions();
                        }
                        catch (error) {
                            failures.push(error);
                        }
                        if (session !== undefined) {
                            try {
                                await emitTrace('session.disposed', finalState === undefined
                                    ? {}
                                    : {
                                        state: finalState,
                                        ...stateIdentity(finalState.stateId),
                                    });
                                await drainEmissions();
                            }
                            catch (error) {
                                failures.push(error);
                            }
                        }
                    }
                    finally {
                        playerResumeTokens.clear();
                        activePlayerIds.clear();
                        playbookCallTurnIds.clear();
                        activeEmissionCalls.clear();
                        emissionQueue.clear();
                        judgeQueue.clear();
                        actor = undefined;
                        activeSignal = undefined;
                        activeTurnId = undefined;
                        controlPlaneError = undefined;
                        emissionFailure = undefined;
                        savedPorts = undefined;
                        runtimePorts = undefined;
                        session = undefined;
                        disposed = true;
                    }
                    if (failures.length === 1)
                        throw failures[0];
                    if (failures.length > 1) {
                        throw new AggregateError(failures, 'playbook runtime disposal failed');
                    }
                })();
                disposalPromise = task;
                return task;
            },
            // @internal — test-only escape hatches for inspecting the underlying
            // actor, traced boundary, and nested bridge. Not part of the stable
            // public runtime contract.
            _getActor() {
                return actor;
            },
            _getBoundary() {
                return boundary;
            },
            _getNestedBridge() {
                return nestedBridge;
            },
        };
        return runtime;
    };
}
