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
  return /\bin quotes\s*\(`>`\)/i.test(context.join(' '));
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
    return { id: start.id, ordinal, delegated, prompt, results };
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
  const findings = [];
  const fragments = sourcePromptFragments(sourceText);
  const items = parseGearsContract(gearsText);
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

  for (const fragment of fragments) {
    if (!items.some((item) => fragmentIndex(item.prompt, fragment.lines) >= 0)) {
      findings.push(
        `source ${fragment.kind} fragment at line ${fragment.start + 1} was dropped or changed`,
      );
    }
  }

  for (const item of items) {
    const matches = fragments
      .map((fragment) => ({
        fragment,
        promptIndex: fragmentIndex(item.prompt, fragment.lines),
      }))
      .filter((entry) => entry.promptIndex >= 0)
      .sort((left, right) => left.promptIndex - right.promptIndex);
    for (let index = 1; index < matches.length; index++) {
      if (matches[index - 1].fragment.start > matches[index].fragment.start) {
        findings.push(`${item.id}: authored prompt fragments are out of Source order`);
        break;
      }
    }

    for (const line of item.prompt) {
      if (line === '' || allPromptLines.has(line)) continue;
      if (/^>\s+<[A-Za-z_$#][A-Za-z0-9_$#-]*>$/.test(line)) continue;
      findings.push(`${item.id}: prompt line is not an authored fragment: ${JSON.stringify(line)}`);
    }
  }

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
    for (const line of item.prompt) {
      for (const match of line.matchAll(PLACEHOLDER)) {
        const field = placeholderField(match[1]);
        if (!relayedFields.has(field)) continue;
        const priorDelegated = (producers.get(field) ?? []).filter(
          (producer) => producer.delegated && producer.ordinal < item.ordinal,
        );
        if (priorDelegated.length === 0) continue;
        const key = `${item.id}:${field}`;
        if (!line.startsWith('> ') && !reported.has(`quote:${key}`)) {
          findings.push(`${item.id}: relayed player field ${field} lacks a literal quote marker`);
          reported.add(`quote:${key}`);
        }
        if (!priorDelegated.every((producer) => producer.verbatim) && !reported.has(`verbatim:${key}`)) {
          findings.push(`${item.id}: relayed player field ${field} is not annotated verbatim`);
          reported.add(`verbatim:${key}`);
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
