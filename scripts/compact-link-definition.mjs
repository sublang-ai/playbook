#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Rejected experiment reproduction, not a compiler phase. Rebase Markdown destinations only;
// fenced code and the full normative contract otherwise remain byte-identical.
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorsOf, linksOf } from './check-links.mjs';

export function rebaseContract(text, reverse = false) {
  const lines = text.split('\n');
  for (const { line, target } of linksOf(text)) {
    if (target.startsWith('#') || target.startsWith('/')) continue;
    const next = reverse ? target.replace(/^\.\.\//, '') : `../${target}`;
    const index = line - 1;
    // linksOf supplies only parsed Markdown targets outside code fences/spans.
    // Replace the delimited destination, never matching prose or code imports.
    lines[index] = lines[index].replace(`](${target})`, `](${next})`)
      .replace(new RegExp(`^( {0,3}\\[[^\\]]+\\]:\\s*)${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`), `$1${next}`);
  }
  return lines.join('\n');
}

export function compactDefinition(full, recipe) {
  const compiled = full.slice(full.indexOf('## Compiled execution\n'), full.indexOf('## References\n'));
  const present = anchorsOf(recipe + compiled);
  const pointers = [...anchorsOf(full)].filter((anchor) => !present.has(anchor))
    .map((anchor) => `<a id="${anchor}"></a>\n[Full contract: ${anchor}](references/link-contract.md#${anchor})`).join('\n\n');
  return `${recipe}${compiled}## Full contract references\n\n${pointers}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, target, recipePath] = process.argv.slice(2);
  if (!source || !target) throw new Error('Usage: compact-link-definition.mjs <full-definition-dir> <new-definition-dir> [recipe.md]');
  if (resolve(source) === resolve(target)) throw new Error('Source and target must differ');
  const full = await readFile(join(source, 'link.md'), 'utf8');
  const recipeSource = await readFile(recipePath ?? new URL('./experiments/rejected-compact-link.md', import.meta.url), 'utf8');
  const recipe = recipeSource.split('## Compiled execution\n')[0];
  const companion = rebaseContract(full);
  if (rebaseContract(companion, true) !== full) throw new Error('Contract relocation is not reversible');
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
  await mkdir(join(target, 'references'), { recursive: true });
  await writeFile(join(target, 'references/link-contract.md'), companion);
  await writeFile(join(target, 'link.md'), compactDefinition(full, recipe));
  const sidecarPath = join(target, 'slc.pin-inputs.json');
  const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'));
  sidecar.closures.link = [...new Set([...sidecar.closures.link, 'materialize-link.mjs', 'references/link-contract.md'])];
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ target: resolve(target), fullBytes: Buffer.byteLength(full), compactBytes: Buffer.byteLength(compactDefinition(full, recipe)) }) + '\n');
}
