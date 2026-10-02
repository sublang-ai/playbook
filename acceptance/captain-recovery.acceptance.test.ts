// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
// Opt-in real-provider run: one injected transport failure between real steps.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assign, createMachine } from 'xstate';
import { expect, it } from 'vitest';
import {
  createEvent,
  type AgentEvent,
  type AgentOptions,
} from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';
import {
  createXStatePlaybookRuntime,
  RUNTIME_ABI,
} from '../src/xstate-runtime.js';
import { createSessionStore } from '../reference/sdlc/code.playbook/session-store.js';
import { openSessionHost } from '../reference/sdlc/code.playbook/session-host.js';
import { loadLaunchPlan } from '../reference/sdlc/code.playbook/bin/launch-config.js';
import { executionConfigFromPlan } from '../reference/sdlc/code.playbook/bin/run.js';

const GENERATED_CHECK_CACHE = 'generated check cache';

const metadata = (stateId: string, description: string, role?: string) => ({
  playbook: { stateId, description, ...(role ? { role } : {}) },
});
const machine = createMachine(
  {
    id: 'recovery-flow',
    initial: 'ready',
    context: { task: '', prior: '' },
    states: {
      ready: {
        tags: ['playbook.parked'],
        meta: metadata('ready', 'Waiting'),
        on: {
          START: {
            target: 'first',
            actions: assign({ task: ({ event }) => event.text }),
          },
        },
      },
      first: {
        tags: ['playbook.busy'],
        meta: metadata('first', 'Create the first commit', 'worker'),
        invoke: {
          src: 'player',
          input: ({ context }) => ({
            stateId: 'first',
            role: 'worker',
            sourceItem: 'FLOW-1',
            prompt: `RECOVERY_LIVE_FIRST: ${context.task}. Write first.txt containing first-completed and commit that one file with message first step. Do not modify any other file. Report the commit.`,
            result: { done: 'The first commit is complete.' },
          }),
          onDone: {
            target: 'second',
            actions: [
              assign({ prior: () => 'first-completed' }),
              {
                type: 'playbook.acceptedOutcome',
                params: {
                  source: 'first',
                  target: 'second',
                  acceptedOutcome: 'done',
                },
              },
            ],
          },
          onError: {
            target: 'failed',
            actions: assign({ lastError: ({ event }) => event.error }),
          },
        },
      },
      second: {
        tags: ['playbook.busy'],
        meta: metadata('second', 'Check the completed commit', 'worker'),
        invoke: {
          src: 'player',
          input: ({ context }) => ({
            stateId: 'second',
            role: 'worker',
            sourceItem: 'FLOW-2',
            prompt: `RECOVERY_LIVE_SECOND: ${context.task}; ${context.prior}. Run node check.mjs and report its exact output. Do not write or commit any files. The required ignored local environment marker is .runtime/ready, prepared by Captain after the interruption.`,
            result: { done: 'The check confirms the task can finish without any unresolved Boss decision.' },
          }),
          onDone: {
            target: 'done',
            actions: {
              type: 'playbook.acceptedOutcome',
              params: {
                source: 'second',
                target: 'done',
                acceptedOutcome: 'done',
              },
            },
          },
          onError: {
            target: 'failed',
            actions: assign({ lastError: ({ event }) => event.error }),
          },
        },
      },
      failed: {
        tags: ['playbook.parked'],
        meta: metadata('failed', 'The flow needs recovery'),
        on: { START: 'first' },
      },
      done: { type: 'final', meta: metadata('done', 'Finished') },
    },
  },
  { actions: { 'playbook.acceptedOutcome': () => undefined } },
);
const createRuntime = createXStatePlaybookRuntime(machine, {
  label: 'recovery-flow',
  compat: { artifactSchema: 3, runtimeAbi: RUNTIME_ABI },
  snapshotOptions: () => ({}),
  entryEvent: { type: 'START', textField: 'text' },
  roleStates: {
    first: { role: 'worker', label: 'Create the first commit' },
    second: { role: 'worker', label: 'Check the completed commit' },
  },
  outcomeAuthority: {
    governedPlayerStates: {
      first: {
        done: { fields: {}, repositoryDisposition: 'one-descendant-commit' },
      },
      second: { done: { fields: {}, repositoryDisposition: 'unchanged' } },
    },
  },
});

