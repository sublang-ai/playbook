// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
/**
 * Compilation-correctness verification for a compiled `playbook` artifact
 * (IR-007 Task 8; DR-009).
 *
 * A compiled artifact is a judgment-produced program, so `slc` re-checks it
 * against its source. The GEARS↔FSM conformance check verifies that every GEARS
 * item the `text2gears` phase produced maps to exactly one FSM state carrying
 * that item's player binding and its prompt body verbatim, and that no FSM state
 * references an unknown item — so a `gears2fsm` result cannot silently drift from
 * its GEARS source (the [DR-005](../decisions/005-slc-self-hosting-meta-pipeline.md)
 * auditable GEARS-to-FSM mapping).
 *
 * {@link checkGearsFsmConformance} is the deterministic checker over parsed
 * inputs; {@link generateGearsFsmConformanceTest} emits a per-artifact test that
 * runs it beside the artifacts. The checker reads the `text2gears` item format
 * and the `gears2fsm` `invoke.input` contract, not any one artifact, so it holds
 * for every compiled `playbook`. See specs/dev/verification.md.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashFile } from './hash.js';
/**
 * The Boss-reply result key `gears2fsm` adds to every captain-invoking state's
 * `result` map, and the load-bearing substring its adjudicator-facing
 * description must carry so the runtime's judge requires a `question` payload
 * (gears2fsm.md "Boss-reply suspension"; DR-009).
 */
export const NEEDS_BOSS_REPLY = 'needsBossReply';
export const BOSS_QUESTION_MARKER = 'Output shall include `question:';
/**
 * The controller decision-state class (slc/gears2fsm.md §Setup, DR-029 §4):
 * stable compiler-contract guard discriminants of a controller playbook's
 * decision state. A machine declaring one such state is a controller
 * machine — its conversational hub receives every Boss turn, so no state
 * carries the Boss-reply suspension and the compiler adds no
 * `needsBossReply` result to its `invoke.input.result` maps.
 */
