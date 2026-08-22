// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { anchorsOf, checkLinks, slugify } from '../scripts/check-links.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const fixtures: string[] = [];

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop() as string, { recursive: true, force: true });
});

/**
 * Write `files` into a throwaway tree and resolve every link in it, in one
 * pass. Everything XREF-3 and XREF-4 claim is asserted through this — the
 * checker's own reported outcome — rather than through a helper call.
 */
function check(files: Record<string, string>): ReturnType<typeof checkLinks> {
  const root = mkdtempSync(join(tmpdir(), 'xref-'));
  fixtures.push(root);
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, 'utf8');
  }
  return checkLinks(root, ['.']);
}

const reasons = (files: Record<string, string>): string[] =>
  check(files).failures.map((f) => f.reason);

describe('XREF-3: link targets resolve', () => {
  it('resolves every relative link in the checked files', () => {
    const { failures, links, files } = checkLinks(repoRoot);

    expect(failures.map((f) => `${f.file}:${f.line} (${f.target}) — ${f.reason}`)).toEqual([]);
    // Guards against a checker that silently walks nothing: a zero-link
    // "pass" would satisfy the assertion above without checking anything.
    expect(files).toBeGreaterThan(50);
    expect(links).toBeGreaterThan(500);
  });

  it('catches a target file that does not exist', () => {
    expect(reasons({ 'a.md': '[x](./gone.md)' })[0]).toMatch(/no such file/);
  });

  // A target outside the repo resolves only where a sibling checkout happens
  // to sit. Two links into ../../../cligent/ passed for exactly that reason
  // and 404 for every other reader.
  it('catches a target that escapes the repository', () => {
    expect(reasons({ 'specs/a.md': '[x](../../elsewhere/b.md)' })).toEqual([
      expect.stringContaining('escapes the repository'),
    ]);
  });

  it('reports the citing file, line, and literal target', () => {
    const { failures } = check({ 'a.md': `${'\n'.repeat(41)}[x](./gone.md)` });
    expect(failures).toEqual([
      expect.objectContaining({ file: 'a.md', line: 42, target: './gone.md' }),
    ]);
  });

  it('does not resolve links inside fenced code blocks', () => {
    expect(reasons({ 'a.md': '```\n[x](./gone.md)\n```\n' })).toEqual([]);
    expect(reasons({ 'a.md': '~~~\n[x](./gone.md)\n~~~\n' })).toEqual([]);
  });

  // Two real cases: a DR quoting a deliberately-bad link as the defect it
  // records fixing, and meta.md's citation-syntax example.
  it('does not resolve links inside inline code spans', () => {
    expect(reasons({ 'a.md': 'cited `[GEARS](/specs/gone.md#item-syntax)` as the bug' })).toEqual(
      [],
    );
  });

  // Blanking code spans must not swallow a link whose TEXT is a code span —
  // the shape used throughout the IR deliverable checklists.
  it('still resolves a link whose text is a code span', () => {
    expect(reasons({ 'a.md': '- [x] [`gone.md`](./gone.md) — note' })[0]).toMatch(/no such file/);
  });

  it('does not resolve external or protocol-relative targets', () => {
    expect(
      reasons({ 'a.md': '[a](https://x.test) [b](mailto:x@x.test) [c](//x.test/y.md)' }),
    ).toEqual([]);
  });

  // Every CommonMark title form, because a form the regex cannot parse makes
  // the whole link invisible rather than merely mis-parsed.
  it('resolves a link carrying a title in any quoting style', () => {
    expect(reasons({ 'a.md': '[x](./gone.md "double")' })[0]).toMatch(/no such file/);
    expect(reasons({ 'a.md': "[x](./gone.md 'single')" })[0]).toMatch(/no such file/);
    expect(reasons({ 'a.md': '[x](./gone.md (paren))' })[0]).toMatch(/no such file/);
    expect(reasons({ 'a.md': "[x](<./gone.md> 'single')" })[0]).toMatch(/no such file/);
  });

  it('resolves a link reference definition, and reports its own line', () => {
    const { failures } = check({ 'a.md': 'one\ntwo\n\n[label]: ./gone.md\n' });
    expect(failures).toEqual([expect.objectContaining({ line: 4, target: './gone.md' })]);
  });

  // The XREF-6 definition-shape clause: unquoted prose after the destination
  // voids the CommonMark definition, so the line renders as the plain-text
  // footnote it was written as — the shape of the SLC phase specs' notes.
  it('reads no link from a definition whose destination is trailed by prose', () => {
    expect(
      reasons({ 'a.md': '[1]: GEARS definition shipped by the installed package\n' }),
    ).toEqual([]);
    const { failures } = check({ 'a.md': 'one\n\n[1]: ./target.md "title"\n' });
    expect(failures).toEqual([expect.objectContaining({ line: 3, target: './target.md' })]);
  });

  it('resolves a percent-encoded target, and survives a malformed escape', () => {
    expect(reasons({ 'a.md': '[x](./a%20b.md)', 'a b.md': 'ok\n' })).toEqual([]);
    expect(reasons({ 'a.md': '[x](./100%-done.md)' })[0]).toMatch(/no such file/);
  });

  it('resolves a leading-slash target from the repository root', () => {
    expect(reasons({ 'deep/a.md': '[x](/top.md)', 'top.md': 'ok\n' })).toEqual([]);
    expect(reasons({ 'deep/a.md': '[x](/gone.md)' })[0]).toMatch(/no such file/);
  });

  it('does not descend into the skipped directories', () => {
    expect(reasons({ 'node_modules/a.md': '[x](./gone.md)' })).toEqual([]);
    expect(reasons({ 'dist/a.md': '[x](./gone.md)' })).toEqual([]);
  });
});

