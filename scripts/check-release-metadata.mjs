// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_HEADING = /^## \[([^\]]+)\](?: - (.*))?$/;
const GROUP_HEADING = /^###\s+(.+?)\s*$/;
const LINK_DEFINITION = /^\[([^\]]+)\]:\s+(\S+)\s*$/;
const PROJECT_URL = 'https://github.com/sublang-ai/playbook';

const CHANGELOG_GROUPS = [
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
];

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

function parseManifestVersion(manifestText) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(
      `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof manifest?.version !== 'string') {
    throw new Error('package.json has no string version');
  }
  return manifest.version;
}

/** Validate the hosted-release tag against the package manifest. */
export function validateReleaseTag({ tag, manifestText }) {
  const tagMatch = RELEASE_TAG.exec(tag);
  if (tagMatch === null) {
    throw new Error(`release tag is not exact stable SemVer: ${tag}`);
  }
  const version = tag.slice(1);
  const manifestVersion = parseManifestVersion(manifestText);
  if (manifestVersion !== version) {
    throw new Error(
      `release tag ${tag} does not match package.json version ${manifestVersion}`,
    );
  }
  return version;
}

/** Validate one hosted release and return its opaque GitHub Release notes. */
export function validateReleaseMetadata({ tag, manifestText, changelogText }) {
  const version = validateReleaseTag({ tag, manifestText });

  const lines = changelogText.replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  for (let index = 0; index < lines.length; index++) {
    const heading = RELEASE_HEADING.exec(lines[index]);
    if (heading !== null) {
      sections.push({ index, version: heading[1], date: heading[2] });
    }
  }
  const matches = sections.filter((section) => section.version === version);
  if (matches.length !== 1) {
    throw new Error(
      `CHANGELOG.md must contain exactly one section for version ${version}`,
    );
  }
  const section = matches[0];
  const unreleased = sections.filter(
    (candidate) => candidate.version === 'Unreleased',
  );
  if (
    unreleased.length !== 1 ||
    unreleased[0].date !== undefined ||
    sections[0] !== unreleased[0] ||
    sections[1] !== section
  ) {
    throw new Error(
      `CHANGELOG.md must keep one undated Unreleased section directly before ${version}`,
    );
  }
  if (section.date === undefined || !validDate(section.date)) {
    throw new Error(
      `CHANGELOG.md section ${version} must have a valid YYYY-MM-DD release date`,
    );
  }

  const nextSection = sections.find((candidate) => candidate.index > section.index);
  if (
    nextSection === undefined ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
      nextSection.version,
    )
  ) {
    throw new Error(
      `CHANGELOG.md section ${version} must precede a stable prior release`,
    );
  }

  const linkDefinitions = [];
  for (const line of lines) {
    const definition = LINK_DEFINITION.exec(line);
    if (definition !== null) {
      linkDefinitions.push({ name: definition[1], target: definition[2] });
    }
  }
  const requireComparisonLink = (name, target) => {
    const matching = linkDefinitions.filter(
      (definition) => definition.name === name,
    );
    if (matching.length !== 1 || matching[0].target !== target) {
      throw new Error(
        `CHANGELOG.md must define [${name}] exactly as ${target}`,
      );
    }
  };
  requireComparisonLink(
    'Unreleased',
    `${PROJECT_URL}/compare/v${version}...HEAD`,
  );
  requireComparisonLink(
    version,
    `${PROJECT_URL}/compare/v${nextSection.version}...v${version}`,
  );

  const body = lines.slice(section.index + 1, nextSection?.index ?? lines.length);
  const groups = [];
  for (let index = 0; index < body.length; index++) {
    const heading = GROUP_HEADING.exec(body[index]);
    if (heading !== null) groups.push({ index, name: heading[1] });
  }
  if (groups.length === 0) {
    throw new Error(`CHANGELOG.md section ${version} has no change-group headings`);
  }

  let previousGroup = -1;
  for (let ordinal = 0; ordinal < groups.length; ordinal++) {
    const group = groups[ordinal];
    const groupIndex = CHANGELOG_GROUPS.indexOf(group.name);
    if (groupIndex === -1) {
      throw new Error(
        `CHANGELOG.md section ${version} uses unsupported heading ${group.name}`,
      );
    }
    if (groupIndex <= previousGroup) {
      throw new Error(
        `CHANGELOG.md section ${version} headings are duplicated or out of order at ${group.name}`,
      );
    }
    previousGroup = groupIndex;

    const nextGroup = groups[ordinal + 1];
    const entries = body.slice(group.index + 1, nextGroup?.index ?? body.length);
    if (!entries.some((line) => line.trim() !== '')) {
      throw new Error(
        `CHANGELOG.md section ${version} heading ${group.name} has no notes`,
      );
    }
  }

  const notes = body.join('\n').trim();
  if (notes === '') {
    throw new Error(`CHANGELOG.md section ${version} has no release notes`);
  }
  return { version, notes: `${notes}\n` };
}

async function main(argv) {
  if (argv.length === 2 && argv[0] === '--tag-only') {
    const manifestText = await readFile(resolve('package.json'), 'utf8');
    validateReleaseTag({ tag: argv[1], manifestText });
    return;
  }
  if (argv.length !== 2) {
    throw new Error(
      'usage: check-release-metadata.mjs --tag-only <vMAJOR.MINOR.PATCH> | ' +
        '<vMAJOR.MINOR.PATCH> <notes-file>',
    );
  }
  const [tag, notesPath] = argv;
  const [manifestText, changelogText] = await Promise.all([
    readFile(resolve('package.json'), 'utf8'),
    readFile(resolve('CHANGELOG.md'), 'utf8'),
  ]);
  const { notes } = validateReleaseMetadata({ tag, manifestText, changelogText });
  await writeFile(resolve(notesPath), notes, 'utf8');
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
