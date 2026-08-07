#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Verify XREF-1 and XREF-2 from specs/test/cross-references.md: every
// relative markdown link in the checked files must resolve to an existing
// file inside this repository, and every `#` fragment must match an anchor
// the target file actually renders. Heading anchors follow GitHub's slug
// rules, which are the whole difficulty — see slugify().
//
// Run standalone (`pnpm check:links`) or through the vitest case in
// src/cross-references.test.ts.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Paths scanned for links, relative to the repo root (XREF §Checked Files). */
export const CHECKED_PATHS = ['specs', 'CHANGELOG.md', 'README.md'];

/** Never descended into when expanding a directory. */
const SKIPPED_DIRS = new Set([
  '.git',
  '.claude',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);

/** A target with one of these schemes is external (XREF §Exclusions). */
const EXTERNAL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HTML_ANCHOR = /<[a-zA-Z][^>]*?\b(?:name|id)\s*=\s*["']([^"']+)["']/g;
/** An inline code span: one or more backticks, matched by an equal run. */
const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])*?\1/g;
/** `](target)` with an optional <…> wrapper and any CommonMark title form. */
const INLINE_LINK =
  /\]\(\s*(?:<([^>]*)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
/** A link reference definition: `[label]: target` at the start of a line. */
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/gm;

/** Markdown link and raw-HTML syntax renders away; everything else stays. */
function renderProse(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>|<!--[\s\S]*?-->/g, '');
}

/**
 * Reproduce the slug GitHub derives from heading text (github-slugger [1]):
 * lowercase, drop every character that is not a letter, number, mark,
 * space, hyphen or underscore, then turn spaces into hyphens.
 *
 * The em dash is the case that matters. `### 11. Host adapter — tmux-play`
 * loses the dash but keeps the two spaces that flanked it, so the slug
 * carries a DOUBLE hyphen: `11-host-adapter--tmux-play`. Collapsing hyphen
 * runs here would silently accept the single-hyphen spelling, which is the
 * exact defect this check exists to catch.
 *
 * GitHub slugs a heading's RENDERED text, so the two strips above run on the
 * prose between code spans and never inside one: `### \`playbooks.<id>\`
 * routing` renders its span verbatim and yields `playbooksid-routing`, not
 * `playbooks-routing`.
 */
export function slugify(headingText) {
  let rendered = '';
  let cut = 0;
  for (const span of headingText.matchAll(CODE_SPAN)) {
    rendered += renderProse(headingText.slice(cut, span.index));
    rendered += span[0].replace(/^`+/, '').replace(/`+$/, '');
    cut = span.index + span[0].length;
  }
  rendered += renderProse(headingText.slice(cut));

  return rendered
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

/** Blank fenced code blocks, preserving line count. */
function blankFences(text) {
  let fence = null;
  return text
    .split('\n')
    .map((line) => {
      const match = FENCE.exec(line);
      if (match !== null) {
        const marker = match[1][0];
        if (fence === null) fence = marker;
        else if (fence === marker) fence = null;
        return '';
      }
      return fence === null ? line : '';
    })
    .join('\n');
}

/**
 * Blank inline code spans, preserving both length and line breaks so link
 * offsets still map to the right line. Two real cases depend on this: a DR
 * that quotes a deliberately-bad link as the defect it records fixing, and
 * meta.md's `[META-1](meta.md#meta-1)` citation-syntax example.
 */
function blankCodeSpans(text) {
  return text.replace(CODE_SPAN, (span) => span.replace(/[^\n]/g, ' '));
}

/** Offsets at which each 1-indexed line starts. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** Percent-decode a target, leaving a malformed escape as written. */
function decodeTarget(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Every anchor the rendered file exposes: one per heading (deduplicated the
 * way GitHub does, with -1/-2 suffixes) plus any explicit HTML id/name.
 */
export function anchorsOf(markdown) {
  const body = blankFences(markdown);
  // Headings keep their code spans (slugify renders them); the HTML-anchor
  // scan does not, so prose quoting `<a id="x">` mints no phantom anchor.
  const prose = blankCodeSpans(body);
  const anchors = new Set();
  const seen = new Map();

  body.split('\n').forEach((line, i) => {
    const heading = ATX_HEADING.exec(line);
    if (heading !== null) {
      const base = slugify(heading[2]);
      if (base !== '') {
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        anchors.add(n === 0 ? base : `${base}-${n}`);
      }
    }
    for (const match of prose.split('\n')[i].matchAll(HTML_ANCHOR)) {
      anchors.add(match[1]);
    }
  });
  return anchors;
}

/** Every relative link in a file, as `{ line, target }`. */
export function linksOf(markdown) {
  const body = blankCodeSpans(blankFences(markdown));
  const starts = lineStarts(body);
  const found = [];

  for (const re of [INLINE_LINK, LINK_DEFINITION]) {
    re.lastIndex = 0;
    for (const match of body.matchAll(re)) {
      const target = (match[1] ?? match[2] ?? '').trim();
      if (target === '') continue;
      if (target.startsWith('//') || EXTERNAL_SCHEME.test(target)) continue;
      found.push({ line: lineAt(starts, match.index), target });
    }
  }
  return found;
}

function markdownFilesUnder(absPath) {
  if (!existsSync(absPath)) return [];
  if (statSync(absPath).isFile()) {
    return absPath.endsWith('.md') ? [absPath] : [];
  }
  const out = [];
  for (const entry of readdirSync(absPath, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      out.push(...markdownFilesUnder(join(absPath, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(join(absPath, entry.name));
    }
  }
  return out;
}

/**
 * Resolve every relative link under `checkedPaths`.
 * Returns `{ files, links, failures }`; `failures` is empty when clean.
 */
export function checkLinks(repoRoot, checkedPaths = CHECKED_PATHS) {
  const root = resolve(repoRoot);
  const files = checkedPaths.flatMap((p) => markdownFilesUnder(resolve(root, p)));
  const anchorCache = new Map();
  const failures = [];
  let links = 0;

  const anchorsFor = (absPath) => {
    if (!anchorCache.has(absPath)) {
      anchorCache.set(absPath, anchorsOf(readFileSync(absPath, 'utf8')));
    }
    return anchorCache.get(absPath);
  };

  for (const file of files) {
    for (const { line, target } of linksOf(readFileSync(file, 'utf8'))) {
      links += 1;
      const hash = target.indexOf('#');
      const filePart = decodeTarget(hash === -1 ? target : target.slice(0, hash));
      const anchor = hash === -1 ? '' : decodeTarget(target.slice(hash + 1));

      // A leading `/` is repo-root-relative here. (On GitHub it is actually
      // site-root-relative, which DR-018 records as its own defect; resolving
      // it from the root keeps this check to link resolution alone.)
      const dest =
        filePart === ''
          ? file
          : filePart.startsWith('/')
            ? resolve(root, `.${filePart}`)
            : resolve(dirname(file), filePart);

      const where = { file: relative(root, file), line, target };
      const inside = relative(root, dest);

      // A target outside the repository resolves only where a sibling
      // checkout happens to sit, so it is broken for every other reader.
      if (inside.startsWith('..')) {
        failures.push({ ...where, reason: `target escapes the repository: ${inside}` });
        continue;
      }
      if (!existsSync(dest)) {
        failures.push({ ...where, reason: `no such file: ${inside}` });
        continue;
      }
      if (anchor === '' || extname(dest) !== '.md') continue;

      const anchors = anchorsFor(dest);
      if (anchors.has(anchor)) continue;

      // A near miss on hyphen runs is the em-dash slug bug; name it.
      const collapsed = anchor.replace(/-+/g, '-');
      const near = [...anchors].find((a) => a.replace(/-+/g, '-') === collapsed);
      failures.push({
        ...where,
        reason:
          `no anchor #${anchor} in ${inside}` +
          (near === undefined ? '' : ` (did you mean #${near}?)`),
      });
    }
  }
  return { files: files.length, links, failures };
}

export function formatFailures(failures) {
  return failures
    .map((f) => `  ${f.file}:${f.line}  (${f.target})\n      ${f.reason}`)
    .join('\n');
}

// CLI entry: only when executed directly, so importers get the API alone.
if (process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`) {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const paths = process.argv.length > 2 ? process.argv.slice(2) : CHECKED_PATHS;
  const { files, links, failures } = checkLinks(repoRoot, paths);
  if (failures.length > 0) {
    console.error(`${failures.length} broken link(s) in ${files} files:\n`);
    console.error(formatFailures(failures));
    process.exit(1);
  }
  console.log(`all ${links} relative links in ${files} files resolve`);
}