export const CONTROLLER_ACTION_GUARDS = Object.freeze([
    'respond',
    'resume',
    'start',
    'switch',
    'dismiss',
    'deliver',
    'runtime',
]);
/** True when `result` declares exactly the closed controller action set. */
export function isControllerDecisionResult(result) {
    const domain = Object.keys(result ?? {}).filter((guard) => guard !== NEEDS_BOSS_REPLY);
    return (domain.length === CONTROLLER_ACTION_GUARDS.length &&
        CONTROLLER_ACTION_GUARDS.every((guard) => domain.includes(guard)));
}
/** True when the machine declares a controller decision state. */
export function isControllerMachine(config) {
    return enumerateCaptainStates(config).some((state) => isControllerDecisionResult(state.result));
}
const ITEM_HEADING = /^###\s+([A-Za-z][\w-]*)\s*$/;
// The `text2gears` item form names a delegated player as "Captain shall prompt
// <Player>" (or a "relay ... to <Player>" variant); English players are
// capitalized, non-English names may be quoted (text2gears.md).
const ITEM_PLAYER = /Captain shall (?:prompt|relay\b[^.]*?\bto)\s+(?:"([^"]+)"|“([^”]+)”|([A-Z][\w]*))/;
const ITEM_PLAYBOOK = /Captain shall call playbook\s+(?:`([^`]+)`|"([^"]+)"|“([^”]+)”|([A-Za-z0-9][\w.-]*))\s*:/;
const ITEM_DYNAMIC_PLAYBOOK = /Captain shall call playbook selected by\s+`([^`]+)`\s*:/;
const DYNAMIC_TEXT = /^<([A-Za-z_$][A-Za-z0-9_$]*)>$/;
// Some items have Captain act directly ("Captain shall <verb> ...") with no
// delegated player; their player is Captain itself.
const CAPTAIN_ACTS = /\bCaptain shall\b/;
const BLOCKQUOTE = /^>\s?(.*)$/;
const SECTION_HEADING = /^##\s/;
const RESULTS_LABEL = /^Results:\s*$/;
const RESULTS_LABEL_NEAR_MISS = /^Results\s*:?[ \t]*$/;
const RESULT_BULLET = /^-\s+`([A-Za-z_$][A-Za-z0-9_$]*)`:\s+(\S(?:.*\S)?)\s*$/;
/**
 * Parses the GEARS items from a `gears` artifact: each `### <ID>` item's player,
 * blockquoted acting prompt, and optional ordered `Results:` metadata.
 */
export function parseGearsItems(gears) {
    const items = [];
    let current = null;
    const flush = () => {
        if (current !== null) {
            const player = current.player !== ''
                ? current.player
                : current.captainActs
                    ? 'Captain'
                    : '';
            const prompt = current.prompt.join('\n');
            const dynamicText = DYNAMIC_TEXT.exec(prompt);
            const playbookCall = current.playbookId !== '' || current.playbookIdContext !== '';
            if (current.resultDeclared && current.results.length === 0) {
                current.resultFindings.push('Results block declares no valid entries');
            }
            if (playbookCall && current.resultDeclared) {
                current.resultFindings.push('nested-playbook call item shall not declare Results metadata');
            }
            items.push({
                id: current.id,
                player,
                prompt,
                ...(!playbookCall && current.player !== ''
                    ? { actor: 'player' }
                    : {}),
                ...(!playbookCall && current.player === '' && current.captainActs
                    ? { actor: 'captain' }
                    : {}),
                ...(current.playbookId !== ''
                    ? { playbookId: current.playbookId }
                    : {}),
                ...(current.playbookIdContext !== ''
                    ? {
                        playbookIdContext: current.playbookIdContext,
                        ...(dynamicText === null ? {} : { textContext: dynamicText[1] }),
                    }
                    : {}),
                ...(current.resultDeclared
                    ? { result: Object.fromEntries(current.results) }
                    : {}),
                ...(current.resultFindings.length > 0
                    ? { resultFindings: current.resultFindings }
                    : {}),
            });
        }
        current = null;
    };
    for (const line of gears.split('\n')) {
        const heading = ITEM_HEADING.exec(line);
        if (heading !== null) {
            flush();
            current = {
                id: heading[1],
                player: '',
                captainActs: false,
                playbookId: '',
                playbookIdContext: '',
                prompt: [],
                resultsEligible: false,
                resultDeclared: false,
                inResults: false,
                results: [],
                resultFindings: [],
            };
            continue;
        }
        if (SECTION_HEADING.test(line)) {
            flush();
            continue;
        }
        if (current === null)
            continue;
        if (RESULTS_LABEL.test(line)) {
            if (current.resultDeclared) {
                current.resultFindings.push('duplicate Results label');
            }
            if (current.prompt.length === 0) {
                current.resultFindings.push('Results block shall follow a non-empty acting blockquote');
            }
            else if (!current.resultsEligible) {
                current.resultFindings.push('Results block shall immediately follow the acting blockquote');
            }
            current.resultDeclared = true;
            current.inResults = true;
            continue;
        }
        if (current.resultsEligible && RESULTS_LABEL_NEAR_MISS.test(line)) {
            current.resultFindings.push(`malformed Results label ${JSON.stringify(line)}`);
            current.resultDeclared = true;
            current.inResults = true;
            continue;
        }
        if (current.inResults) {
            if (line.trim() === '')
                continue;
            const result = RESULT_BULLET.exec(line);
            if (result === null) {
                current.resultFindings.push(`malformed Results entry ${JSON.stringify(line)}`);
                continue;
            }
            const [, guard, description] = result;
            if (current.results.some(([existing]) => existing === guard)) {
                current.resultFindings.push(`duplicate Results guard ${guard}`);
                continue;
            }
            if (guard === NEEDS_BOSS_REPLY) {
                current.resultFindings.push(`${NEEDS_BOSS_REPLY} is compiler-owned and shall not be source metadata`);
            }
            current.results.push([guard, description]);
            continue;
        }
        const quote = BLOCKQUOTE.exec(line);
        if (quote !== null) {
            current.prompt.push(quote[1]);
            current.resultsEligible = true;
            continue;
        }
        if (line.trim() !== '')
            current.resultsEligible = false;
        const player = ITEM_PLAYER.exec(line);
        if (player !== null && current.player === '') {
            current.player = player[1] ?? player[2] ?? player[3];
        }
        const dynamicPlaybook = ITEM_DYNAMIC_PLAYBOOK.exec(line);
        if (dynamicPlaybook !== null &&
            current.playbookIdContext === '' &&
            current.playbookId === '') {
            current.playbookIdContext = dynamicPlaybook[1];
        }
        const playbook = ITEM_PLAYBOOK.exec(line);
        if (playbook !== null &&
            current.playbookId === '' &&
            current.playbookIdContext === '') {
            current.playbookId =
                playbook[1] ?? playbook[2] ?? playbook[3] ?? playbook[4];
        }
        if (CAPTAIN_ACTS.test(line))
            current.captainActs = true;
    }
    flush();
    return items;
}
/** Walks every state node depth-first in declaration order. */
function walkStateNodes(config) {
    const out = [];
    const visit = (states, parent) => {
        for (const [key, state] of Object.entries(states ?? {})) {
            const path = [...parent, key];
            out.push({ key, path, statePath: path.join('.'), state });
            visit(state.states, path);
        }
    };
    visit(config.states, []);
    return out;
}
/** Normalizes XState's one-or-many invoke declaration to declaration order. */
function normalizeInvokes(invoke) {
    if (invoke === undefined)
        return [];
    if (Array.isArray(invoke)) {
        return invoke.filter((candidate) => typeof candidate === 'object' && candidate !== null);
    }
    return typeof invoke === 'object' && invoke !== null ? [invoke] : [];
}
function invocationInput(invoke, context = {}) {
    if (typeof invoke.input !== 'function')
        return { invalid: true };
    let value;
    try {
        value = invoke.input({ context });
    }
    catch (error) {
        return { error: messageOf(error) };
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { invalid: true };
    }
    return { value: value };
}
function publicStateId(node, input) {
    if (isNonEmptyString(input?.stateId))
        return input.stateId;
    if (isNonEmptyString(node.state.id))
        return node.state.id;
    return node.path.length === 1 ? node.key : node.statePath;
}
function nestedStatePath(node) {
    return node.path.length > 1 ? { statePath: node.statePath } : {};
}
function metadataStateId(state) {
    if (typeof state.meta !== 'object' || state.meta === null)
        return undefined;
    const playbook = state.meta.playbook;
    if (typeof playbook !== 'object' || playbook === null)
        return undefined;
    const stateId = playbook.stateId;
    return isNonEmptyString(stateId) ? stateId : undefined;
}
function stateIdConsistencyFindings(node, inputStateId) {
    if (!isNonEmptyString(inputStateId))
        return [];
    const findings = [];
    if (isNonEmptyString(node.state.id) && node.state.id !== inputStateId) {
        findings.push(`invoke.input.stateId "${inputStateId}" does not match state.id "${node.state.id}"`);
    }
    const metaStateId = metadataStateId(node.state);
    if (metaStateId !== undefined && metaStateId !== inputStateId) {
        findings.push(`invoke.input.stateId "${inputStateId}" does not match state.meta.playbook.stateId "${metaStateId}"`);
    }
    return findings;
}
function hasStructuredTopology(nodes) {
    return nodes.some(({ path, state }) => path.length > 1 ||
        state.type === 'parallel' ||
        Object.keys(state.states ?? {}).length > 0);
}
function structuredStateIdentityFindings(nodes) {
    if (!hasStructuredTopology(nodes))
        return [];
    const findings = [];
    for (const node of nodes) {
        const configId = node.state.id;
        const metaId = metadataStateId(node.state);
        if (!isNonEmptyString(configId)) {
            findings.push(`FSM structured state ${node.statePath}: state.id is not a non-empty string`);
        }
        if (metaId === undefined) {
            findings.push(`FSM structured state ${node.statePath}: state.meta.playbook.stateId is not a non-empty string`);
        }
        else if (isNonEmptyString(configId) && metaId !== configId) {
            findings.push(`FSM structured state ${node.statePath}: state.meta.playbook.stateId "${metaId}" does not match state.id "${configId}"`);
        }
    }
    return findings;
}
function enumerateCaptainBindings(config) {
    const out = [];
    for (const node of walkStateNodes(config)) {
        for (const invoke of normalizeInvokes(node.state.invoke)) {
            const source = invokeSource(invoke.src);
            const explicitlyWorkActor = source === 'captain' || source === 'player';
            if (!explicitlyWorkActor && invoke.src !== undefined)
                continue;
            const inspected = invocationInput(invoke);
            if ('error' in inspected) {
                if (explicitlyWorkActor) {
                    const actor = source === 'player' ? 'player' : 'captain';
                    out.push({
                        state: malformedCaptainState(publicStateId(node, undefined), `invoke.input threw during introspection: ${inspected.error}`, actor, node),
                        node,
                        invoke,
                        inputFn: invoke.input,
                        pinActor: true,
                    });
                }
                continue;
            }
            if ('invalid' in inspected) {
                if (explicitlyWorkActor) {
                    const actor = source === 'player' ? 'player' : 'captain';
                    out.push({
                        state: malformedCaptainState(publicStateId(node, undefined), typeof invoke.input === 'function'
                            ? 'invoke.input returned a non-object'
                            : 'invoke.input is not a function', actor, node),
                        node,
                        invoke,
                        inputFn: invoke.input,
                        pinActor: true,
                    });
                }
                continue;
            }
            const fields = inspected.value;
            // Preserve the legacy sourceItem-recognition path only when no explicit
            // actor is named. A playbook actor carrying source metadata is not a
            // player invocation.
            if (!explicitlyWorkActor &&
                (invoke.src !== undefined || !isNonEmptyString(fields.sourceItem))) {
                continue;
            }
            // Published artifacts used `captain` for every work call and carried a
            // player field. Preserve that shape as delegated work until regeneration.
            // In the new model, direct Captain work omits player and delegated work
            // names the `player` actor explicitly.
            const actor = source === 'player' || Object.hasOwn(fields, 'player')
                ? 'player'
                : 'captain';
            const pinActor = source === 'player' || (source === 'captain' && actor === 'captain');
            const bindingFindings = [];
            if (!isNonEmptyString(fields.sourceItem)) {
                bindingFindings.push('invoke.input.sourceItem is not a non-empty string');
            }
            if (actor === 'player' && typeof fields.player !== 'string') {
                bindingFindings.push('invoke.input.player is not a string');
            }
            if (typeof fields.prompt !== 'string') {
                bindingFindings.push('invoke.input.prompt is not a string');
            }
            if (!isStringMap(fields.result)) {
                bindingFindings.push('invoke.input.result is not a string-valued object');
            }
            if (node.path.length > 1 && !isNonEmptyString(fields.stateId)) {
                bindingFindings.push('nested invoke.input.stateId is not a non-empty string');
            }
            bindingFindings.push(...stateIdConsistencyFindings(node, fields.stateId));
            if (Object.keys(node.state.states ?? {}).length > 0) {
                bindingFindings.push(`${source === 'player' ? 'player' : 'captain'} invocation is declared on a compound state instead of a leaf`);
            }
            out.push({
                state: {
                    stateId: publicStateId(node, fields),
                    sourceItem: isNonEmptyString(fields.sourceItem)
                        ? fields.sourceItem
                        : '',
                    actor,
                    player: typeof fields.player === 'string' ? fields.player : '',
                    prompt: typeof fields.prompt === 'string' ? fields.prompt : '',
                    result: resultMap(fields.result),
                    ...nestedStatePath(node),
                    ...(bindingFindings.length > 0 ? { bindingFindings } : {}),
                },
                node,
                invoke,
                inputFn: invoke.input,
                pinActor,
            });
        }
    }
    return out;
}
/**
 * Enumerates a machine's direct-Captain and delegated-player states, reading
 * `invoke.input` under a stub context to recover the static source binding.
 */
export function enumerateCaptainStates(config) {
    return enumerateCaptainBindings(config).map(({ state }) => state);
}
function enumeratePlaybookBindings(config) {
    const out = [];
    for (const node of walkStateNodes(config)) {
        for (const invoke of normalizeInvokes(node.state.invoke)) {
            if (invokeSource(invoke.src) !== 'playbook')
                continue;
            const inspected = invocationInput(invoke);
            if ('error' in inspected) {
                out.push({
                    state: malformedPlaybookState(publicStateId(node, undefined), `invoke.input threw during introspection: ${inspected.error}`, node),
                    node,
                    invoke,
                });
                continue;
            }
            if ('invalid' in inspected) {
                out.push({
                    state: malformedPlaybookState(publicStateId(node, undefined), typeof invoke.input === 'function'
                        ? 'invoke.input returned a non-object'
                        : 'invoke.input is not a function', node),
                    node,
                    invoke,
                });
                continue;
            }
            const fields = inspected.value;
            const bindingFindings = [];
            if (!isNonEmptyString(fields.stateId)) {
                bindingFindings.push('invoke.input.stateId is not a non-empty string');
            }
            const dynamic = Object.hasOwn(fields, 'playbookIdContext') ||
                Object.hasOwn(fields, 'textContext');
            if (dynamic) {
                if (!isNonEmptyString(fields.playbookIdContext)) {
                    bindingFindings.push('invoke.input.playbookIdContext is not a non-empty string');
                }
                if (!isNonEmptyString(fields.textContext)) {
                    bindingFindings.push('invoke.input.textContext is not a non-empty string');
                }
                if (isNonEmptyString(fields.playbookIdContext) &&
                    isNonEmptyString(fields.textContext)) {
                    const playbookIdSentinel = sentinelFor(fields.playbookIdContext);
                    const textSentinel = sentinelFor(fields.textContext);
                    const wired = invocationInput(invoke, {
                        [fields.playbookIdContext]: playbookIdSentinel,
                        [fields.textContext]: textSentinel,
                    });
                    if ('error' in wired) {
                        bindingFindings.push(`invoke.input threw during dynamic context introspection: ${wired.error}`);
                    }
                    else if ('invalid' in wired) {
                        bindingFindings.push('invoke.input returned a non-object during dynamic context introspection');
                    }
                    else {
                        if (wired.value.playbookId !== playbookIdSentinel) {
                            bindingFindings.push(`invoke.input.playbookId is not wired from context.${fields.playbookIdContext}`);
                        }
                        if (wired.value.text !== textSentinel) {
                            bindingFindings.push(`invoke.input.text is not wired from context.${fields.textContext}`);
                        }
                    }
                }
            }
            else {
                if (!isNonEmptyString(fields.playbookId)) {
                    bindingFindings.push('invoke.input.playbookId is not a non-empty string');
                }
                if (typeof fields.text !== 'string') {
                    bindingFindings.push('invoke.input.text is not a string');
                }
            }
            bindingFindings.push(...stateIdConsistencyFindings(node, fields.stateId));
            if (Object.keys(node.state.states ?? {}).length > 0) {
                bindingFindings.push('playbook invocation is declared on a compound state instead of a leaf');
            }
            out.push({
                state: {
                    stateId: publicStateId(node, fields),
                    playbookId: !dynamic && isNonEmptyString(fields.playbookId)
                        ? fields.playbookId
                        : '',
                    text: !dynamic && typeof fields.text === 'string' ? fields.text : '',
                    ...(isNonEmptyString(fields.playbookIdContext)
                        ? { playbookIdContext: fields.playbookIdContext }
                        : {}),
                    ...(isNonEmptyString(fields.textContext)
                        ? { textContext: fields.textContext }
                        : {}),
                    ...(isNonEmptyString(fields.sourceItem)
                        ? { sourceItem: fields.sourceItem }
                        : {}),
                    ...nestedStatePath(node),
                    ...(bindingFindings.length > 0 ? { bindingFindings } : {}),
                },
                node,
                invoke,
            });
        }
    }
    return out;
}
/** Enumerates typed `playbook` actor calls across the complete state tree. */
export function enumeratePlaybookStates(config) {
    return enumeratePlaybookBindings(config).map(({ state }) => state);
}
function malformedCaptainState(stateId, finding, actor, node) {
    return {
        stateId,
        sourceItem: '',
        actor,
        player: '',
        prompt: '',
        result: {},
        ...(node === undefined ? {} : nestedStatePath(node)),
        bindingFindings: [finding],
    };
}
function malformedPlaybookState(stateId, finding, node) {
    return {
        stateId,
        playbookId: '',
        text: '',
        ...nestedStatePath(node),
        bindingFindings: [finding],
    };
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function isStringMap(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((entry) => typeof entry === 'string'));
}
/** Narrows a state's `invoke.input.result` to its string-described guard keys. */
function resultMap(value) {
    if (typeof value !== 'object' || value === null)
        return {};
    const out = {};
    for (const [key, description] of Object.entries(value)) {
        if (typeof description === 'string')
            out[key] = description;
    }
    return out;
}
function isPlaybookItem(item) {
    return item.playbookId !== undefined || item.playbookIdContext !== undefined;
}
function gearsPlaybookSignature(item) {
    return item.playbookIdContext === undefined
        ? JSON.stringify(['static', item.playbookId, item.prompt])
        : JSON.stringify([
            'dynamic',
            item.playbookIdContext,
            item.textContext ?? null,
        ]);
}
function statePlaybookSignature(state) {
    return state.playbookIdContext === undefined
        ? JSON.stringify(['static', state.playbookId, state.text])
        : JSON.stringify([
            'dynamic',
            state.playbookIdContext,
            state.textContext ?? null,
        ]);
}
/**
 * Checks GEARS↔FSM conformance and returns human-readable findings (empty when
 * conformant): every GEARS item maps to one state with the same player and the
 * prompt verbatim, every captain state references a known item, and every
 * captain state's `result` map declares the Boss-reply suspension key with its
 * adjudicator contract (VERIFY-1, VERIFY-3; DR-009).
 */
export function checkGearsFsmConformance(gears, config) {
    const items = parseGearsItems(gears);
    const captainBindings = enumerateCaptainBindings(config);
    const states = captainBindings.map(({ state }) => state);
    const explicitActorStates = new Set(captainBindings
        .filter(({ pinActor }) => pinActor)
        .map(({ state }) => state));
    const playbookStates = enumeratePlaybookStates(config);
    const findings = [];
    findings.push(...structuredStateIdentityFindings(walkStateNodes(config)));
    for (const item of items) {
        findings.push(...(item.resultFindings ?? []).map((finding) => `GEARS item ${item.id}: ${finding}`));
    }
    for (const state of states) {
        findings.push(...(state.bindingFindings ?? []).map((finding) => `FSM state ${state.stateId}: ${finding}`));
    }
    for (const state of playbookStates) {
        findings.push(...(state.bindingFindings ?? []).map((finding) => `FSM playbook state ${state.stateId}: ${finding}`));
    }
    const statesByItem = new Map();
    for (const state of states) {
        if (state.sourceItem === '')
            continue;
        const matched = statesByItem.get(state.sourceItem);
        if (matched === undefined)
            statesByItem.set(state.sourceItem, [state]);
        else
            matched.push(state);
    }
    const playbookItems = items.filter(isPlaybookItem);
    const matchedPlaybookStates = new Set();
    const playbookMatchesByItem = new Map();
    const playbookItemsByState = new Map();
    const addPlaybookMatch = (item, state) => {
        const matchedStates = playbookMatchesByItem.get(item);
        if (matchedStates === undefined) {
            playbookMatchesByItem.set(item, [state]);
        }
        else {
            matchedStates.push(state);
        }
        const matchedItems = playbookItemsByState.get(state);
        if (matchedItems === undefined) {
            playbookItemsByState.set(state, [item.id]);
        }
        else {
            matchedItems.push(item.id);
        }
        matchedPlaybookStates.add(state);
    };
    // An explicit sourceItem is authoritative, including when its target or text
    // drifted; retaining that pairing lets conformance report the precise drift.
    for (const state of playbookStates) {
        if (state.sourceItem === undefined)
            continue;
        for (const item of playbookItems) {
            if (item.id === state.sourceItem)
                addPlaybookMatch(item, state);
        }
    }
    // The PlaybookInput contract does not require sourceItem. Pair otherwise
    // indistinguishable calls by signature and declaration order, comparing each
    // signature as a multiset. Equal duplicate cardinalities are conformant;
    // surplus items or states remain unmatched and are reported below.
    const itemsBySignature = new Map();
    for (const item of playbookItems) {
        if ((playbookMatchesByItem.get(item)?.length ?? 0) > 0)
            continue;
        const key = gearsPlaybookSignature(item);
        const grouped = itemsBySignature.get(key);
        if (grouped === undefined)
            itemsBySignature.set(key, [item]);
        else
            grouped.push(item);
    }
    const statesBySignature = new Map();
    for (const state of playbookStates) {
        if (state.sourceItem !== undefined)
            continue;
        const key = statePlaybookSignature(state);
        const grouped = statesBySignature.get(key);
        if (grouped === undefined)
            statesBySignature.set(key, [state]);
        else
            grouped.push(state);
    }
    for (const [key, groupedItems] of itemsBySignature) {
        const groupedStates = statesBySignature.get(key) ?? [];
        const pairs = Math.min(groupedItems.length, groupedStates.length);
        for (let index = 0; index < pairs; index += 1) {
            addPlaybookMatch(groupedItems[index], groupedStates[index]);
        }
    }
    for (const item of items) {
        if (isPlaybookItem(item)) {
            const matched = playbookMatchesByItem.get(item) ?? [];
            if (matched.length === 0) {
                findings.push(`GEARS item ${item.id} maps to no FSM playbook state`);
                continue;
            }
            if (matched.length > 1) {
                findings.push(`GEARS item ${item.id} maps to ${matched.length} FSM playbook states (expected exactly one: ${matched.map((state) => state.stateId).join(', ')})`);
            }
            const state = matched[0];
            if (item.playbookIdContext !== undefined) {
                if (item.textContext === undefined) {
                    findings.push(`${item.id}: GEARS dynamic playbook text is not a single <contextField> placeholder`);
                }
                if (state.playbookIdContext !== item.playbookIdContext) {
                    findings.push(`${item.id}: FSM playbookIdContext "${state.playbookIdContext ?? ''}" is not GEARS context "${item.playbookIdContext}"`);
                }
                if (state.textContext !== item.textContext) {
                    findings.push(`${item.id}: FSM textContext "${state.textContext ?? ''}" is not GEARS context "${item.textContext ?? ''}"`);
                }
            }
            else {
                if (state.playbookId !== item.playbookId) {
                    findings.push(`${item.id}: FSM playbook "${state.playbookId ?? ''}" is not GEARS playbook "${item.playbookId ?? ''}"`);
                }
                if (state.text !== item.prompt) {
                    findings.push(`${item.id}: FSM playbook text is not the GEARS prompt verbatim`);
                }
            }
            continue;
        }
        const matched = statesByItem.get(item.id) ?? [];
        if (matched.length === 0) {
            findings.push(`GEARS item ${item.id} maps to no FSM state`);
            continue;
        }
        if (matched.length > 1) {
            findings.push(`GEARS item ${item.id} maps to ${matched.length} FSM states (expected exactly one: ${matched.map((s) => s.stateId).join(', ')})`);
        }
        const state = matched[0];
        if (item.actor !== undefined &&
            explicitActorStates.has(state) &&
            state.actor !== item.actor) {
            findings.push(`${item.id}: FSM actor "${state.actor}" is not GEARS actor "${item.actor}"`);
        }
        if (item.actor === 'player' && state.player !== item.player) {
            findings.push(`${item.id}: FSM player "${state.player}" is not GEARS player "${item.player}"`);
        }
        if (state.prompt !== item.prompt) {
            findings.push(`${item.id}: FSM prompt is not the GEARS prompt verbatim`);
        }
        if (item.result !== undefined) {
            const expected = Object.entries(item.result);
            const actual = Object.entries(state.result).filter(([guard]) => guard !== NEEDS_BOSS_REPLY);
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                findings.push(`${item.id}: FSM domain result contract ${JSON.stringify(actual)} is not GEARS Results ${JSON.stringify(expected)}`);
            }
        }
    }
    const itemIds = new Set(items.map((item) => item.id));
    const playbookItemIds = new Set(playbookItems.map((item) => item.id));
    // A controller machine's hub receives every Boss turn, so a clarifying
    // question to Boss is a `respond` selection: the compiler adds no
    // `needsBossReply` result to any of its states (slc/gears2fsm.md §Setup,
    // controller decision-state class; DR-029).
    const controllerMachine = states.some((state) => isControllerDecisionResult(state.result));
    for (const state of states) {
        if (state.sourceItem !== '' && !itemIds.has(state.sourceItem)) {
            findings.push(`FSM state ${state.stateId} references unknown GEARS item ${state.sourceItem}`);
        }
        if (controllerMachine) {
            if (state.result[NEEDS_BOSS_REPLY] !== undefined) {
                findings.push(`FSM state ${state.stateId} declares ${NEEDS_BOSS_REPLY} on a controller machine`);
            }
            continue;
        }
        // Every captain-invoking state of a non-controller machine supports
        // Boss-reply suspension: its result map carries `needsBossReply` with
        // the adjudicator-facing contract text (gears2fsm.md; VERIFY-3).
        const bossReply = state.result[NEEDS_BOSS_REPLY];
        if (bossReply === undefined) {
            findings.push(`FSM state ${state.stateId} declares no ${NEEDS_BOSS_REPLY} result`);
        }
        else if (!bossReply.includes(BOSS_QUESTION_MARKER)) {
            findings.push(`FSM state ${state.stateId}: ${NEEDS_BOSS_REPLY} description lacks the ${BOSS_QUESTION_MARKER}\` contract`);
        }
    }
    for (const state of playbookStates) {
        const matchedItems = playbookItemsByState.get(state) ?? [];
        if (matchedItems.length > 1) {
            findings.push(`FSM playbook state ${state.stateId} maps to ${matchedItems.length} GEARS playbook-call items (expected exactly one: ${matchedItems.join(', ')})`);
        }
        if (state.sourceItem !== undefined &&
            !playbookItemIds.has(state.sourceItem)) {
            findings.push(`FSM playbook state ${state.stateId} references unknown GEARS playbook item ${state.sourceItem}`);
        }
        else if (!matchedPlaybookStates.has(state)) {
            findings.push(`FSM playbook state ${state.stateId} maps to no GEARS playbook-call item`);
        }
    }
    return findings;
}
/*
 * Machine introspection (VERIFY-4).
 *
 * `pinIntrospection` reduces a machine config to its structural facts — the
 * captain-state bindings, every transition arm, the root and quiescent event
 * surfaces, and the `BOSS_INTERRUPT` jumpable set — computed once at build time
 * and baked into the emitted introspection test, so any unintended topology
 * change to the artifact fails the test (DR-009).
 */
/** The `gears2fsm`-mandated root pre-emption event name. */
export const INTERRUPT_EVENT = 'BOSS_INTERRUPT';
/** The `gears2fsm`-mandated Boss-reply event and wait-state names. */
export const BOSS_REPLY_EVENT = 'BOSS_REPLY';
export const AWAIT_BOSS_REPLY_STATE = 'awaitBossReply';
/**
 * Normalizes an XState transition declaration — a string target, a
 * target/guard/actions object, or an array of either — into ordered
 * {@link TransitionArm}s.
 */
export function normalizeArms(raw) {
    const arms = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    return arms.map((arm, index) => {
        if (typeof arm === 'string') {
            return { index, target: stripHash(arm), guarded: false };
        }
        if (typeof arm === 'object' && arm !== null) {
            const record = arm;
            return {
                index,
                target: typeof record.target === 'string' ? stripHash(record.target) : null,
                guarded: record.guard !== undefined,
            };
        }
        return { index, target: null, guarded: false };
    });
}
function stripHash(target) {
    return target.startsWith('#') ? target.slice(1) : target;
}
function eventArms(on) {
    const out = {};
    for (const [event, raw] of Object.entries(on ?? {})) {
        out[event] = normalizeArms(raw);
    }
    return out;
}
function normalizedTags(tags) {
    if (typeof tags === 'string')
        return [tags];
    return Array.isArray(tags)
        ? tags.filter((tag) => typeof tag === 'string')
        : [];
}
function invokeSource(src) {
    if (typeof src === 'string')
        return src;
    if (typeof src === 'object' &&
        src !== null &&
        'type' in src &&
        typeof src.type === 'string') {
        return src.type;
    }
    return null;
}
/**
 * Reduces a machine config to the structural facts the emitted introspection
 * test pins (VERIFY-4): captain bindings with result keys and every transition
 * arm, the quiescent states' event surfaces, the root event surface, and the
 * `BOSS_INTERRUPT` jumpable set.
 */
export function pinIntrospection(config) {
    const nodes = walkStateNodes(config);
    const captainBindings = enumerateCaptainBindings(config);
    const playbookBindings = enumeratePlaybookBindings(config);
    const invokingPaths = new Set([
        ...captainBindings.map(({ node }) => node.statePath),
        ...playbookBindings.map(({ node }) => node.statePath),
    ]);
    const captain = [];
    const quiescent = [];
    for (const binding of captainBindings) {
        captain.push({
            state: binding.state.stateId,
            ...(binding.state.statePath !== undefined
                ? { path: binding.state.statePath }
                : {}),
            ...(binding.pinActor ? { actor: binding.state.actor } : {}),
            sourceItem: binding.state.sourceItem,
            player: binding.state.player,
            resultKeys: Object.keys(binding.state.result).sort(),
            onDone: normalizeArms(binding.invoke.onDone),
            onError: normalizeArms(binding.invoke.onError),
            on: eventArms(binding.node.state.on),
        });
    }
    for (const [stateId, state] of Object.entries(config.states ?? {})) {
        if (!invokingPaths.has(stateId)) {
            quiescent.push({
                state: stateId,
                final: state.type === 'final',
                on: eventArms(state.on),
            });
        }
    }
    const rootOn = eventArms(config.on);
    const interruptTargets = (rootOn[INTERRUPT_EVENT] ?? [])
        .map((arm) => arm.target)
        .filter((target) => target !== null);
    const playbook = playbookBindings.map((binding) => ({
        state: binding.state.stateId,
        ...(binding.state.statePath !== undefined
            ? { path: binding.state.statePath }
            : {}),
        ...(binding.state.playbookIdContext === undefined
            ? { playbookId: binding.state.playbookId }
            : {}),
        ...(binding.state.playbookIdContext !== undefined
            ? { playbookIdContext: binding.state.playbookIdContext }
            : {}),
        ...(binding.state.textContext !== undefined
            ? { textContext: binding.state.textContext }
            : {}),
        ...(binding.state.sourceItem !== undefined
            ? { sourceItem: binding.state.sourceItem }
            : {}),
        onDone: normalizeArms(binding.invoke.onDone),
        onError: normalizeArms(binding.invoke.onError),
        on: eventArms(binding.node.state.on),
    }));
    const structured = hasStructuredTopology(nodes)
        ? {
            states: nodes.map(({ path, state, statePath }) => ({
                path: statePath,
                parent: path.length > 1 ? path.slice(0, -1).join('.') : null,
                id: typeof state.id === 'string' ? state.id : null,
                publicStateId: metadataStateId(state) ?? null,
                type: typeof state.type === 'string' ? state.type : null,
                initial: typeof state.initial === 'string' ? state.initial : null,
                tags: normalizedTags(state.tags),
                children: Object.keys(state.states ?? {}),
                invokes: normalizeInvokes(state.invoke)
                    .map(({ src }) => invokeSource(src))
                    .filter((source) => source !== null),
                onDone: normalizeArms(state.onDone),
                onError: normalizeArms(state.onError),
                on: eventArms(state.on),
            })),
        }
        : undefined;
    return {
        initial: typeof config.initial === 'string' ? config.initial : null,
        captain,
        quiescent,
        rootOn,
        interruptTargets,
        ...(playbook.length > 0 ? { playbook } : {}),
        ...(structured !== undefined ? { structured } : {}),
    };
}
/*
 * Prompt-contract capture and composition checks (VERIFY-5).
 *
 * The contract is derived from the artifacts, never hand-authored: context
 * reads are traced through each state's `invoke.input` thunk with a recording
 * proxy, wiring by sentinel values, placeholders by scanning the prompt body,
 * and substitution by composing with sentinels and observing which tokens the
 * linked composer replaces. The derived facts are pinned into the emitted test
 * so contract drift fails it (DR-009).
 */
/** The exact continuation preamble the link contract mandates (link.md). */
export const CONTINUATION_PREAMBLE = 'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.';
export const BOSS_QUESTION_LABEL = 'Boss question:';
export const BOSS_REPLY_LABEL = 'Boss reply:';
// Direct Captain prompts cross the callCaptain boundary and therefore must
// not acquire player-only routing or session-control text. Match the stable
// labelled form as well as natural-language variants; occurrence deltas below
// keep self-hosting prompt bodies free to quote either marker verbatim.
const PLAYER_BINDING_MARKER = /\bplayer\s+binding\b|(?:^|\n)[ \t]*player[ \t]*:[ \t]*(?=\S)/gi;
const PLAYER_RESUME_MARKER = /\b(?:resume|resuming)\b[^\n]{0,120}\bplayer(?:'s)?\b|\bplayer(?:'s)?\b[^\n]{0,120}\b(?:resume|resuming)\b/gi;
const PLACEHOLDER = /<[^\s<>`]{1,60}>/g;
/** Lists the distinct `<...>` placeholder tokens in a prompt body, in order. */
export function placeholdersIn(prompt) {
    const seen = [];
    for (const token of prompt.match(PLACEHOLDER) ?? []) {
        if (!seen.includes(token))
            seen.push(token);
    }
    return seen;
}
const sentinelFor = (field) => `«${field}»`;
/**
 * Traces which context fields an `invoke.input` thunk reads, via a recording
 * proxy context; reads collected up to a throw are kept.
 */
export function probeContextReads(inputFn) {
    const reads = new Set();
    const context = new Proxy({}, {
        get(_target, prop) {
            if (typeof prop === 'string')
                reads.add(prop);
            return undefined;
        },
        has() {
            return true;
        },
    });
    try {
        inputFn({ context });
    }
    catch {
        // Reads observed before the throw still pin the contract.
    }
    return [...reads].sort();
}
function sentinelContext(reads) {
    return Object.fromEntries(reads.map((field) => [field, sentinelFor(field)]));
}
// The gears2fsm-normative Boss-reply context fields: present only on a
// continuation turn, so an ordinary-turn probe must leave them unset.
const BOSS_CONTEXT_FIELDS = [
    'pendingBossQuestion',
    'bossReply',
    'pendingBossQuestions',
    'bossReplies',
];
function ordinaryContext(reads) {
    return sentinelContext(reads.filter((field) => !BOSS_CONTEXT_FIELDS.includes(field)));
}
function carriesSentinel(value, sentinel) {
    try {
        return (JSON.stringify(value) ?? '').includes(sentinel);
    }
    catch {
        return false;
    }
}
/**
 * Derives every captain state's prompt contract from the machine config
 * (VERIFY-5): traced context reads, sentinel-traced input wiring, and the
 * prompt body's placeholder tokens.
 */
export function capturePromptContract(config) {
    const rows = [];
    for (const binding of enumerateCaptainBindings(config)) {
        const { state, inputFn } = binding;
        if (typeof inputFn !== 'function')
            continue;
        const reads = probeContextReads(inputFn);
        const wires = {};
        try {
            const input = inputFn({ context: sentinelContext(reads) });
            if (typeof input === 'object' && input !== null) {
                for (const [key, value] of Object.entries(input)) {
                    const carried = reads.filter((field) => carriesSentinel(value, sentinelFor(field)));
                    if (carried.length > 0)
                        wires[key] = carried;
                }
            }
        }
        catch {
            // Wiring stays empty; the traced reads alone still pin the contract.
        }
        rows.push({
            state: state.stateId,
            sourceItem: state.sourceItem,
            player: state.player,
            reads,
            wires,
            placeholders: placeholdersIn(state.prompt),
        });
    }
    return rows;
}
/**
 * Derives, per captain state, which of its prompt's placeholder tokens the
 * linked composer substitutes when the wired context is present — pinned into
 * the emitted test so a token that later leaks unsubstituted fails it
 * (VERIFY-5).
 */
export function deriveSubstitutions(config, compose, actor) {
    const out = {};
    for (const binding of enumerateCaptainBindings(config)) {
        const { state, inputFn } = binding;
        if (actor !== undefined && state.actor !== actor)
            continue;
        if (typeof inputFn !== 'function')
            continue;
        try {
            const reads = probeContextReads(inputFn);
            const composed = compose(inputFn({ context: ordinaryContext(reads) }));
            if (typeof composed !== 'string') {
                out[state.stateId] = [];
                continue;
            }
            // A placeholder counts as substituted only when the exact body survives
            // on its source line and that token's position carries one of the context
            // sentinels. Derive line-by-line so an unrelated mutated line does not
            // hide valid evidence, while merely deleting a token still cannot
            // masquerade as substitution.
            const evidenced = new Set();
            for (const line of state.prompt.split('\n')) {
                for (const token of matchPromptBody(line, composed, reads)
                    ?.substitutions ?? []) {
                    evidenced.add(token);
                }
            }
            out[state.stateId] = placeholdersIn(state.prompt).filter((token) => evidenced.has(token));
        }
        catch {
            out[state.stateId] = [];
        }
    }
    return out;
}
/**
 * Checks the linked composer against the link contract for every captain state
 * (VERIFY-5), returning findings (empty when conformant): the prompt body is
 * preserved modulo substituted placeholders, the adjudicator-facing Boss-reply
 * contract never leaks into a player prompt, no continuation appears on an
 * ordinary turn, and a Boss-reply continuation turn opens with the exact
 * preamble and labelled Q&A blocks before the body.
 */
export function checkPromptComposition(opts) {
    const findings = [];
    const substitutions = deriveSubstitutions(opts.config, opts.compose, opts.actor);
    const composerName = opts.actor === 'captain' ? 'composeCaptainPrompt' : 'composePlayerPrompt';
    // A controller machine carries no Boss-reply suspension (slc/gears2fsm.md
    // §Setup, controller decision-state class): its hub receives every Boss
    // turn, no state resumes from a pending question, and the input thunks
    // deliberately carry no continuation fields — so the continuation-turn
    // composition contract below does not apply.
    const controllerMachine = isControllerMachine(opts.config);
    for (const binding of enumerateCaptainBindings(opts.config)) {
        const { state, inputFn } = binding;
        if (opts.actor !== undefined && state.actor !== opts.actor)
            continue;
        if (typeof inputFn !== 'function')
            continue;
        const reads = probeContextReads(inputFn);
        const substituted = substitutions[state.stateId] ?? [];
        let ordinary;
        try {
            ordinary = opts.compose(inputFn({ context: ordinaryContext(reads) }));
            if (typeof ordinary !== 'string') {
                throw new Error(`${composerName} returned a non-string value`);
            }
        }
        catch (error) {
            findings.push(`${state.stateId}: ${composerName} threw on an ordinary turn: ${messageOf(error)}`);
            continue;
        }
        findings.push(...bodyFindings(state, ordinary, substituted, reads, 'ordinary'));
        pushUnique(findings, ...directCaptainControlFindings(state, ordinary));
        // A self-hosted playbook's domain body may legitimately quote the
        // adjudicator contract or the continuation texts (it instructs a compiler
        // about them); only occurrences the composer ADDS beyond the body's own
        // are leaks.
        if (occurrences(ordinary, BOSS_QUESTION_MARKER) >
            occurrences(state.prompt, BOSS_QUESTION_MARKER)) {
            findings.push(`${state.stateId}: the adjudicator-facing ${NEEDS_BOSS_REPLY} contract leaks into the player prompt`);
        }
        if ([CONTINUATION_PREAMBLE, BOSS_QUESTION_LABEL, BOSS_REPLY_LABEL].some((needle) => occurrences(ordinary, needle) > occurrences(state.prompt, needle))) {
            findings.push(`${state.stateId}: continuation blocks appear on an ordinary turn`);
        }
        if (controllerMachine)
            continue;
        // A Boss-reply continuation turn: the thunk carries the pending question
        // and reply, and the composer opens with the exact preamble and labelled
        // Q&A blocks before the domain body (gears2fsm.md, link.md).
        const question = sentinelFor('question');
        const reply = sentinelFor('bossReply');
        const pendingBossQuestion = {
            resumeStateId: state.stateId,
            sourceItem: state.sourceItem,
            player: state.player,
            question,
        };
        let continuation;
        let input;
        try {
            input = inputFn({
                context: {
                    ...ordinaryContext(reads),
                    pendingBossQuestion,
                    bossReply: reply,
                    pendingBossQuestions: {
                        [state.stateId]: pendingBossQuestion,
                    },
                    bossReplies: { [state.stateId]: reply },
                },
            });
            continuation = opts.compose(input);
            if (typeof continuation !== 'string') {
                throw new Error(`${composerName} returned a non-string value`);
            }
        }
        catch (error) {
            findings.push(`${state.stateId}: ${composerName} threw on a continuation turn: ${messageOf(error)}`);
            continue;
        }
        if (!carriesSentinel(input, question) || !carriesSentinel(input, reply)) {
            findings.push(`${state.stateId}: invoke.input does not carry pendingBossQuestion/bossReply for a continuation turn`);
            continue;
        }
        if (!continuation.startsWith(`${CONTINUATION_PREAMBLE}\n\n`)) {
            findings.push(`${state.stateId}: a continuation turn does not open with the exact preamble`);
        }
        const bodyStart = bodyIndex(state, continuation, substituted, reads);
        const questionBlock = `${BOSS_QUESTION_LABEL}\n${question}`;
        const replyBlock = `${BOSS_REPLY_LABEL}\n${reply}`;
        for (const [label, value] of [
            [BOSS_QUESTION_LABEL, questionBlock],
            [BOSS_REPLY_LABEL, replyBlock],
        ]) {
            // The composer must ADD the labelled block (beyond any body-carried
            // occurrence), with its sentinel value immediately below the label and
            // before the body.
            const at = continuation.indexOf(value);
            if (occurrences(continuation, value) <= occurrences(state.prompt, value)) {
                findings.push(`${state.stateId}: a continuation turn lacks the "${label}" block`);
            }
            else if (bodyStart !== -1 && at > bodyStart) {
                findings.push(`${state.stateId}: the "${label}" block appears after the domain prompt body`);
            }
        }
        const exactContinuationPrefix = `${CONTINUATION_PREAMBLE}\n\n${questionBlock}\n\n${replyBlock}\n\n`;
        if (!continuation.startsWith(exactContinuationPrefix)) {
            findings.push(`${state.stateId}: a continuation turn does not preserve the exact ordered Boss question/reply blocks`);
        }
        findings.push(...bodyFindings(state, continuation, substituted, reads, 'continuation'));
        pushUnique(findings, ...directCaptainControlFindings(state, continuation));
    }
    return findings;
}
function directCaptainControlFindings(state, composed) {
    if (state.actor !== 'captain')
        return [];
    const findings = [];
    if (patternOccurrences(composed, PLAYER_BINDING_MARKER) >
        patternOccurrences(state.prompt, PLAYER_BINDING_MARKER)) {
        findings.push(`${state.stateId}: composeCaptainPrompt introduces a player binding into a direct-Captain prompt`);
    }
    if (patternOccurrences(composed, PLAYER_RESUME_MARKER) >
        patternOccurrences(state.prompt, PLAYER_RESUME_MARKER)) {
        findings.push(`${state.stateId}: composeCaptainPrompt introduces a player resume instruction into a direct-Captain prompt`);
    }
    return findings;
}
function patternOccurrences(hay, pattern) {
    return [...hay.matchAll(new RegExp(pattern.source, pattern.flags))].length;
}
function pushUnique(target, ...values) {
    for (const value of values) {
        if (!target.includes(value))
            target.push(value);
    }
}
/** Counts non-overlapping occurrences of `needle` in `hay`. */
function occurrences(hay, needle) {
    return needle === '' ? 0 : hay.split(needle).length - 1;
}
/** Escapes a literal for use inside a regular expression. */
function escapeRegExp(literal) {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Finds the prompt body as one exact, line-bounded block inside a composed
 * prompt. In derivation mode, a placeholder may remain literal or be replaced
 * by one exact non-empty context sentinel; mixed replacement of repeated
 * tokens is rejected. With `expectedSubstitutions`, substituted positions must
 * carry a sentinel and every other placeholder must remain literal.
 */
function matchPromptBody(prompt, composed, reads, expectedSubstitutions) {
    const sentinels = reads.map(sentinelFor);
    const sentinelPattern = sentinels.length > 0
        ? sentinels
            .flatMap((sentinel) => [sentinel, JSON.stringify(sentinel)])
            .map(escapeRegExp)
            .join('|')
        : '(?!)';
    const captures = [];
    let pattern = '';
    let offset = 0;
    for (const match of prompt.matchAll(PLACEHOLDER)) {
        const index = match.index;
        const token = match[0];
        pattern += escapeRegExp(prompt.slice(offset, index));
        if (expectedSubstitutions === undefined) {
            pattern += `(${escapeRegExp(token)}|${sentinelPattern})`;
            captures.push(token);
        }
        else if (expectedSubstitutions.includes(token)) {
            pattern += `(?:${sentinelPattern})`;
        }
        else {
            pattern += escapeRegExp(token);
        }
        offset = index + token.length;
    }
    pattern += escapeRegExp(prompt.slice(offset));
    const matched = new RegExp(`(?:^|\\n)${pattern}(?=\\n|$)`).exec(composed);
    if (matched === null)
        return null;
    const index = matched.index + (matched[0].startsWith('\n') ? 1 : 0);
    if (expectedSubstitutions !== undefined) {
        return { index, substitutions: [...expectedSubstitutions] };
    }
    const modes = new Map();
    for (let capture = 0; capture < captures.length; capture++) {
        const token = captures[capture];
        const value = matched[capture + 1];
        const tokenModes = modes.get(token) ?? new Set();
        tokenModes.add(value === token ? 'literal' : 'sentinel');
        modes.set(token, tokenModes);
    }
    if ([...modes.values()].some((tokenModes) => tokenModes.size > 1)) {
        return null;
    }
    const substitutions = placeholdersIn(prompt).filter((token) => modes.get(token)?.has('sentinel') === true);
    return { index, substitutions };
}
/** Findings when a composed prompt does not preserve the domain body (VERIFY-5). */
function bodyFindings(state, composed, substituted, reads, turn) {
    if (matchPromptBody(state.prompt, composed, reads, substituted) !== null) {
        return [];
    }
    // Preserve the established line-specific diagnostic where possible, while
    // the whole-body match above additionally catches reordering, inserted
    // lines, and prefixes/suffixes around otherwise present lines.
    for (const line of state.prompt.split('\n')) {
        if (line.trim() === '')
            continue;
        if (matchPromptBody(line, composed, reads, substituted) === null) {
            return [
                `${state.stateId}: a ${turn} turn does not preserve the body line "${line}"`,
            ];
        }
    }
    return [
        `${state.stateId}: a ${turn} turn does not preserve the prompt body verbatim and in order`,
    ];
}
/** The index of the body's first preserved line in a composed prompt, or -1. */
function bodyIndex(state, composed, substituted, reads) {
    return (matchPromptBody(state.prompt, composed, reads, substituted)?.index ?? -1);
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Serializes an arbitrary string as a safe JavaScript/TypeScript literal. */
function sourceString(value) {
    return JSON.stringify(value)
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}
/**
 * Package-export default for direct emitter callers. Full reserved-pipeline
 * runs override it with the artifact-local verifier support module.
 */
export const VERIFY_MODULE = '@sublang/slc/verify';
/**
 * Finds the XState machine an `fsm` module exports — the export whose value has a
 * `.config.states` — so callers need not know its export name, and returns that
 * machine's config for {@link checkGearsFsmConformance}.
 *
 * @throws when the module exports no such machine.
 */
export function findMachineConfig(fsmModule) {
    if (typeof fsmModule === 'object' && fsmModule !== null) {
        for (const value of Object.values(fsmModule)) {
            if (typeof value === 'object' && value !== null && 'config' in value) {
                const config = value.config;
                if (typeof config === 'object' &&
                    config !== null &&
                    'states' in config) {
                    return config;
                }
            }
        }
    }
    throw new Error('fsm module exports no XState machine with a `.config.states`');
}
/**
 * Builds a per-artifact vitest module that fails when the compiled FSM drifts
 * from its GEARS source: it reads the artifact's `gears` file and the machine its
 * `fsm` module exports (via {@link findMachineConfig}, so no export name is
 * needed), then asserts {@link checkGearsFsmConformance} finds nothing.
 */
export function generateGearsFsmConformanceTest(opts) {
    return `// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Generated by slc (IR-007 Task 8): GEARS↔FSM conformance.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { checkGearsFsmConformance, findMachineConfig } from ${sourceString(opts.verifyModule)};
import * as fsm from ${sourceString(opts.fsmModule)};

describe(${sourceString(`${opts.basename}: GEARS↔FSM conformance`)}, () => {
  it('maps every GEARS item to a state with its player and verbatim prompt', () => {
    const gears = readFileSync(
      fileURLToPath(new URL(${sourceString(opts.gearsFile)}, import.meta.url)),
      'utf8',
    );
    expect(checkGearsFsmConformance(gears, findMachineConfig(fsm))).toEqual([]);
  });
});
`;
}
/**
 * Emits the GEARS↔FSM conformance test as `slc` output beside a compiled
 * `playbook` artifact: writes `<basename>.gears-fsm.test.ts` into the artifact
 * directory (`<basename>.playbook/`), wiring the artifact's `gears` file and its
 * `fsm` module's machine to the checker, and returns the written path (VERIFY-2;
 * [DR-009](../decisions/009-slc-playbook-pipeline-compilation.md)).
 */
export async function emitGearsFsmConformanceTest(opts) {
    const content = generateGearsFsmConformanceTest({
        basename: opts.basename,
        // NodeNext source imports the TypeScript artifact through its runtime
        // `.js` specifier; Vitest resolves that edge to the sibling source.
        fsmModule: `./${opts.basename}.fsm.js`,
        gearsFile: `./${opts.basename}.gears.md`,
        verifyModule: opts.verifyModule ?? VERIFY_MODULE,
    });
    await mkdir(opts.artifactDir, { recursive: true });
    const path = join(opts.artifactDir, `${opts.basename}.gears-fsm.test.ts`);
    await writeFile(path, content);
    return path;
}
/**
 * Imports a produced `fsm` artifact module for emission-time derivation. The
 * artifact is TypeScript; under Node's type stripping (erasable-syntax-only)
 * the direct import works, and a failure is reported to the caller so emission
 * degrades to a diagnostic rather than failing the run. The URL carries the
 * content hash so a rebuilt artifact at the same path is never served from the
 * module cache.
 */
export async function loadFsmModule(fsmPath) {
    const resolved = resolve(fsmPath);
    const url = pathToFileURL(resolved);
    url.searchParams.set('v', await hashFile(resolved));
    return import(url.href);
}
/**
 * Imports the generated linked TypeScript module before its sibling FSM has
 * been built to JavaScript. NodeNext source correctly names the runtime-safe
 * `./<basename>.fsm.js` edge, but emission-time verification runs while only
 * `./<basename>.fsm.ts` exists. Stage a same-directory copy whose one generated
 * module specifier points at the hashed TypeScript artifact, import that copy,
 * and remove it without changing the linked source or its production import.
 */
async function loadLinkedModuleForVerification(opts) {
    const linkedSource = await readFile(opts.linkedPath, 'utf8');
    const fsmStem = basename(opts.fsmPath, '.ts');
    const runtimeSpecifier = `./${fsmStem}.js`;
    const verificationSpecifier = `./${fsmStem}.ts?v=${await hashFile(opts.fsmPath)}`;
    const stagedSource = linkedSource
        .replaceAll(sourceString(runtimeSpecifier), sourceString(verificationSpecifier))
        .replaceAll(`'${runtimeSpecifier}'`, `'${verificationSpecifier}'`);
    // Linked fixtures that do not import their FSM need no staging and retain
    // the established direct-loading behavior.
    if (stagedSource === linkedSource) {
        return loadFsmModule(opts.linkedPath);
    }
    const linkedStem = basename(opts.linkedPath, '.ts');
    const stagedPath = join(dirname(opts.linkedPath), `.${linkedStem}.slc-verify-${randomUUID()}.ts`);
    await writeFile(stagedPath, stagedSource, { flag: 'wx' });
    try {
        return await loadFsmModule(stagedPath);
    }
    finally {
        await unlink(stagedPath);
    }
}
/**
 * Builds a per-artifact vitest module that fails when the machine's structure
 * drifts from the topology pinned at build time (VERIFY-4).
 */
export function generateFsmIntrospectionTest(opts) {
    return `// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Generated by slc (DR-009): FSM introspection pins.
// The PINNED topology was derived from the artifact at build time; any
// unintended structural change to the machine fails this test.
import { describe, expect, it } from 'vitest';

import { findMachineConfig, pinIntrospection } from ${sourceString(opts.verifyModule)};
import * as fsm from ${sourceString(opts.fsmModule)};

const PINNED = ${JSON.stringify(opts.pins, null, 2)};

describe(${sourceString(`${opts.basename}: FSM introspection`)}, () => {
  it('matches the machine topology pinned at build time', () => {
    expect(pinIntrospection(findMachineConfig(fsm))).toEqual(PINNED);
  });
});
`;
}
/**
 * Builds a per-artifact vitest module pinning the prompt contract derived from
 * the artifacts at build time (VERIFY-5): the per-state context reads, input
 * wiring, and placeholders always; and, when the linked module exposes its
 * matching Captain/player composers, the composition checks and pinned
 * substitution maps.
 */
export function generatePromptContractTest(opts) {
    const composerImports = opts.composer
        ? `import * as playbook from ${sourceString(opts.composer.playbookModule)};\n`
        : '';
    const composerBlock = [
        ['captain', 'Captain', 'composeCaptainPrompt'],
        ['player', 'player', 'composePlayerPrompt'],
    ]
        .flatMap(([actor, label, exportName]) => {
        const substituted = opts.composer?.[actor];
        if (substituted === undefined)
            return [];
        const constant = `${actor.toUpperCase()}_SUBSTITUTED`;
        const compose = `compose${label === 'Captain' ? 'Captain' : 'Player'}`;
        return [
            `
const ${constant} = ${JSON.stringify(substituted, null, 2)};

const ${compose} = (
  playbook as unknown as {
    _internal: { ${exportName}: (input: unknown) => string };
  }
)._internal.${exportName};

  it('composes ${label} prompts per the link contract', () => {
    expect(
      checkPromptComposition({
        config: findMachineConfig(fsm),
        compose: ${compose},
        actor: '${actor}',
      }),
    ).toEqual([]);
  });

  it('substitutes the ${label} placeholders pinned at build time', () => {
    expect(
      deriveSubstitutions(
        findMachineConfig(fsm),
        ${compose},
        '${actor}',
      ),
    ).toEqual(${constant});
  });
`,
        ];
    })
        .join('');
    const checkerImports = opts.composer
        ? 'capturePromptContract,\n  checkPromptComposition,\n  deriveSubstitutions,\n  findMachineConfig,'
        : 'capturePromptContract,\n  findMachineConfig,';
    return `// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Generated by slc (DR-009): prompt contract.
// The pinned rows were derived from the artifacts at build time; wiring,
// placeholder, or composition drift fails this test.
import { describe, expect, it } from 'vitest';

import {
  ${checkerImports}
} from ${sourceString(opts.verifyModule)};
import * as fsm from ${sourceString(opts.fsmModule)};
${composerImports}
const CONTRACT = ${JSON.stringify(opts.rows, null, 2)};

describe(${sourceString(`${opts.basename}: prompt contract`)}, () => {
  it('matches the prompt contract pinned at build time', () => {
    expect(capturePromptContract(findMachineConfig(fsm))).toEqual(CONTRACT);
  });
${composerBlock}});
`;
}
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
export async function emitPromptContractTest(opts) {
    const diagnostics = [];
    const fsmPath = join(opts.artifactDir, `${opts.basename}.fsm.ts`);
    const config = findMachineConfig(await loadFsmModule(fsmPath));
    const rows = capturePromptContract(config);
    let composer;
    const linkedPath = join(opts.artifactDir, `${opts.basename}.playbook.ts`);
    if (existsSync(linkedPath)) {
        try {
            const linked = (await loadLinkedModuleForVerification({
                linkedPath,
                fsmPath,
            }));
            const actors = new Set(enumerateCaptainStates(config).map(({ actor }) => actor));
            const substitutions = {};
            for (const actor of ['captain', 'player']) {
                if (!actors.has(actor))
                    continue;
                const exportName = actor === 'captain' ? 'composeCaptainPrompt' : 'composePlayerPrompt';
                const compose = linked._internal?.[exportName];
                if (typeof compose !== 'function') {
                    diagnostics.push(`prompt contract: linked module exposes no _internal.${exportName}; ${actor} composition checks not emitted`);
                    continue;
                }
                const typedCompose = compose;
                substitutions[actor] = deriveSubstitutions(config, typedCompose, actor);
                const findings = checkPromptComposition({
                    config,
                    compose: typedCompose,
                    actor,
                });
                diagnostics.push(...findings.map((finding) => `prompt contract: ${finding}`));
            }
            if (substitutions.captain !== undefined ||
                substitutions.player !== undefined) {
                composer = {
                    playbookModule: `./${opts.basename}.playbook.js`,
                    ...substitutions,
                };
            }
        }
        catch (error) {
            diagnostics.push(`prompt contract: linked module could not be imported (${messageOf(error)}); composition checks not emitted`);
        }
    }
    const content = generatePromptContractTest({
        basename: opts.basename,
        fsmModule: `./${opts.basename}.fsm.js`,
        verifyModule: opts.verifyModule ?? VERIFY_MODULE,
        rows,
        composer,
    });
    await mkdir(opts.artifactDir, { recursive: true });
    const path = join(opts.artifactDir, `${opts.basename}.prompt-contract.test.ts`);
    await writeFile(path, content);
    return { path, diagnostics };
}
/**
 * Emits the introspection test beside a compiled `playbook` artifact
 * (VERIFY-4): derives topology pins from the physical `<basename>.fsm.ts`,
 * emits a NodeNext `.js` import for that sibling source, and writes
 * `<basename>.fsm.introspect.test.ts` into the artifact directory.
 *
 * @throws when the `fsm` artifact cannot be imported or exports no machine.
 */
export async function emitFsmIntrospectionTest(opts) {
    const fsmPath = join(opts.artifactDir, `${opts.basename}.fsm.ts`);
    const pins = pinIntrospection(findMachineConfig(await loadFsmModule(fsmPath)));
    const content = generateFsmIntrospectionTest({
        basename: opts.basename,
        fsmModule: `./${opts.basename}.fsm.js`,
        verifyModule: opts.verifyModule ?? VERIFY_MODULE,
        pins,
    });
    await mkdir(opts.artifactDir, { recursive: true });
    const path = join(opts.artifactDir, `${opts.basename}.fsm.introspect.test.ts`);
    await writeFile(path, content);
    return path;
}
// Transition-coverage verification (VERIFY-6) lives in its own module — it
// depends on `xstate` to drive the machine — and is re-exported here so every
// generated test imports one checker module (`@sublang/slc/verify`).
export * from './verify-coverage.js';
