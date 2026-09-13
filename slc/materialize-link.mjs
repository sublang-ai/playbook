#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Optional compiler tool, not an interpreter. The complete link.md contract
// and emitted conformance checks still govern every generated artifact.
import { createRequire } from 'node:module';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, extname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Compile-time source only; emitted modules depend only on the shared engine.
function quotedPlayerSource(placeholderFields, continuationMode) {
  return `function composePlayerPrompt(input: PlaybookPlayerInput, _identity?: unknown${continuationMode ? ', resuming = false' : ''}): string {
  const fields = input as unknown as Readonly<Record<string, unknown>>;
  const mapping: Readonly<Record<string, string>> = ${JSON.stringify(placeholderFields)};
  const body = input.prompt.replace(
    /^> <(#|[A-Za-z_$][A-Za-z0-9_$-]*)>(\\r?\\n|$)|<(#|[A-Za-z_$][A-Za-z0-9_$-]*)>/gm,
    (match: string, quoted: string | undefined, ending: string | undefined, inline: string | undefined): string => {
      const token = quoted ?? inline!;
      const field = mapping[token] ?? (token === '#' ? 'irNumber' : token.replace(/-([A-Za-z0-9])/g, (_match: string, next: string) => next.toUpperCase()));
      const value = fields[field];
      if (typeof value !== 'string') return match;
      if (quoted === undefined) return value;
      if (value === '') return '';
      return value.split(/(\\r?\\n)/).map((part, index) => index % 2 === 0 && part !== '' ? '> ' + part : part).join('') + (ending ?? '');
    },
  );
  // The shared composer supplies only the continuation prefix; rendered values
  // never reenter substitution and the original PlayerInput remains unchanged.
  return defaultComposePlayerPrompt({ ...input, prompt: '' }, mapping${continuationMode ? ', resuming' : ''}) + body;
}
`;
}

function labelledPlayerSource(descriptor) {
  return `function renderPlayerPrompt(input: SourcePlayerInput, promptIdentity: XStatePromptIdentity, resuming = false): string {
  const fields = input as unknown as Readonly<Record<string, unknown>>;
  const mapping: Readonly<Record<string, string>> = ${JSON.stringify(descriptor.placeholderFields)};
  const identities: Readonly<Record<string, string>> = ${JSON.stringify(descriptor.identityPlaceholders)};
  const omitted = new Set<string>(${JSON.stringify(descriptor.omitEmptyRelayLines)});
  const fieldFor = (token: string): string => Object.hasOwn(mapping, token) ? mapping[token]! : (token === '#' ? 'irNumber' : token.replace(/-([A-Za-z0-9_$])/g, (_match: string, next: string) => next.toUpperCase()));
  const parts = input.prompt.split(/(\\r?\\n)/);
  let body = '';
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!;
    if (omitted.has(line)) {
      const token = /<(#|[A-Za-z_$][A-Za-z0-9_$-]*)>$/.exec(line)![1]!;
      if (fields[fieldFor(token)] === '') continue;
    }
    body += line.replace(/<(#|[A-Za-z_$][A-Za-z0-9_$-]*)>/g, (match: string, token: string): string => {
      const value = Object.hasOwn(identities, token) ? promptIdentity(identities[token]!) : fields[fieldFor(token)];
      if (typeof value !== 'string') return match;
      return line.startsWith('> ') ? value.replace(/\\r?\\n/g, (ending: string) => ending + '> ') : value;
    }) + (parts[index + 1] ?? '');
  }
  return composePlayerContinuation(input, body, resuming);
}
const composePlayerPrompt = (input: PlaybookPlayerInput, promptIdentity: XStatePromptIdentity, resuming?: boolean): string =>
  renderPlayerPrompt(input as SourcePlayerInput, promptIdentity, resuming);
`;
}

export class UnsupportedLinkProfile extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedLinkProfile';
  }
}

