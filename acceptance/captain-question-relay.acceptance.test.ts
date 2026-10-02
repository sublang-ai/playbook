// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';
import { questionRegistry } from '../acceptance-fixtures/captain-question-flow.js';
import { createSessionStore } from '../reference/sdlc/code.playbook/session-store.js';
import { openSessionHost } from '../reference/sdlc/code.playbook/session-host.js';
import { loadLaunchPlan } from '../reference/sdlc/code.playbook/bin/launch-config.js';
import { executionConfigFromPlan } from '../reference/sdlc/code.playbook/bin/run.js';
import { runPlaybookCli } from '../reference/sdlc/code.playbook/bin/playbook.js';
import { liveModels } from './live-config.js';

class LocalClaude extends ClaudeCodeAdapter {
  constructor() {
    super({ loadSdk: async () => {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      return { query: ({ prompt, options }: any) => sdk.query({ prompt, options: {
        ...options,
        ...(process.env.PLAYBOOK_ACCEPTANCE_CLAUDE_PATH ? { pathToClaudeCodeExecutable: process.env.PLAYBOOK_ACCEPTANCE_CLAUDE_PATH } : {}),
      } }) } as any;
    } });
  }
}
it.each(['SDK', 'CLI'])('Boss clarifies, reopens, and answers using only Captain replies through %s', async (frontend) => {
  const root = await mkdtemp(join(tmpdir(), 'captain-question-live-'));
  const cwd = join(root, 'repo'); await mkdir(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd });
  const configPath = join(root, 'config.yaml');
  const { claude, codex } = liveModels();
  await writeFile(configPath, `captain:
  adapter: claude
  model: ${JSON.stringify(claude)}
  effort: low
  permissions: { mode: auto }
notifications: { player_finished: off, turn_finished: off, turn_aborted: off }
players:
  worker:
    adapter: codex
    model: ${JSON.stringify(codex)}
    effort: low
    permissions: { mode: auto }
playbooks:
  question-flow:
    from: mod://question-flow
    roles: { worker: worker }
`);
  const loadModule = async () => ({ default: questionRegistry });
  const plan = await loadLaunchPlan({ userConfigPath: configPath, loadModule });
  const config = executionConfigFromPlan(plan);
  const store = createSessionStore({ sessionsDir: join(root, 'sessions') });
  const records: any[] = [];
  const options = { store, config, loadModule, adapterImports: {
    claude: async () => LocalClaude, codex: async () => CodexAdapter,
  } as never, observers: [{ onRecord: (record: any) => { records.push(record); } }] };
  let cliTurn = 0;
  async function openTestHost(sessionId?: string) {
    if (frontend === 'SDK') return openSessionHost({ ...options, cwd,
      ...(sessionId ? { mode: 'continue' as const, sessionId } : { mode: 'new' as const }),
    });
    return {
      get sessionId() { return sessionId!; },
      async dispose() { /* Each CLI invocation releases its own lease. */ },
      async handleBossTurn(input: string) {
        const json = ++cliTurn % 2 === 0;
        let stdout = '', stderr = '';
        const result = await runPlaybookCli({
          argv: ['run', ...(sessionId ? ['--session', sessionId] : []), ...(json ? ['--json'] : []), input],
          cwd, userConfigPath: configPath, sessionStore: store, loadModule,
          adapterImports: options.adapterImports,
          stdout: { write(text: string) { stdout += text; return true; } },
          stderr: { write(text: string) { stderr += text; return true; } },
        });
        expect(result.code, stderr).toBe(0);
        sessionId = result.sessionId;
        const stored = await store.readStream(sessionId!);
        records.splice(0, records.length, ...stored.entries.map(entry => entry.record));
        expect(stdout).toBe(`${json ? JSON.stringify({ sessionId, reply: result.reply }) : result.reply}\n`);
        expect(result.reply).toBe(records.filter(record => record.type === 'captain_reply').at(-1)?.text);
        expect(stderr).not.toContain('execution topology');
        return result.record;
      },
    };
  }
  let controller = await openTestHost();
  const replies = () => records.filter(record => record.type === 'captain_reply').map(record => record.text);
  console.log(`Captain conversation evidence: ${root}`);
  try {
    const first = await controller.handleBossTurn('/question-flow Help me choose preview or production. Explain the choices briefly in plain English; do not choose for me.');
    expect(first.snapshot.mode).toBe('engaged.parked');
    expect(first.effectLedger.boundaries).toHaveLength(1);
    const firstReply = replies().at(-1)!;
    console.log(`Initial Captain reply: ${firstReply}`);
    expect(firstReply).toMatch(/preview/i);
    expect(firstReply).toMatch(/seven|7/i);
    expect(firstReply).toMatch(/delet|remov|lost|los[et]|erased/i);
    expect(firstReply).toMatch(/production/i);
    expect(firstReply).toMatch(/approv/i);
    expect(firstReply).not.toMatch(/execution topology|compatibility envelope|ephemeral/i);
    expect(firstReply.length).toBeLessThan(650);
    expect(firstReply.trim().split(/\s+/).length).toBeLessThanOrEqual(65);
    const before = JSON.stringify(first.snapshot.frames);
    const clarification = await controller.handleBossTurn('Captain, explain what happens to preview data after a week. I am not choosing yet.');
    expect(clarification.snapshot.lastAction).toBe('respond');
    expect(JSON.stringify(clarification.snapshot.frames)).toBe(before);
    console.log(`Captain clarification: ${replies().at(-1)}`);
    const id = controller.sessionId;
    await controller.dispose();
    controller = await openTestHost(id);
    const followUp = await controller.handleBossTurn('Please ask the worker to confirm whether preview deletes all its data after seven days. Do not choose an option yet.');
    expect(followUp.effectLedger.boundaries).toHaveLength(2);
    expect(records.filter(record => record.type === 'player_prompt').at(-1)?.prompt).toContain('Please ask the worker to confirm whether preview deletes all its data after seven days. Do not choose an option yet.');
    expect(followUp.snapshot.mode).toBe('engaged.parked');
    console.log(`Relayed worker answer: ${replies().at(-1)}`);
    const final = await controller.handleBossTurn('Use preview. I accept deletion of all preview data after seven days.');
    expect(final.snapshot.lastAction).toBe('deliver');
    expect(final.snapshot.mode).toBe('chat');
    expect(final.snapshot.lastSettlementStatus).toBe('ok');
    console.log(`Final Captain reply: ${replies().at(-1)}`);
    expect(records.filter(record => record.type === 'captain_status').some(record => record.data?.kind === 'boss-question')).toBe(false);
    await writeFile(join(root, 'captain-replies.json'), JSON.stringify(replies(), null, 2));
    await writeFile(join(root, 'final.json'), JSON.stringify(final, null, 2));
  } finally {
    await controller.dispose();
  }
});
