// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
/**
 * Compilation-correctness verification for a compiled `playbook` artifact
 * (DR-009).
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
 * for every compiled `playbook`. See specs/packages/verification.md.
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
 * True when the declaration admits the roleless schema-3 `composed-v3`
 * generation: `RUNTIME_ABI` is exactly `1` and `SUPPORTED_ARTIFACT_SCHEMAS`
 * contains `3` (DR-028).
 */
export function declaresComposedV3(declaration) {
    return (declaration.runtimeAbi === 1 &&
        Array.isArray(declaration.supportedArtifactSchemas) &&
        declaration.supportedArtifactSchemas.includes(3));
}
/** Names a declaration for fail-closed diagnostics. */
export function describeRuntimeDeclaration(declaration) {
    const abi = declaration.runtimeAbi === undefined
        ? 'no RUNTIME_ABI'
        : `RUNTIME_ABI ${renderDeclared(declaration.runtimeAbi)}`;
    const schemas = declaration.supportedArtifactSchemas === undefined
        ? 'no SUPPORTED_ARTIFACT_SCHEMAS'
        : `SUPPORTED_ARTIFACT_SCHEMAS ${renderDeclared(declaration.supportedArtifactSchemas)}`;
    return `${declaration.provenance} declares ${abi} and ${schemas}`;
}
function renderDeclared(value) {
    try {
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : json;
    }
    catch {
        return String(value);
    }
}
/**
 * Artifact schema recorded for an exact reviewed Playbook provenance: the
 * historical map kept as recorded (DR-028). A later release supplies its
 * schema through the installed engine's declaration instead
 * ({@link resolveArtifactSchemaForVerification}).
 */
export function artifactSchemaForPlaybookProvenance(provenance) {
    switch (provenance) {
        case '@sublang/playbook@0.10.0':
        case '@sublang/playbook@1.0.0':
        case '@sublang/playbook@2.0.0':
        case '@sublang/playbook@3.1.0':
        case '@sublang/playbook@4.0.0':
            return 1;
        case '@sublang/playbook@10.0.0':
            return 3;
        default:
            return undefined;
    }
}
/**
 * Returns the Playbook package provenance that owns an invocation's concrete
 * link target. The first package manifest above the target owns the file; a
 * parent workspace manifest must not lend its identity to a nested local file.
 */
