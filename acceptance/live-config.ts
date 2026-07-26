// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The top-level config the live release gate writes for its fixture repos.
// It lives here, apart from the gate itself, so an ordinary test in the
// normal suite can assert it still composes: the gate is excluded from
// `pnpm test` and CI, so a config-model change would otherwise break the
// release gate silently and only surface during a manual pre-tag run.

export function liveConfig(): string {
  const claudeModel =
    process.env.PLAYBOOK_ACCEPTANCE_CLAUDE_MODEL ?? 'claude-opus-4-8';
  const codexModel =
    process.env.PLAYBOOK_ACCEPTANCE_CODEX_MODEL ?? 'gpt-5.5';
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
