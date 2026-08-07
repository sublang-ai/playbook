// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The top-level configs the live release gate writes for its fixture repos.
// They live here, apart from the gate itself, so an ordinary test in the
// normal suite can assert they still compose: the gate is excluded from
// `pnpm test` and CI, so a config-model change would otherwise break the
// release gate silently and only surface during a manual pre-tag run.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function liveModels(): { claude: string; codex: string } {
  return {
    claude:
      process.env.PLAYBOOK_ACCEPTANCE_CLAUDE_MODEL ?? 'claude-opus-4-8',
    codex: process.env.PLAYBOOK_ACCEPTANCE_CODEX_MODEL ?? 'gpt-5.5',
  };
}

export function liveConfig(): string {
  const { claude: claudeModel, codex: codexModel } = liveModels();
  // DR-021: agent settings are inline per captain and player; a config
  // carrying a `profiles` map is rejected by the launcher.
  const claudePlayer = (effort: string): string[] => [
    '        adapter: claude',
    `        model: ${JSON.stringify(claudeModel)}`,
    `        effort: ${effort}`,
    '        permissions:',
    '          mode: auto',
  ];
  const codexPlayer = (effort: string): string[] => [
    '        adapter: codex',
    `        model: ${JSON.stringify(codexModel)}`,
    `        effort: ${effort}`,
    '        permissions:',
    '          mode: auto',
    "          writablePaths: ['.git']",
  ];
  return [
    'captain:',
    '  adapter: claude',
    `  model: ${JSON.stringify(claudeModel)}`,
    '  effort: high',
    '  permissions:',
    '    mode: auto',
    'notifications:',
    '  player_finished: off',
    '  turn_finished: off',
    '  turn_aborted: off',
    'playbooks:',
    '  code:',
    '    from: "@sublang/playbook/code/registry"',
    '    players:',
    '      coder:',
    ...claudePlayer('xhigh'),
    '      reviewer:',
    ...codexPlayer('xhigh'),
    '    committer: coder',
    '  discuss:',
    '    from: "@sublang/playbook/discuss/registry"',
    '    players:',
    '      host:',
    ...claudePlayer('xhigh'),
    '      participant:',
    ...codexPlayer('xhigh'),
    '    committer: host',
    '',
  ].join('\n');
}

// RELEASE-25 fifth case: the config that enables exactly the two fixture
// playbooks the conversational session engages (`live-fixtures.ts`). The
// Captain block matches `liveConfig`'s own; the fixtures need no player call
// at all, but the launcher requires each playbook to resolve at least one
// visible role, so one claude role is bound and never used.
export function conversationConfig(repo: string): string {
  const { claude: claudeModel } = liveModels();
  const fixture = (id: string, file: string): string[] => [
    `  ${id}:`,
    `    from: ${JSON.stringify(pathToFileURL(join(repo, file)).href)}`,
    '    players:',
    '      worker:',
    '        adapter: claude',
    `        model: ${JSON.stringify(claudeModel)}`,
    '        effort: low',
    '        permissions:',
    '          mode: auto',
  ];
  return [
    'captain:',
    '  adapter: claude',
    `  model: ${JSON.stringify(claudeModel)}`,
    '  effort: high',
    '  permissions:',
    '    mode: auto',
    'notifications:',
    '  player_finished: off',
    '  turn_finished: off',
    '  turn_aborted: off',
    'playbooks:',
    ...fixture('checklist', 'checklist.registry.mjs'),
    ...fixture('notes', 'notes.registry.mjs'),
    '',
  ].join('\n');
}
