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

export function liveConfig(
  options: { readonly reviewerInstruction?: string } = {},
): string {
  const { claude: claudeModel, codex: codexModel } = liveModels();
  // DR-021: agent settings are inline per captain and player; a config
  // carrying a `profiles` map is rejected by the launcher.
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
    'players:',
    '  acceptance.dev.coder:',
    '    adapter: claude',
    `    model: ${JSON.stringify(claudeModel)}`,
    '    effort: xhigh',
    '    permissions:',
    '      mode: auto',
    '  acceptance.dev.reviewer:',
    '    adapter: codex',
    `    model: ${JSON.stringify(codexModel)}`,
    '    effort: xhigh',
    ...(options.reviewerInstruction === undefined
      ? []
      : [`    instruction: ${JSON.stringify(options.reviewerInstruction)}`]),
    '    permissions:',
    '      mode: auto',
    "      writablePaths: ['.git']",
    'playbooks:',
    '  code:',
    '    from: "@sublang/playbook/code/registry"',
    '    roles: { coder: acceptance.dev.coder }',
    '  review:',
    '    from: "@sublang/playbook/review/registry"',
    '    roles: { coder: acceptance.dev.coder, reviewer: acceptance.dev.reviewer }',
    '  decide:',
    '    from: "@sublang/playbook/decide/registry"',
    '    roles: { coder: acceptance.dev.coder, reviewer: acceptance.dev.reviewer }',
    '',
  ].join('\n');
}

// RELEASE-25 selected DECIDE continuation: only compatible execution tuning
// changes. Fixed adapters, instruction, permissions, roles, and player ids
// remain supplied by the primary config and therefore stay structural.
export function liveRetuneOverlay(): string {
  return [
    'captain:',
    '  effort: low',
    '  fastMode: false',
    'players:',
    '  acceptance.dev.coder:',
    '    effort: high',
    '    fastMode: true',
    '  acceptance.dev.reviewer:',
    '    effort: high',
    '    fastMode: false',
    'playbooks:',
    '  decide:',
    '    roles:',
    '      reviewer: { player: acceptance.dev.reviewer, model: false, effort: false, fastMode: true }',
    '',
  ].join('\n');
}

// RELEASE-25 fourth case: the globally installed candidate resolves this
// filesystem registry through the same shared config and Captain path as any
// other headless command. Keeping the exact config here lets the normal suite
// compose it without spending a model call (PBCLI-32).
export function hermeticConfig(repo: string): string {
  const { claude: claudeModel, codex: codexModel } = liveModels();
  return [
    'captain:',
    '  adapter: codex',
    `  model: ${JSON.stringify(codexModel)}`,
    '  effort: low',
    '  permissions:',
    '    mode: auto',
    "    writablePaths: ['.git']",
    'notifications:',
    '  player_finished: off',
    '  turn_finished: off',
    '  turn_aborted: off',
    'players:',
    '  release.worker:',
    '    adapter: claude',
    `    model: ${JSON.stringify(claudeModel)}`,
    '    effort: low',
    '    permissions:',
    '      mode: auto',
    'playbooks:',
    '  hermetic:',
    `    from: ${JSON.stringify(
      pathToFileURL(join(repo, 'hermetic.playbook.mjs')).href,
    )}`,
    '    roles: { worker: release.worker }',
    '',
  ].join('\n');
}

// RELEASE-25 fifth case: the config that enables exactly the two fixture
// playbooks the conversational session engages (`live-fixtures.ts`). The
// Captain block matches `liveConfig`'s own; these fixtures delegate no player
// work, so their exact role maps are empty. The unreferenced player remains a
// valid authored default but does not enter the normalized session roster.
export function conversationConfig(repo: string): string {
  const { claude: claudeModel } = liveModels();
  const fixture = (id: string, file: string): string[] => [
    `  ${id}:`,
    `    from: ${JSON.stringify(pathToFileURL(join(repo, file)).href)}`,
    '    roles: {}',
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
    'players:',
    '  release.worker:',
    '    adapter: claude',
    `    model: ${JSON.stringify(claudeModel)}`,
    '    effort: low',
    '    permissions:',
    '      mode: auto',
    'playbooks:',
    ...fixture('checklist', 'checklist.registry.mjs'),
    ...fixture('notes', 'notes.registry.mjs'),
    '',
  ].join('\n');
}