const SCHEMA = 'sublang.playbook.link.v1';
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'hostCapabilities']);
const DESCRIPTOR_KEYS = [
  'schema', 'profile', 'machineExport', 'label', 'options', 'inputMapping',
  'entryEvent', 'bossEvents', 'outcomeAuthority', 'placeholderFields',
  'transitionEventFields', 'verbatimPayloadFields', 'resumableStateIds',
  'unfinishedFinalStateIds', 'controlContextFields',
];
const LABELLED_KEYS = ['playerInputExport', 'omitEmptyRelayLines', 'identityPlaceholders'];
const TOKEN = /^(#|[A-Za-z_$][A-Za-z0-9_$-]*)$/;
const CONTRACT_TYPES = [
  'PlayerResult', 'PlayerCallOptions', 'PlayerSessionStore', 'CaptainResult',
  'CaptainCallOptions', 'JsonValue', 'NormalizedError', 'PlaybookCallRequest',
  'PlaybookCallResult', 'PlaybookCallStart', 'PlaybookStateValue', 'PlaybookState',
  'PlaybookPendingCall', 'PlaybookRunResult', 'PlaybookRuntime',
  'PlaybookRuntimeFactory', 'PlaybookRuntimeSnapshot', 'PlaybookSession',
  'PlaybookPorts', 'PlaybookTraceEvent', 'PlaybookTraceType',
  'PlaybookControlReceipt', 'PlaybookControlView',
];

function record(value, path, allowed, required = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${path} must be a plain object`);
  }
  for (const key of Object.keys(value)) {
    if (RESERVED_KEYS.has(key) || (allowed && !allowed.includes(key))) {
      throw new TypeError(`${path}.${key} is not declared`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required`);
  }
  return value;
}

function nonempty(value, path) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${path} must be a nonempty string`);
  return value;
}

function strings(value, path, allowEmptyStrings = false) {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  for (const item of value) {
    if (allowEmptyStrings) {
      if (typeof item !== 'string') throw new TypeError(`${path} values must be strings`);
    } else nonempty(item, path);
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${path} must not repeat values`);
  return value;
}