describe('XREF-4: fragments match a rendered anchor', () => {
  // The PBCLI-36 bug: the path resolved to a file that DOES exist, just the
  // wrong one. File existence alone passes here; only the anchor catches it.
  // Both links resolve in ONE pass, so a cache keyed by basename rather than
  // by path would surface as a false positive on the corrected link.
  it('catches a wrong-group link whose target file exists but lacks the item', () => {
    expect(
      reasons({
        'test/release.md': '[a](playbook-cli.md#pbcli-36)\n[b](../user/playbook-cli.md#pbcli-36)',
        'test/playbook-cli.md': '### PBCLI-30\n',
        'user/playbook-cli.md': '### PBCLI-36\n',
      }),
    ).toEqual([expect.stringContaining('no anchor #pbcli-36 in test/playbook-cli.md')]);
  });

  // The DR-007 bug, end to end through a real heading.
  it('catches the single-hyphen spelling of an em-dash heading and names the fix', () => {
    const target = '# T\n\n### 11. Host adapter — tmux-play\n';
    expect(reasons({ 'a.md': '[s](./b.md#11-host-adapter-tmux-play)', 'b.md': target })).toEqual([
      expect.stringContaining('did you mean #11-host-adapter--tmux-play?'),
    ]);
    expect(reasons({ 'a.md': '[s](./b.md#11-host-adapter--tmux-play)', 'b.md': target })).toEqual(
      [],
    );
  });

  it('catches a broken same-file fragment', () => {
    expect(reasons({ 'a.md': '# Real\n\n[x](#not-real)' })[0]).toMatch(/no anchor #not-real/);
  });

  it('accepts a fragment on a target that is not markdown', () => {
    expect(reasons({ 'a.md': '[x](./s.yaml#anything)', 's.yaml': 'k: v\n' })).toEqual([]);
  });

  // No heading-slug collision exists anywhere in specs/ today, so this rule
  // has no coverage from real data.
  it('answers the second and third heading of one slug at -1 and -2', () => {
    const files = { 'b.md': '## Detail\n\n## Detail\n\n## Detail\n' };
    expect(reasons({ ...files, 'a.md': '[x](./b.md#detail-2)' })).toEqual([]);
    expect(reasons({ ...files, 'a.md': '[x](./b.md#detail-3)' })[0]).toMatch(/no anchor/);
  });

  it('resolves an explicit HTML id or name as an anchor', () => {
    expect(reasons({ 'a.md': '[x](./b.md#by-hand)', 'b.md': '<a name="by-hand"></a>\n' })).toEqual(
      [],
    );
    expect(reasons({ 'a.md': '[x](./b.md#by-id)', 'b.md': '<div id="by-id">t</div>\n' })).toEqual(
      [],
    );
  });

  it('mints no anchor from an HTML tag quoted inside a code span', () => {
    expect(
      reasons({ 'a.md': '[x](./b.md#ghost)', 'b.md': 'write `<a id="ghost">` inline\n' })[0],
    ).toMatch(/no anchor #ghost/);
  });
});

describe('slug derivation matches GitHub', () => {
  // The bug this whole check exists for: an em dash is dropped but the two
  // spaces that flanked it are not, so the slug carries a DOUBLE hyphen.
  // A slugger that collapses hyphen runs returns the single-hyphen spelling
  // and accepts the broken link.
  it('leaves a double hyphen where an em dash stood between spaces', () => {
    expect(slugify('11. Host adapter — tmux-play')).toBe('11-host-adapter--tmux-play');
    expect(slugify('11. Host adapter — tmux-play')).not.toBe('11-host-adapter-tmux-play');
  });

  it('drops backticks, section signs, colons, periods and parentheses', () => {
    expect(slugify('10. Emitted module — `code.playbook.ts`')).toBe(
      '10-emitted-module--codeplaybookts',
    );
    expect(slugify('META: Spec Definition')).toBe('meta-spec-definition');
    expect(slugify('A1. §8 quiescent values (per DR-005)')).toBe(
      'a1-8-quiescent-values-per-dr-005',
    );
  });

  it('keeps hyphens and underscores, which are the only surviving punctuation', () => {
    expect(slugify('2. New typed event BOSS_REPLY')).toBe('2-new-typed-event-boss_reply');
    expect(slugify('PBCLI-36')).toBe('pbcli-36');
  });

  // GitHub slugs a heading's RENDERED text, and a code span renders verbatim,
  // so markdown and HTML syntax inside one is content — not syntax to strip.
  it('renders a code span verbatim instead of stripping syntax inside it', () => {
    expect(slugify('`playbooks.<id>` routing')).toBe('playbooksid-routing');
    expect(slugify('Use `[META-1](meta.md#meta-1)` syntax')).toBe('use-meta-1metamdmeta-1-syntax');
  });

  it('strips only real HTML tags, leaving comparison operators as prose', () => {
    expect(slugify('When count < limit and retries > 0')).toBe('when-count--limit-and-retries--0');
    // A real tag renders away; the same text quoted in a span does not.
    expect(slugify('The <details> element')).toBe('the--element');
    expect(slugify('The `<details>` element')).toBe('the-details-element');
  });

  it('renders a markdown link in a heading as its text', () => {
    expect(anchorsOf('## See [the map](map.md)\n')).toContain('see-the-map');
  });
});