class LocalClaude extends ClaudeCodeAdapter {
  static interruptJudge = false;
  static interruptPreparation: (() => void) | undefined;
  async *run(
    prompt: string,
    options?: AgentOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    if (
      LocalClaude.interruptJudge &&
      prompt.includes('This is hidden control work.')
    ) {
      LocalClaude.interruptJudge = false;
      yield createEvent(
        'done',
        this.agent,
        {
          status: 'error',
          error: 'ECONNRESET: injected judge network interruption after commit',
          usage: { toolUses: 0 },
          durationMs: 1,
        },
        'transport:error',
      );
      return;
    }
    for await (const event of super.run(prompt, options)) {
      if (prompt.includes('You are Captain preparing an interrupted playbook') && event.type === 'done' && LocalClaude.interruptPreparation) {
        const interrupt = LocalClaude.interruptPreparation;
        LocalClaude.interruptPreparation = undefined;
        interrupt();
        throw new Error('ECONNRESET: interrupted after preparation tools ran');
      }
      yield event;
    }
  }
  constructor() {
    super({
      loadSdk: async () => {
        const sdk = await import('@anthropic-ai/claude-agent-sdk');
        return {
          query: ({ prompt, options }: any) =>
            sdk.query({
              prompt,
              options: {
                ...options,
                ...(process.env.PLAYBOOK_ACCEPTANCE_CLAUDE_PATH
                  ? {
                      pathToClaudeCodeExecutable:
                        process.env.PLAYBOOK_ACCEPTANCE_CLAUDE_PATH,
                    }
                  : {}),
              },
            }),
        } as any;
      },
    });
  }
}
class InterruptedCodex extends CodexAdapter {
  static interrupted = false;
  static injectStrayFile = false;
  static firstCalls = 0;
  static secondCalls = 0;
  async *run(
    prompt: string,
    options?: AgentOptions,
  ): AsyncGenerator<AgentEvent, void, void> {
    if (prompt.includes('RECOVERY_LIVE_FIRST:')) InterruptedCodex.firstCalls++;
    if (prompt.includes('RECOVERY_LIVE_SECOND:')) {
      InterruptedCodex.secondCalls++;
      if (!InterruptedCodex.interrupted) {
        InterruptedCodex.interrupted = true;
        yield createEvent(
          'done',
          this.agent,
          {
            status: 'error',
            error:
              'ECONNRESET: injected network interruption before the second step; local environment also needs .runtime/ready',
            usage: { toolUses: 0 },
            durationMs: 1,
          },
          'transport:error',
        );
        return;
      }
    }
    for await (const event of super.run(prompt, options)) {
      if (InterruptedCodex.injectStrayFile && prompt.includes('RECOVERY_LIVE_SECOND:') && event.type === 'done') {
        InterruptedCodex.injectStrayFile = false;
        // Inject after the real worker finishes, so its own tidying cannot
        // erase the failure this acceptance scenario is meant to exercise.
        await writeFile(join(options!.cwd!, 'scratch-output'), GENERATED_CHECK_CACHE);
      }
      yield event;
    }
  }
}
it.each(['player', 'judge', 'files', 'preparation', 'missing-transition'])(
  'Captain recovers the real-model %s interruption without a repeated commit',
  async (failure) => {
    LocalClaude.interruptJudge = failure === 'judge';
    InterruptedCodex.injectStrayFile = failure === 'files';
    InterruptedCodex.interrupted = ['judge', 'files', 'missing-transition'].includes(failure);
    LocalClaude.interruptPreparation = undefined;
    InterruptedCodex.firstCalls = 0;
    InterruptedCodex.secondCalls = 0;
    const root = await mkdtemp(join(tmpdir(), 'captain-recovery-live-'));
    const cwd = join(root, 'repo');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(cwd);
    git('init', '-q');
    git('config', 'user.name', 'Recovery Acceptance');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    await writeFile(join(cwd, '.gitignore'), '.runtime/\n');
    await writeFile(
      join(cwd, 'check.mjs'),
      "import {readFileSync} from 'node:fs'; if(readFileSync('.runtime/ready','utf8').trim()!=='ready') throw Error('missing environment'); console.log('RECOVERY_LIVE_OK');\n",
    );
    if (failure === 'judge') {
      await mkdir(join(cwd, '.runtime'));
      await writeFile(join(cwd, '.runtime/ready'), 'ready');
    }
    if (failure === 'missing-transition') {
      await mkdir(join(cwd, '.runtime'));
      await writeFile(join(cwd, '.runtime/ready'), 'ready');
      await writeFile(join(cwd, 'check.mjs'), "console.log('Cannot finish: Boss must choose whether to keep or delete data. This playbook offers only done and has no path for requesting that decision.');\n");
    }
    if (failure === 'files') {
      await mkdir(join(cwd, '.runtime'));
      await writeFile(join(cwd, '.runtime/ready'), 'ready');
      await writeFile(join(cwd, 'check.mjs'), `import {existsSync,writeFileSync} from 'node:fs'; if(!existsSync('.runtime/no-cache')) writeFileSync('scratch-output',${JSON.stringify(GENERATED_CHECK_CACHE)}); console.log('RECOVERY_LIVE_OK');\n`);
    }
    git('add', '.');
    git('commit', '-qm', 'fixture');
    const registry = {
      id: 'recovery-flow',
      command: 'recover-flow',
      intent: 'Create one commit then check the prepared environment',
      artifactSchema: 3,
      runtimeProfile: { kind: 'shared-factory', compat: createRuntime.compat },
      requiredRoleIds: ['worker'],
      concurrentRoleSets: [],
      validateOptions: (value: unknown) => value ?? {},
      createRuntime: (configuredOptions: unknown, hostCapabilities: any) =>
        createRuntime({ configuredOptions, hostCapabilities }),
    };
    const configPath = join(root, 'playbook.config.yaml');
    await writeFile(
      configPath,
      `captain:
  adapter: claude
  model: ${process.env.PLAYBOOK_ACCEPTANCE_CLAUDE_MODEL ?? 'claude-opus-5-5'}
  effort: low
  permissions: { mode: auto }
notifications: { player_finished: off, turn_finished: off, turn_aborted: off }
players:
  worker:
    adapter: codex
    model: ${process.env.PLAYBOOK_ACCEPTANCE_CODEX_MODEL ?? 'gpt-6-sol'}
    effort: low
    permissions: { mode: auto, writablePaths: ['.git'] }
playbooks:
  recovery-flow:
    from: mod://recovery-flow
    roles: { worker: worker }
`,
    );
    const loadModule = async () => ({ default: registry });
    const plan = await loadLaunchPlan({
      userConfigPath: configPath,
      loadModule,
    });
    const config = executionConfigFromPlan(plan);
    const store = createSessionStore({ sessionsDir: join(root, 'sessions') });
    const adapterImports = {
      claude: async () => LocalClaude,
      codex: async () => InterruptedCodex,
    } as never;
    let controller = await openSessionHost({
      store,
      mode: 'new',
      cwd,
      config,
      loadModule,
      adapterImports,
    });
    console.log(`Live recovery evidence: ${root}`);
    try {
      if (failure === 'preparation') LocalClaude.interruptPreparation = () => controller.host.abortActiveTurn();
      const task = '/recover-flow Verify exact-step recovery. Prepare required local settings automatically. Generated check caches are disposable after preserving a copy; keep tracked source and completed commits unchanged.';
      let recovered;
      if (failure === 'preparation') {
        await expect(controller.handleBossTurn(task)).rejects.toThrow();
        const broken = await controller.read();
        await writeFile(join(root, 'broken.json'), JSON.stringify(broken, null, 2));
        expect(broken?.state).toBe('settled');
        expect(broken?.snapshot.frames?.[0]?.runtime.recoveryCheckpoint?.stateId).toBe('second');
        expect(git('rev-list', '--count', 'HEAD')).toBe('2');
        const id = controller.sessionId;
        await controller.dispose();
        controller = await openSessionHost({ store, mode: 'recover', sessionId: id, config, loadModule, adapterImports });
        recovered = await controller.recover('Continue the existing task, preserving completed commits and preparing only its next step.');
      } else {
        recovered = await controller.handleBossTurn(task);
      }
      await writeFile(join(root, 'recovered.json'), JSON.stringify(recovered, null, 2));
      if (failure === 'missing-transition') {
        expect(recovered.snapshot.mode).toBe('engaged.parked');
        expect(recovered.snapshot.lastSettlementStatus).toBe('failed');
        expect(InterruptedCodex.firstCalls).toBe(1);
        expect(InterruptedCodex.secondCalls).toBe(1);
        const second = recovered.effectLedger.boundaries[1];
        expect(second.semanticCandidate).toHaveProperty('blocked');
        expect(second.correctionBudget.spent).toBe(false);
        const facts = recovered.snapshot.journal.filter((entry) => entry.kind === 'outcome');
        expect(JSON.stringify(facts)).toMatch(/preparation reported.*blocked.*(transition|path|playbook|outcome)/i);
        expect(git('rev-list', '--count', 'HEAD')).toBe('2');
        return;
      }
      expect(await readFile(join(cwd, '.runtime/ready'), 'utf8')).toMatch(
        /^ready\s*$/,
      );
      expect(recovered.snapshot.lastAction).toBe('recover');
      expect(recovered.snapshot.mode).toBe('chat');
      expect(recovered.snapshot.lastSettlementStatus).toBe('ok');
      expect(InterruptedCodex.firstCalls).toBe(1);
      expect(InterruptedCodex.secondCalls).toBe(failure === 'judge' ? 1 : 2);
      expect(git('rev-list', '--count', 'HEAD')).toBe('2');
      if (failure === 'files') expect(recovered.effectLedger.boundaries.some((boundary) => boundary.restored !== undefined)).toBe(true);
      expect(git('status', '--porcelain')).toBe('');
    } finally {
      await controller.dispose();
    }
  },
  600_000,
);
