// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { chmodSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { runPlaybookCli } from './bin/playbook.js';
import {
  createCaptainSessionStore,
  projectCaptainSessionStructure,
  validateCaptainSessionRecord,
} from './bin/session-store.js';
import * as facadeModule from './session-store.js';

const tempDirs: string[] = [];
const sessionId = '94000000-0000-4000-8000-000000000001';
const skippedSessionId = '94000000-0000-4000-8000-000000000002';
const streamOnlySessionId = '94000000-0000-4000-8000-000000000003';
const captainRuntimeId = '94000000-0000-4000-8000-000000000004';
const foreignSessionId = '94000000-0000-4000-8000-000000000005';
const malformedLeaseSessionId = '94000000-0000-4000-8000-000000000006';
const indeterminateSessionId = '94000000-0000-4000-8000-000000000007';
const raceSessionId = '94000000-0000-4000-8000-000000000008';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixtureDir() {
  const root = await mkdtemp(join(tmpdir(), 'playbook-session-facade-'));
  tempDirs.push(root);
  return { root, sessionsDir: join(root, 'sessions') };
}

function streamPath(sessionsDir: string, id = sessionId) {
  return join(sessionsDir, `${id}.records.jsonl`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function effectLedger() {
  return {
    schemaVersion: 1,
    revision: 0,
    boundaries: [],
    logicalOperations: [],
  };
}

function executionProjection() {
  return {
    schemaVersion: 2,
    captain: {
      adapter: 'claude',
      model: { kind: 'provider-default' },
      effort: { kind: 'provider-default' },
      permissions: { mode: 'auto' },
    },
    players: [
      {
        id: 'dev.coder',
        adapter: 'codex',
        model: { kind: 'provider-default' },
        effort: { kind: 'value', value: 'high' },
        permissions: { fileWrite: 'ask' },
      },
    ],
    catalog: {
      code: {
        id: 'code',
        from: '@sublang/playbook/code/registry',
        manifestCommand: 'code',
        command: 'code',
        intent: 'Implement a requested change.',
        artifactSchema: 3,
        requiredRoleIds: ['coder'],
        concurrentRoleSets: [],
        roles: {
          coder: {
            playerId: 'dev.coder',
            model: { kind: 'provider-default' },
            effort: { kind: 'value', value: 'high' },
          },
        },
        options: {},
      },
    },
  };
}

function runtimeSnapshot(turn = 1) {
  const state = {
    value: 'routing',
    activeStateIds: ['routing'],
    tags: ['playbook.parked'],
    status: 'active',
    quiescent: true,
    stateId: 'routing',
  };
  return {
    schemaVersion: 4,
    playbookId: 'captain',
    machine: { value: state.value, status: state.status },
    roleResumeTokens: {},
    sequences: {
      trace: 0,
      turn,
      judgeCall: 0,
      playerCall: 0,
      playbookCall: 0,
      captainCall: 0,
    },
    state,
    pendingBossQuestions: [],
    effectLedger: effectLedger(),
  };
}

function credentialSnapshot(execution: ReturnType<typeof executionProjection>) {
  const structural = projectCaptainSessionStructure(execution);
  return {
    schemaVersion: 4,
    captain: {
      sessionId: captainRuntimeId,
      runtime: runtimeSnapshot(),
      agent: structural.captain,
      conversation: { kind: 'pinned', token: 'captain-resume-secret' },
    },
    playerSessions: Object.fromEntries(
      structural.players.map(({ id, ...agent }: any) => [
        id,
        { ...agent, resumeToken: 'player-resume-secret' },
      ]),
    ),
    issuedSessionIds: [captainRuntimeId],
    sequences: { turn: 1, journal: 1 },
    journal: [{ seq: 1, turnId: 1, kind: 'boss', payload: 'hello' }],
    effectLedger: effectLedger(),
    lastAction: 'respond',
    lastSettlementStatus: 'ok',
    mode: 'chat',
  };
}

function freshSnapshot(execution: ReturnType<typeof executionProjection>) {
  const structural = projectCaptainSessionStructure(execution);
  return {
    schemaVersion: 4,
    captain: {
      sessionId: captainRuntimeId,
      runtime: runtimeSnapshot(0),
      agent: structural.captain,
      conversation: { kind: 'unopened' },
    },
    playerSessions: Object.fromEntries(
      structural.players.map(({ id, ...agent }: any) => [id, agent]),
    ),
    issuedSessionIds: [captainRuntimeId],
    sequences: { turn: 0, journal: 0 },
    journal: [],
    effectLedger: effectLedger(),
    mode: 'chat',
  };
}

async function publishCredentialManifest(sessionsDir: string) {
  const execution = executionProjection();
  const privateStore = createCaptainSessionStore({ sessionsDir });
  const privateLease = await privateStore.acquire(sessionId);
  await privateLease.initializeSettledWithPredecessor({
    cwd: process.cwd(),
    structuralProjection: projectCaptainSessionStructure(execution),
    executionProjection: execution,
    snapshot: freshSnapshot(execution),
  });
  const attemptId = '94000000-0000-4000-8000-000000000010';
  await privateLease.beginTurn({input:'hello',attemptId,attemptedExecutionProjection:execution});
  privateLease.acknowledgeHint('captain','captain-resume-secret');
  privateLease.acknowledgeHint('dev.coder','player-resume-secret');
  await privateLease.settle({attemptId,snapshot:credentialSnapshot(execution),unresolvedEffects:[]});
  await privateLease.release();
  return JSON.parse(await readFile(join(sessionsDir,`${sessionId}.json`),'utf8'));

}

async function writePrivateFile(path: string, text: string) {
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function rejectedError(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return error as Error & { code?: unknown };
  }
  throw new Error('expected operation to reject');
}

function importedBindingSpecifier(
  source: string,
  importer: URL,
  importedName: string,
) {
  const parsed = ts.createSourceFile(
    importer.pathname,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const matches: string[] = [];
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    if (
      bindings.elements.some(
        (element) =>
          (element.propertyName?.text ?? element.name.text) === importedName,
      )
    ) {
      matches.push(statement.moduleSpecifier.text);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `${importer.href} must import ${importedName} from exactly one module`,
    );
  }
  return matches[0]!;
}

function resolveImportedBinding(
  source: string,
  importer: URL,
  importedName: string,
) {
  const specifier = importedBindingSpecifier(source, importer, importedName);
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    throw new Error(
      `${importer.href} must import ${importedName} from a relative module`,
    );
  }
  return new URL(specifier, importer).href;
}

function processOutputSpies() {
  const stdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((() => true) as any);
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((() => true) as any);
  return { stdout, stderr };
}

describe('published session-store facade (PBCLI-73, PBCLI-79, PBCLI-80)', () => {
  it('shares one private store and validator with every CLI path', async () => {
    const facadeUrl = new URL('./session-store.js', import.meta.url);
    const cliUrls = [
      new URL('./bin/run.js', import.meta.url),
      new URL('./bin/interactive-session.js', import.meta.url),
      new URL('./bin/playbook.js', import.meta.url),
    ];
    const [facade, ...cliSources] = await Promise.all(
      [facadeUrl, ...cliUrls].map((url) => readFile(url, 'utf8')),
    );

    const privateStore = new URL(
      './bin/session-store.js',
      import.meta.url,
    ).href;
    expect(
      resolveImportedBinding(
        facade,
        facadeUrl,
        'createCaptainSessionStore',
      ),
    ).toBe(privateStore);
    for (const [index, source] of cliSources.entries()) {
      const importer = cliUrls[index]!;
      expect(
        resolveImportedBinding(source, importer, 'createCaptainSessionStore'),
      ).toBe(privateStore);
      expect(
        resolveImportedBinding(
          source,
          importer,
          'validateCaptainSessionRecord',
        ),
      ).toBe(privateStore);
    }
  });

  it('publishes lifecycle APIs while keeping the narrow handles exact', async () => {
    expect(Object.keys(facadeModule).sort()).toEqual([
      'RECORDS_STREAM_VERSION',
      'assertCaptainSessionExecutionCompatible',
      'attachSessionHints',
      'createSessionStore',
      'defaultSessionsDir',
      'openSessionStore',
      'projectCaptainSessionStructure',
      'validateCaptainSessionExecutionProjection',
      'validateCaptainSessionStructuralProjection',
      'validateSessionContext',
      'validateSessionManifest',
    ]);
    expect(facadeModule).not.toHaveProperty('default');
    expect(facadeModule.RECORDS_STREAM_VERSION).toBe(1);

    const priorStateHome = process.env.SPEX_HOME;
    const priorHome = process.env.HOME;
    try {
      process.env.SPEX_HOME = '/tmp/playbook-state-one';
      expect(facadeModule.defaultSessionsDir()).toBe(
        '/tmp/playbook-state-one/sessions',
      );
      delete process.env.SPEX_HOME;
      process.env.HOME = '/tmp/playbook-home-two';
      expect(facadeModule.defaultSessionsDir()).toBe(
        '/tmp/playbook-home-two/.spex/sessions',
      );
    } finally {
      if (priorStateHome === undefined) delete process.env.SPEX_HOME;
      else process.env.SPEX_HOME = priorStateHome;
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }

    expect(() => facadeModule.openSessionStore('relative/sessions')).toThrow();
    const { sessionsDir } = await fixtureDir();
    const store = facadeModule.openSessionStore(sessionsDir);
    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.keys(store).sort()).toEqual([
      'acquire',
      'list',
      'read',
      'readStream',
      'sessionsDir',
    ]);

    const lease = await store.acquire(sessionId);
    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.keys(lease).sort()).toEqual([
      'append',
      'ownerToken',
      'readStream',
      'release',
      'sessionId',
      'streamStatus',
    ]);
    for (const privateMember of [
      'initializeSettledWithPredecessor',
      'beginTurn',
      'beginRetry',
      'settle',
      'discard',
      'abandon',
      'writeEffectLedger',
      'assertOwner',
    ]) {
      expect(store).not.toHaveProperty(privateMember);
      expect(lease).not.toHaveProperty(privateMember);
    }
    await lease.release();
  });

  it('lists and reads detached token-free summaries while reporting skips', async () => {
    const { root, sessionsDir } = await fixtureDir();
    const manifest = await publishCredentialManifest(sessionsDir);
    const invalidPath = join(sessionsDir, `${skippedSessionId}.json`);
    const {
      unresolvedEffects: _unresolvedEffects,
      replay: _replay,
      contextSeq: _contextSeq,
      ...preUnresolvedEffectsRecord
    } = manifest;
    await writePrivateFile(
      invalidPath,
      `${JSON.stringify({
        ...preUnresolvedEffectsRecord,
        schemaVersion: 5,
        sessionId: skippedSessionId,
      })}\n`,
    );
    const streamOnlyPath = streamPath(sessionsDir, streamOnlySessionId);
    const streamOnlyBytes = `${JSON.stringify({
      v: 1,
      seq: 1,
      record: { type: 'peer_record' },
    })}\n`;
    await writePrivateFile(
      streamOnlyPath,
      streamOnlyBytes,
    );
    const sidecarPath = join(sessionsDir, `${sessionId}.peer.json`);
    const sidecarBytes = '{"peer":"untouched"}\n';
    await writePrivateFile(sidecarPath, sidecarBytes);

    const store = facadeModule.openSessionStore(sessionsDir);
    const listed = await store.list();
    expect(Object.keys(listed).sort()).toEqual(['sessions', 'skipped']);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.skipped).toHaveLength(1);
    const summary = listed.sessions[0]!;
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.keys(summary).sort()).toEqual([
      'cwd',
      'schemaVersion',
      'sessionId',
      'state',
      'updatedAt',
    ]);
    expect(summary).toEqual({
      schemaVersion: 7,
      sessionId,
      state: 'settled',
      cwd: manifest.cwd,
      updatedAt: manifest.updatedAt,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /resume|token|snapshot|projection|ledger|recovery|effect|generation/i,
    );
    expect(listed.skipped[0]).toMatchObject({ sessionId: skippedSessionId });
    expect(Object.keys(listed.skipped[0]!).sort()).toEqual([
      'reason',
      'sessionId',
    ]);
    expect(listed.skipped[0]!.reason).toMatch(/schema|invalid|cutover/i);

    const direct = await store.read(sessionId);
    expect(direct).toEqual(summary);
    expect(direct).not.toBe(summary);
    expect(Object.isFrozen(direct)).toBe(true);
    const oldSchemaError = await rejectedError(store.read(skippedSessionId));
    expect(oldSchemaError.code).toBeUndefined();
    for (const [argv, prefix] of [
      [
        ['run', '--session', skippedSessionId, 'must not run'],
        'playbook run:',
      ],
      [['--session', skippedSessionId], 'playbook:'],
    ] as const) {
      const frontEndStdout = vi.fn(() => true);
      const frontEndStderr = vi.fn(() => true);
      const launch = vi.fn();
      expect(
        await runPlaybookCli({
          argv,
          env: {},
          homeDir: root,
          sessionsDir,
          stdout: { write: frontEndStdout },
          stderr: { write: frontEndStderr },
          tmuxPlayBin: '/unused/tmux-play.js',
          launchManagedTmuxPlay: launch,
        }),
      ).toEqual({ code: 1 });
      expect(frontEndStdout).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(frontEndStderr).toHaveBeenCalledTimes(1);
      expect(frontEndStderr).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^${prefix} .*schema 5`)),
      );
    }
    expect(await readFile(sidecarPath, 'utf8')).toBe(sidecarBytes);
    expect(await readFile(streamOnlyPath, 'utf8')).toBe(streamOnlyBytes);
  });

  it('supports manifestless replay and exposes only the two control-flow codes', async () => {
    const { sessionsDir } = await fixtureDir();
    const store = facadeModule.openSessionStore(sessionsDir);

    const missing = await rejectedError(store.read(sessionId));
    expect(missing).toBeInstanceOf(Error);
    expect(missing.code).toBe('PLAYBOOK_SESSION_NOT_FOUND');
    expect(await store.readStream(sessionId)).toEqual({
      entries: [],
      lastReadableSeq: 0,
    });

    const lease = await store.acquire(sessionId);
    const active = await rejectedError(store.acquire(sessionId));
    expect(active).toBeInstanceOf(Error);
    expect(active.code).toBe('PLAYBOOK_SESSION_LEASE_ACTIVE');
    expect(Object.keys(lease.streamStatus()).sort()).toEqual([
      'incomplete',
      'lastDurableSeq',
      'lastReadableSeq',
    ]);

    expect(
      await lease.append(
        {
          type: 'opaque_record',
          resumeToken: 'remove-me',
          nested: { resume: 'remove-me-too', retained: { resume: false } },
        },
        'coder',
      ),
    ).toBeUndefined();
    expect(lease.streamStatus()).toEqual({
      lastReadableSeq: 1,
      lastDurableSeq: 0,
      incomplete: false,
    });
    const live = await lease.readStream({ afterSeq: undefined });
    expect(Object.keys(live).sort()).toEqual([
      'entries',
      'incomplete',
      'lastDurableSeq',
      'lastReadableSeq',
    ]);
    expect(live).toEqual({
      entries: [
        {
          v: 1,
          seq: 1,
          role: 'coder',
          record: {
            type: 'opaque_record',
            nested: { retained: { resume: false } },
          },
        },
      ],
      lastReadableSeq: 1,
      lastDurableSeq: 0,
      incomplete: false,
    });
    expect(await lease.release()).toEqual({
      lastReadableSeq: 1,
      lastDurableSeq: 1,
      incomplete: false,
    });

    const followed = await store.readStream(sessionId, { afterSeq: 0 });
    expect(Object.keys(followed).sort()).toEqual([
      'entries',
      'lastReadableSeq',
    ]);
    expect(followed.entries).toEqual(live.entries);
    expect(followed.lastReadableSeq).toBe(1);
    expect(await store.list()).toEqual({ sessions: [], skipped: [] });

    const invalidArgument = await rejectedError(store.read('not-a-uuid'));
    expect(invalidArgument.code).toBeUndefined();

    const foreignLease = await createCaptainSessionStore({
      sessionsDir,
      hostname: 'foreign.example.test',
      pid: 111,
    }).acquire(foreignSessionId);
    const foreign = await rejectedError(store.acquire(foreignSessionId));
    expect(foreign).toBeInstanceOf(Error);
    expect(foreign.code).toBe('PLAYBOOK_SESSION_LEASE_ACTIVE');
    await foreignLease.assertOwner();
    await foreignLease.release();

    const malformedLock = join(
      sessionsDir,
      `.${malformedLeaseSessionId}.lock`,
    );
    await mkdir(malformedLock, { mode: 0o700 });
    await writePrivateFile(join(malformedLock, 'owner.json'), '{invalid\n');
    const malformed = await rejectedError(
      store.acquire(malformedLeaseSessionId),
    );
    expect(malformed.code).toBeUndefined();

    const unsafeFixture = await fixtureDir();
    await mkdir(unsafeFixture.sessionsDir, { mode: 0o755 });
    await chmod(unsafeFixture.sessionsDir, 0o500);
    const unsafeStore = facadeModule.openSessionStore(
      unsafeFixture.sessionsDir,
    );
    const unsafe = await rejectedError(unsafeStore.read(sessionId));
    expect(unsafe.code).toBeUndefined();
  });

  it('classifies indeterminate owners and publication-race winners exactly', async () => {
    const indeterminateFixture = await fixtureDir();
    const indeterminateOwner = await createCaptainSessionStore({
      sessionsDir: indeterminateFixture.sessionsDir,
      hostname: 'shared-host',
      pid: 111,
    }).acquire(indeterminateSessionId);
    const indeterminate = await rejectedError(
      createCaptainSessionStore({
        sessionsDir: indeterminateFixture.sessionsDir,
        hostname: 'shared-host',
        pid: 222,
        probeProcess: async () => {
          const error = new Error('permission denied') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        },
      }).acquire(indeterminateSessionId),
    );
    expect(indeterminate).toBeInstanceOf(Error);
    expect(indeterminate.code).toBeUndefined();
    await indeterminateOwner.assertOwner();
    await indeterminateOwner.release();

    const raceFixture = await fixtureDir();
    const canonicalLock = join(
      raceFixture.sessionsDir,
      `.${raceSessionId}.lock`,
    );
    const loserAtRename = deferred();
    const continueLoser = deferred();
    let held = false;
    const loserStore = createCaptainSessionStore({
      sessionsDir: raceFixture.sessionsDir,
      hostname: 'shared-host',
      pid: 222,
      probeProcess: async () => {},
      fsOps: {
        async rename(from: string, to: string) {
          if (!held && to === canonicalLock && from.includes('.lock.stage.')) {
            held = true;
            loserAtRename.resolve();
            await continueLoser.promise;
          }
          return rename(from, to);
        },
      },
    });
    const loser = loserStore.acquire(raceSessionId);
    await loserAtRename.promise;
    const winner = await createCaptainSessionStore({
      sessionsDir: raceFixture.sessionsDir,
      hostname: 'shared-host',
      pid: 111,
    }).acquire(raceSessionId);
    continueLoser.resolve();
    const race = await rejectedError(loser);
    expect(race).toBeInstanceOf(Error);
    expect(race.code).toBe('PLAYBOOK_SESSION_LEASE_ACTIVE');
    await winner.assertOwner();
    await winner.release();

    const storageFixture = await fixtureDir();
    const storage = await rejectedError(
      createCaptainSessionStore({
        sessionsDir: storageFixture.sessionsDir,
        fsOps: {
          async mkdir() {
            const error = new Error(
              'synthetic storage failure',
            ) as NodeJS.ErrnoException;
            error.code = 'PLAYBOOK_SESSION_LEASE_ACTIVE';
            throw error;
          },
        },
      }).acquire(sessionId),
    );
    expect(storage).toBeInstanceOf(Error);
    expect(storage.code).toBeUndefined();
  });

  it('keeps facade argument failures retryable and sanitizer failures live-only', async () => {
    const { stdout, stderr } = processOutputSpies();
    const boundaryCases: readonly [unknown, unknown?][] = [
      [null],
      [7],
      [() => undefined],
      [[{ type: 'array-record' }]],
      [{ type: 'empty-role' }, ''],
      [{ type: 'non-string-role' }, 7],
    ];

    for (const [index, [record, role]] of boundaryCases.entries()) {
      const { sessionsDir } = await fixtureDir();
      const id = `94100000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      const store = facadeModule.openSessionStore(sessionsDir);
      const lease = await store.acquire(id);
      const initial = lease.streamStatus();
      await expect((lease.append as any)(record, role)).rejects.toBeDefined();
      expect(lease.streamStatus()).toEqual(initial);
      expect(await store.readStream(id)).toEqual({
        entries: [],
        lastReadableSeq: 0,
      });
      expect(await lease.append({ type: 'corrected' })).toBeUndefined();
      expect(await lease.release()).toEqual({
        lastReadableSeq: 1,
        lastDurableSeq: 1,
        incomplete: false,
      });
      expect((await store.readStream(id)).entries[0]).toMatchObject({
        seq: 1,
        record: { type: 'corrected' },
      });
    }

    for (const [index, record] of [
      new Date('2026-08-31T00:00:00.000Z'),
      (() => {
        const value: Record<string, unknown> = { type: 'cyclic' };
        value.self = value;
        return value;
      })(),
    ].entries()) {
      const { sessionsDir } = await fixtureDir();
      const id = `94200000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      const store = facadeModule.openSessionStore(sessionsDir);
      const lease = await store.acquire(id);
      await expect(lease.append(record)).rejects.toBeDefined();
      expect(lease.streamStatus()).toEqual({
        lastReadableSeq: 0,
        lastDurableSeq: 0,
        incomplete: true,
      });
      expect(await lease.append({ type: 'suppressed' })).toBeUndefined();
      expect(await lease.release()).toEqual({
        lastReadableSeq: 0,
        lastDurableSeq: 0,
        incomplete: true,
      });

      const successor = await store.acquire(id);
      expect(successor.streamStatus()).toEqual({
        lastReadableSeq: 0,
        lastDurableSeq: 0,
        incomplete: false,
      });
      await successor.append({ type: 'successor' });
      await successor.release();
      expect((await store.readStream(id)).entries[0]).toMatchObject({
        seq: 1,
        record: { type: 'successor' },
      });
    }
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('serializes overlapping appends and drains failures before release', async () => {
    const { sessionsDir } = await fixtureDir();
    const store = facadeModule.openSessionStore(sessionsDir);
    const lease = await store.acquire(sessionId);
    const enteredSanitizer = deferred();
    let second!: Promise<void>;
    let released!: ReturnType<typeof lease.release>;
    let afterBarrier!: Promise<void>;
    let admittedFollowers = false;
    const firstRecord = new Proxy(
      { type: 'first' },
      {
        ownKeys(target) {
          if (!admittedFollowers) {
            admittedFollowers = true;
            second = lease.append({ type: 'second' });
            released = lease.release();
            afterBarrier = lease.append({ type: 'after-barrier' });
            enteredSanitizer.resolve();
          }
          return Reflect.ownKeys(target);
        },
      },
    );
    const first = lease.append(firstRecord);
    await enteredSanitizer.promise;

    await expect(afterBarrier).rejects.toBeDefined();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(released).resolves.toEqual({
      lastReadableSeq: 2,
      lastDurableSeq: 2,
      incomplete: false,
    });
    expect((await store.readStream(sessionId)).entries).toEqual([
      { v: 1, seq: 1, record: { type: 'first' } },
      { v: 1, seq: 2, record: { type: 'second' } },
    ]);

    const failureId = '94300000-0000-4000-8000-000000000001';
    const failurePath = streamPath(sessionsDir, failureId);
    await writePrivateFile(failurePath, '');
    const failedLease = await store.acquire(failureId);
    const failedHead = failedLease.append({ type: 'fails-before-bytes' });
    const queued = failedLease.append({ type: 'queued-after-failure' });
    const failedRelease = failedLease.release();
    chmodSync(failurePath, 0o644);
    await expect(failedHead).rejects.toBeDefined();
    chmodSync(failurePath, 0o600);
    await expect(queued).resolves.toBeUndefined();
    await expect(failedRelease).resolves.toEqual({
      lastReadableSeq: 0,
      lastDurableSeq: 0,
      incomplete: true,
    });
    expect(await store.readStream(failureId)).toEqual({
      entries: [],
      lastReadableSeq: 0,
    });
  });

  it.each([
    ['numeric', false],
    ['null-boundary', true],
  ] as const)(
    'caches a retired %s handle without disturbing its successor',
    async (_name, unavailable) => {
      const { sessionsDir } = await fixtureDir();
      if (unavailable) {
        await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
        await chmod(sessionsDir, 0o700);
        await writePrivateFile(
          streamPath(sessionsDir),
          '{"v":2,"seq":1,"record":{"type":"future"}}\n',
        );
      }
      const store = facadeModule.openSessionStore(sessionsDir);
      const retired = await store.acquire(sessionId);
      if (!unavailable) await retired.append({ type: 'retained' });
      const finalStatus = await retired.release();
      expect(finalStatus).toEqual(
        unavailable
          ? {
              lastReadableSeq: null,
              lastDurableSeq: null,
              incomplete: true,
            }
          : {
              lastReadableSeq: 1,
              lastDurableSeq: 1,
              incomplete: false,
            },
      );

      const successor = await store.acquire(sessionId);
      const before = await readFile(streamPath(sessionsDir), 'utf8');
      let optionsInspected = false;
      const untrustedOptions = new Proxy(
        {},
        {
          ownKeys() {
            optionsInspected = true;
            return [];
          },
          getOwnPropertyDescriptor() {
            optionsInspected = true;
            return undefined;
          },
        },
      );
      chmodSync(sessionsDir, 0o755);
      try {
        expect(retired.streamStatus()).toBe(finalStatus);
        await expect(retired.release()).resolves.toBe(finalStatus);
        await expect(retired.readStream(untrustedOptions)).rejects.toBeDefined();
        expect(optionsInspected).toBe(false);
      } finally {
        chmodSync(sessionsDir, 0o700);
      }
      expect(await readFile(streamPath(sessionsDir), 'utf8')).toBe(before);
      await expect(successor.release()).resolves.toBeDefined();
    },
  );

  it('keeps unavailable and post-validation write degradation silent', async () => {
    const { stdout, stderr } = processOutputSpies();

    const unavailableFixture = await fixtureDir();
    await mkdir(unavailableFixture.sessionsDir, {
      recursive: true,
      mode: 0o700,
    });
    await chmod(unavailableFixture.sessionsDir, 0o700);
    await writePrivateFile(
      streamPath(unavailableFixture.sessionsDir),
      '{"v":9,"seq":1,"record":{"type":"future"}}\n',
    );
    const unavailableStore = facadeModule.openSessionStore(
      unavailableFixture.sessionsDir,
    );
    const unavailable = await unavailableStore.acquire(sessionId);
    expect(unavailable.streamStatus()).toEqual({
      lastReadableSeq: null,
      lastDurableSeq: null,
      incomplete: true,
    });
    expect(await unavailable.append({ type: 'suppressed' })).toBeUndefined();
    await expect(unavailable.readStream()).rejects.toBeDefined();
    expect(await unavailable.release()).toEqual({
      lastReadableSeq: null,
      lastDurableSeq: null,
      incomplete: true,
    });

    const writeFailureFixture = await fixtureDir();
    await mkdir(writeFailureFixture.sessionsDir, {
      recursive: true,
      mode: 0o700,
    });
    await chmod(writeFailureFixture.sessionsDir, 0o700);
    const failedPath = streamPath(writeFailureFixture.sessionsDir);
    await writePrivateFile(failedPath, '');
    const failedStore = facadeModule.openSessionStore(
      writeFailureFixture.sessionsDir,
    );
    const failed = await failedStore.acquire(sessionId);
    const append = failed.append({ type: 'fails-after-validation' });
    chmodSync(failedPath, 0o644);
    await expect(append).rejects.toBeDefined();
    chmodSync(failedPath, 0o600);
    expect(failed.streamStatus()).toEqual({
      lastReadableSeq: 0,
      lastDurableSeq: 0,
      incomplete: true,
    });
    expect(await failed.append({ type: 'suppressed' })).toBeUndefined();
    expect(await failed.release()).toEqual({
      lastReadableSeq: 0,
      lastDurableSeq: 0,
      incomplete: true,
    });
    expect(await readFile(failedPath, 'utf8')).toBe('');

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