function validateDescriptor(value, engine) {
  const descriptor = engine.snapshotJsonValue(value, 'link descriptor');
  const labelled = descriptor?.profile === 'flat-labelled-relays';
  const keys = labelled ? [...DESCRIPTOR_KEYS, ...LABELLED_KEYS] : DESCRIPTOR_KEYS;
  record(descriptor, 'descriptor', keys, keys);
  if (descriptor.schema !== SCHEMA) throw new TypeError(`descriptor.schema must equal ${SCHEMA}`);
  if (!['flat-defaults', 'flat-quoted-relays', 'flat-labelled-relays'].includes(descriptor.profile)) throw new UnsupportedLinkProfile('profile requires ordinary normative linking');
  if (labelled) {
    if (typeof engine.composePlayerContinuation !== 'function') throw new UnsupportedLinkProfile('labelled relays require the shared continuation API');
    if (typeof descriptor.playerInputExport !== 'string' || !IDENTIFIER.test(descriptor.playerInputExport)) throw new TypeError('playerInputExport must name the exported FSM player-input type');
    strings(descriptor.omitEmptyRelayLines, 'omitEmptyRelayLines');
    record(descriptor.identityPlaceholders, 'identityPlaceholders');
    for (const [token, role] of Object.entries(descriptor.identityPlaceholders)) {
      if (!TOKEN.test(token)) throw new TypeError('identityPlaceholders key must be a placeholder token');
      nonempty(role, `identityPlaceholders.${token}`);
    }
  }
  nonempty(descriptor.label, 'descriptor.label');
  if (typeof descriptor.machineExport !== 'string' || !IDENTIFIER.test(descriptor.machineExport)) {
    throw new TypeError('descriptor.machineExport must be an exported JavaScript identifier');
  }
  record(descriptor.options, 'descriptor.options');
  for (const [key, option] of Object.entries(descriptor.options)) {
    nonempty(key, 'option name');
    record(option, `options.${key}`, ['type', 'required'], ['type', 'required']);
    if (!['string', 'boolean', 'number'].includes(option.type)) {
      throw new UnsupportedLinkProfile(`options.${key} requires an unsupported option shape`);
    }
    if (typeof option.required !== 'boolean') throw new TypeError(`options.${key}.required must be boolean`);
  }
  record(descriptor.inputMapping, 'descriptor.inputMapping');
  for (const [key, option] of Object.entries(descriptor.inputMapping)) {
    nonempty(key, 'input field');
    nonempty(option, `inputMapping.${key}`);
    if (!Object.hasOwn(descriptor.options, option)) throw new TypeError(`inputMapping.${key} names undeclared option ${option}`);
  }
  for (const key of Object.keys(descriptor.options)) {
    if (key !== 'cwd' && !Object.values(descriptor.inputMapping).includes(key)) {
      throw new UnsupportedLinkProfile(`option ${key} needs a strategy outside the input-mapping profile`);
    }
  }
  if (descriptor.entryEvent !== null) {
    record(descriptor.entryEvent, 'entryEvent', ['type', 'textField', 'contextField'], ['type', 'textField']);
    for (const [key, value] of Object.entries(descriptor.entryEvent)) nonempty(value, `entryEvent.${key}`);
  }
  if (!Array.isArray(descriptor.bossEvents)) throw new TypeError('bossEvents must be an array');
  const eventTypes = new Set();
  for (const event of descriptor.bossEvents) {
    record(event, 'bossEvents entry', ['type', 'fields'], ['type']);
    nonempty(event.type, 'bossEvents.type');
    if (eventTypes.has(event.type)) throw new TypeError(`bossEvents repeats ${event.type}`);
    eventTypes.add(event.type);
    if (event.fields !== undefined) {
      record(event.fields, 'bossEvents.fields');
      for (const [key, field] of Object.entries(event.fields)) {
        nonempty(key, 'Boss event field');
        record(field, `bossEvents.fields.${key}`, ['source', 'required', 'values'], ['source']);
        if (!['judge', 'text'].includes(field.source)) throw new TypeError(`bossEvents.fields.${key}.source is invalid`);
        if (field.required !== undefined && typeof field.required !== 'boolean') throw new TypeError(`bossEvents.fields.${key}.required must be boolean`);
        if (field.values !== undefined) {
          strings(field.values, `bossEvents.fields.${key}.values`, true);
          if (!field.values.length) throw new TypeError(`bossEvents.fields.${key}.values must not be empty`);
        }
      }
    }
  }
  record(descriptor.outcomeAuthority, 'outcomeAuthority', ['governedPlayerStates'], ['governedPlayerStates']);
  record(descriptor.outcomeAuthority.governedPlayerStates, 'governedPlayerStates');
  for (const [state, outcomes] of Object.entries(descriptor.outcomeAuthority.governedPlayerStates)) {
    record(outcomes, `outcomeAuthority.${state}`);
    for (const [outcome, declaration] of Object.entries(outcomes)) {
      nonempty(outcome, 'outcome');
      record(declaration, `outcomeAuthority.${state}.${outcome}`, ['fields', 'repositoryDisposition'], ['fields', 'repositoryDisposition']);
      record(declaration.fields, `outcomeAuthority.${state}.${outcome}.fields`);
      for (const authority of Object.values(declaration.fields)) {
        if (!['presentation', 'semantic', 'effect', 'runtime'].includes(authority)) throw new TypeError(`outcomeAuthority.${state}.${outcome} has an unknown field authority`);
      }
      if (!['unchanged', 'one-descendant-commit', 'deferred'].includes(declaration.repositoryDisposition)) {
        throw new TypeError(`outcomeAuthority.${state}.${outcome} has an unknown repository disposition`);
      }
    }
  }
  record(descriptor.placeholderFields, 'placeholderFields');
  for (const [key, value] of Object.entries(descriptor.placeholderFields)) {
    nonempty(key, 'placeholder token');
    nonempty(value, `placeholderFields.${key}`);
  }
  if (labelled) {
    for (const token of Object.keys(descriptor.identityPlaceholders)) {
      if (Object.hasOwn(descriptor.placeholderFields, token)) throw new TypeError(`identity placeholder ${token} also declares a field mapping`);
    }
    for (const line of descriptor.omitEmptyRelayLines) {
      const matched = /^> [^<>\r\n]*<(#|[A-Za-z_$][A-Za-z0-9_$-]*)>$/.exec(line);
      if (!matched) throw new UnsupportedLinkProfile('optional relay must be a complete quoted line with one terminal placeholder');
      if (Object.hasOwn(descriptor.identityPlaceholders, matched[1])) throw new TypeError('an identity relay cannot be optional');
    }
  }
  for (const field of ['transitionEventFields', 'verbatimPayloadFields', 'resumableStateIds', 'unfinishedFinalStateIds', 'controlContextFields']) {
    strings(descriptor[field], field);
  }
  return descriptor;
}

function inspectMachine(machine, engine, labelled = false) {
  const config = machine?.config;
  if (!config || typeof config !== 'object' || !config.states) throw new TypeError('FSM export must be an XState machine');
  if (config.type === 'parallel' || config.invoke) throw new UnsupportedLinkProfile('root parallel states or invocations require ordinary linking');
  const descriptions = engine.stateDescriptionsFromMachine(machine);
  const roleStates = Object.create(null);
  let hasScript = false;
  for (const [key, state] of Object.entries(config.states)) {
    if (RESERVED_KEYS.has(key)) throw new UnsupportedLinkProfile(`state ${key} requires ordinary linking`);
    if (!state || typeof state !== 'object') throw new TypeError(`state ${key} must be an object`);
    if (state.states || (state.type !== undefined && !['atomic', 'final'].includes(state.type))) {
      throw new UnsupportedLinkProfile(`state ${key} is outside the flat single-region profile`);
    }
    const invokes = Array.isArray(state.invoke) ? state.invoke : state.invoke ? [state.invoke] : [];
    if (invokes.length > 1) throw new UnsupportedLinkProfile(`state ${key} has multiple actors`);
    for (const invoke of invokes) {
      if (!(labelled ? ['player', 'script', 'playbook'] : ['player', 'script']).includes(invoke.src)) throw new UnsupportedLinkProfile(`state ${key} actor ${String(invoke.src)} requires ordinary linking`);
      if (invoke.src === 'script') hasScript = true;
      else if (invoke.src === 'player') {
        const role = nonempty(state.meta?.playbook?.role, `state ${key} role`);
        const label = nonempty(descriptions.get(key), `state ${key} description`);
        roleStates[key] = { role, label };
      }
    }
  }
  return { roleStates, hasScript };
}

function snapshotPrimitiveOptions(value, options, engine, label) {
  const captured = engine.snapshotJsonValue(value, `${label} runtime options`);
  record(captured, `${label} runtime options`, Object.keys(options));
  for (const [key, schema] of Object.entries(options)) {
    if (!Object.hasOwn(captured, key)) {
      if (schema.required) throw new TypeError(`${label} runtime options.${key} is required`);
    } else if (typeof captured[key] !== schema.type || (schema.type === 'number' && !Number.isFinite(captured[key]))) {
      throw new TypeError(`${label} runtime options.${key} must be ${schema.type}`);
    }
  }
  return captured;
}

/** Pure emission: no filesystem writes, actor construction, or host calls. */
export function materializeLink({ machine, descriptor: value, fsmSpecifier, engine }) {
  for (const method of ['snapshotJsonValue', 'stateDescriptionsFromMachine', 'createXStatePlaybookRuntime', 'defaultComposePlayerPrompt']) {
    if (typeof engine?.[method] !== 'function') throw new TypeError(`installed shared engine is missing ${method}`);
  }
  if (!engine.SUPPORTED_ARTIFACT_SCHEMAS?.includes(3) || !Number.isInteger(engine.RUNTIME_ABI)) {
    throw new TypeError('installed shared engine does not declare schema 3 and a literal ABI');
  }
  if (typeof fsmSpecifier !== 'string' || !/^(?:\.\/|\.\.\/)/.test(fsmSpecifier) || !/\.(?:ts|js)$/.test(fsmSpecifier) || /[\r\n]/.test(fsmSpecifier)) {
    throw new TypeError('FSM import must be an extension-bearing relative .ts or .js specifier');
  }
  const descriptor = validateDescriptor(value, engine);
  const labelledPlayer = descriptor.profile === 'flat-labelled-relays';
  const { roleStates, hasScript } = inspectMachine(machine, engine, labelledPlayer);
  if (labelledPlayer) {
    const roles = new Set(Object.values(roleStates).map((state) => state.role));
    if (!roles.size) throw new UnsupportedLinkProfile('labelled profile requires a delegated player');
    for (const role of Object.values(descriptor.identityPlaceholders)) {
      if (!roles.has(role)) throw new TypeError(`identity placeholder names undeclared role ${role}`);
    }
  }
  const options = { ...descriptor.options };
  if (hasScript) {
    if (options.cwd && (options.cwd.type !== 'string' || options.cwd.required)) {
      throw new UnsupportedLinkProfile('script cwd must be an optional string');
    }
    options.cwd = { type: 'string', required: false };
  }
  for (const state of descriptor.resumableStateIds) {
    if (!Object.hasOwn(roleStates, state)) throw new TypeError(`resumableStateIds contains non-player state ${state}`);
  }
  const spec = {
    label: descriptor.label,
    compat: { artifactSchema: 3, runtimeAbi: engine.RUNTIME_ABI },
    snapshotOptions: (value) => snapshotPrimitiveOptions(value, options, engine, descriptor.label),
    machineInput: (options) => Object.fromEntries(Object.entries(descriptor.inputMapping)
      .filter(([, key]) => options[key] !== undefined).map(([field, key]) => [field, options[key]])),
    ...(descriptor.entryEvent === null ? {} : { entryEvent: descriptor.entryEvent }),
    bossEvents: descriptor.bossEvents,
    roleStates,
    outcomeAuthority: descriptor.outcomeAuthority,
    placeholderFields: descriptor.placeholderFields,
    transitionEventFields: descriptor.transitionEventFields,
    verbatimPayloadFields: new Set(descriptor.verbatimPayloadFields),
    resumableStateIds: new Set(descriptor.resumableStateIds),
    unfinishedFinalStateIds: new Set(descriptor.unfinishedFinalStateIds),
    controlContextFields: descriptor.controlContextFields,
  };
  // The engine validates exact role/state identity, authority shape, Boss
  // contracts, projection, and final-state membership without starting actors.
  engine.createXStatePlaybookRuntime(machine, spec);
  const json = (value) => JSON.stringify(value, null, 2);
  const hasPlayer = Object.keys(roleStates).length > 0;
  const quotedPlayer = hasPlayer && descriptor.profile === 'flat-quoted-relays';
  // The continuation API was added after 12.3. Emit only arguments supported
  // by the installed engine's public surface, rather than widening its types.
  const hasContinuationMode = typeof engine.composePlayerContinuation === 'function';
  const fsmImport = descriptor.machineExport === 'default'
    ? `import machine from ${JSON.stringify(fsmSpecifier)};`
    : `import { ${descriptor.machineExport} as machine } from ${JSON.stringify(fsmSpecifier)};`;
  const data = { ...spec };
  for (const key of ['snapshotOptions', 'machineInput', 'verbatimPayloadFields', 'resumableStateIds', 'unfinishedFinalStateIds']) delete data[key];
  return `// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
// Generated by slc/materialize-link.mjs; governed by the complete slc/link.md.
// FSM: ${JSON.stringify(fsmSpecifier)}; export: ${descriptor.machineExport}; strategies: ${labelledPlayer ? 'shared defaults with labelled string relays and nested actors' : quotedPlayer ? 'shared defaults with standalone quoted relays' : 'shared defaults'}.
${fsmImport}
${labelledPlayer ? `import type { ${descriptor.playerInputExport} as SourcePlayerInput } from ${JSON.stringify(fsmSpecifier)};\n` : ''}import {
  createXStatePlaybookRuntime, snapshotJsonValue,${labelledPlayer ? '\n  composePlayerContinuation, type XStatePromptIdentity,' : hasPlayer ? '\n  defaultComposePlayerPrompt,' : ''}
  ${hasPlayer ? 'type PlaybookPlayerInput,' : ''}
  type XStatePlaybookRuntimeConstruction,
  type XStatePlaybookRuntimeFactory,
  type XStatePlaybookRuntimeSpecV3,
} from '@sublang/playbook/xstate-runtime';
export type {
  ${CONTRACT_TYPES.join(',\n  ')},
} from '@sublang/playbook/runtime';

export interface PlaybookRuntimeOptions {
${Object.entries(options).map(([key, value]) => `  readonly ${JSON.stringify(key)}${value.required ? '' : '?'}: ${value.type};`).join('\n')}
}
export type PlaybookHostCapabilities = XStatePlaybookRuntimeConstruction<
  PlaybookRuntimeOptions, { readonly authority: object }
>['hostCapabilities'];

const OPTION_SCHEMA = ${json(options)} as const;
const INPUT_MAPPING = ${json(descriptor.inputMapping)} as const;
const RESUMABLE_STATE_IDS: ReadonlySet<string> = new Set(${json(descriptor.resumableStateIds)});
const UNFINISHED_FINAL_STATE_IDS: ReadonlySet<string> = new Set(${json(descriptor.unfinishedFinalStateIds)});
export function validateOptions(value: unknown): PlaybookRuntimeOptions {
  const captured = snapshotJsonValue(value === undefined ? {} : value, ${JSON.stringify(`${descriptor.label} runtime options`)});
  if (captured === null || typeof captured !== 'object' || Array.isArray(captured)) {
    throw new TypeError(${labelledPlayer ? json(`${descriptor.label} runtime options must be an object`) : "'runtime options must be an object'"});
  }
  const fields = captured as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(captured)) {
    if (!Object.hasOwn(OPTION_SCHEMA, key)) throw new TypeError(${labelledPlayer ? json(`${descriptor.label} runtime options.`) : "'runtime options.'"} + key + ' is not declared');
  }
  for (const [key, schema] of Object.entries(OPTION_SCHEMA) as [string, { type: string; required: boolean }][]) {
    if (!Object.hasOwn(captured, key)) {
      if (schema.required) throw new TypeError(${labelledPlayer ? json(`${descriptor.label} runtime options.`) : "'runtime options.'"} + key + ' is required');
    } else if (typeof fields[key] !== schema.type || (schema.type === 'number' && !Number.isFinite(fields[key]))) {
      throw new TypeError(${labelledPlayer ? json(`${descriptor.label} runtime options.`) : "'runtime options.'"} + key + ${labelledPlayer ? "' must be a '" : "' must be '"} + schema.type);
    }
  }
  return captured as unknown as PlaybookRuntimeOptions;
}
${labelledPlayer ? labelledPlayerSource(descriptor) : quotedPlayer ? quotedPlayerSource(descriptor.placeholderFields, hasContinuationMode) : ''}const runtimeSpec = {
${quotedPlayer || labelledPlayer ? '  composePlayerPrompt,\n' : ''}  ...${json(data)},
  snapshotOptions: validateOptions,
  machineInput: (options: PlaybookRuntimeOptions) => Object.fromEntries(
    Object.entries(INPUT_MAPPING).filter(([, key]) => options[key as keyof PlaybookRuntimeOptions] !== undefined)
      .map(([field, key]) => [field, options[key as keyof PlaybookRuntimeOptions]]),
  ),
  verbatimPayloadFields: new Set<string>(${json(descriptor.verbatimPayloadFields)}),
  resumableStateIds: RESUMABLE_STATE_IDS,
  unfinishedFinalStateIds: UNFINISHED_FINAL_STATE_IDS,
} satisfies XStatePlaybookRuntimeSpecV3<PlaybookRuntimeOptions>;

export const _internal = {
  ${quotedPlayer || labelledPlayer ? 'composePlayerPrompt,\n  ' : hasPlayer ? `composePlayerPrompt: (input: PlaybookPlayerInput, _identity?: unknown${hasContinuationMode ? ', resuming = false' : ''}) =>
    defaultComposePlayerPrompt(input, ${json(descriptor.placeholderFields)}${hasContinuationMode ? ', resuming' : ''}),\n  ` : ''}RESUMABLE_STATE_IDS,
  UNFINISHED_FINAL_STATE_IDS,
};
const createPlaybookRuntime: XStatePlaybookRuntimeFactory<
  XStatePlaybookRuntimeConstruction<PlaybookRuntimeOptions, PlaybookHostCapabilities>, 3
> = createXStatePlaybookRuntime<PlaybookRuntimeOptions, PlaybookHostCapabilities>(machine, runtimeSpec);
export default createPlaybookRuntime;
`;
}

function argumentsOf(argv) {
  if (argv.length !== 4) throw new TypeError('Usage: node materialize-link.mjs --fsm <.fsm.ts|.fsm.js> --out <.playbook.ts> < descriptor.json');
  const fields = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--fsm', '--out'].includes(key) || Object.hasOwn(fields, key)) throw new TypeError(`Unknown or repeated argument ${key}`);
    fields[key] = resolve(nonempty(argv[index + 1], key));
  }
  return { fsm: fields['--fsm'], out: fields['--out'] };
}

