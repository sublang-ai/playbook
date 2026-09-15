// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';
import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADING = /^### ([A-Za-z][\w-]*)$/;
const QUOTE = /^>[ \t]?(.*)$/;
const RESULT = /^- `([A-Za-z_$][A-Za-z0-9_$]*)`: (\S(?:.*\S)?)$/;
const HELP = 'Usage: node scaffold-fsm.mjs --source <GEARS.md> --out <new.fsm.ts>\nCreates an incomplete authoring scaffold; ordinary compiler checks remain required.\n';

function refuse(message) {
  throw new Error(message);
}

/** A closed copying profile, not a GEARS semantic compiler. */
function sourceItems(source) {
  if (/[\r\u2028\u2029\uFEFF]/.test(source)) refuse('unsupported line encoding; the scaffold profile requires LF text');
  if (source.split('\n').some(line => /^\s*(```|~~~)/.test(line))) refuse('fenced source bodies are outside this profile');
  const items = [];
  let current;
  for (const line of source.split('\n')) {
    if (line.startsWith('###')) {
      const heading = HEADING.exec(line);
      if (!heading) refuse('unsupported item heading');
      if (items.some(item => item.id === heading[1])) refuse('duplicate item id');
      current = { id: heading[1], lines: [] };
      items.push(current);
    } else if (/^#{1,2} /.test(line)) {
      current = undefined;
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (items.length === 0) refuse('no supported item headings');
  const prompted = [];
  for (const { id, lines } of items) {
    const first = lines.findIndex(line => QUOTE.test(line));
    const preamble = lines.slice(0, first === -1 ? lines.length : first);
    if (preamble.some(line => /Parallel group:|Captain shall run\s*:|Captain shall call playbook selected by/.test(line))) {
      refuse(`${id}: script, dynamic or parallel item is outside this profile`);
    }
    if (first === -1) {
      if (lines.some(line => /Captain shall|^Results\b/.test(line))) refuse(`${id}: acting item has no blockquote`);
      continue;
    }
    const before = preamble.join(' ');
    const child = /\bCaptain shall call playbook (?:`([A-Za-z0-9][\w.-]*)`|([A-Za-z0-9][\w.-]*)):\s*$/.exec(before.trim());
    const player = /\bCaptain shall (?:prompt ([A-Z][\w]*)|relay\b[^.]*?\bto ([A-Z][\w]*)):\s*$/.exec(before.trim());
    if (!child && /\bCaptain shall call playbook\b/.test(before)) refuse(`${id}: unsupported nested-call form`);
    if (!player && /\bCaptain shall (?:prompt|relay)\b/.test(before)) refuse(`${id}: unsupported delegated-role form`);
    if (!child && !player && !/\bCaptain shall\b.*:\s*$/.test(before.trim())) refuse(`${id}: unsupported acting clause`);
    if (/Results\s*:/.test(before)) refuse(`${id}: Results precedes its prompt`);
    const prompt = [];
    let cursor = first;
    while (cursor < lines.length) {
      const quote = QUOTE.exec(lines[cursor]);
      if (!quote) break;
      prompt.push(quote[1]);
      cursor++;
    }
    const after = lines.slice(cursor);
    if (after.some(line => QUOTE.test(line))) refuse(`${id}: noncontiguous prompt`);
    const nonblank = after.filter(line => line.trim() !== '');
    let results;
    if (nonblank.some(line => /^Results\b/.test(line))) {
      if (child) refuse(`${id}: nested-call Results are forbidden`);
      if (nonblank[0] !== 'Results:') refuse(`${id}: Results must immediately follow its prompt`);
      results = [];
      for (const line of nonblank.slice(1)) {
        const result = RESULT.exec(line);
        if (!result) refuse(`${id}: malformed Results entry`);
        if (results.some(([guard]) => guard === result[1])) refuse(`${id}: duplicate Results guard`);
        results.push([result[1], result[2]]);
      }
      if (results.length === 0) refuse(`${id}: empty Results block`);
    } else if (!child && nonblank.length > 0) {
      refuse(`${id}: trailing acting-item prose is outside this profile`);
    }
    prompted.push({ id, actor: child ? 'playbook' : player ? 'player' : 'captain', prompt: prompt.join('\n'), results });
  }
  if (prompted.length === 0) refuse('no supported prompted items');
  return prompted;
}

function sourceLicense(source) {
  const header = /^(?:<!--[^]*?-->\s*)+/.exec(source)?.[0] ?? '';
  return [...header.matchAll(/<!--\s*(SPDX-[^]*?)\s*-->/g)]
    .flatMap(match => match[1].split('\n').map(line => `// ${line.trim()}`))
    .join('\n');
}

const CHILD_VALIDATION_IMPORTS = `import { validatePlaybookCallResult } from '@sublang/playbook/xstate-runtime';
import type { PlaybookCallResult } from '@sublang/playbook/runtime';`;

const CHILD_VALIDATION_HELPER = `export function authoredChildResult(error: unknown, expectedPlaybookId: string): PlaybookCallResult | undefined {
  if (!(error instanceof Error)) return undefined;
  try {
    const result = validatePlaybookCallResult(
      (error as Error & { result?: unknown }).result,
      expectedPlaybookId,
    );
    return result.status !== 'ok' || result.terminal?.kind === 'failure' ? result : undefined;
  } catch {
    return undefined;
  }
}`;

function render(source, items) {
  const kinds = [...new Set(items.map(item => item.actor))];
  const constants = items.map(item => {
    const result = item.results === undefined ? 'undefined' : `{ ${item.results.map(([guard, description]) => `[${JSON.stringify(guard)}]: ${JSON.stringify(description)}`).join(', ')} }`;
    return `  [${JSON.stringify(item.id)}]: { prompt: ${JSON.stringify(item.prompt)}, result: ${result} }`;
  }).join(',\n');
  const types = kinds.map(kind => {
    const title = kind[0].toUpperCase() + kind.slice(1);
    if (kind === 'playbook') return `export type PlaybookInput = { stateId: string; sourceItem: string; playbookId: string; text: string };\nexport type PlaybookOutput = JsonValue | undefined;`;
    return `export type ${title}Input = { stateId: string; sourceItem: string; ${kind === 'player' ? 'role: string; ' : ''}prompt: string; result: Readonly<Record<string, string>> } & __AUTHOR_${kind.toUpperCase()}_FIELDS__;\nexport type ${title}Output = __AUTHOR_${kind.toUpperCase()}_OUTPUT__;`;
  }).join('\n');
  const actors = kinds.map(kind => {
    const title = kind[0].toUpperCase() + kind.slice(1);
    return `    ${kind}: fromPromise<${title}Output, ${title}Input>(async () => { throw new Error('${kind} actor must be provided by the runner'); })`;
  }).join(',\n');
  const json = kinds.includes('playbook') ? `export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };\n` : '';
  const license = sourceLicense(source);
  return `${license ? `${license}\n\n` : ''}// INCOMPLETE AUTHORING SCAFFOLD: replace every __AUTHOR_* marker and finish the workflow.
// Read the complete GEARS Source and phase definition; constants are not its routing semantics.
import { assign, fromPromise, setup } from 'xstate';
${kinds.includes('playbook') ? `${CHILD_VALIDATION_IMPORTS}\n` : ''}
// Acting prompts stay literal; carry runtime values beside invoke.input.prompt.
// Nested prompts are templates: compose child text under the phase's actual rules.
// Results are only authored declarations. Apply the phase's default/question/controller rules.
export const GEARS_ITEMS = {
${constants}
} as const;

type Context = __AUTHOR_CONTEXT__;
type Event = __AUTHOR_EVENTS__;
export type MachineInput = __AUTHOR_MACHINE_INPUT__;
export type MachineOutput = __AUTHOR_MACHINE_OUTPUT__;
${json}${types}
${kinds.includes('playbook') ? `\n${CHILD_VALIDATION_HELPER}\n` : ''}
function invocationOutput(event: unknown): unknown {
  return typeof event === 'object' && event !== null && 'output' in event ? event.output : undefined;
}

const actorSetup = setup({
  types: {} as { context: Context; events: Event; input: MachineInput; output: MachineOutput },
  actors: {
${actors}
  },
});

// Keep reusable completion assignments registered and reference their names.
// A standalone typed action reused directly on onDone can mismatch external event types.
const machineSetup = actorSetup.extend({
  actions: {
    rememberResult: assign(({ event }) => {
      const output = invocationOutput(event);
      // Narrow unknown output to the declared result arm before reading payload fields.
      return __AUTHOR_CONTEXT_UPDATE_FROM_OUTPUT__;
    }),
  },
});

// Use machineSetup.createStateConfig(...) for shared transition/config fragments.
// Agent-owned work includes routes, guards, public metadata, failures, Boss continuation,
// actor value relays and any child-result predicates. No default topology is supplied.
export const machine = machineSetup.createMachine({
  ...__AUTHOR_MACHINE_CONFIG__,
});
`;
}

export async function scaffoldFsm({ sourcePath, outputPath }) {
  const source = await readFile(sourcePath, 'utf8');
  if (!outputPath.endsWith('.fsm.ts')) refuse('output must end in .fsm.ts');
  if (resolve(sourcePath) === resolve(outputPath)) refuse('source and output must differ');
  const items = sourceItems(source);
  try {
    const xstate = createRequire(resolve(outputPath))('xstate');
    const typed = xstate.setup({});
    if (typeof typed.extend !== 'function' || typeof typed.createStateConfig !== 'function') {
      refuse('unsupported XState setup API');
    }
  } catch {
    refuse('target dependencies must supply XState setup.extend and createStateConfig');
  }
  const target = render(source, items);
  const staging = join(dirname(outputPath), `.fsm-scaffold-${randomUUID()}.tmp`);
  try {
    await writeFile(staging, target, { flag: 'wx' });
    // Exclusive publication prevents replacing a target created after our read.
    await link(staging, outputPath);
  } finally {
    await unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return { status: 'scaffold', bytes: Buffer.byteLength(target), items: items.length };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(HELP);
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--source', '--out'].includes(key) || typeof args[index + 1] !== 'string' || args[index + 1].startsWith('--') || Object.hasOwn(options, key)) refuse(HELP.trim());
    options[key] = args[index + 1];
  }
  if (!options['--source'] || !options['--out']) refuse(HELP.trim());
  const result = await scaffoldFsm({ sourcePath: resolve(options['--source']), outputPath: resolve(options['--out']) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`FSM scaffold: ${error instanceof Error ? error.message : 'initialization failed'}\n`);
    process.exitCode = 1;
  });
}
