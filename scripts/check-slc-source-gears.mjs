// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ITEM_HEADING = /^###\s+([^\s]+)\s*$/;
const MARKDOWN_FENCE = /^```markdown\s*$/i;
const FENCE_END = /^```\s*$/;
const BLOCKQUOTE = /^>\s?(.*)$/;
const PLACEHOLDER = /<([A-Za-z_$#][A-Za-z0-9_$#-]*)>/g;
const RESULT_BULLET = /^-\s+`([A-Za-z_$][A-Za-z0-9_$]*)`:\s+(.+)$/;
const REQUIRED_FIELD = /^([A-Za-z_$][A-Za-z0-9_$]*)(?::\s*<([^>]+)>)?$/;
const ENGLISH_PLAYER = '[A-Z][A-Za-z0-9_-]*';
const RELAY_LINE = /^>/;
const BARE_RELAY = /^>\s+<[A-Za-z_$#][A-Za-z0-9_$#-]*>$/;
const TILING_LIMIT = 4096;

/**
 * The units the prefix pass moves or keeps: a quoted relay fragment is one
 * relay unit; in an instruction or prompt fragment, a paragraph of only quoted
 * lines is a relay unit, and the lines between relay units, without their
 * bounding blank lines, are one instruction unit that keeps its interior blank
 * lines. Each unit keeps its Source position for ordering.
 */
function fragmentUnits(fragment) {
  if (fragment.kind === 'relay') {
    return [{ kind: 'relay', start: fragment.start, lines: fragment.lines }];
  }
  const units = [];
  let from = -1;
  let to = -1;
  const flush = () => {
    if (from === -1) return;
    units.push({
      kind: 'instruction',
      start: fragment.start + from,
      lines: fragment.lines.slice(from, to),
    });
    from = -1;
  };
  for (let index = 0; index < fragment.lines.length; ) {
    let end = index;
    while (end < fragment.lines.length && fragment.lines[end] !== '') end++;
    const paragraph = fragment.lines.slice(index, end);
    if (paragraph.length > 0 && paragraph.every((line) => RELAY_LINE.test(line))) {
      flush();
      units.push({ kind: 'relay', start: fragment.start + index, lines: paragraph });
    } else if (paragraph.length > 0) {
      if (from === -1) from = index;
      to = end;
    }
    index = end + 1;
  }
  flush();
  return units;
}

/** Resolve Markdown escaping that is Source syntax rather than prompt content. */
function normalizePromptLine(line) {
  return line.replace(/\\([<>])/g, '$1');
}

/** Whether prose immediately introducing a Source blockquote makes `>` content. */
function introducesQuotedRelay(lines, start) {
  const context = [];
  for (let index = start - 1; index >= 0 && context.length < 4; index--) {
    const line = lines[index].trim();
    if (line === '') continue;
    if (line.startsWith('#') || line.startsWith('```')) break;
    context.unshift(line);
  }
  // The marker is a backticked `>` in ASCII or full-width parentheses; the
  // words around it are prose in any language.
  return /[(（]\s*`>`\s*[)）]/.test(context.join(' '));
}

/** Prompt fragments authored explicitly in one free-form playbook Source. */
export function sourcePromptFragments(sourceText) {
  const lines = sourceText.split('\n');
  const fragments = [];
  for (let index = 0; index < lines.length; index++) {
    if (MARKDOWN_FENCE.test(lines[index])) {
      const start = index;
      const content = [];
      for (index++; index < lines.length && !FENCE_END.test(lines[index]); index++) {
        content.push(normalizePromptLine(lines[index]));
      }
      if (index >= lines.length) {
        throw new Error(`unclosed markdown instruction fence at line ${start + 1}`);
      }
      fragments.push({ kind: 'instruction', start, lines: content });
      continue;
    }

    if (!BLOCKQUOTE.test(lines[index])) continue;
    const start = index;
    const quotedRelay = introducesQuotedRelay(lines, start);
    const content = [];
    while (index < lines.length) {
      const match = BLOCKQUOTE.exec(lines[index]);
      if (match === null) break;
      const line = normalizePromptLine(match[1]);
      content.push(
        quotedRelay ? (line === '' ? '>' : `> ${line}`) : line,
      );
      index++;
    }
    index--;
    fragments.push({
      kind: quotedRelay ? 'relay' : 'prompt',
      start,
      lines: content,
    });
  }
  return fragments.filter((fragment) => fragment.lines.length > 0);
}

/** Required result fields and their ownership annotation. */
function resultFields(description) {
  const marker = description.indexOf('Output shall include');
  if (marker === -1) return [];
  const fields = [];
  for (const match of description.slice(marker).matchAll(/`([^`]+)`/g)) {
    const field = REQUIRED_FIELD.exec(match[1].trim());
    if (field === null) continue;
    fields.push({
      name: field[1],
      verbatim: field[2]?.trim().toLowerCase() === 'verbatim final text',
    });
  }
  return fields;
}

/** Player named by one delegated GEARS acting sentence. */
function actingPlayer(acting) {
  const prompted = new RegExp(
    `\\bCaptain shall prompt\\s+(${ENGLISH_PLAYER})\\b`,
  ).exec(acting)?.[1];
  if (prompted !== undefined) return prompted;
  return new RegExp(
    `\\bCaptain shall relay\\b.*?\\bto\\s+(${ENGLISH_PLAYER})\\b`,
  ).exec(acting)?.[1];
}

/** Minimal GEARS item surface needed for Source and relay-contract checks. */
export function parseGearsContract(gearsText) {
  const lines = gearsText.split('\n');
  const starts = [];
  for (let index = 0; index < lines.length; index++) {
    const heading = ITEM_HEADING.exec(lines[index]);
    if (heading !== null) starts.push({ index, id: heading[1] });
  }

  return starts.map((start, ordinal) => {
    const end = starts[ordinal + 1]?.index ?? lines.length;
    const section = lines.slice(start.index + 1, end);
    const firstQuote = section.findIndex((line) => BLOCKQUOTE.test(line));
    const prompt = [];
    let cursor = firstQuote;
    while (cursor >= 0 && cursor < section.length) {
      const quote = BLOCKQUOTE.exec(section[cursor]);
      if (quote === null) break;
      prompt.push(normalizePromptLine(quote[1]));
      cursor++;
    }
    const acting = section.slice(0, Math.max(firstQuote, 0)).join(' ');
    const delegated = /\bCaptain shall (?:prompt\b|relay\b)/.test(acting);
    // slc/text2gears.md "Script behaviors": fixed machine syntax, so the
    // clause stays in this exact English form in every source language.
    const script = /\bCaptain shall run:/.test(acting);
    const player = actingPlayer(acting);
    const results = [];
    for (const line of section.slice(Math.max(cursor, 0))) {
      const bullet = RESULT_BULLET.exec(line);
      if (bullet === null) continue;
      results.push({
        guard: bullet[1],
        description: bullet[2],
        fields: resultFields(bullet[2]),
      });
    }
    return { id: start.id, ordinal, delegated, script, player, prompt, results };
  });
}

/** Canonical kebab-token to camel-field mapping from slc/link.md. */
function placeholderField(token) {
  if (token === '#') return 'irNumber';
  return token.replace(/-([A-Za-z0-9_$])/g, (_match, next) => next.toUpperCase());
}

/** First exact contiguous occurrence of `needle` in `haystack`. */
function fragmentIndex(haystack, needle) {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let index = 0; index <= haystack.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

/** Every start of an exact contiguous occurrence of `needle` in `haystack`. */
function fragmentIndices(haystack, needle) {
  const indices = [];
  if (needle.length === 0 || needle.length > haystack.length) return indices;
  outer: for (let index = 0; index <= haystack.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    indices.push(index);
  }
  return indices;
}

/** Whether two line arrays are equal. */
function sameLines(left, right) {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/**
 * The prefix-first layout the prefix pass (slc/prefix.md) leaves: no relay
 * block precedes an instruction, and whole fragments taken in Source order
 * tile the prompt: their instruction units in the region before the trailing
 * relay blocks and their relay units among the trailing blocks, or in place
 * where the raw layout kept a relay beside instruction text, each unit
 * occurrence used once, with blank lines and bare relay lines free among the
 * trailing blocks. Before a unit stand exactly the one blank line the pass
 * leaves where a moved relay unit stood, exactly the authored blank lines
 * between it and a unit of its fragment that kept its place, or the boundary
 * Source composed before a fragment. Every tiling is returned as the multiset
 * of fragment texts it carries, for conservation; none means the prompt is
 * not in the prefix-first layout.
 */
function prefixFirstTilings(item, fragments, textIds) {
  const { prompt } = item;
  // The relay blocks the pass moves: blank-bounded runs of relay lines.
  const inBlock = prompt.map(() => false);
  for (let start = 0; start < prompt.length; start++) {
    let end = start;
    while (end < prompt.length && RELAY_LINE.test(prompt[end])) end++;
    if (end > start && (start === 0 || prompt[start - 1] === '') &&
      (end === prompt.length || prompt[end] === '')) inBlock.fill(true, start, end);
    start = Math.max(start, end);
  }
  const lastStatic = prompt.findLastIndex((line, index) => line !== '' && !inBlock[index]);
  if (inBlock.some((inside, index) => inside && index < lastStatic)) {
    return { tilings: [], overflow: false };
  }
  const statics = prompt.slice(0, lastStatic + 1);
  const tail = prompt.slice(lastStatic + 1);
  const free = (line) => line === '' || BARE_RELAY.test(line);
  // The static line after `unit` matched at the cursor across exactly `gap`
  // blank lines, or across any number where Source composed the boundary.
  const staticMatch = (line, unit, gap) => {
    let at = line;
    if (line > 0) {
      if (gap === null) {
        while (at < statics.length && statics[at] === '') at++;
      } else {
        for (let count = 0; count < gap; count++, at++) {
          if (statics[at] !== '') return -1;
        }
      }
    }
    return sameLines(statics.slice(at, at + unit.lines.length), unit.lines)
      ? at + unit.lines.length
      : -1;
  };
  // The tail line after `unit` matched at or after the cursor, past free lines.
  const tailMatch = (at, unit) => {
    for (let t = at; t + unit.lines.length <= tail.length; t++) {
      if (sameLines(tail.slice(t, t + unit.lines.length), unit.lines)) return t + unit.lines.length;
      if (!free(tail[t])) return -1;
    }
    return -1;
  };
  // Each reachable position — static line, tail line, whether the last unit
  // moved — with every multiset of fragment texts some path to it carries, as
  // sorted text ids.
  const keyOf = (state) => `${state.line} ${state.tail} ${Number(state.lastMoved)}`;
  let overflow = false;
  const merge = (states, state) => {
    const existing = states.get(keyOf(state));
    if (existing === undefined) {
      states.set(keyOf(state), state);
      return;
    }
    for (const list of state.lists) {
      if (existing.lists.size >= TILING_LIMIT && !existing.lists.has(list)) {
        overflow = true;
        break;
      }
      existing.lists.add(list);
    }
  };
  const withText = (list, id) =>
    (list === '' ? [id] : [...list.split(',').map(Number), id]).sort((left, right) => left - right).join(',');
  let reached = new Map();
  merge(reached, { line: 0, tail: 0, lastMoved: false, lists: new Set(['']) });
  fragments.forEach((fragment, index) => {
    const units = fragmentUnits(fragment);
    const next = new Map();
    for (const state of reached.values()) merge(next, { ...state, lists: new Set(state.lists) });
    let frontier = [...reached.values()];
    units.forEach((unit, position) => {
      const previous = units[position - 1];
      const advanced = [];
      for (const state of frontier) {
        // The blank lines before this unit: the pass's one after a moved unit,
        // the authored count after a unit of this fragment that stayed, and
        // Source's own composition before a fragment's first unit.
        const gap = state.lastMoved
          ? 1
          : position === 0
            ? null
            : unit.start - (previous.start + previous.lines.length);
        const line = staticMatch(state.line, unit, gap);
        if (unit.kind === 'instruction') {
          if (line >= 0) advanced.push({ ...state, line, lastMoved: false });
          continue;
        }
        const end = tailMatch(state.tail, unit);
        if (end >= 0) advanced.push({ ...state, tail: end, lastMoved: true });
        if (line >= 0) advanced.push({ ...state, line, lastMoved: false });
      }
      frontier = advanced;
    });
    for (const state of frontier) {
      const lists = new Set([...state.lists].map((list) => withText(list, textIds[index])));
      merge(next, { ...state, lists });
    }
    reached = next;
  });
  const ends = [...reached.values()].filter((state) =>
    state.line === statics.length && tail.slice(state.tail).every(free));
  return {
    tilings: [...new Set(ends.flatMap((state) => [...state.lists]))]
      .map((list) => (list === '' ? [] : list.split(',').map(Number))),
    overflow,
  };
}

/**
 * The Source-order layout: every complete occurrence of an authored fragment
 * the prompt carries admits an order-preserving Source attribution. An
 * occurrence inside a longer carried one belongs to that one, identical
 * fragments are alternative attributions of one occurrence, and only disjoint
 * occurrences order each other. slc's copy reads it the same way.
 */
function inSourceOrder(item, fragments) {
  const spans = new Map();
  for (const fragment of fragments) {
    for (const start of fragmentIndices(item.prompt, fragment.lines)) {
      const end = start + fragment.lines.length;
      const key = `${start}:${end}`;
      const span = spans.get(key) ?? { start, end, sourceStarts: [] };
      // Fragments arrive in Source order; identical matches are alternatives.
      span.sourceStarts.push(fragment.start);
      spans.set(key, span);
    }
  }
  const ordered = [...spans.values()].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  let furthestEnd = -1;
  let sourceFloor = -1;
  let completed = 0;
  const attributed = [];
  for (const span of ordered) {
    // A shorter match inside another carried fragment is that fragment's
    // content, not a second independently ordered occurrence.
    if (span.end <= furthestEnd) continue;
    furthestEnd = span.end;
    // Only disjoint earlier occurrences raise the floor; a crossing overlap
    // invents no order of the lines the two share.
    while (completed < attributed.length && attributed[completed].end <= span.start) {
      sourceFloor = Math.max(sourceFloor, attributed[completed].sourceStart);
      completed++;
    }
    // The earliest compatible attribution leaves every later choice open, so
    // none here means no order-preserving attribution exists.
    const sourceStart = span.sourceStarts.find((start) => start >= sourceFloor);
    if (sourceStart === undefined) return false;
    attributed.push({ end: span.end, sourceStart });
  }
  return true;
}

/** Non-overlapping contiguous occurrences of `needle` in `haystack`. */
function countFragment(haystack, needle) {
  let count = 0;
  for (let from = 0; from + needle.length <= haystack.length; ) {
    const at = fragmentIndex(haystack.slice(from), needle);
    if (at < 0) break;
    count++;
    from += at + needle.length;
  }
  return count;
}

/**
 * The deficit left by the best choice of one layout per item with a choice:
 * for each fragment text, how many authored fragments no chosen layout
 * supplies. The search is exact, memoized over the deficit still to cover.
 */
function residualDeficit(deficit, choices) {
  const total = (vector) => vector.reduce((sum, value) => sum + value, 0);
  const memo = new Map();
  const search = (depth, vector) => {
    if (depth === choices.length || total(vector) === 0) return vector;
    const key = `${depth}|${vector.join(',')}`;
    const seen = memo.get(key);
    if (seen !== undefined) return seen;
    let best = vector;
    for (const alternative of choices[depth]) {
      const result = search(
        depth + 1,
        vector.map((value, id) => Math.max(0, value - alternative[id])),
      );
      if (total(result) < total(best)) best = result;
      if (total(best) === 0) break;
    }
    memo.set(key, best);
    return best;
  };
  return search(0, deficit);
}

/** Fields whose result contracts make the player's final text authoritative. */
export function verbatimFieldsFromGears(gearsText) {
  const fields = new Set();
  for (const item of parseGearsContract(gearsText)) {
    for (const result of item.results) {
      for (const field of result.fields) {
        if (field.verbatim) fields.add(field.name);
      }
    }
  }
  return fields;
}

/** Compare a linked runtime's field ownership with its GEARS annotations. */
export function checkLinkedVerbatimContract(gearsText, linkedFields) {
  const expected = verbatimFieldsFromGears(gearsText);
  const actual = new Set(linkedFields);
  const findings = [];
  for (const field of expected) {
    if (!actual.has(field)) findings.push(`linked runtime omits verbatim field ${field}`);
  }
  for (const field of actual) {
    if (!expected.has(field)) findings.push(`linked runtime invents verbatim field ${field}`);
  }
  return findings;
}

/**
 * Deterministic conservation checks at the Source -> GEARS seam.
 *
 * Semantic item partitioning remains the compiler's judgment, but authored
 * fragments, their order, literal quote markers, and ownership of relayed
 * player output are mechanically decidable and checked here.
 */
export function checkSourceGearsContract(sourceText, gearsText) {
  const fragments = sourcePromptFragments(sourceText);
  const items = parseGearsContract(gearsText);
  const findings = [];
  // A fragment's text id is the index of the first fragment authored with it.
  const texts = fragments.map((fragment) => JSON.stringify(fragment.lines));
  const textIds = texts.map((text) => texts.indexOf(text));
  const ids = [...new Set(textIds)];
  // DR-065 §3: every item is accepted in the Source-order layout or in the
  // prefix-first one; a script item, which the prefix pass never rewrites,
  // only in Source order.
  const ordered = items.map((item) => inSourceOrder(item, fragments));
  const prefixFirst = items.map((item) =>
    (item.script ? { tilings: [], overflow: false } : prefixFirstTilings(item, fragments, textIds)));
  // Each item carries the fragments of one layout it is accepted in: those
  // it carries contiguously in Source order, or one prefix-first tiling. An
  // item accepted in neither is reported and carries its contiguous ones.
  // The layouts are chosen so that the items together supply each authored
  // text as many times as Source authors it — one occurrence never stands
  // for two authored fragments.
  const layouts = items.map((item, index) => {
    const contiguous = ids.map((id) => countFragment(item.prompt, fragments[id].lines));
    const tilings = prefixFirst[index].tilings
      .map((tiling) => ids.map((id) => tiling.filter((textId) => textId === id).length));
    if (tilings.length === 0) return [contiguous];
    return ordered[index] ? [contiguous, ...tilings] : tilings;
  });
  const deficit = ids.map((id, position) => Math.max(0,
    textIds.filter((textId) => textId === id).length -
      layouts
        .filter((layout) => layout.length === 1)
        .reduce((sum, [only]) => sum + only[position], 0)));
  const residual = residualDeficit(deficit, layouts.filter((layout) => layout.length > 1));
  const relayedFields = new Set(
    fragments
      .filter((fragment) => fragment.kind === 'relay')
      .flatMap((fragment) =>
        fragment.lines.flatMap((line) =>
          [...line.matchAll(PLACEHOLDER)].map((match) =>
            placeholderField(match[1]),
          ),
        ),
      ),
  );
  const allPromptLines = new Set(
    fragments.flatMap((fragment) => fragment.lines.filter((line) => line !== '')),
  );

  ids.forEach((id, position) => {
    const missing = residual[position];
    if (missing === 0) return;
    const indexes = textIds.flatMap((textId, index) => (textId === id ? [index] : []));
    for (const index of indexes.slice(-missing)) {
      const fragment = fragments[index];
      findings.push(
        `source ${fragment.kind} fragment at line ${fragment.start + 1} was dropped or changed`,
      );
    }
  });

  items.forEach((item, index) => {
    if (!ordered[index]) {
      if (prefixFirst[index].overflow) {
        findings.push(`${item.id}: prompt admits more tilings than the checker verifies`);
      }
      if (prefixFirst[index].tilings.length === 0) {
        findings.push(`${item.id}: authored prompt fragments are out of Source order`);
      }
    }

    for (const line of item.prompt) {
      if (line === '' || allPromptLines.has(line)) continue;
      if (BARE_RELAY.test(line)) continue;
      findings.push(`${item.id}: prompt line is not an authored fragment: ${JSON.stringify(line)}`);
    }
  });

  const producers = new Map();
  for (const item of items) {
    for (const result of item.results) {
      for (const field of result.fields) {
        const entries = producers.get(field.name) ?? [];
        entries.push({
          itemId: item.id,
          ordinal: item.ordinal,
          delegated: item.delegated,
          verbatim: field.verbatim,
        });
        producers.set(field.name, entries);
      }
    }
  }

  for (const [field, entries] of producers) {
    if (entries.some((entry) => entry.verbatim) && entries.some((entry) => !entry.verbatim)) {
      findings.push(`${field}: result field mixes verbatim and judge-authored ownership`);
    }
  }

  const reported = new Set();
  for (const item of items) {
    // A script blockquote is shell text no agent ever reads, so a placeholder
    // there binds the command to its target rather than relaying player text
    // into a prompt; the literal quote marker does not apply to it.
    if (item.script) continue;
    for (const line of item.prompt) {
      // A line the Source authored keeps the Source's own form — a command
      // that compares the value as a single-quoted shell word, for instance —
      // so the marker is owed only by a line the compiler composed.
      if (allPromptLines.has(line)) continue;
      for (const match of line.matchAll(PLACEHOLDER)) {
        const field = placeholderField(match[1]);
        if (!relayedFields.has(field)) continue;
        const key = `${item.id}:${field}`;
        if (!line.startsWith('> ') && !reported.has(`quote:${key}`)) {
          findings.push(`${item.id}: relayed player field ${field} lacks a literal quote marker`);
          reported.add(`quote:${key}`);
        }
      }
    }
  }

  return findings;
}

async function main(argv) {
  if (argv.length !== 2) {
    throw new Error('usage: check-slc-source-gears.mjs <source.md> <gears.md>');
  }
  const [sourcePath, gearsPath] = argv.map((path) => resolve(path));
  const [source, gears] = await Promise.all([
    readFile(sourcePath, 'utf8'),
    readFile(gearsPath, 'utf8'),
  ]);
  const findings = checkSourceGearsContract(source, gears);
  if (findings.length === 0) return;
  for (const finding of findings) process.stderr.write(`${finding}\n`);
  process.exitCode = 1;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
