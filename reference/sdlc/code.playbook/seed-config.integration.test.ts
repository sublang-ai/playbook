// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { seedConfigText } from './seed-config.js';

describe('model selection in the public seed', () => {
  const env = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' };
  const homes: string[] = [];
  afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

  it('keeps the adapter lineup when a host supplies a separate custom Claude route', () => {
    const { captain, players } = parse(seedConfigText({
      env, homeDir: '/unused/credentials', modelEnv: { ANTHROPIC_BASE_URL: 'https://provider.example' },
    }).text);
    expect(captain.adapter).toBe('claude');
    expect(captain).not.toHaveProperty('model');
    expect(captain).not.toHaveProperty('subagentModel');
    expect(players['dev.reviewer']).toMatchObject({ adapter: 'codex', model: 'gpt-6-astra', subagentModel: 'gpt-6.1-sol' });
  });

  it('reads the custom Codex provider from a local user home or an explicitly scoped server seat', async () => {
    const home = await mkdtemp(join(tmpdir(), 'playbook-seed-'));
    homes.push(home);
    const codexHome = join(home, '.codex');
    await mkdir(codexHome);
    await writeFile(join(codexHome, 'config.toml'), 'model_provider = "azure"\n');
    const unscoped = parse(seedConfigText({ env, homeDir: home, modelEnv: {} }).text);
    expect(unscoped.players['dev.reviewer']).toMatchObject({ model: 'gpt-6-astra', subagentModel: 'gpt-6.1-sol' });
    for (const options of [{ env, homeDir: home }, { env, homeDir: '/unused/credentials', modelEnv: {}, modelHome: home },
      { env, homeDir: '/unused/credentials', modelEnv: {}, modelHome: { codexHome } }]) {
      const { captain, players } = parse(seedConfigText(options).text);
      expect(captain).toMatchObject({ adapter: 'claude', model: 'claude-fable-5-2', subagentModel: 'claude-opus-5-5' });
      expect(players['dev.reviewer'].adapter).toBe('codex');
      expect(players['dev.reviewer']).not.toHaveProperty('model');
      expect(players['dev.reviewer']).not.toHaveProperty('subagentModel');
    }
  });
});
