// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  validateReleaseMetadata,
  validateReleaseTag,
} from '../scripts/check-release-metadata.mjs';

const manifest = (version = '6.2.1'): string =>
  JSON.stringify({ name: '@sublang/playbook', version });

const changelog = (body: string, heading = '## [6.2.1] - 2026-08-11'): string =>
  `# Changelog\n\n## [Unreleased]\n\n${heading}\n\n${body}\n\n## [6.2.0] - 2026-08-01\n\n### Fixed\n\n- Earlier fix.\n\n[Unreleased]: https://github.com/sublang-ai/playbook/compare/v6.2.1...HEAD\n[6.2.1]: https://github.com/sublang-ai/playbook/compare/v6.2.0...v6.2.1\n`;

describe('hosted release metadata', () => {
  it('extracts a dated version section with nonempty allowed headings in order', () => {
    const result = validateReleaseMetadata({
      tag: 'v6.2.1',
      manifestText: manifest(),
      changelogText: changelog(
        '### Added\n\n- New behavior.\n\n### Changed\n\nRelease wording.\n\n### Fixed\n\n- Correctness fix.',
      ),
    });

    expect(result).toEqual({
      version: '6.2.1',
      notes:
        '### Added\n\n- New behavior.\n\n### Changed\n\nRelease wording.\n\n### Fixed\n\n- Correctness fix.\n',
    });
  });

  it.each([
    'v6',
    'v6.2',
    'v6.2.1-beta.1',
    'v06.2.1',
    'release-v6.2.1',
    'v6.2.1/extra',
  ])('rejects non-exact stable SemVer tag %s', (tag) => {
    expect(() =>
      validateReleaseMetadata({
        tag,
        manifestText: manifest(),
        changelogText: changelog('### Fixed\n\n- Correctness fix.'),
      }),
    ).toThrow(/not exact stable SemVer/);
  });

  it('rejects a tag that differs from the manifest version', () => {
    expect(() =>
      validateReleaseMetadata({
        tag: 'v6.2.1',
        manifestText: manifest('6.2.0'),
        changelogText: changelog('### Fixed\n\n- Correctness fix.'),
      }),
    ).toThrow('does not match package.json version 6.2.0');
  });

  it('validates the tag and manifest before reading release notes', () => {
    expect(
      validateReleaseTag({ tag: 'v6.2.1', manifestText: manifest() }),
    ).toBe('6.2.1');
  });

  it.each([
    ['an undated section', '## [6.2.1]'],
    ['an impossible date', '## [6.2.1] - 2026-02-30'],
  ])('rejects %s', (_label, heading) => {
    expect(() =>
      validateReleaseMetadata({
        tag: 'v6.2.1',
        manifestText: manifest(),
        changelogText: changelog('### Fixed\n\n- Correctness fix.', heading),
      }),
    ).toThrow(/valid YYYY-MM-DD release date/);
  });

  it.each([
    ['an unsupported heading', '### Added\n\n- Addition.\n\n### Notes\n\n- Other.'],
    ['out-of-order headings', '### Fixed\n\n- Fix.\n\n### Changed\n\n- Change.'],
    ['a duplicate heading', '### Added\n\n- One.\n\n### Added\n\n- Two.'],
    ['an empty group', '### Added\n\n### Fixed\n\n- Fix.'],
  ])('rejects %s', (_label, body) => {
    expect(() =>
      validateReleaseMetadata({
        tag: 'v6.2.1',
        manifestText: manifest(),
        changelogText: changelog(body),
      }),
    ).toThrow();
  });

  it.each([
    [
      'a missing Unreleased section',
      changelog('### Fixed\n\n- Fix.').replace('## [Unreleased]\n\n', ''),
    ],
    [
      'a misplaced Unreleased section',
      changelog('### Fixed\n\n- Fix.')
        .replace('## [Unreleased]\n\n', '')
        .replace('## [6.2.0]', '## [Unreleased]\n\n## [6.2.0]'),
    ],
    [
      'a stale Unreleased comparison link',
      changelog('### Fixed\n\n- Fix.').replace(
        'compare/v6.2.1...HEAD',
        'compare/v6.2.0...HEAD',
      ),
    ],
    [
      'a missing version comparison link',
      changelog('### Fixed\n\n- Fix.').replace(
        '[6.2.1]: https://github.com/sublang-ai/playbook/compare/v6.2.0...v6.2.1\n',
        '',
      ),
    ],
  ])('rejects %s', (_label, changelogText) => {
    expect(() =>
      validateReleaseMetadata({
        tag: 'v6.2.1',
        manifestText: manifest(),
        changelogText,
      }),
    ).toThrow();
  });

  it('keeps the hosted workflow narrowed and validates before publishing', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/release.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain("tags: ['v[0-9]+.[0-9]+.[0-9]+']");
    expect(workflow).not.toContain("tags: ['v[0-9]*']");

    const orderedSteps = [
      'run: node scripts/check-release-metadata.mjs --tag-only "$GITHUB_REF_NAME"',
      'run: rm -f pnpm-workspace.yaml',
      'run: pnpm install --frozen-lockfile',
      'run: pnpm build',
      '- name: Verify .ts and compiled siblings are in sync',
      'run: pnpm test',
      'run: node scripts/check-release-metadata.mjs "$GITHUB_REF_NAME" /tmp/release-notes.md',
      'run: npm publish --provenance --access public',
      'run: gh release create "$GITHUB_REF_NAME"',
    ];
    const positions = orderedSteps.map((step) => workflow.indexOf(step));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(workflow).toContain('id-token: write');
    expect(workflow).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./i);
  });
});
