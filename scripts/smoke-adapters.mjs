#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Copy into installed Cligent so all probes start at the adapter's module owner.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';
import { agentRuntimeTargets, classifyRuntime, describeRuntimeReadiness, locateAgentExecutable } from '@sublang/cligent';

const [expectation, allowedRoot] = process.argv.slice(2);
if (!['available', 'missing-codex', 'missing-claude'].includes(expectation) || !allowedRoot)
  throw Error('usage: smoke-adapters.mjs <available|missing-codex|missing-claude> <owned-root>');
const root = realpathSync(allowedRoot), owner = realpathSync(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const owned = (path) => { const rel = relative(root, realpathSync(path)); if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) throw Error('SDK/native lookup escaped installed owner tree'); };
owned(owner);
const records = [];
for (const [id, name, adapter] of [
  ['claude', '@anthropic-ai/claude-agent-sdk', new ClaudeCodeAdapter()],
  ['codex', '@openai/codex-sdk', new CodexAdapter()],
]) {
  const want = expectation !== 'missing-' + id;
  const available = await adapter.isAvailable();
  if (available !== want) throw Error(id + ' SDK availability mismatch');
  const target = agentRuntimeTargets().find(target => target.package === name);
  if (!target) throw Error('Cligent omitted the SDK runtime target');
  const readiness = classifyRuntime(target, available);
  if (want && !['satisfied', 'untested'].includes(readiness.state)) throw Error('Installed SDK is not supported/loadable');
  if (!want && (readiness.state !== 'missing' || !readiness.repair.spec.startsWith(name + '@')))
    throw Error('Damaged SDK lacks the real pre-Agent repair verdict');
  let sdkRoot = null, native = null;
  if (want) {
    for (const base of require.resolve.paths(name) ?? []) {
      try { const file = join(base, name, 'package.json'); if (JSON.parse(readFileSync(file)).name === name) { sdkRoot = realpathSync(dirname(file)); break; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!sdkRoot) throw Error('SDK manifest is unreachable from Cligent');
    owned(sdkRoot);
    native = locateAgentExecutable(id);
    if (native.state !== 'present') throw Error('SDK-owned native executable missing');
    owned(native.path);
  }
  records.push({ id, sdk: name, available, sdkRoot, native, readiness,
    diagnostic: describeRuntimeReadiness(readiness),
    nativeSHA256: native ? createHash('sha256').update(readFileSync(native.path)).digest('hex') : null });
}
console.log(JSON.stringify({ owner, cligentVersion: JSON.parse(readFileSync(join(owner, 'package.json'))).version,
  allowedRoot: root, expectation, records }));