export async function runMaterializer(argv, input) {
  const { fsm, out } = argumentsOf(argv);
  if (!['.js', '.ts'].includes(extname(fsm))) throw new UnsupportedLinkProfile('FSM loading supports only .js or native-stripped .ts');
  if (extname(fsm) === '.ts' && !process.features.typescript) {
    throw new UnsupportedLinkProfile('Loading .fsm.ts requires Node native type stripping (Node >=23.6 or >=22.18); use a compiled .fsm.js on Node 20');
  }
  if (extname(out) !== '.ts') throw new TypeError('declared target must be a TypeScript module');
  const source = await realpath(fsm);
  const targetInfo = await lstat(out).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (targetInfo?.isSymbolicLink()) throw new TypeError('declared target must not be a symbolic link');
  if (source === out || (targetInfo && source === await realpath(out))) throw new TypeError('declared target must not replace the FSM');
  const enginePath = createRequire(pathToFileURL(source)).resolve('@sublang/playbook/xstate-runtime');
  const targetEnginePath = createRequire(pathToFileURL(out)).resolve('@sublang/playbook/xstate-runtime');
  if (await realpath(enginePath) !== await realpath(targetEnginePath)) throw new TypeError('FSM and target must resolve the same installed shared engine');
  if (Buffer.byteLength(input, 'utf8') > 1024 * 1024) throw new TypeError('descriptor exceeds 1 MiB');
  const descriptor = JSON.parse(input);
  const engine = await import(pathToFileURL(enginePath).href);
  // Validate the export name before selecting it from the imported module.
  validateDescriptor(descriptor, engine);
  const module = await import(pathToFileURL(source).href);
  const specifier = relative(dirname(out), fsm).replaceAll('\\', '/');
  const code = materializeLink({ machine: module[descriptor.machineExport], descriptor,
    fsmSpecifier: specifier.startsWith('.') ? specifier : `./${specifier}`, engine });
  const temporary = `${out}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o644);
    try { await file.writeFile(code, 'utf8'); } finally { await file.close(); }
    await rename(temporary, out);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  return { status: 'ok', target: out, bytes: Buffer.byteLength(code, 'utf8') };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    argumentsOf(process.argv.slice(2));
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > 1024 * 1024) throw new TypeError('descriptor exceeds 1 MiB');
    }
    process.stdout.write(`${JSON.stringify(await runMaterializer(process.argv.slice(2), input))}\n`);
  } catch (error) {
    const unsupported = error instanceof UnsupportedLinkProfile;
    process.stderr.write(`${JSON.stringify({ status: unsupported ? 'unsupported' : 'error', message: error.message,
      ...(unsupported ? { fallback: 'Continue ordinary linking under the complete link.md definition.' } : {}) })}\n`);
    process.exitCode = unsupported ? 2 : 1;
  }
}
