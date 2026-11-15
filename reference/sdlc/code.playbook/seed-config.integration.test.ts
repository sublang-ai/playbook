// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { seedConfigText } from './seed-config.js';

const modelDefaults = vi.hoisted(() => vi.fn());
vi.mock('@sublang/cligent', async (load) => ({
  ...await load<typeof import('@sublang/cligent')>(),
  defaultAgentModels: modelDefaults,
}));

describe('model selection in the public seed', () => {
  const env = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' };
  const homeDir = '/isolated/seed-home';
  it('uses the installed runtime’s pair for each credential-selected adapter', () => {
    modelDefaults.mockImplementation(adapter => adapter === 'claude'
      ? { model: 'claude-fable-5-2', subagentModel: 'claude-opus-5-5' }
      : { model: 'gpt-6-astra', subagentModel: 'gpt-6.1-sol' });
    const { captain, players } = parse(seedConfigText({ env, homeDir }).text);
    expect(modelDefaults).toHaveBeenCalledWith('claude', env, homeDir);
    expect(captain).toMatchObject({ model: 'claude-fable-5-2', subagentModel: 'claude-opus-5-5' });
    expect(players['dev.reviewer']).toMatchObject({ model: 'gpt-6-astra', subagentModel: 'gpt-6.1-sol' });
  });
  it('keeps a host’s credential projection separate from its already-resolved provider environment', () => {
    const modelEnv = { ANTHROPIC_BASE_URL: 'https://provider.example' };
    modelDefaults.mockReturnValue({});
    const { captain, players } = parse(seedConfigText({ env, homeDir, modelEnv }).text);
    expect(modelDefaults).toHaveBeenCalledWith('claude', modelEnv, undefined);
    expect(modelDefaults).toHaveBeenCalledWith('codex', modelEnv, undefined);
    expect(captain.adapter).toBe('claude');
    expect(players['dev.reviewer'].adapter).toBe('codex');
    for (const agent of [captain, ...Object.values(players)]) {
      expect(agent).not.toHaveProperty('model');
      expect(agent).not.toHaveProperty('subagentModel');
    }
  });
});