export async function playbookProvenanceForLinkTarget(linkTarget) {
    let cursor = dirname(resolve(linkTarget));
    for (;;) {
        const manifestPath = join(cursor, 'package.json');
        if (existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
                return manifest.name === '@sublang/playbook' &&
                    typeof manifest.version === 'string' &&
                    manifest.version.length > 0
                    ? `${manifest.name}@${manifest.version}`
                    : undefined;
            }
            catch {
                return undefined;
            }
        }
        const parent = dirname(cursor);
        if (parent === cursor)
            return undefined;
        cursor = parent;
    }
}
/** Both XState initial-transition forms select one immediate child key. */
export function initialStateTarget(initial) {
    return typeof initial === 'string' ? initial : initial?.target;
}
const ITEM_HEADING = /^###\s+([A-Za-z][\w-]*)\s*$/;
// The `text2gears` item form names a delegated player as "Captain shall prompt
// <Player>" (or a "relay ... to <Player>" variant); English players are
// capitalized, non-English names are quoted only "when needed to distinguish
// from prose" (text2gears.md), so backtick/straight/CJK-quoted forms and bare
// non-ASCII names are all accepted.
const ITEM_PLAYER = /Captain shall (?:prompt|relay\b[^.]*?\bto)\s+(?:`([^`]+)`|"([^"]+)"|“([^”]+)”|([A-Z][\w]*)|([^\p{ASCII}][^\s:：，,。;；]*))/u;
const ITEM_PLAYBOOK = /Captain shall call playbook\s+(?:`([^`]+)`|"([^"]+)"|“([^”]+)”|([A-Za-z0-9][\w.-]*))\s*:/;
const ITEM_DYNAMIC_PLAYBOOK = /Captain shall call playbook selected by\s+`([^`]+)`\s*:/;
const PARALLEL_GROUP = /^Parallel group:\s*(\S(?:.*\S)?)\s*$/;
const DYNAMIC_TEXT = /^<([A-Za-z_$][A-Za-z0-9_$]*)>$/;
// An optimizer-introduced script item runs a shell command without any agent
// (text2gears.md "Script behaviors"; DR-013). The clause is fixed machine
// syntax, so it is matched literally ahead of the generic Captain form.
const SCRIPT_CLAUSE = /\bCaptain shall run\s*:/;
// Some items have Captain act directly ("Captain shall <verb> ...") with no
// delegated player; their player is Captain itself.
const CAPTAIN_ACTS = /\bCaptain shall\b/;
const BLOCKQUOTE = /^>\s?(.*)$/;
const SECTION_HEADING = /^##\s/;
const RESULTS_LABEL = /^Results:\s*$/;
const RESULTS_LABEL_NEAR_MISS = /^Results\s*:?[ \t]*$/;
const RESULT_BULLET = /^-\s+`([A-Za-z_$][A-Za-z0-9_$]*)`:\s+(\S(?:.*\S)?)\s*$/;
const PLAYBOOK_CALL_SEQUENCING_NEAR_MISS = /\bCaptain shall (first|then|next|finally) call playbook\b/u;
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
            if (current.script && !playbookCall) {
                // A script item carries exactly two exit-status guards, zero-exit
                // first (text2gears.md "Script behaviors").
                if (!current.resultDeclared) {
                    current.resultFindings.push('script item shall declare a two-guard Results contract');
                }
                else if (current.results.length !== 2) {
                    current.resultFindings.push(`script item declares ${current.results.length} Results guards (expected exactly 2)`);
                }
            }
            items.push({
                id: current.id,
                player: current.script && !playbookCall ? '' : player,
                prompt,
                ...(!playbookCall && current.script
                    ? { actor: 'script' }
                    : {}),
                ...(!playbookCall && !current.script && current.player !== ''
                    ? { actor: 'player' }
                    : {}),
                ...(!playbookCall &&
                    !current.script &&
                    current.player === '' &&
                    current.captainActs
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
                ...(current.parallelGroup !== ''
                    ? { parallelGroup: current.parallelGroup }
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
    for (const line of gears.split(/\r?\n/)) {
        const heading = ITEM_HEADING.exec(line);
        if (heading !== null) {
            flush();
            current = {
                id: heading[1],
                player: '',
                captainActs: false,
                script: false,
                playbookId: '',
                playbookIdContext: '',
                parallelGroup: '',
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
            current.resultFindings.push(...outputFieldGuidanceFindings(guard, description));
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
        const parallelGroup = PARALLEL_GROUP.exec(line.trim());
        if (parallelGroup !== null && current.parallelGroup === '') {
            current.parallelGroup = parallelGroup[1];
        }
        const player = ITEM_PLAYER.exec(line);
        if (player !== null && current.player === '') {
            current.player =
                player[1] ?? player[2] ?? player[3] ?? player[4] ?? player[5];
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
        if (SCRIPT_CLAUSE.test(line))
            current.script = true;
        if (CAPTAIN_ACTS.test(line))
            current.captainActs = true;
    }
    flush();
    return items;
}
/** Backticks in an output clause declare fields, never nested prose (DR-051). */
function outputFieldGuidanceFindings(guard, description) {
    const marker = description.indexOf('Output shall include');
    if (marker < 0)
        return [];
    let depth = 0;
    const findings = [];
    for (const [token] of description.slice(marker).matchAll(/`[^`]+`|[()]/g)) {
        if (token === '(')
            depth++;
        else if (token === ')')
            depth = Math.max(0, depth - 1);
        else if (depth > 0) {
            findings.push(`result \`${guard}\` puts ${token} inside parenthetical output guidance; output-clause backticks declare fields, so move the field declaration outside parentheses or use plain guidance text or a complete field annotation`);
        }
    }
    return findings;
}
function gearsResultFindings(items) {
    return items.flatMap((item) => (item.resultFindings ?? []).map((finding) => `GEARS item ${item.id}: ${finding}`));
}
function gearsActorFindings(gears) {
    const findings = [];
    let item;
    let inResults = false;
    for (const line of gears.split('\n')) {
        const heading = ITEM_HEADING.exec(line);
        if (heading !== null) {
            item = heading[1];
            inResults = false;
            continue;
        }
        if (SECTION_HEADING.test(line)) {
            item = undefined;
            inResults = false;
            continue;
        }
        if (item === undefined)
            continue;
        if (BLOCKQUOTE.test(line))
            continue;
        if (RESULTS_LABEL.test(line) || RESULTS_LABEL_NEAR_MISS.test(line)) {
            inResults = true;
            continue;
        }
        if (inResults)
            continue;
        const nearMiss = PLAYBOOK_CALL_SEQUENCING_NEAR_MISS.exec(line);
        if (nearMiss === null)
            continue;
        findings.push(`GEARS item ${item}: ${JSON.stringify(nearMiss[0])} is not a valid nested-playbook acting clause; use exact \`Captain shall call playbook ...:\` and preserve sequencing in When/While or continuation prose`);
    }
    return findings;
}
/** Existing GEARS result-parser findings, without requiring a consumer FSM. */
export function checkGearsResultContract(gears) {
    return gearsResultFindings(parseGearsItems(gears));
}
/** GEARS actor-clause findings, without changing parser classification. */
export function checkGearsActorContract(gears) {
    return gearsActorFindings(gears);
}
const ROLE_DECLARATION = /^(?:#{1,6}\s+(Roles|Players)|(Roles|Players):)\s*$/;
/** Canonical lowercase local-role id used by schema-3 artifacts. */
export function canonicalRoleId(name) {
    return name.toLowerCase();
}
function declarationName(value) {
    const match = /^[`"“]?([^`"”]+?)[`"”]?\s*$/.exec(value.trim());
    return match?.[1].trim() || undefined;
}
/** Parses Roles/Players plus source-derived concurrent role sets without host bindings. */
export function inspectGearsRoleContract(gears) {
    const findings = [];
    const declarations = [];
    let active;
    for (const line of gears.split('\n')) {
        const heading = ROLE_DECLARATION.exec(line.trim());
        if (heading !== null) {
            active = {
                kind: (heading[1] ?? heading[2]),
                names: [],
            };
            declarations.push(active);
            continue;
        }
        if (active === undefined)
            continue;
        if (line.trim() === '')
            continue;
        const bullet = /^-\s+(.*)$/.exec(line.trim());
        if (bullet === null) {
            active = undefined;
            continue;
        }
        const declaration = bullet[1].trim();
        if (active.kind === 'Roles' && /[=|]/.test(declaration)) {
            findings.push(`Roles declaration ${JSON.stringify(declaration)} uses removed alias syntax`);
            continue;
        }
        // Historical schema-1 Players may declare a composite launcher choice
        // (`Committer = Coder | Reviewer`). It is not one concrete player binding
        // and therefore does not enter the source-order player list, including
        // when every name is backtick- or quote-delimited.
        if (active.kind === 'Players' && declaration.includes('='))
            continue;
        const name = declarationName(declaration);
        if (name === undefined) {
            findings.push(`malformed ${active.kind} declaration ${JSON.stringify(declaration)}`);
            continue;
        }
        active.names.push(name);
    }
    const kinds = new Set(declarations.map(({ kind }) => kind));
    if (declarations.length > 1) {
        findings.push('GEARS declares more than one Roles/Players section');
    }
    if (kinds.size > 1) {
        findings.push('GEARS mixes Roles and Players declarations');
    }
    const selected = declarations[0];
    const generation = selected?.kind === 'Roles'
        ? 'schema-3'
        : selected?.kind === 'Players'
            ? 'schema-1'
            : 'unspecified';
    const names = selected?.names ?? [];
    const roleIds = names.map(canonicalRoleId);
    if (generation === 'schema-3') {
        const byCanonical = new Map();
        for (let index = 0; index < names.length; index += 1) {
            const name = names[index];
            const roleId = roleIds[index];
            const existing = byCanonical.get(roleId);
            if (existing !== undefined) {
                findings.push(existing === name
                    ? `Roles declaration repeats ${JSON.stringify(name)}`
                    : `Roles declarations ${JSON.stringify(existing)} and ${JSON.stringify(name)} collide as canonical role ${JSON.stringify(roleId)}`);
            }
            else {
                byCanonical.set(roleId, name);
            }
            // A canonical local role id is the declared name lowercased. Playbook 10
            // explicitly admits non-English role names ("quote non-English names
            // (e.g., `作者`)"), and a script without case - Chinese among them -
            // lowercases to itself, so an ASCII-only class would reject exactly the
            // names the definition sanctions. Require instead that the id be genuinely
            // canonical: already lowercase, carrying no whitespace or separator that
            // would make it ambiguous as an identifier.
            if (roleId.length === 0 ||
                roleId !== roleId.toLowerCase() ||
                /[\s.,;:/\\'"`()[\]{}<>|]/u.test(roleId)) {
                findings.push(`Roles declaration ${JSON.stringify(name)} derives noncanonical local role ${JSON.stringify(roleId)}`);
            }
            else if (roleId === 'captain') {
                findings.push('Roles declaration uses reserved local role "captain"');
            }
        }
    }
    const groups = new Map();
    if (generation === 'schema-3') {
        const declared = new Set(roleIds);
        for (const item of parseGearsItems(gears)) {
            if (item.actor === 'player') {
                const roleId = canonicalRoleId(item.player);
                if (!declared.has(roleId)) {
                    findings.push(`GEARS item ${item.id} delegates to undeclared role ${JSON.stringify(item.player)}`);
                }
            }
            if (item.parallelGroup === undefined)
                continue;
            if (item.actor !== 'player') {
                findings.push(`parallel group ${JSON.stringify(item.parallelGroup)} contains non-role item ${item.id}`);
                continue;
            }
            const roleId = canonicalRoleId(item.player);
            const members = groups.get(item.parallelGroup) ?? [];
            if (members.includes(roleId)) {
                findings.push(`parallel group ${JSON.stringify(item.parallelGroup)} repeats canonical role ${JSON.stringify(roleId)}`);
            }
            members.push(roleId);
            groups.set(item.parallelGroup, members);
        }
        const groupByMembers = new Map();
        for (const [group, members] of groups) {
            if (members.length < 2) {
                findings.push(`parallel group ${JSON.stringify(group)} contains fewer than two roles`);
            }
            // A concurrent role set is unordered for duplicate detection even
            // though its source member order remains significant in the FSM export.
            const signature = JSON.stringify([...members].sort());
            const existing = groupByMembers.get(signature);
            if (existing !== undefined) {
                findings.push(`parallel groups ${JSON.stringify(existing)} and ${JSON.stringify(group)} duplicate concurrent role set ${signature}`);
            }
            else {
                groupByMembers.set(signature, group);
            }
        }
    }
    return {
        generation,
        names,
        roleIds,
        concurrentRoleSets: [...groups.values()],
        findings,
    };
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
function invocationInput(invoke, context = {}, allowStatic = false) {
    if (allowStatic &&
        typeof invoke.input === 'object' &&
        invoke.input !== null &&
        !Array.isArray(invoke.input)) {
        return { value: invoke.input };
    }
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
function metadataRole(state) {
    if (typeof state.meta !== 'object' || state.meta === null)
        return undefined;
    const playbook = state.meta.playbook;
    if (typeof playbook !== 'object' || playbook === null)
        return undefined;
    return playbook.role;
}
/** The published terminal kind a root final state declares, if any. */
function metadataTerminal(state) {
    if (typeof state.meta !== 'object' || state.meta === null)
        return undefined;
    const playbook = state.meta.playbook;
    if (typeof playbook !== 'object' || playbook === null)
        return undefined;
    return playbook.terminal;
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
/**
 * A schema-3 machine publishes each of its own terminal outcomes as
 * `success` or `failure`, so a caller reads the child's meaning from the
 * state it reached rather than from its output fields. Only the machine's own
 * root final states carry that kind: a final inside a parallel region merely
 * stages the join and publishes no workflow outcome.
 *
 * Artifacts compiled before the definition declared the kind carry none at
 * all, and they are retained rather than rebuilt, so the requirement engages
 * once the artifact declares one — a partly declared artifact is drift.
 */
function terminalKindFindings(nodes, schema3) {
    if (!schema3)
        return [];
    const finals = nodes.filter(({ path, state }) => path.length === 1 && state.type === 'final');
    if (!finals.some(({ state }) => metadataTerminal(state) !== undefined)) {
        return [];
    }
    const findings = [];
    for (const { statePath, state } of finals) {
        const terminal = metadataTerminal(state);
        if (terminal === undefined) {
            findings.push(`FSM final state ${statePath}: state.meta.playbook.terminal is missing while other final states declare it`);
        }
        else if (terminal !== 'success' && terminal !== 'failure') {
            findings.push(`FSM final state ${statePath}: state.meta.playbook.terminal ${JSON.stringify(terminal)} is neither "success" nor "failure"`);
        }
    }
    return findings;
}
function enumerateCaptainBindings(config) {
    const out = [];
    const initial = initialMachineContext(config) ?? {};
    for (const node of walkStateNodes(config)) {
        for (const invoke of normalizeInvokes(node.state.invoke)) {
            const source = invokeSource(invoke.src);
            const explicitlyWorkActor = source === 'captain' || source === 'player';
            if (!explicitlyWorkActor && invoke.src !== undefined)
                continue;
            const inspected = invocationInput(invoke, initial);
            if ('error' in inspected) {
                if (explicitlyWorkActor) {
                    const actor = source === 'player' ? 'player' : 'captain';
                    out.push({
                        state: malformedCaptainState(publicStateId(node, undefined), `invoke.input threw during introspection: ${inspected.error}`, actor, node),
                        node,
                        invoke,
                        inputFn: typeof invoke.input === 'function' ? invoke.input : undefined,
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
                        inputFn: typeof invoke.input === 'function' ? invoke.input : undefined,
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
            // Published schema-1 artifacts carried a concrete player field. Schema 3
            // carries only its canonical local role and repeats it in public metadata.
            const actor = source === 'player' ||
                Object.hasOwn(fields, 'player') ||
                Object.hasOwn(fields, 'role')
                ? 'player'
                : 'captain';
            const pinActor = source === 'player' || (source === 'captain' && actor === 'captain');
            const bindingFindings = [];
            if (!isNonEmptyString(fields.sourceItem)) {
                bindingFindings.push('invoke.input.sourceItem is not a non-empty string');
            }
            if (actor === 'player') {
                const hasPlayer = Object.hasOwn(fields, 'player');
                const hasRole = Object.hasOwn(fields, 'role');
                if (hasPlayer && hasRole) {
                    bindingFindings.push('invoke.input carries both historical player and schema-3 role');
                }
                if (hasRole && typeof fields.role !== 'string') {
                    bindingFindings.push('invoke.input.role is not a string');
                }
                if (hasRole && source !== 'player') {
                    bindingFindings.push('schema-3 delegated work does not invoke the player actor');
                }
                if (!hasRole && typeof fields.player !== 'string') {
                    bindingFindings.push('invoke.input.player is not a string');
                }
                const publicRole = metadataRole(node.state);
                if (hasRole) {
                    if (typeof publicRole !== 'string') {
                        bindingFindings.push('state.meta.playbook.role is not a string for schema-3 delegated work');
                    }
                    else if (publicRole !== fields.role) {
                        bindingFindings.push(`state.meta.playbook.role ${JSON.stringify(publicRole)} does not match invoke.input.role ${JSON.stringify(fields.role)}`);
                    }
                }
                else if (publicRole !== undefined) {
                    bindingFindings.push('historical delegated-player state unexpectedly declares state.meta.playbook.role');
                }
            }
            else if (Object.hasOwn(fields, 'role') ||
                metadataRole(node.state) !== undefined) {
                bindingFindings.push('direct-Captain state unexpectedly declares a role binding');
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
                    ...(typeof fields.role === 'string' ? { role: fields.role } : {}),
                    prompt: typeof fields.prompt === 'string' ? fields.prompt : '',
                    result: resultMap(fields.result),
                    ...nestedStatePath(node),
                    ...(bindingFindings.length > 0 ? { bindingFindings } : {}),
                },
                node,
                invoke,
                inputFn: typeof invoke.input === 'function' ? invoke.input : undefined,
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
    const initial = initialMachineContext(config) ?? {};
    for (const node of walkStateNodes(config)) {
        for (const invoke of normalizeInvokes(node.state.invoke)) {
            if (invokeSource(invoke.src) !== 'playbook')
                continue;
            const inspected = invocationInput(invoke, initial, true);
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
                        ...initial,
                        [fields.playbookIdContext]: playbookIdSentinel,
                        [fields.textContext]: textSentinel,
                    }, true);
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
/**
 * Enumerates typed `script` actor calls across the complete state tree
 * (gears2fsm.md "Setup"; DR-013). A script state carries `stateId`,
 * `sourceItem`, the verbatim `command`, and exactly two exit-status guards; it
 * is not agent-invoking, so `needsBossReply` in its result map is malformed.
 */
export function enumerateScriptStates(config) {
    const out = [];
    const initial = initialMachineContext(config) ?? {};
    for (const node of walkStateNodes(config)) {
        for (const invoke of normalizeInvokes(node.state.invoke)) {
            if (invokeSource(invoke.src) !== 'script')
                continue;
            const malformed = (finding) => ({
                stateId: publicStateId(node, undefined),
                sourceItem: '',
                command: '',
                result: {},
                ...nestedStatePath(node),
                bindingFindings: [finding],
            });
            const inspected = invocationInput(invoke, initial);
            if ('error' in inspected) {
                out.push(malformed(`invoke.input threw during introspection: ${inspected.error}`));
                continue;
            }
            if ('invalid' in inspected) {
                out.push(malformed(typeof invoke.input === 'function'
                    ? 'invoke.input returned a non-object'
                    : 'invoke.input is not a function'));
                continue;
            }
            const fields = inspected.value;
            const bindingFindings = [];
            if (!isNonEmptyString(fields.stateId)) {
                bindingFindings.push('invoke.input.stateId is not a non-empty string');
            }
            if (!isNonEmptyString(fields.sourceItem)) {
                bindingFindings.push('invoke.input.sourceItem is not a non-empty string');
            }
            if (!isNonEmptyString(fields.command)) {
                bindingFindings.push('invoke.input.command is not a non-empty string');
            }
            if (!isStringMap(fields.result)) {
                bindingFindings.push('invoke.input.result is not a string-valued object');
            }
            else {
                const guards = Object.keys(fields.result);
                if (guards.length !== 2) {
                    bindingFindings.push(`script invoke.input.result declares ${guards.length} guards (expected exactly 2)`);
                }
                if (guards.includes(NEEDS_BOSS_REPLY)) {
                    bindingFindings.push(`script state shall not declare ${NEEDS_BOSS_REPLY}`);
                }
            }
            bindingFindings.push(...stateIdConsistencyFindings(node, fields.stateId));
            if (Object.keys(node.state.states ?? {}).length > 0) {
                bindingFindings.push('script invocation is declared on a compound state instead of a leaf');
            }
            out.push({
                stateId: publicStateId(node, fields),
                sourceItem: isNonEmptyString(fields.sourceItem)
                    ? fields.sourceItem
                    : '',
                command: isNonEmptyString(fields.command) ? fields.command : '',
                result: resultMap(fields.result),
                ...nestedStatePath(node),
                ...(bindingFindings.length > 0 ? { bindingFindings } : {}),
            });
        }
    }
    return out;
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
/** Exact action guards of Playbook 10's controller decision result. */
export const CONTROLLER_ACTION_GUARDS = [
    'respond',
    'resume',
    'start',
    'switch',
    'dismiss',
    'deliver',
    'runtime',
];
const CONTROLLER_DOMAINS = [
    CONTROLLER_ACTION_GUARDS,
    [...CONTROLLER_ACTION_GUARDS, 'recover'],
];
/** Exact legacy or recovery-capable controller domain. */
export function isControllerDecisionResult(result) {
    if (!isStringMap(result))
        return false;
    const keys = Object.keys(result).filter((key) => key !== NEEDS_BOSS_REPLY);
    return CONTROLLER_DOMAINS.some((domain) => keys.length === domain.length &&
        domain.every((guard) => Object.hasOwn(result, guard)));
}
/** A single missing or extra key against the matching controller domain. */
export function controllerDecisionNearMiss(result) {
    if (!isStringMap(result))
        return undefined;
    const actual = Object.keys(result).filter((key) => key !== NEEDS_BOSS_REPLY);
    if (isControllerDecisionResult(result))
        return undefined;
    const present = new Set(actual);
    const domain = present.has('recover')
        ? CONTROLLER_DOMAINS[1]
        : CONTROLLER_ACTION_GUARDS;
    const expected = new Set(domain);
    const missing = domain.filter((key) => !present.has(key));
    const extra = actual.filter((key) => !expected.has(key));
    return missing.length + extra.length === 1
        ? { missing, extra, domain }
        : undefined;
}
/** Whether a machine contains Playbook 10's grounded controller decision state. */
export function isControllerMachine(config) {
    return enumerateCaptainBindings(config).some(({ state, pinActor }) => {
        if (!pinActor || state.actor !== 'captain')
            return false;
        if (state.bindingFindings?.includes('invoke.input.result is not a string-valued object')) {
            return false;
        }
        return isControllerDecisionResult(state.result);
    });
}
/** Whether an explicit direct-Captain result is one key from the controller domain. */
export function hasControllerDecisionNearMiss(config) {
    return enumerateCaptainBindings(config).some(({ state, pinActor }) => pinActor &&
        state.actor === 'captain' &&
        state.result[NEEDS_BOSS_REPLY] === undefined &&
        controllerDecisionNearMiss(state.result) !== undefined);
}
function concurrentRoleSets(value) {
    if (!Array.isArray(value))
        return undefined;
    const sets = [];
    for (const candidate of value) {
        if (!Array.isArray(candidate) ||
            candidate.some((role) => typeof role !== 'string')) {
            return undefined;
        }
        sets.push([...candidate]);
    }
    return sets;
}
/** Reject tags that prevent the public runtime returning a pending child. */
export function checkFsmChildSuspension(config) {
    const nodes = walkStateNodes(config);
    const busy = (tags) => typeof tags === 'string'
        ? tags === 'playbook.busy'
        : tags?.includes('playbook.busy') === true;
    return enumeratePlaybookBindings(config).flatMap(({ node, state }) => {
        const locations = [
            ...(busy(config.tags) ? ['machine root'] : []),
            ...nodes
                .filter((ancestor) => ancestor.path.length <= node.path.length &&
                ancestor.path.every((key, index) => key === node.path[index]) &&
                busy(ancestor.state.tags))
                .map((ancestor) => ancestor.statePath),
        ];
        return locations.length === 0
            ? []
            : [
                `FSM playbook state ${state.stateId}: playbook.busy on ${locations.join(', ')} prevents returning a suspended child call; remove that tag from the call state and its ancestors`,
            ];
    });
}
/**
 * Checks GEARS↔FSM conformance and returns human-readable findings (empty when
 * conformant): every GEARS item maps to one state with the same player and the
 * prompt verbatim, every captain state references a known item, and every
 * captain state's `result` map declares the Boss-reply suspension key with its
 * adjudicator contract (verification-1, verification-3; DR-009).
 */
export function checkGearsFsmConformance(gears, config, options = {}) {
    const items = parseGearsItems(gears);
    const roleContract = inspectGearsRoleContract(gears);
    const controller = isControllerMachine(config);
    const captainBindings = enumerateCaptainBindings(config);
    const states = captainBindings.map(({ state }) => state);
    const controllerNearMisses = captainBindings.flatMap(({ state, pinActor }) => {
        if (!pinActor ||
            state.actor !== 'captain' ||
            state.result[NEEDS_BOSS_REPLY] !== undefined) {
            return [];
        }
        const nearMiss = controllerDecisionNearMiss(state.result);
        return nearMiss === undefined ? [] : [{ state, nearMiss }];
    });
    const controllerNearMissStates = new Set(controllerNearMisses.map(({ state }) => state));
    const explicitActorStates = new Set(captainBindings
        .filter(({ pinActor }) => pinActor)
        .map(({ state }) => state));
    const playbookBindings = enumeratePlaybookBindings(config);
    const playbookStates = playbookBindings.map(({ state }) => state);
    const initialContext = initialMachineContext(config);
    const literalChecks = new Map();
    const literalFinding = (item, state) => {
        let checked = literalChecks.get(state);
        if (checked === undefined)
            literalChecks.set(state, (checked = new Map()));
        if (!checked.has(item.prompt)) {
            const binding = playbookBindings.find((candidate) => candidate.state === state);
            checked.set(item.prompt, binding === undefined
                ? 'has no inspectable invocation'
                : literalPlaybookTextFinding(item.prompt, binding, initialContext));
        }
        return checked.get(item.prompt);
    };
    const scriptStates = enumerateScriptStates(config);
    const findings = [];
    if (typeof config.meta === 'object' &&
        config.meta !== null &&
        Object.hasOwn(config.meta, 'playbook')) {
        findings.push('FSM machine root declares meta.playbook; public playbook metadata belongs only to state nodes under states');
    }
    for (const { state, nearMiss } of controllerNearMisses) {
        const detail = nearMiss.missing.length > 0
            ? `missing ${JSON.stringify(nearMiss.missing[0])}`
            : `extra ${JSON.stringify(nearMiss.extra[0])}`;
        findings.push(`FSM state ${state.stateId}: controller decision contract near-miss (${detail}); the controller domain requires exactly ${nearMiss.domain.join(', ')}`);
    }
    const nodes = walkStateNodes(config);
    findings.push(...checkFsmChildSuspension(config));
    findings.push(...structuredStateIdentityFindings(nodes));
    findings.push(...roleContract.findings);
    const schema3 = roleContract.generation === 'schema-3' ||
        controller ||
        options.artifactSchema === 3;
    findings.push(...terminalKindFindings(nodes, schema3));
    if (schema3) {
        const actual = concurrentRoleSets(options.concurrentRoleSets);
        if (actual === undefined) {
            findings.push('schema-3 FSM exports no valid concurrentRoleSets array');
        }
        else if (JSON.stringify(actual) !== JSON.stringify(roleContract.concurrentRoleSets)) {
            findings.push(`schema-3 FSM concurrentRoleSets ${JSON.stringify(actual)} do not match GEARS groups ${JSON.stringify(roleContract.concurrentRoleSets)}`);
        }
    }
    findings.push(...gearsResultFindings(items));
    findings.push(...gearsActorFindings(gears));
    for (const state of states) {
        findings.push(...(state.bindingFindings ?? []).map((finding) => `FSM state ${state.stateId}: ${finding}`));
    }
    for (const state of playbookStates) {
        findings.push(...(state.bindingFindings ?? []).map((finding) => `FSM playbook state ${state.stateId}: ${finding}`));
    }
    for (const state of scriptStates) {
        findings.push(...(state.bindingFindings ?? []).map((finding) => `FSM script state ${state.stateId}: ${finding}`));
    }
    const scriptStatesByItem = new Map();
    for (const state of scriptStates) {
        if (state.sourceItem === '')
            continue;
        const matched = scriptStatesByItem.get(state.sourceItem);
        if (matched === undefined)
            scriptStatesByItem.set(state.sourceItem, [state]);
        else
            matched.push(state);
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
    // Composed literal inputs have no static text signature. The optional
    // sourceItem remains optional: match otherwise unbound calls by their whole
    // observable template, never by guessed context-field names.
    for (const item of playbookItems) {
        if (item.playbookIdContext !== undefined || playbookMatchesByItem.has(item))
            continue;
        const state = playbookStates.find((candidate) => candidate.sourceItem === undefined &&
            !matchedPlaybookStates.has(candidate) &&
            candidate.playbookIdContext === undefined &&
            candidate.playbookId === item.playbookId &&
            literalFinding(item, candidate) === undefined);
        if (state !== undefined)
            addPlaybookMatch(item, state);
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
                const textFinding = literalFinding(item, state);
                if (textFinding !== undefined) {
                    findings.push(`${item.id}: FSM playbook text ${textFinding}`);
                }
            }
            continue;
        }
        if (item.actor === 'script') {
            const matchedScripts = scriptStatesByItem.get(item.id) ?? [];
            if (matchedScripts.length === 0) {
                const drifted = statesByItem.get(item.id) ?? [];
                findings.push(drifted.length > 0
                    ? `${item.id}: FSM actor "${drifted[0].actor}" is not GEARS actor "script"`
                    : `GEARS item ${item.id} maps to no FSM script state`);
                continue;
            }
            if (matchedScripts.length > 1) {
                findings.push(`GEARS item ${item.id} maps to ${matchedScripts.length} FSM script states (expected exactly one: ${matchedScripts.map((s) => s.stateId).join(', ')})`);
            }
            const scriptState = matchedScripts[0];
            if (scriptState.command !== item.prompt) {
                findings.push(`${item.id}: FSM script command is not the GEARS blockquote verbatim`);
            }
            if (item.result !== undefined) {
                const expected = Object.entries(item.result);
                const actual = Object.entries(scriptState.result);
                if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                    findings.push(`${item.id}: FSM script result contract ${JSON.stringify(actual)} is not GEARS Results ${JSON.stringify(expected)}`);
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
        if (item.actor === 'player') {
            if (roleContract.generation === 'schema-3') {
                const expectedRole = canonicalRoleId(item.player);
                if (state.role !== expectedRole) {
                    findings.push(`${item.id}: FSM role ${JSON.stringify(state.role ?? '')} is not GEARS canonical role ${JSON.stringify(expectedRole)}`);
                }
                if (state.player !== '') {
                    findings.push(`${item.id}: schema-3 delegated role carries removed invoke.input.player ${JSON.stringify(state.player)}`);
                }
            }
            else {
                if (state.player !== item.player) {
                    findings.push(`${item.id}: FSM player "${state.player}" is not GEARS player "${item.player}"`);
                }
                if (state.role !== undefined) {
                    findings.push(`${item.id}: historical delegated player unexpectedly carries invoke.input.role ${JSON.stringify(state.role)}`);
                }
            }
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
    const scriptItemIds = new Set(items.filter((item) => item.actor === 'script').map((item) => item.id));
    for (const state of scriptStates) {
        if (state.sourceItem === '')
            continue;
        if (!itemIds.has(state.sourceItem)) {
            findings.push(`FSM script state ${state.stateId} references unknown GEARS item ${state.sourceItem}`);
        }
        else if (!scriptItemIds.has(state.sourceItem)) {
            findings.push(`FSM script state ${state.stateId} realizes non-script GEARS item ${state.sourceItem}`);
        }
    }
    for (const state of states) {
        if (state.sourceItem !== '' && !itemIds.has(state.sourceItem)) {
            findings.push(`FSM state ${state.stateId} references unknown GEARS item ${state.sourceItem}`);
        }
        const bossReply = state.result[NEEDS_BOSS_REPLY];
        if (controller) {
            if (bossReply !== undefined) {
                findings.push(`FSM controller state ${state.stateId} unexpectedly declares ${NEEDS_BOSS_REPLY}`);
            }
        }
        else if (controllerNearMissStates.has(state)) {
            // The precise controller-domain diagnostic above owns a malformed
            // near-controller state; do not suggest adding the ordinary wait key to
            // that state, while retaining ordinary findings for every other state.
            continue;
        }
        else if (bossReply === undefined) {
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
 * Machine introspection (verification-4).
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
 * test pins (verification-4): captain bindings with result keys and every transition
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
            // Captain-binding enumeration never yields `script`; the widened
            // CaptainState union exists only for coverage-driving views.
            ...(binding.pinActor && binding.state.actor !== 'script'
                ? { actor: binding.state.actor }
                : {}),
            sourceItem: binding.state.sourceItem,
            player: binding.state.player,
            ...(binding.state.role !== undefined ? { role: binding.state.role } : {}),
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
                initial: initialStateTarget(state.initial) ?? null,
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
        initial: initialStateTarget(config.initial) ?? null,
        captain,
        quiescent,
        rootOn,
        interruptTargets,
        ...(playbook.length > 0 ? { playbook } : {}),
        ...(structured !== undefined ? { structured } : {}),
    };
}
/*
 * Prompt-contract capture and composition checks (verification-5).
 *
 * The contract is derived from the artifacts, never hand-authored: context
 * reads are traced through each state's `invoke.input` thunk with a recording
 * proxy, wiring by sentinel values, placeholders by scanning the prompt body,
 * and substitution by composing with sentinels and observing which tokens the
 * linked composer replaces. The derived facts are pinned into the emitted test
 * so contract drift fails it (DR-009).
 */
/** The historical full continuation format, retained for schema-1 and old composers. */
export const CONTINUATION_PREAMBLE = 'You previously paused this task to ask Boss a question; Boss has now replied. Continue the same task using the reply below.';
export const BOSS_QUESTION_LABEL = 'Boss question:';
export const BOSS_REPLY_LABEL = 'Boss reply:';
const CURRENT_CONTINUATION_PREAMBLE = 'Continue the same task using Boss’s reply below.';
const CURRENT_BOSS_QUESTION_LABEL = 'Your previous question:';
// Direct Captain prompts cross the callCaptain boundary and therefore must
// not acquire player-only routing or session-control text. Match the stable
// labelled form as well as natural-language variants; occurrence deltas below
// keep self-hosting prompt bodies free to quote either marker verbatim.
const PLAYER_BINDING_MARKER = /\bplayer\s+binding\b|(?:^|\n)[ \t]*player[ \t]*:[ \t]*(?=\S)/gi;
const ROLE_BINDING_MARKER = /\brole\s+binding\b|(?:^|\n)[ \t]*role[ \t]*:[ \t]*(?=\S)/gi;
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
export function probeContextReads(inputFn, 
/** The machine's initial context, so a typed field does not truncate the trace. */
initial = {}) {
    const reads = new Set();
    const context = new Proxy({ ...initial }, {
        get(target, prop) {
            if (typeof prop === 'string')
                reads.add(prop);
            return Reflect.get(target, prop);
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
// The gears2fsm-normative Boss-reply context fields: filled only on a
// continuation turn. An ordinary turn holds each at its initial shape — the
// scalar form absent, the keyed form of a parallel machine an empty record —
// so a state's input can index its own entry without meeting a shape the
// machine's context type never admits (verification-5).
const BOSS_CONTEXT_FIELDS = [
    'pendingBossQuestion',
    'bossReply',
    'pendingBossQuestions',
    'bossReplies',
];
const KEYED_BOSS_CONTEXT_FIELDS = ['pendingBossQuestions', 'bossReplies'];
function isKeyedBossRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function ordinaryContext(reads) {
    return {
        ...sentinelContext(reads.filter((field) => !BOSS_CONTEXT_FIELDS.includes(field))),
        ...Object.fromEntries(reads
            .filter((field) => KEYED_BOSS_CONTEXT_FIELDS.includes(field))
            .map((field) => [field, {}])),
    };
}
/**
 * The machine's resolved initial context (verification-5): a literal record, or
 * the config's factory resolved with the declared initial input, so a typed
 * context field an ordinary turn reads keeps its initial shape instead of a
 * string sentinel. Returns undefined when no initial snapshot can be produced
 * without running the machine — the caller then degrades to sentinels alone.
 */
function initialMachineContext(config) {
    const declared = config.context;
    if (declared === undefined)
        return {};
    if (typeof declared === 'object' && declared !== null) {
        return { ...declared };
    }
    if (typeof declared !== 'function')
        return undefined;
    try {
        const resolved = declared({
            input: {},
            spawn: () => undefined,
            self: undefined,
            event: { type: 'xstate.init' },
        });
        return typeof resolved === 'object' && resolved !== null
            ? { ...resolved }
            : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * The context an ordinary-turn probe drives an `invoke.input` thunk with: the
 * machine's initial context, overlaid with one string sentinel per traced read
 * whose initial value is absent or itself a string, with every Boss-reply
 * field at its initial shape — absent, or an empty keyed record
 * (verification-5).
 */
function ordinaryTurnContext(reads, initial, 
/** Traces the Boss-reply fields too, for wiring capture rather than a turn. */
includeBossFields = false) {
    if (initial === undefined) {
        return includeBossFields ? sentinelContext(reads) : ordinaryContext(reads);
    }
    const context = { ...initial };
    if (!includeBossFields) {
        for (const field of BOSS_CONTEXT_FIELDS) {
            if (isKeyedBossRecord(context[field]))
                context[field] = {};
            else
                delete context[field];
        }
    }
    for (const field of reads) {
        if (!includeBossFields && BOSS_CONTEXT_FIELDS.includes(field))
            continue;
        const current = context[field];
        if (current === undefined || typeof current === 'string') {
            context[field] = sentinelFor(field);
        }
    }
    return context;
}
// Input fields the composition contract itself owns: a placeholder naming one
// of them relays no runtime value, so the probe never overwrites it.
const CONTRACT_INPUT_FIELDS = [
    'prompt',
    'result',
    'stateId',
    'sourceItem',
    'role',
    'player',
    ...BOSS_CONTEXT_FIELDS,
];
/** The canonical field a `<kebab-token>` placeholder relays: its segments joined camel-case. */
function placeholderField(token) {
    const segments = token.replace(/^<|>$/g, '').split('-');
    return segments
        .map((segment, index) => index === 0
        ? segment
        : segment.charAt(0).toUpperCase() + segment.slice(1))
        .join('');
}
/**
 * Overlays one string sentinel on every placeholder-derived input field the
 * prompt relays, so a field the machine's initial context leaves empty or
 * derives through a typed value still evidences substitution (verification-5).
 * Returns the probed input and the sentinel field names it carries.
 */
function withPlaceholderValues(state, input) {
    if (typeof input !== 'object' || input === null)
        return { input, fields: [] };
    const record = input;
    const probed = { ...record };
    const fields = [];
    for (const token of placeholdersIn(state.prompt)) {
        const field = placeholderField(token);
        if (field === '' || CONTRACT_INPUT_FIELDS.includes(field))
            continue;
        if (typeof record[field] !== 'string')
            continue;
        probed[field] = sentinelFor(field);
        if (!fields.includes(field))
            fields.push(field);
    }
    return { input: probed, fields };
}
/** Every canonical local role the artifact's player states declare (verification-1). */
function declaredLocalRoles(config) {
    const roles = new Set();
    for (const state of enumerateCaptainStates(config)) {
        if (state.role !== undefined)
            roles.add(state.role);
    }
    return [...roles].sort();
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
 * (verification-5): traced context reads, sentinel-traced input wiring, and the
 * prompt body's placeholder tokens.
 */
export function capturePromptContract(config) {
    const rows = [];
    const initial = initialMachineContext(config);
    for (const binding of enumerateCaptainBindings(config)) {
        const { state, inputFn } = binding;
        if (typeof inputFn !== 'function')
            continue;
        const reads = probeContextReads(inputFn, initial);
        const wires = {};
        try {
            const input = inputFn({
                context: ordinaryTurnContext(reads, initial, true),
            });
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
            ...(state.role !== undefined ? { role: state.role } : {}),
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
 * (verification-5).
 */
export function deriveSubstitutions(config, compose, actor) {
    const out = {};
    const roles = declaredLocalRoles(config);
    const initial = initialMachineContext(config);
    for (const binding of enumerateCaptainBindings(config)) {
        const { state, inputFn } = binding;
        if (actor !== undefined && state.actor !== actor)
            continue;
        if (typeof inputFn !== 'function')
            continue;
        try {
            const reads = probeContextReads(inputFn, initial);
            const probed = withPlaceholderValues(state, inputFn({ context: ordinaryTurnContext(reads, initial) }));
            const composed = composeForState(compose, state, probed.input, roles);
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
            const promptReads = promptSentinelFields(state, reads, probed.fields, roles);
            for (const line of state.prompt.split('\n')) {
                for (const token of matchPromptBody(line, composed, promptReads)
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
/** The shared input-only portion of the canonical continuation probe. */
function probeContinuationInput(state, inputFn, initial, artifactSchema) {
    const question = sentinelFor('question');
    const reply = sentinelFor('bossReply');
    const pendingBossQuestion = {
        ...(artifactSchema === 3
            ? state.actor === 'captain'
                ? { asker: { kind: 'captain' } }
                : { asker: { kind: 'role', roleId: state.role ?? '' } }
            : { player: state.actor === 'captain' ? 'Captain' : state.player }),
        questionId: state.stateId,
        resumeStateId: state.stateId,
        sourceItem: state.sourceItem,
        question,
    };
    return {
        ...withPlaceholderValues(state, inputFn({
            context: {
                ...ordinaryTurnContext(probeContextReads(inputFn, initial), initial),
                pendingBossQuestion,
                bossReply: reply,
                pendingBossQuestions: { [state.stateId]: pendingBossQuestion },
                bossReplies: { [state.stateId]: reply },
            },
        })),
        question,
        reply,
    };
}
function continuationInputFinding(stateId, input, question, reply) {
    return !carriesSentinel(input, question) || !carriesSentinel(input, reply)
        ? `${stateId}: invoke.input does not carry pendingBossQuestion/bossReply for a continuation turn`
        : undefined;
}
/** Known-schema FSM input checks, without requiring a linked composer. */
export function checkFsmContinuationInputs(config, artifactSchema) {
    if (isControllerMachine(config))
        return [];
    const initial = initialMachineContext(config);
    const findings = [];
    for (const { state, inputFn } of enumerateCaptainBindings(config)) {
        if (typeof inputFn !== 'function' ||
            !Object.hasOwn(state.result, NEEDS_BOSS_REPLY))
            continue;
        try {
            const { input, question, reply } = probeContinuationInput(state, inputFn, initial, artifactSchema);
            const finding = continuationInputFinding(state.stateId, input, question, reply);
            if (finding !== undefined)
                findings.push(finding);
        }
        catch (error) {
            findings.push(`${state.stateId}: invoke.input threw on a continuation turn: ${messageOf(error)}`);
        }
    }
    return findings;
}
/**
 * Checks the linked composer against the link contract for every captain state
 * (verification-5), returning findings (empty when conformant): the prompt body is
 * preserved modulo substituted placeholders, the adjudicator-facing Boss-reply
 * contract never leaks into a player prompt, no continuation appears on an
 * ordinary turn, and a Boss-reply continuation turn opens with a supported exact
 * prefix. Only an explicitly resumed schema-3 player may omit the question.
 */
export function checkPromptComposition(opts) {
    const findings = [];
    const controller = isControllerMachine(opts.config);
    const roles = declaredLocalRoles(opts.config);
    const initial = initialMachineContext(opts.config);
    if (initial === undefined) {
        opts.diagnostics?.push('the machine has no resolvable initial context; ordinary-turn input is synthesized from context sentinels alone');
    }
    const schemaResolution = resolveArtifactSchemaForVerification({
        config: opts.config,
        ...(opts.artifactSchema === undefined
            ? {}
            : { artifactSchema: opts.artifactSchema }),
    });
    findings.push(...schemaResolution.findings);
    const inferredArtifactSchema = schemaResolution.artifactSchema;
    const substitutions = deriveSubstitutions(opts.config, opts.compose, opts.actor);
    const composerName = opts.actor === 'captain' ? 'composeCaptainPrompt' : 'composePlayerPrompt';
    const bindings = enumerateCaptainBindings(opts.config);
    for (const binding of bindings) {
        const { state, inputFn } = binding;
        if (opts.actor !== undefined && state.actor !== opts.actor)
            continue;
        if (typeof inputFn !== 'function')
            continue;
        const reads = probeContextReads(inputFn, initial);
        const substituted = substitutions[state.stateId] ?? [];
        const relayFindingKeys = new Set();
        const artifactSchema = schemaResolution.findings.length > 0
            ? undefined
            : (inferredArtifactSchema ??
                (state.role !== undefined ? 3 : state.player !== '' ? 1 : undefined));
        const modes = artifactSchema === 3 && state.actor === 'player'
            ? [undefined, false, true]
            : [undefined];
        let promptReads;
        for (const resuming of modes) {
            let ordinary;
            let input;
            try {
                const probed = withPlaceholderValues(state, inputFn({ context: ordinaryTurnContext(reads, initial) }));
                input = probed.input;
                promptReads = promptSentinelFields(state, reads, probed.fields, roles);
                ordinary = composeForState(opts.compose, state, probed.input, roles, resuming);
                if (typeof ordinary !== 'string') {
                    throw new Error(`${composerName} returned a non-string value`);
                }
            }
            catch (error) {
                pushUnique(findings, `${state.stateId}: ${composerName} threw on an ordinary turn: ${messageOf(error)}`);
                continue;
            }
            pushUnique(findings, ...bodyFindings(state, ordinary, substituted, promptReads, 'ordinary'), ...literalPromptRelayFindings(state, ordinary, input, substituted, promptReads, opts.compose, roles, relayFindingKeys, resuming));
            pushUnique(findings, ...promptControlFindings(state, ordinary));
            // A self-hosted playbook's domain body may legitimately quote the
            // adjudicator contract or the continuation texts (it instructs a compiler
            // about them); only occurrences the composer ADDS beyond the body's own
            // are leaks.
            if (occurrences(ordinary, BOSS_QUESTION_MARKER) >
                occurrences(state.prompt, BOSS_QUESTION_MARKER)) {
                pushUnique(findings, `${state.stateId}: the adjudicator-facing ${NEEDS_BOSS_REPLY} contract leaks into the player prompt`);
            }
            if ([
                CONTINUATION_PREAMBLE,
                CURRENT_CONTINUATION_PREAMBLE,
                BOSS_QUESTION_LABEL,
                CURRENT_BOSS_QUESTION_LABEL,
                BOSS_REPLY_LABEL,
            ].some((needle) => occurrences(ordinary, needle) > occurrences(state.prompt, needle))) {
                pushUnique(findings, `${state.stateId}: continuation blocks appear on an ordinary turn`);
            }
        }
        // Controllers own no Boss-reply wait. A missing ordinary result is already
        // diagnosed by conformance, so do not fabricate a continuation contract.
        if (controller || !Object.hasOwn(state.result, NEEDS_BOSS_REPLY))
            continue;
        if (artifactSchema === undefined) {
            findings.push(`${state.stateId}: prompt composition requires artifactSchema 1 or 3 to probe this direct-Captain continuation`);
            continue;
        }
        // Probe absent and explicit fresh modes separately: wrappers may forward
        // the optional argument incorrectly. Historical composers may ignore it
        // and keep their complete Q&A prefix even when a player resumes.
        for (const resuming of modes) {
            const question = sentinelFor('question');
            const reply = sentinelFor('bossReply');
            let continuation;
            let input;
            try {
                const probed = probeContinuationInput(state, inputFn, initial, artifactSchema);
                input = probed.input;
                promptReads = promptSentinelFields(state, reads, probed.fields, roles);
                continuation = composeForState(opts.compose, state, input, roles, resuming);
                if (typeof continuation !== 'string') {
                    throw new Error(`${composerName} returned a non-string value`);
                }
            }
            catch (error) {
                pushUnique(findings, `${state.stateId}: ${composerName} threw on a continuation turn: ${messageOf(error)}`);
                continue;
            }
            const inputFinding = continuationInputFinding(state.stateId, input, question, reply);
            if (inputFinding !== undefined) {
                pushUnique(findings, inputFinding);
                continue;
            }
            pushUnique(findings, ...continuationPrefixFindings(state, continuation, substituted, promptReads, artifactSchema, resuming, question, reply), ...bodyFindings(state, continuation, substituted, promptReads, 'continuation'), ...promptControlFindings(state, continuation), ...literalPromptRelayFindings(state, continuation, input, substituted, promptReads, opts.compose, roles, relayFindingKeys, resuming));
        }
    }
    return findings;
}
function promptSentinelFields(state, reads, placeholderFields, declaredRoles) {
    const fields = [...reads, ...placeholderFields];
    return state.role === undefined
        ? fields
        : [...fields, ...declaredRoles.map((role) => `promptIdentity:${role}`)];
}
function composeForState(compose, state, input, declaredRoles, resuming) {
    // Schema-1 composers and the shared default composer use their second
    // positional argument as a placeholder-field map. A callable proxy with a
    // property-clean view is therefore both an invocation-scoped schema-3 lookup
    // and an empty map to historical/default composition, without Function.name,
    // Function.length, or Function.prototype token collisions.
    const lookup = (roleId) => {
        if (state.role === undefined) {
            throw new Error(`prompt identity lookup used role ${JSON.stringify(roleId)} for a direct-Captain or historical state`);
        }
        // A prompt may name any declared role's identity — a Coder prompt reaches
        // the Reviewer's `<reviewer-llm>` — so only an undeclared role is drift
        // (link.md, "Player prompt composition").
        if (!declaredRoles.includes(roleId)) {
            throw new Error(`prompt identity lookup used undeclared role ${JSON.stringify(roleId)}; the artifact declares ${JSON.stringify(declaredRoles)}`);
        }
        return sentinelFor(`promptIdentity:${roleId}`);
    };
    const promptIdentity = new Proxy(lookup, {
        get: () => undefined,
        has: () => false,
        ownKeys: () => [],
        getOwnPropertyDescriptor: () => undefined,
    });
    return state.actor === 'player' && state.role !== undefined
        ? resuming === undefined
            ? compose(input, promptIdentity)
            : compose(input, promptIdentity, resuming)
        : compose(input);
}
function continuationPrefixFindings(state, composed, substituted, reads, artifactSchema, resuming, question, reply) {
    const fullProfiles = [
        { preamble: CONTINUATION_PREAMBLE, questionLabel: BOSS_QUESTION_LABEL },
        ...(artifactSchema === 3
            ? [
                {
                    preamble: CURRENT_CONTINUATION_PREAMBLE,
                    questionLabel: CURRENT_BOSS_QUESTION_LABEL,
                },
            ]
            : []),
    ];
    const compactAllowed = artifactSchema === 3 && state.actor === 'player' && resuming === true;
    const replyBlock = `${BOSS_REPLY_LABEL}\n${reply}`;
    const prefixes = fullProfiles.map(({ preamble, questionLabel }) => `${preamble}\n\n${questionLabel}\n${question}\n\n${replyBlock}\n\n`);
    const compactPrefix = `${CURRENT_CONTINUATION_PREAMBLE}\n\n${replyBlock}\n\n`;
    const compact = compactAllowed && composed.startsWith(compactPrefix);
    if (compactAllowed)
        prefixes.push(compactPrefix);
    const findings = [];
    if (compact &&
        [BOSS_QUESTION_LABEL, CURRENT_BOSS_QUESTION_LABEL].some((label) => occurrences(composed, `${label}\n${question}`) >
            occurrences(state.prompt, `${label}\n${question}`))) {
        findings.push(`${state.stateId}: a compact continuation adds the Boss question outside its domain prompt body`);
    }
    if (!fullProfiles.some(({ preamble }) => composed.startsWith(`${preamble}\n\n`))) {
        findings.push(`${state.stateId}: a continuation turn does not open with the exact preamble`);
    }
    // Select diagnostics by the observed full format, without permitting a
    // hybrid label or using function arity/package versions as capability evidence.
    const profile = fullProfiles.find(({ preamble }) => composed.startsWith(`${preamble}\n\n`)) ?? fullProfiles[0];
    const blocks = [
        ...(!compact
            ? [[profile.questionLabel, `${profile.questionLabel}\n${question}`]]
            : []),
        [BOSS_REPLY_LABEL, replyBlock],
    ];
    const bodyStart = bodyIndex(state, composed, substituted, reads);
    for (const [label, value] of blocks) {
        // Authored domain text can itself quote the framework contract; a real
        // continuation must add its own sentinel-bearing blocks before that body.
        if (occurrences(composed, value) <= occurrences(state.prompt, value)) {
            findings.push(`${state.stateId}: a continuation turn lacks the "${label}" block`);
        }
        else if (bodyStart !== -1 && composed.indexOf(value) > bodyStart) {
            findings.push(`${state.stateId}: the "${label}" block appears after the domain prompt body`);
        }
    }
    if (!prefixes.some((prefix) => composed.startsWith(prefix))) {
        findings.push(`${state.stateId}: a continuation turn does not preserve the exact ordered Boss question/reply blocks`);
    }
    return findings;
}
function promptControlFindings(state, composed) {
    const findings = [];
    const introducesPlayerBinding = patternOccurrences(composed, PLAYER_BINDING_MARKER) >
        patternOccurrences(state.prompt, PLAYER_BINDING_MARKER);
    if (state.actor === 'captain' && introducesPlayerBinding) {
        findings.push(`${state.stateId}: composeCaptainPrompt introduces a player binding into a direct-Captain prompt`);
    }
    else if (state.role !== undefined && introducesPlayerBinding) {
        findings.push(`${state.stateId}: composePlayerPrompt exposes a concrete player binding in a schema-3 delegated-role prompt`);
    }
    if (state.actor === 'captain' &&
        patternOccurrences(composed, ROLE_BINDING_MARKER) >
            patternOccurrences(state.prompt, ROLE_BINDING_MARKER)) {
        findings.push(`${state.stateId}: composeCaptainPrompt introduces a role binding into a direct-Captain prompt`);
    }
    if (state.actor === 'captain' &&
        patternOccurrences(composed, PLAYER_RESUME_MARKER) >
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
/**
 * Finds the prompt body as one exact, line-bounded block inside a composed
 * prompt. In derivation mode, a placeholder may remain literal or be replaced
 * by one exact non-empty context sentinel; mixed replacement of repeated
 * tokens is rejected. With `expectedSubstitutions`, substituted positions must
 * carry a sentinel and every other placeholder must remain literal.
 */
function matchPromptBody(prompt, composed, reads, expectedSubstitutions) {
    const placeholderMatches = [...prompt.matchAll(PLACEHOLDER)];
    const sentinels = reads.map(sentinelFor);
    const sentinelForms = sentinels.flatMap((sentinel) => [
        sentinel,
        JSON.stringify(sentinel),
    ]);
    // Decompose the prompt into literal segments separated by placeholders, then
    // scan the composed text segment by segment. A monolithic escaped regex over
    // a meta-scale prompt exceeds the engine's pattern-size limit, so matching
    // is plain string comparison over a finite candidate set at each gap.
    const segments = [];
    const tokens = [];
    let offset = 0;
    for (const match of placeholderMatches) {
        segments.push(prompt.slice(offset, match.index));
        tokens.push(match[0]);
        offset = match.index + match[0].length;
    }
    segments.push(prompt.slice(offset));
    const tryFrom = (start) => {
        if (!composed.startsWith(segments[0], start))
            return null;
        let pos = start + segments[0].length;
        const values = [];
        for (let gap = 0; gap < tokens.length; gap++) {
            const token = tokens[gap];
            const candidates = expectedSubstitutions === undefined
                ? [token, ...sentinelForms]
                : expectedSubstitutions.includes(token)
                    ? sentinelForms
                    : [token];
            const next = segments[gap + 1];
            const chosen = candidates.find((candidate) => composed.startsWith(candidate, pos) &&
                composed.startsWith(next, pos + candidate.length));
            if (chosen === undefined)
                return null;
            values.push(chosen);
            pos += chosen.length + next.length;
        }
        if (pos !== composed.length && composed[pos] !== '\n')
            return null;
        return { end: pos, values };
    };
    for (let start = 0; start <= composed.length; start++) {
        if (start !== 0 && composed[start - 1] !== '\n')
            continue;
        const attempt = tryFrom(start);
        if (attempt === null)
            continue;
        if (expectedSubstitutions !== undefined) {
            return {
                index: start,
                end: attempt.end,
                substitutions: [...expectedSubstitutions],
                values: attempt.values,
            };
        }
        const modes = new Map();
        for (let gap = 0; gap < tokens.length; gap++) {
            const token = tokens[gap];
            const tokenModes = modes.get(token) ?? new Set();
            tokenModes.add(attempt.values[gap] === token ? 'literal' : 'sentinel');
            modes.set(token, tokenModes);
        }
        if ([...modes.values()].some((tokenModes) => tokenModes.size > 1)) {
            continue;
        }
        const substitutions = placeholdersIn(prompt).filter((token) => modes.get(token)?.has('sentinel') === true);
        return {
            index: start,
            end: attempt.end,
            substitutions,
            values: attempt.values,
        };
    }
    return null;
}
/** Probe observed string relays without inventing context fields or input shapes. */
function literalPromptRelayFindings(state, composed, input, substituted, reads, compose, roles, findingKeys, resuming) {
    if (typeof input !== 'object' || input === null)
        return [];
    const match = matchPromptBody(state.prompt, composed, reads, substituted);
    if (match === null)
        return []; // Existing body diagnostics own this case.
    const tokens = [...state.prompt.matchAll(PLACEHOLDER)];
    const groups = new Map();
    for (const [field, value] of Object.entries(input)) {
        if (CONTRACT_INPUT_FIELDS.includes(field) ||
            typeof value !== 'string' ||
            roles.some((role) => value === sentinelFor(`promptIdentity:${role}`)) ||
            !match.values.some((matched, index) => matched === value && substituted.includes(tokens[index][0])) ||
            match.values.includes(JSON.stringify(value)))
            continue;
        // Equal values may be intentional aliases. Changing them together avoids
        // guessing which of several indistinguishable fields supplied the token.
        const fields = groups.get(value) ?? [];
        fields.push(field);
        groups.set(value, fields);
    }
    if (groups.size === 0)
        return [];
    const quotedGroups = new Set([...groups.keys()].filter((value) => tokens.every((token, index) => {
        if (match.values[index] !== value)
            return true;
        const start = state.prompt.lastIndexOf('\n', token.index - 1) + 1;
        const next = state.prompt.indexOf('\n', token.index);
        const line = state.prompt
            .slice(start, next < 0 ? undefined : next)
            .replace(/\r$/, '');
        return /^> [^<>\r\n]*(<[^\s<>`]{1,60}>)$/.exec(line)?.[1] === token[0];
    })));
    const findings = [];
    for (const multiline of [false, true]) {
        const values = new Map();
        for (const [index, value] of [...groups.keys()].entries()) {
            if (multiline && !quotedGroups.has(value))
                continue;
            const literal = `relay-${index}: $& $$ $\` $' ${placeholdersIn(state.prompt).join(' ')}`;
            // No empty-line policy is inferred here; all segments are nonempty.
            values.set(value, multiline ? `${literal}\nsecond-${index}\r\nthird-${index}` : literal);
        }
        if (values.size === 0)
            continue;
        const probed = { ...input };
        for (const [value, replacement] of values) {
            for (const field of groups.get(value))
                probed[field] = replacement;
        }
        let index = 0;
        const body = state.prompt.replace(PLACEHOLDER, () => {
            const value = match.values[index++];
            const replacement = values.get(value);
            return replacement === undefined
                ? value
                : multiline
                    ? replacement.replace(/\n/g, '\n> ')
                    : replacement;
        });
        const expected = composed.slice(0, match.index) + body + composed.slice(match.end);
        const label = multiline
            ? 'multiline quoted-relay'
            : 'single-pass literal-relay';
        const key = `${state.stateId}:${label}`;
        const prefix = `${state.stateId}: prompt composition does not preserve ${label} text`;
        try {
            const actual = composeForState(compose, state, probed, roles, resuming);
            if (actual === expected)
                continue;
            pushRelayFinding(findings, findingKeys, key, `${prefix}; probe preserves literal text and LF/CRLF separators/quote markers; ${firstDifferenceDiagnostic(expected, actual)}`);
        }
        catch {
            // One state/representation diagnostic also covers mode-dependent errors.
            pushRelayFinding(findings, findingKeys, key, prefix);
        }
    }
    return findings;
}
function pushRelayFinding(findings, findingKeys, key, finding) {
    if (findingKeys.has(key))
        return;
    findingKeys.add(key);
    findings.push(finding);
}
function firstDifferenceDiagnostic(expected, actual) {
    let offset = 0;
    const length = Math.max(expected.length, actual.length);
    while (offset < length && expected[offset] === actual[offset])
        offset++;
    return `first difference at UTF-16 offset ${offset}: expected ${boundedJsonSnippet(expected, offset)}, actual ${boundedJsonSnippet(actual, offset)}`;
}
function boundedJsonSnippet(value, offset) {
    if (offset >= value.length)
        return '<end>';
    return JSON.stringify(value.slice(offset, offset + 24));
}
/** Verify the FSM-owned composer; child inputs reach the bridge already rendered. */
function literalPlaybookTextFinding(prompt, binding, initial) {
    const input = binding.invoke.input;
    // Only explicit quoted relay notation establishes required runtime slots.
    // Domain metavariables and inline-code examples remain literal template text.
    const requiredRelays = new Set(prompt.split(/\r?\n/).flatMap((line) => {
        const token = /^> (?:[^<>\r\n]+: )?(<[^\s<>`]{1,60}>)$/.exec(line)?.[1];
        return token === undefined ? [] : [token];
    }));
    const unresolvedRelay = (token) => `leaves quoted child-input relay ${token} unresolved`;
    if (typeof input !== 'function') {
        if (binding.state.text !== prompt)
            return 'does not preserve the complete GEARS child-input template';
        const token = requiredRelays.values().next().value;
        return token === undefined ? undefined : unresolvedRelay(token);
    }
    const base = initial ?? {};
    const fields = new Set();
    let context = { ...base };
    // Later reads can be behind a string-valued branch. Discover them without
    // overwriting an initialized object, array, boolean, or numeric context field.
    for (let pass = 0; pass < 4; pass++) {
        const before = fields.size;
        for (const field of probeContextReads(input, context)) {
            if (base[field] === undefined || typeof base[field] === 'string')
                fields.add(field);
        }
        if (fields.size > 128)
            return 'has unsupported composition (too many scalar reads)';
        context = {
            ...base,
            ...Object.fromEntries([...fields].map((field) => [field, sentinelFor(field)])),
        };
        if (fields.size === before)
            break;
        if (pass === 3)
            return 'has unsupported composition (context reads did not stabilize)';
    }
    const probe = (values) => {
        const result = invocationInput(binding.invoke, values);
        return 'value' in result &&
            result.value.playbookId === binding.state.playbookId &&
            result.value.stateId === binding.state.stateId &&
            typeof result.value.text === 'string'
            ? result.value.text
            : undefined;
    };
    const text = probe(context);
    if (text === undefined)
        return 'has unsupported composition (input evaluation or literal identity changed)';
    const matched = matchPromptBody(prompt, text, [...fields]);
    if (matched === null || matched.index !== 0 || matched.end !== text.length) {
        return 'does not preserve the complete GEARS child-input template';
    }
    const tokens = [...prompt.matchAll(PLACEHOLDER)].map((match) => match[0]);
    const mapping = new Map();
    const observed = new Map();
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index], value = matched.values[index];
        if (observed.has(token) && observed.get(token) !== value) {
            return `uses inconsistent context substitutions for ${token}`;
        }
        observed.set(token, value);
        if (value === token) {
            if (requiredRelays.has(token))
                return unresolvedRelay(token);
            continue;
        }
        const field = [...fields].find((name) => value === sentinelFor(name));
        if (field === undefined)
            return `has unsupported composition for ${token}`;
        mapping.set(token, { field });
    }
    // A source-labelled complete relay can carry arbitrary prose. Inline slots
    // can instead be constrained identifiers (for example a commit identity),
    // so do not invent multiline identifier inputs merely because TS erased the
    // narrower domain contract. Neither decision depends on the field's name.
    const multilineFields = new Set();
    for (const line of prompt.split(/\r?\n/)) {
        const token = /^> [^<>\r\n]*(<[^\s<>`]{1,60}>)$/.exec(line)?.[1];
        const field = token === undefined ? undefined : mapping.get(token)?.field;
        if (field !== undefined)
            multilineFields.add(field);
    }
    const payloads = Object.fromEntries([...fields].map((field) => [
        field,
        `«${field}:literal» $& $$ $\x60 $' ${[...new Set(tokens)].join(' ')}` +
            (multilineFields.has(field) ? `\n\n«${field}:second»` : ''),
    ]));
    const render = (values) => {
        // Only the source-defined standalone relay form owns empty-line removal.
        const template = prompt
            .split(/(?<=\n)/)
            .filter((line) => {
            const token = /^> (<[^\s<>`]{1,60}>)(?:\r?\n)?$/.exec(line)?.[1];
            const mapped = token === undefined ? undefined : mapping.get(token);
            return mapped === undefined || values[mapped.field] !== '';
        })
            .join('');
        return template.replace(PLACEHOLDER, (token, offset) => {
            const mapped = mapping.get(token);
            if (mapped === undefined)
                return token;
            const value = values[mapped.field];
            const lineStart = template.lastIndexOf('\n', offset - 1) + 1;
            return template.startsWith('> ', lineStart)
                ? value.replace(/\r?\n/g, (separator) => `${separator}> `)
                : value;
        });
    };
    const composed = probe({ ...base, ...payloads });
    if (composed === undefined || composed !== render(payloads)) {
        return 'does not preserve literal substitutions and quoted continuation lines';
    }
    const emptyFields = new Set();
    for (const line of prompt.split(/\r?\n/)) {
        const token = /^> (<[^\s<>`]{1,60}>)$/.exec(line)?.[1];
        const field = token === undefined ? undefined : mapping.get(token)?.field;
        if (field !== undefined)
            emptyFields.add(field);
    }
    if (emptyFields.size > 0) {
        const values = {
            ...payloads,
            ...Object.fromEntries([...emptyFields].map((field) => [field, ''])),
        };
        const emptyText = probe({ ...base, ...values });
        if (emptyText === undefined || emptyText !== render(values)) {
            return 'does not preserve source-defined empty standalone relay omission';
        }
    }
    return undefined;
}
/** Findings when a composed prompt does not preserve the domain body (verification-5). */
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
// Local copy: this module is copied verbatim beside the artifact (verification-12),
// so it may not import a sibling module.
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
/** Reads the schema-3 cohort declaration from an imported FSM module. */
export function findConcurrentRoleSets(fsmModule) {
    if (typeof fsmModule !== 'object' || fsmModule === null)
        return undefined;
    return fsmModule.concurrentRoleSets;
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

// Generated by slc (DR-009): GEARS↔FSM conformance.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { checkGearsFsmConformance, findConcurrentRoleSets, findMachineConfig } from ${sourceString(opts.verifyModule)};
import * as fsm from ${sourceString(opts.fsmModule)};

const SCHEMA_FINDINGS: readonly string[] = ${JSON.stringify(opts.schemaFindings ?? [], null, 2)};

describe(${sourceString(`${opts.basename}: GEARS↔FSM conformance`)}, () => {
  it('uses consistent artifact-schema evidence', () => {
    expect(SCHEMA_FINDINGS).toEqual([]);
  });

  it('maps every GEARS item to a state with its player and verbatim prompt', () => {
    const gears = readFileSync(
      fileURLToPath(new URL(${sourceString(opts.gearsFile)}, import.meta.url)),
      'utf8',
    );
    expect(
      checkGearsFsmConformance(gears, findMachineConfig(fsm), {
        concurrentRoleSets: findConcurrentRoleSets(fsm),
        ${opts.artifactSchema === undefined
        ? ''
        : `artifactSchema: ${opts.artifactSchema},`}
      }),
    ).toEqual([]);
  });
});
`;
}
/**
 * Emits the GEARS↔FSM conformance test as `slc` output beside a compiled
 * `playbook` artifact: writes `<basename>.gears-fsm.test.ts` into the artifact
 * directory (`<basename>.playbook/`), wiring the artifact's `gears` file and its
 * `fsm` module's machine to the checker, and returns the written path (verification-2;
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
        ...(opts.artifactSchema === undefined
            ? {}
            : { artifactSchema: opts.artifactSchema }),
        schemaFindings: opts.schemaFindings,
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
 * Imports generated linked TypeScript for emission-time, standalone, or
 * equivalence review before its sibling FSM has been built to JavaScript.
 * NodeNext source correctly names the runtime-safe `./<basename>.fsm.js` edge,
 * but review may run while only `./<basename>.fsm.ts` exists. Stage a
 * same-directory copy whose one generated module specifier points at the
 * hashed TypeScript artifact, import that copy, and remove it without changing
 * the linked source or its production import.
 */
export async function loadLinkedModuleForVerification(opts) {
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
 * drifts from the topology pinned at build time (verification-4).
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

const PINNED = ${JSON.stringify(opts.pins, null, 2)} as const;

describe(${sourceString(`${opts.basename}: FSM introspection`)}, () => {
  it('matches the machine topology pinned at build time', () => {
    expect(pinIntrospection(findMachineConfig(fsm))).toEqual(PINNED);
  });
});
`;
}
/**
 * Builds a per-artifact vitest module pinning the prompt contract derived from
 * the artifacts at build time (verification-5): the per-state context reads, input
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
const ${constant} = ${JSON.stringify(substituted, null, 2)} as const;

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
        ${opts.artifactSchema === undefined
                ? ''
                : `artifactSchema: ${opts.artifactSchema},`}
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
const CONTRACT = ${JSON.stringify(opts.rows, null, 2)} as const;
const SCHEMA_FINDINGS: readonly string[] = ${JSON.stringify(opts.schemaFindings ?? [], null, 2)};

describe(${sourceString(`${opts.basename}: prompt contract`)}, () => {
  it('uses consistent artifact-schema evidence', () => {
    expect(SCHEMA_FINDINGS).toEqual([]);
  });

  it('matches the prompt contract pinned at build time', () => {
    expect(capturePromptContract(findMachineConfig(fsm))).toEqual(CONTRACT);
  });
${composerBlock}});
`;
}
function promptArtifactSchemaSignalsFromConfig(config) {
    const states = enumerateCaptainStates(config);
    return {
        schema1: states.some(({ player }) => player !== ''),
        schema3: isControllerMachine(config) ||
            states.some(({ role }) => role !== undefined),
    };
}
function linkedArtifactSchemaSignal(linked) {
    const factory = linked.default;
    if (typeof factory !== 'function') {
        return { historicalFallback: false, invalidCompatibility: false };
    }
    if (!Object.hasOwn(factory, 'compat')) {
        return { historicalFallback: true, invalidCompatibility: false };
    }
    const descriptor = Object.getOwnPropertyDescriptor(factory, 'compat');
    if (descriptor === undefined ||
        !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true ||
        descriptor.writable !== false ||
        descriptor.configurable !== false) {
        return { historicalFallback: false, invalidCompatibility: true };
    }
    const compat = descriptor.value;
    if (typeof compat !== 'object' ||
        compat === null ||
        Array.isArray(compat) ||
        Object.getPrototypeOf(compat) !== Object.prototype ||
        !Object.isFrozen(compat) ||
        Object.getOwnPropertySymbols(compat).length !== 0) {
        return { historicalFallback: false, invalidCompatibility: true };
    }
    const names = Object.getOwnPropertyNames(compat);
    const artifactSchema = Object.getOwnPropertyDescriptor(compat, 'artifactSchema');
    const runtimeAbi = Object.getOwnPropertyDescriptor(compat, 'runtimeAbi');
    const exact = names.length === 2 &&
        names.includes('artifactSchema') &&
        names.includes('runtimeAbi') &&
        artifactSchema?.enumerable === true &&
        Object.hasOwn(artifactSchema, 'value') &&
        artifactSchema.value === 3 &&
        runtimeAbi?.enumerable === true &&
        Object.hasOwn(runtimeAbi, 'value') &&
        runtimeAbi.value === 1;
    return exact
        ? { schema: 3, historicalFallback: false, invalidCompatibility: false }
        : { historicalFallback: false, invalidCompatibility: true };
}
/**
 * Schema decision shared by generated and standalone artifact verification
 * (verification-21). Reviewed provenance is evidence through its exact
 * historical map; any other provenance is evidence only through the engine
 * declaration read from the link target's installed package — `RUNTIME_ABI`
 * `1` with artifact schema `3` — and is otherwise reported unsupported
 * (DR-028).
 */
export function resolveArtifactSchemaForVerification(opts) {
    const candidates = [];
    const invalidSignalFindings = [];
    if (opts.artifactSchema !== undefined) {
        candidates.push({
            source: 'review-supplied artifact schema',
            schema: opts.artifactSchema,
        });
    }
    const provenance = opts.provenance ?? opts.runtimeDeclaration?.provenance;
    const provenanceSchema = artifactSchemaForPlaybookProvenance(provenance);
    if (provenanceSchema !== undefined) {
        candidates.push({
            source: 'reviewed link-target provenance',
            schema: provenanceSchema,
        });
    }
    else if (provenance !== undefined) {
        if (opts.runtimeDeclaration === undefined) {
            invalidSignalFindings.push(`artifact schema has unsupported link-target provenance ${JSON.stringify(provenance)}`);
        }
        else if (declaresComposedV3(opts.runtimeDeclaration)) {
            candidates.push({ source: 'declared link-target contract', schema: 3 });
        }
        else {
            invalidSignalFindings.push(`artifact schema has an unsupported link-target contract: ${describeRuntimeDeclaration(opts.runtimeDeclaration)}`);
        }
    }
    if (opts.config !== undefined) {
        const configSignals = promptArtifactSchemaSignalsFromConfig(opts.config);
        if (configSignals.schema1)
            candidates.push({ source: 'FSM historical-player structure', schema: 1 });
        if (configSignals.schema3)
            candidates.push({ source: 'FSM role/controller structure', schema: 3 });
    }
    const linkedSignal = opts.linked === undefined
        ? undefined
        : linkedArtifactSchemaSignal(opts.linked);
    if (linkedSignal?.schema !== undefined) {
        candidates.push({
            source: 'linked factory compatibility',
            schema: linkedSignal.schema,
        });
    }
    if (linkedSignal?.invalidCompatibility) {
        invalidSignalFindings.push('linked factory has an own compatibility declaration that is not exact immutable schema 3/runtime ABI 1');
    }
    if (invalidSignalFindings.length > 0) {
        return { findings: invalidSignalFindings };
    }
    const schemas = new Set(candidates.map(({ schema }) => schema));
    if (schemas.size > 1) {
        return {
            findings: [
                `artifact schema signals disagree (${candidates
                    .map(({ source, schema }) => `${source}: ${schema}`)
                    .join(', ')})`,
            ],
        };
    }
    const [artifactSchema] = schemas;
    if (artifactSchema !== undefined) {
        return { artifactSchema, findings: [] };
    }
    if (linkedSignal?.historicalFallback) {
        return { artifactSchema: 1, findings: [] };
    }
    const hasAmbiguousCaptainContinuation = opts.requireContinuationSchema !== false &&
        opts.config !== undefined &&
        enumerateCaptainStates(opts.config).some((state) => state.actor === 'captain' &&
            Object.hasOwn(state.result, NEEDS_BOSS_REPLY));
    return hasAmbiguousCaptainContinuation
        ? {
            findings: [
                'artifact schema has no reviewed provenance, generation-specific actor structure, or callable linked factory for a direct-Captain continuation',
            ],
        }
        : { findings: [] };
}
/** The `_internal` composer export serving one state actor (verification-5). */
const COMPOSER_EXPORTS = {
    captain: 'composeCaptainPrompt',
    player: 'composePlayerPrompt',
};
/**
 * Runs the deterministic prompt-contract checks over one live linked module
 * beside its FSM (verification-5, verification-27): the module imports through
 * the ephemeral TypeScript FSM edge, its schema evidence reconciles, and every
 * actor the machine invokes has a composer that honors the link contract.
 *
 * Shared by the emitted suite's generator, which pins the derived substitutions
 * and degrades each observation to a diagnostic, and by the link-fidelity gate,
 * which relays the same observations as findings — so the gate adds no check of
 * its own (DR-030).
 */
async function inspectLinkedPromptContract(opts) {
    const { config, evidence } = opts;
    const withoutModule = (extra) => {
        const resolution = resolveArtifactSchemaForVerification({
            config,
            ...evidence,
        });
        return {
            ...(resolution.artifactSchema === undefined
                ? {}
                : { artifactSchema: resolution.artifactSchema }),
            schemaFindings: resolution.findings,
            present: true,
            composers: [],
            ...extra,
        };
    };
    if (!existsSync(opts.linkedPath))
        return withoutModule({ present: false });
    let linked;
    try {
        linked = (await loadLinkedModuleForVerification({
            linkedPath: opts.linkedPath,
            fsmPath: opts.fsmPath,
        }));
    }
    catch (error) {
        return withoutModule({ loadError: messageOf(error) });
    }
    const resolution = resolveArtifactSchemaForVerification({
        config,
        linked,
        ...evidence,
    });
    const artifactSchema = resolution.artifactSchema;
    const actors = new Set(enumerateCaptainStates(config).map(({ actor }) => actor));
    const composers = [];
    for (const actor of ['captain', 'player']) {
        if (!actors.has(actor))
            continue;
        const exportName = COMPOSER_EXPORTS[actor];
        const compose = linked._internal?.[exportName];
        if (typeof compose !== 'function') {
            composers.push({ actor, exportName, findings: [], diagnostics: [] });
            continue;
        }
        const typedCompose = compose;
        const diagnostics = [];
        composers.push({
            actor,
            exportName,
            substitutions: deriveSubstitutions(config, typedCompose, actor),
            findings: checkPromptComposition({
                config,
                compose: typedCompose,
                actor,
                ...(artifactSchema === undefined ? {} : { artifactSchema }),
                diagnostics,
            }),
            diagnostics,
        });
    }
    return {
        ...(artifactSchema === undefined ? {} : { artifactSchema }),
        schemaFindings: resolution.findings,
        present: true,
        composers,
    };
}
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
export async function checkLinkedModuleContract(opts) {
    if (!existsSync(opts.linkedPath) || !existsSync(opts.fsmPath))
        return [];
    let config;
    try {
        config = findMachineConfig(await loadFsmModule(opts.fsmPath));
    }
    catch {
        return [];
    }
    const contract = await inspectLinkedPromptContract({
        config,
        linkedPath: opts.linkedPath,
        fsmPath: opts.fsmPath,
        evidence: {},
    });
    const findings = [...contract.schemaFindings];
    if (contract.loadError !== undefined) {
        findings.push(`linked module could not be imported: ${contract.loadError}`);
        return findings;
    }
    // A module exposing no matching composer degrades exactly as emission does
    // (verification-5): the suite asserts nothing about it, so neither does the
    // gate that reuses the suite's checks.
    for (const composer of contract.composers) {
        findings.push(...composer.findings);
    }
    return findings;
}
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
export async function emitPromptContractTest(opts) {
    const diagnostics = [];
    const fsmPath = join(opts.artifactDir, `${opts.basename}.fsm.ts`);
    const config = findMachineConfig(await loadFsmModule(fsmPath));
    const rows = capturePromptContract(config);
    const evidence = {
        ...(opts.provenance === undefined ? {} : { provenance: opts.provenance }),
        ...(opts.runtimeDeclaration === undefined
            ? {}
            : { runtimeDeclaration: opts.runtimeDeclaration }),
        ...(opts.artifactSchema === undefined
            ? {}
            : { artifactSchema: opts.artifactSchema }),
    };
    const contract = await inspectLinkedPromptContract({
        config,
        linkedPath: join(opts.artifactDir, `${opts.basename}.playbook.ts`),
        fsmPath,
        evidence,
    });
    const artifactSchema = contract.artifactSchema;
    if (contract.loadError !== undefined) {
        diagnostics.push(`prompt contract: linked module could not be imported (${contract.loadError}); composition checks not emitted`);
    }
    const substitutions = {};
    for (const inspected of contract.composers) {
        if (inspected.substitutions === undefined) {
            diagnostics.push(`prompt contract: linked module exposes no _internal.${inspected.exportName}; ${inspected.actor} composition checks not emitted`);
            continue;
        }
        substitutions[inspected.actor] = inspected.substitutions;
        diagnostics.push(...inspected.diagnostics.map((diagnostic) => `prompt contract: ${diagnostic}`), ...inspected.findings.map((finding) => `prompt contract: ${finding}`));
    }
    const composer = substitutions.captain !== undefined || substitutions.player !== undefined
        ? {
            playbookModule: `./${opts.basename}.playbook.js`,
            ...substitutions,
        }
        : undefined;
    diagnostics.unshift(...contract.schemaFindings.map((finding) => `prompt contract: ${finding}`));
    const content = generatePromptContractTest({
        basename: opts.basename,
        fsmModule: `./${opts.basename}.fsm.js`,
        verifyModule: opts.verifyModule ?? VERIFY_MODULE,
        rows,
        ...(artifactSchema === undefined ? {} : { artifactSchema }),
        schemaFindings: contract.schemaFindings,
        composer,
    });
    await mkdir(opts.artifactDir, { recursive: true });
    const path = join(opts.artifactDir, `${opts.basename}.prompt-contract.test.ts`);
    await writeFile(path, content);
    return { path, diagnostics };
}
/**
 * Emits the introspection test beside a compiled `playbook` artifact
 * (verification-4): derives topology pins from the physical `<basename>.fsm.ts`,
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
// Transition-coverage verification (verification-6) lives in its own module — it
// depends on `xstate` to drive the machine — and is re-exported here so every
// generated test imports one checker module (`@sublang/slc/verify`).
export * from './verify-coverage.js';
